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
  for (const file of ["0002_relationships.sql", "0003_administration.sql"]) {
    await exec(
      readFileSync(
        new URL("../packages/database/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  }
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
async function ready() {
  const id = await account();
  await call("claim_username", [id, "u" + id.replaceAll("-", "").slice(0, 20)]);
  await call("save_profile", [
    id,
    JSON.stringify({
      display_name: "Test",
      gender: "woman",
      interested_in: ["woman"],
      city: "Tashkent",
      intent: "serious_relationship",
      bio: "Hello",
    }),
    ["travel", "music", "movies", "coffee", "architecture"],
  ]);
  const ph = await call("photo_begin", [id, null, randomUUID()]);
  await call("reserve_photo_quota", [ph, 950]);
  await call("photo_finish", [id, ph, "SAFE", `${id}/${ph}.jpg`]);
  return { id, ph };
}
describe("relationship safety transactions", () => {
  it("keeps unapproved profiles out of discovery", async () => {
    const a = await ready();
    const b = await account();
    await call("claim_username", [b, "hiddenpending"]);
    expect(await call("discover", [a.id, false, "hiddenpending"])).toBe(null);
  });
  it("keeps old primary on rejection and atomically replaces on approval", async () => {
    const a = await ready();
    const bad = await call("photo_begin", [a.id, a.ph, "bad"]);
    await call("reserve_photo_quota", [bad, 950]);
    await call("photo_finish", [a.id, bad, "UNSAFE", null]);
    expect(
      (
        await q("select id from photos where user_id=$1 and primary_photo", [
          a.id,
        ])
      )[0]?.id,
    ).toBe(a.ph);
    const good = await call("photo_begin", [a.id, a.ph, "good"]);
    await call("reserve_photo_quota", [good, 950]);
    expect(
      await call("photo_finish", [a.id, good, "SAFE", `${a.id}/${good}.jpg`]),
    ).toBe(true);
    expect(
      (
        await q("select id from photos where user_id=$1 and primary_photo", [
          a.id,
        ])
      )[0]?.id,
    ).toBe(good);
  });
  it("creates exactly one mutual match under duplicate and concurrent likes", async () => {
    const a = await ready(),
      b = await ready();
    await Promise.all([
      call("social_action", [a.id, "like", b.id, "", "a", "{}"]),
      call("social_action", [b.id, "like", a.id, "", "b", "{}"]),
      call("social_action", [a.id, "like", b.id, "", "c", "{}"]),
    ]);
    expect(
      (
        await q(
          "select count(*)::int n from matches where user_a=least($1::uuid,$2::uuid) and user_b=greatest($1::uuid,$2::uuid)",
          [a.id, b.id],
        )
      )[0]?.n,
    ).toBe(1);
  });
  it("requires request acceptance and prevents duplicate requests", async () => {
    const a = await ready(),
      b = await ready();
    await expect(
      call("social_action", [a.id, "message", b.id, "Hi", "m1", "{}"]),
    ).rejects.toThrow("REQUEST_REQUIRED");
    const r = (await call("social_action", [
      a.id,
      "request",
      b.id,
      "Hi",
      "req",
      "{}",
    ])) as { id: string };
    await expect(
      call("social_action", [a.id, "request", b.id, "Again", "req2", "{}"]),
    ).rejects.toThrow("REQUEST_EXISTS");
    await call("social_action", [
      b.id,
      "accept",
      a.id,
      "",
      "accept",
      JSON.stringify({ id: r.id }),
    ]);
    await call("social_action", [a.id, "message", b.id, "Hello", "m2", "{}"]);
    await call("social_action", [a.id, "message", b.id, "Hello", "m2", "{}"]);
    expect(
      (
        await q(
          "select count(*)::int n from messages where sender=$1 and body='Hello'",
          [a.id],
        )
      )[0]?.n,
    ).toBe(1);
  });
  it("blocks messages, requests, cards and username search server-side", async () => {
    const a = await ready(),
      b = await ready();
    await call("social_action", [a.id, "block", b.id, "", "block", "{}"]);
    await expect(
      call("social_action", [b.id, "message", a.id, "Hi", "blockedm", "{}"]),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      call("social_action", [b.id, "request", a.id, "Hi", "blockedr", "{}"]),
    ).rejects.toThrow("NOT_FOUND");
    expect(await call("card", [b.id, a.id])).toBe(null);
    const name = (
      await q("select canonical from usernames where owner_id=$1", [a.id])
    )[0]?.canonical;
    expect(await call("discover", [b.id, false, name])).toBe(null);
  });
  it("serializes block against sending; nothing can be sent after block commits", async () => {
    const a = await ready(),
      b = await ready();
    await call("social_action", [a.id, "like", b.id, "", "l", "{}"]);
    await call("social_action", [b.id, "like", a.id, "", "l", "{}"]);
    await Promise.allSettled([
      call("social_action", [a.id, "block", b.id, "", "bl", "{}"]),
      call("social_action", [b.id, "message", a.id, "Race", "race", "{}"]),
    ]);
    await expect(
      call("social_action", [b.id, "message", a.id, "After", "after", "{}"]),
    ).rejects.toThrow("NOT_FOUND");
    expect(
      (
        await q(
          "select count(*)::int n from notifications where recipient=$1 and actor=$2 and state='PENDING'",
          [a.id, b.id],
        )
      )[0]?.n,
    ).toBe(0);
  });
  it("limits first message requests", async () => {
    const a = await ready();
    for (let n = 0; n < 5; n++) {
      const b = await ready();
      await call("social_action", [
        a.id,
        "request",
        b.id,
        "Hi",
        String(n),
        "{}",
      ]);
    }
    const b = await ready();
    await expect(
      call("social_action", [a.id, "request", b.id, "Hi", "six", "{}"]),
    ).rejects.toThrow("LIMIT");
  });
  it("creates reports and audits case-bound private content access", async () => {
    const a = await ready(),
      b = await ready();
    await call("social_action", [a.id, "like", b.id, "", "l", "{}"]);
    await call("social_action", [b.id, "like", a.id, "", "l", "{}"]);
    await call("social_action", [
      a.id,
      "message",
      b.id,
      "Reported text",
      "text",
      "{}",
    ]);
    const r = (await call("social_action", [
      b.id,
      "report",
      a.id,
      "Report details",
      "report",
      JSON.stringify({ category: "harassment" }),
    ])) as { id: string };
    const admin = (await q("select id from admin_users where role='OWNER'"))[0]
      ?.id;
    const result = (await call("admin_action", [
      admin,
      "VIEW_REPORTED_CONVERSATION",
      r.id,
      "Investigating report",
      "{}",
    ])) as unknown[];
    expect(result).toHaveLength(1);
    expect(
      (
        await q(
          "select count(*)::int n from audit_logs where action='VIEW_REPORTED_CONVERSATION' and target=$1",
          [r.id],
        )
      )[0]?.n,
    ).toBe(1);
  });
  it("denies support premium operations and moderator staff changes; protects owner", async () => {
    const support = (
      await q("select id from admin_users where role='SUPPORT'")
    )[0]?.id;
    await expect(
      call("admin_action", [
        support,
        "RESERVE_USERNAME",
        "z",
        "Safety hold",
        "{}",
      ]),
    ).rejects.toThrow("FORBIDDEN");
    const m = randomUUID();
    await q("insert into admin_users(id,role) values($1,'MODERATOR')", [m]);
    await expect(
      call("admin_action", [
        m,
        "DISABLE_STAFF",
        support,
        "Disable access",
        "{}",
      ]),
    ).rejects.toThrow("FORBIDDEN");
    const owner = (await q("select id from admin_users where role='OWNER'"))[0]
      ?.id;
    await expect(
      call("admin_action", [
        owner,
        "DISABLE_STAFF",
        owner,
        "Disable owner",
        "{}",
      ]),
    ).rejects.toThrow("OWNER_PROTECTED");
  });
  it("allows only one concurrent premium gift winner", async () => {
    const a = await account(),
      b = await account();
    const owner = (await q("select id from admin_users where role='OWNER'"))[0]
      ?.id;
    const results = await Promise.allSettled([
      call("admin_action", [
        owner,
        "GIFT_USERNAME",
        "z",
        "First gift",
        JSON.stringify({ recipient: a }),
      ]),
      call("admin_action", [
        owner,
        "GIFT_USERNAME",
        "z",
        "Second gift",
        JSON.stringify({ recipient: b }),
      ]),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("claims each update exclusively and marks completion", async () => {
    const a = randomUUID(),
      b = randomUUID();
    const result = await Promise.all([
      call("claim_update", [100, a]),
      call("claim_update", [100, b]),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    await call("finish_update", [100, result[0] ? a : b, true]);
    expect(await call("claim_update", [100, randomUUID()])).toBe(false);
  });
  it("keeps existing users available when registrations are paused", async () => {
    const u = await account();
    const telegram = (
      await q("select telegram_id from users where id=$1", [u])
    )[0]?.telegram_id;
    await q("update settings set value='false' where key='registrations'");
    expect(await call("onboard", [telegram, "en"])).toBeTruthy();
    await expect(
      call("onboard", [Math.floor(Math.random() * 1e12), "en"]),
    ).rejects.toThrow("PAUSED");
    await q("update settings set value='true' where key='registrations'");
  });
  it("self pause cannot override admin profile hiding", async () => {
    const a = await ready(),
      b = await ready();
    await q(
      "update profiles set hidden=true,user_paused=true where user_id=$1",
      [b.id],
    );
    await q("update profiles set user_paused=false where user_id=$1", [b.id]);
    expect(await call("card", [a.id, b.id])).toBeNull();
  });
  it("all premium administration controls preserve unique ownership", async () => {
    const owner = (await q("select id from admin_users where role='OWNER'"))[0]
      ?.id;
    const a = await account(),
      b = await account();
    await call("admin_action", [
      owner,
      "RESERVE_USERNAME",
      "q",
      "Reserve rare handle",
      "{}",
    ]);
    await expect(
      call("admin_action", [
        owner,
        "GIFT_USERNAME",
        "q",
        "Reserved gift attempt",
        JSON.stringify({ recipient: a }),
      ]),
    ).rejects.toThrow("NOT_AVAILABLE");
    await call("admin_action", [
      owner,
      "RELEASE_USERNAME",
      "q",
      "Release reservation",
      "{}",
    ]);
    await call("admin_action", [
      owner,
      "GIFT_USERNAME",
      "q",
      "Gift rare handle",
      JSON.stringify({ recipient: a }),
    ]);
    expect(
      (await q("select state from users where id=$1", [a]))[0]?.state,
    ).toBe("PROFILE");
    await call("admin_action", [
      owner,
      "FREEZE_USERNAME",
      "q",
      "Safety freeze",
      "{}",
    ]);
    expect(await call("username_status", ["q"])).toBe("FROZEN");
    await call("admin_action", [
      owner,
      "REASSIGN_USERNAME",
      "q",
      "Reviewed reassignment",
      JSON.stringify({ recipient: b }),
    ]);
    expect(
      (await q("select owner_id from usernames where canonical='q'"))[0]
        ?.owner_id,
    ).toBe(b);
    expect(
      (await q("select state from users where id=$1", [a]))[0]?.state,
    ).toBe("USERNAME");
  });
  it("enforces monthly 950 cap with simultaneous reservations and no replay", async () => {
    const ids: unknown[] = [];
    for (let n = 0; n < 6; n++) {
      const u = await account();
      ids.push(await call("photo_begin", [u, null, randomUUID()]));
    }
    await q(
      "update usage_quotas set used=948 where month=date_trunc('month',timezone('UTC',now()))::date",
    );
    const results = await Promise.all(
      ids.map((id) => call("reserve_photo_quota", [id, 950])),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect((await q("select used from usage_quotas"))[0]?.used).toBe(950);
    expect(await call("reserve_photo_quota", [ids[0], 950])).toBe(false);
  });
});
