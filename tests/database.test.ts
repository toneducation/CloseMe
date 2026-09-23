import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { app, type Env } from "../apps/bot/src/index";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
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
  for (const file of [
    "0002_relationships.sql",
    "0003_administration.sql",
    "0005_optional_profile_photo.sql",
  ]) {
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
    await q("update usage_quotas set used=0");
  });
});

// Exercise the real Hono → grammY → Supabase client → PostgreSQL path.
// Only network boundaries are simulated; application handlers and RPCs are real.
async function botSession(telegram: number) {
  const replies: Record<string, unknown>[] = [];
  const pending: Promise<unknown>[] = [];
  const env: Env = {
    TELEGRAM_BOT_TOKEN: "123456:test-only-token",
    TELEGRAM_BOT_ID: "123456",
    TELEGRAM_BOT_USERNAME: "closeme_test_bot",
    TELEGRAM_WEBHOOK_SECRET: "w".repeat(64),
    PHONE_HMAC_SECRET: "h".repeat(64),
    SUPABASE_URL: "https://database.test",
    SUPABASE_SECRET_KEY: "test-only-key",
    GOOGLE_SERVICE_ACCOUNT_JSON: "",
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.hostname === "api.telegram.org") {
        if (url.pathname.endsWith("/sendMessage")) replies.push(body);
        return Response.json({
          ok: true,
          result: {
            message_id: 1,
            date: 1,
            chat: { id: telegram, type: "private" },
            ...body,
          },
        });
      }
      if (url.hostname !== "database.test")
        throw new Error("Unexpected network request");
      try {
        if (url.pathname.startsWith("/rest/v1/rpc/")) {
          const name = url.pathname.split("/").at(-1)!;
          if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid test RPC");
          const args = Object.keys(body);
          if (args.some((key) => !/^p_[a-z_]+$/.test(key)))
            throw new Error("Invalid argument");
          const values = Object.values(body).map((v) =>
            v && typeof v === "object" && !Array.isArray(v)
              ? JSON.stringify(v)
              : v,
          );
          const rows = await q(
            `select ${name}(${args.map((key, i) => `${key} := $${i + 1}`).join(",")}) as value`,
            values,
          );
          return Response.json(rows[0]?.value ?? null);
        }
        const table = url.pathname.split("/").at(-1)!;
        if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid test table");
        const params: unknown[] = [];
        const bind = (v: unknown) => {
          params.push(v && typeof v === "object" ? JSON.stringify(v) : v);
          return `$${params.length}`;
        };
        const sets = Object.entries(body).map(
          ([key, v]) => `${key}=${bind(v)}`,
        );
        const filters: string[] = [];
        for (const [key, value] of url.searchParams) {
          if (["select", "order", "limit"].includes(key)) continue;
          if (!/^[a-z_]+$/.test(key) || !value.startsWith("eq."))
            throw new Error("Unsupported test filter");
          filters.push(`${key}=${bind(value.slice(3))}`);
        }
        const where = filters.length ? ` where ${filters.join(" and ")}` : "";
        const rows =
          init?.method === "PATCH"
            ? await q(
                `update ${table} set ${sets.join(",")}${where} returning *`,
                params,
              )
            : await q(`select * from ${table}${where}`, params);
        const single = new Headers(init?.headers)
          .get("accept")
          ?.includes("object+json");
        return Response.json(single ? (rows[0] ?? null) : rows);
      } catch (error) {
        return Response.json(
          {
            message: error instanceof Error ? error.message : "DB",
            code: "TEST_DB",
          },
          { status: 400 },
        );
      }
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  let updateId = telegram;
  async function send(
    value: string | Record<string, unknown>,
    callback = false,
  ) {
    const from = {
      id: telegram,
      is_bot: false,
      first_name: "Test",
      language_code: "en",
    };
    const message = {
      message_id: ++updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: telegram, type: "private" },
      from,
    };
    const update = callback
      ? {
          update_id: updateId,
          callback_query: {
            id: String(updateId),
            from,
            chat_instance: "test",
            message,
            data: value,
          },
        }
      : {
          update_id: updateId,
          message: {
            ...message,
            ...(typeof value === "string" ? { text: value } : value),
          },
        };
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: JSON.stringify(update),
      },
      env,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending.splice(0));
    expect(response.status).toBe(200);
    return replies.at(-1);
  }
  return { send, replies, close: () => vi.unstubAllGlobals() };
}

