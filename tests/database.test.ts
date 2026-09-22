import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
// CI uses a real isolated PostgreSQL service. Local runs use PostgreSQL WASM.
const pool = process.env.TEST_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : null;
const lite = pool ? null : new PGlite();
async function q(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return pool
    ? (await pool.query(sql, params)).rows
    : (await lite!.query<Record<string, unknown>>(sql, params)).rows;
}
async function exec(sql: string) {
  if (pool) await pool.query(sql);
  else await lite!.exec(sql);
}
async function call(name: string, params: unknown[]) {
  return (
    await q(
      `select public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) as value`,
      params,
    )
  )[0]?.value;
}
async function account() {
  const telegram = Math.floor(Math.random() * 1e12) + 1;
  const id = randomUUID();
  await q(
    "insert into users(id,telegram_id,state,birth_date,adult_confirmed_at,phone_hmac,phone_verified_at) values($1,$2,'USERNAME','2000-01-01',now(),$3,now())",
    [id, telegram, id.replaceAll("-", "").repeat(2)],
  );
  return id;
}
beforeAll(async () => {
  // This URL MUST point at a disposable database, never Supabase production.
  await exec(
    "create role anon; create role authenticated; create role service_role bypassrls;",
  );
  await exec(
    readFileSync(
      new URL(
        "../packages/database/migrations/0001_identity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await pool?.end();
  await lite?.close();
});
describe("real migration and identity RPCs", () => {
  it("seeds exactly 36 admin-controlled one-character handles", async () =>
    expect(
      (await q("select count(*)::int n from usernames where premium"))[0]?.n,
    ).toBe(36));
  it("allows only one winner for simultaneous case-insensitive claims", async () => {
    const a = await account(),
      b = await account();
    const results = await Promise.allSettled([
      call("claim_username", [a, "AzIz"]),
      call("claim_username", [b, "AZIZ"]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await q("select count(*)::int n from usernames where canonical='aziz'")
      )[0]?.n,
    ).toBe(1);
  });
  it("prevents self-registration of premium and reserved names", async () => {
    const a = await account();
    await expect(call("claim_username", [a, "x"])).rejects.toThrow("PREMIUM");
    await expect(call("claim_username", [a, "ADMIN"])).rejects.toThrow(
      "RESERVED",
    );
  });
  it("requires verified adult before claiming", async () => {
    const id = randomUUID();
    await q("insert into users(id,telegram_id) values($1,991)", [id]);
    await expect(call("claim_username", [id, "unverified"])).rejects.toThrow(
      "ACCOUNT_NOT_VERIFIED",
    );
  });
  it("enforces adult date directly in database", async () =>
    await expect(
      q(
        "insert into users(telegram_id,birth_date) values(992,current_date-interval '17 years')",
      ),
    ).rejects.toThrow("UNDERAGE_OR_INVALID_DOB"));
  it("does not reset denied onboarding with /start semantics", async () => {
    await call("onboard", [993, "uz", "deny", null]);
    const u = (await call("onboard", [993, "uz", "read", null])) as {
      state: string;
    };
    expect(u.state).toBe("DENIED");
  });
  it("gifts premium with audited ownership and rejects support", async () => {
    const a = await account(),
      owner = randomUUID(),
      support = randomUUID();
    await q(
      "insert into admin_users(id,role) values($1,'OWNER'),($2,'SUPPORT')",
      [owner, support],
    );
    await expect(
      call("gift_premium", [support, "x", a, "Customer request"]),
    ).rejects.toThrow("FORBIDDEN");
    await call("gift_premium", [owner, "x", a, "Launch gift"]);
    expect(
      (await q("select owner_id from usernames where canonical='x'"))[0]
        ?.owner_id,
    ).toBe(a);
    expect(
      (await q("select action from audit_logs where target='x'"))[0]?.action,
    ).toBe("GIFT_USERNAME");
    await expect(q("update audit_logs set reason='changed'")).rejects.toThrow(
      "IMMUTABLE_RECORD",
    );
  });
  it("requires both confirmations and rejects replay", async () => {
    const a = await account(),
      b = await account();
    await call("claim_username", [a, "sender"]);
    await call("claim_username", [b, "recipient"]);
    await q(
      "update users set username_changed_at=now()-interval '8 days' where id in ($1,$2)",
      [a, b],
    );
    const token = "a".repeat(64);
    const id = await call("begin_transfer", [a, b, token]);
    await expect(call("confirm_transfer", [id, b, token])).rejects.toThrow(
      "CONFIRMATION_REQUIRED",
    );
    expect(await call("confirm_transfer", [id, a, token])).toBe("PENDING");
    expect(await call("confirm_transfer", [id, b, token])).toBe("COMPLETED");
    expect(
      (await q("select owner_id from usernames where canonical='sender'"))[0]
        ?.owner_id,
    ).toBe(b);
    expect(
      (await q("select status from usernames where canonical='recipient'"))[0]
        ?.status,
    ).toBe("AVAILABLE");
    await expect(call("confirm_transfer", [id, b, token])).rejects.toThrow(
      "TRANSFER_USED",
    );
    await expect(
      q("delete from username_history where canonical='sender'"),
    ).rejects.toThrow("IMMUTABLE_RECORD");
  });
  it("rejects expired transfer, wrong token, and nonparticipant", async () => {
    const a = await account(),
      b = await account(),
      other = await account();
    await call("claim_username", [a, "expiring"]);
    await q(
      "update users set username_changed_at=now()-interval '8 days' where id=$1",
      [a],
    );
    const token = "b".repeat(64);
    const id = await call("begin_transfer", [a, b, token]);
    await expect(
      call("confirm_transfer", [id, a, "c".repeat(64)]),
    ).rejects.toThrow("INVALID_TRANSFER");
    await expect(call("confirm_transfer", [id, other, token])).rejects.toThrow(
      "NOT_PARTICIPANT",
    );
    await q(
      "update username_transfers set expires_at=now()-interval '1 second' where id=$1",
      [id],
    );
    await expect(call("confirm_transfer", [id, a, token])).rejects.toThrow(
      "TRANSFER_EXPIRED",
    );
  });
  it("enforces cooldown", async () => {
    const a = await account(),
      b = await account();
    await call("claim_username", [a, "cooldown"]);
    await expect(
      call("begin_transfer", [a, b, "d".repeat(64)]),
    ).rejects.toThrow("COOLDOWN");
  });
  it("atomically limits requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call("consume_limit", ["actor", "message", 3, 86400]),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
  it("denies browser-role table access and RPC execution", async () => {
    expect(
      (
        await q(
          "select has_table_privilege('authenticated','public.users','select') as allowed",
        )
      )[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await q(
          "select has_function_privilege('anon','public.claim_username(uuid,text)','execute') as allowed",
        )
      )[0]?.allowed,
    ).toBe(false);
  });
});