describe("Telegram webhook registration regression", () => {
  it("completes /start through profile without a photo and rejects invalid usernames and other contacts", async () => {
    const tg = 800010000;
    const bot = await botSession(tg);
    try {
      expect((await bot.send("/start"))?.text).toContain("English");
      await bot.send("lang:en", true);
      const { t } = await import("../packages/shared/src/i18n");
      await bot.send(t("en", "adult"));
      await bot.send("2000-01-01");
      await bot.send({
        contact: {
          user_id: tg + 1,
          phone_number: "+998901111111",
          first_name: "Other",
        },
      });
      expect(
        (await q("select state from users where telegram_id=$1", [tg]))[0]
          ?.state,
      ).toBe("CONTACT");
      await bot.send({
        contact: {
          user_id: tg,
          phone_number: "+998901111112",
          first_name: "Test",
        },
      });
      for (const name of [
        "a",
        "ADMIN",
        "bad_name",
        "bad-name",
        "a".repeat(26),
      ]) {
        await bot.send(name);
        expect(
          (await q("select state from users where telegram_id=$1", [tg]))[0]
            ?.state,
        ).toBe("USERNAME");
      }
      await bot.send("FlowAziz");
      await bot.send("Aziz");
      await bot.send("choose:man", true);
      await bot.send("choose:woman", true);
      await bot.send("Tashkent");
      await bot.send("Architecture and books");
      for (const interest of [
        "travel",
        "music",
        "movies",
        "coffee",
        "architecture",
      ])
        await bot.send(`interest:${interest}`, true);
      await bot.send("interests:done", true);
      expect((await bot.send("intent:0", true))?.text).toContain(
        "profile is ready",
      );
      const u = (
        await q("select id,state from users where telegram_id=$1", [tg])
      )[0]!;
      expect(u.state).toBe("READY");
      expect(
        (
          await q("select canonical from usernames where owner_id=$1", [u.id])
        )[0]?.canonical,
      ).toBe("flowaziz");
      expect(
        await q("select id from photos where user_id=$1", [u.id]),
      ).toHaveLength(0);
      expect(await call("visible_user", [u.id])).toBe(true);
      expect((await bot.send("/start"))?.reply_markup).toBeDefined();
      await bot.send("m:profile", true);
      expect(bot.replies.at(-1)?.text).toContain("@flowaziz");
      const viewer = await ready();
      const card = (await call("discover", [viewer.id, false, "flowaziz"])) as {
        photo: unknown;
      };
      expect(card.photo).toBe(null);
      const pending = await call("photo_begin", [u.id, null, "pending"]);
      expect(
        ((await call("card", [viewer.id, u.id])) as { photo: unknown }).photo,
      ).toBe(null);
      await call("photo_finish", [u.id, pending, "UNSAFE", null]);
      expect(
        ((await call("card", [viewer.id, u.id])) as { photo: unknown }).photo,
      ).toBe(null);
    } finally {
      bot.close();
    }
  });
  it("denies an underage DOB in the real message handler", async () => {
    const bot = await botSession(800020000);
    try {
      await bot.send("/start");
      await bot.send("lang:en", true);
      const { t } = await import("../packages/shared/src/i18n");
      await bot.send(t("en", "adult"));
      await bot.send("2020-01-01");
      await bot.send("/start");
      expect(
        (await q("select state from users where telegram_id=800020000"))[0]
          ?.state,
      ).toBe("DENIED");
    } finally {
      bot.close();
    }
  });
  it("allows removal of the last photo without undoing registration", async () => {
    const u = await ready();
    await call("photo_edit", [u.id, u.ph, "delete"]);
    expect(
      (await q("select state from users where id=$1", [u.id]))[0]?.state,
    ).toBe("READY");
    expect(
      ((await call("card", [u.id, u.id])) as { photo: unknown }).photo,
    ).toBe(null);
  });
});
