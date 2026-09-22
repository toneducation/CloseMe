import { Hono } from "hono";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { roles, type Role } from "../../../packages/shared/src/index";
import { boundedBody, sha256 } from "../../../packages/shared/src/safety";
interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_ORIGIN: string;
}
type Staff = { id: string; role: Role };
type Variables = { db: SupabaseClient; staff: Staff };
const actions = [
  "WARN_USER",
  "SUSPEND_USER",
  "UNSUSPEND_USER",
  "BAN_USER",
  "UNBAN_USER",
  "HIDE_PROFILE",
  "RESTORE_PROFILE",
  "DISABLE_MESSAGING",
  "ENABLE_MESSAGING",
  "REQUIRE_REVIEW",
  "GIFT_USERNAME",
  "TRANSFER_USERNAME",
  "REASSIGN_USERNAME",
  "RESERVE_USERNAME",
  "FREEZE_USERNAME",
  "RELEASE_USERNAME",
  "REVIEW_REPORT",
  "VIEW_REPORTED_CONVERSATION",
  "HIDE_PHOTO",
  "RESTORE_PHOTO",
  "CHANGE_STAFF_ROLE",
  "DISABLE_STAFF",
  "ENABLE_STAFF",
  "SECURITY_SETTING_CHANGE",
] as const;
export function authorize(
  claims: { sub?: string; aal?: unknown },
  userId: string,
  staff: { id: string; role: string; active: boolean } | null,
): Staff {
  if (
    claims.sub !== userId ||
    claims.aal !== "aal2" ||
    !staff?.active ||
    staff.id !== userId ||
    !roles.includes(staff.role as Role)
  )
    throw new Error("FORBIDDEN");
  return { id: userId, role: staff.role as Role };
}
export function allowed(role: Role, action: string) {
  if (
    [
      "CHANGE_STAFF_ROLE",
      "DISABLE_STAFF",
      "ENABLE_STAFF",
      "SECURITY_SETTING_CHANGE",
    ].includes(action)
  )
    return role === "OWNER";
  if (
    action.includes("USERNAME") ||
    ["BAN_USER", "UNBAN_USER"].includes(action)
  )
    return role === "OWNER" || role === "SUPER_ADMIN";
  return role !== "SUPPORT" || action === "WARN_USER";
}
export const admin = new Hono<{ Bindings: Env; Variables: Variables }>();
admin.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Strict-Transport-Security", "max-age=31536000");
  const origin = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(
    c.env.SUPABASE_URL ?? "",
  )
    ? c.env.SUPABASE_URL
    : "";
  c.header(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  );
});
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
admin.use("*", async (c, next) => {
  try {
    const domain = z
      .string()
      .regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/)
      .parse(c.env.ACCESS_TEAM_DOMAIN);
    const issuer = `https://${domain}`;
    let keys = keysets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keysets.set(issuer, keys);
    }
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token || !c.env.ACCESS_AUD) throw new Error("AUTH");
    await jwtVerify(token, keys, {
      issuer,
      audience: c.env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
  } catch {
    return c.json({ error: "Cloudflare Access required" }, 403);
  }
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    c.req.header("Origin") !== c.env.ADMIN_ORIGIN
  )
    return c.json({ error: "Origin denied" }, 403);
  c.set(
    "db",
    createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
  const { data, error } = await c.get("db").rpc("consume_limit", {
    p_actor: await sha256(c.req.header("CF-Connecting-IP") ?? "unknown"),
    p_action: "admin_api",
    p_limit: 120,
    p_seconds: 60,
  });
  if (error || !data) return c.json({ error: "Try later" }, 429);
  await next();
});
admin.get("/api/config", (c) =>
  c.json({ url: c.env.SUPABASE_URL, key: c.env.SUPABASE_PUBLISHABLE_KEY }),
);
admin.use("/api/*", async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return c.json({ error: "Authentication required" }, 401);
  const db = c.get("db");
  try {
    const [{ data: verified, error: e }, { data: identity, error: e2 }] =
      await Promise.all([db.auth.getClaims(token), db.auth.getUser(token)]);
    if (e || e2 || !verified || !identity.user) throw new Error("AUTH");
    const { data, error } = await db
      .from("admin_users")
      .select("id,role,active")
      .eq("id", identity.user.id)
      .maybeSingle();
    if (error) throw new Error("DB");
    c.set("staff", authorize(verified.claims, identity.user.id, data));
    await db
      .from("admin_users")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", identity.user.id);
  } catch {
    return c.json({ error: "Active staff with TOTP MFA required" }, 403);
  }
  await next();
});
async function result(q: PromiseLike<{ data: unknown; error: unknown }>) {
  const r = await q;
  if (r.error) throw new Error("REQUEST_FAILED");
  return r.data;
}
admin.get("/api/me", (c) => c.json(c.get("staff")));
admin.get("/api/metrics", async (c) =>
  c.json(
    await result(
      c.get("db").rpc("admin_metrics", { p_admin: c.get("staff").id }),
    ),
  ),
);
admin.get("/api/users", async (c) => {
  const query = z
    .string()
    .max(80)
    .parse(c.req.query("q") ?? "");
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .parse(c.req.query("offset") ?? 0);
  return c.json(
    await result(
      c.get("db").rpc("admin_users_search", {
        p_admin: c.get("staff").id,
        p_query: query,
        p_offset: offset,
      }),
    ),
  );
});
admin.get("/api/users/:id", async (c) => {
  const id = z.uuid().parse(c.req.param("id")),
    db = c.get("db");
  const items = await Promise.all([
    result(
      db.rpc("admin_users_search", { p_admin: c.get("staff").id, p_query: id }),
    ),
    result(
      db
        .from("profiles")
        .select(
          "display_name,gender,interested_in,city,intent,bio,hidden,completed",
        )
        .eq("user_id", id)
        .maybeSingle(),
    ),
    result(
      db
        .from("photos")
        .select("id,status,primary_photo,created_at")
        .eq("user_id", id)
        .in("status", ["APPROVED", "HIDDEN"]),
    ),
    result(
      db
        .from("username_history")
        .select("*")
        .or(`from_user.eq.${id},to_user.eq.${id}`)
        .order("created_at", { ascending: false })
        .limit(50),
    ),
    result(
      db
        .from("reports")
        .select("id,category,state,priority,created_at")
        .eq("subject", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ),
    result(
      db
        .from("moderation_actions")
        .select("action,reason,created_at,admin_id")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ),
    result(
      db.from("profile_interests").select("interest_id").eq("user_id", id),
    ),
  ]);
  const counts: Record<string, number> = {};
  for (const [table, filter] of [
    ["matches", `user_a.eq.${id},user_b.eq.${id}`],
    ["blocks", `blocker.eq.${id},blocked.eq.${id}`],
    ["likes", `sender.eq.${id},recipient.eq.${id}`],
  ]) {
    const { count, error } = await db
      .from(table!)
      .select("*", { count: "exact", head: true })
      .or(filter!);
    if (error) throw new Error("DB");
    counts[table!] = count ?? 0;
  }
  return c.json({
    user: items[0],
    profile: items[1],
    photos: items[2],
    history: items[3],
    reports: items[4],
    moderation: items[5],
    interests: items[6],
    counts,
  });
});
admin.get("/api/username", async (c) => {
  const name = z
      .string()
      .regex(/^[a-zA-Z0-9]{1,25}$/)
      .parse(c.req.query("q"))
      .toLowerCase(),
    db = c.get("db");
  const [status, record, history] = await Promise.all([
    result(db.rpc("username_status", { p_name: name })),
    result(
      db
        .from("usernames")
        .select("canonical,owner_id,status,premium,created_at")
        .eq("canonical", name)
        .maybeSingle(),
    ),
    result(
      db
        .from("username_history")
        .select("*")
        .eq("canonical", name)
        .order("created_at", { ascending: false })
        .limit(100),
    ),
  ]);
  return c.json({ name, status, record, history });
});
const lists = {
  premium: [
    "usernames",
    "canonical,status,owner_id,premium,created_at",
    "canonical",
  ],
  profiles: [
    "profiles",
    "user_id,display_name,city,intent,hidden,completed,updated_at",
    "updated_at",
  ],
  reports: [
    "reports",
    "id,reporter,subject,photo_id,conversation_id,category,detail,state,priority,assigned_to,created_at",
    "created_at",
  ],
  transfers: [
    "username_transfers",
    "id,canonical,sender_id,recipient_id,state,sender_confirmed_at,recipient_confirmed_at,created_at,expires_at,completed_at",
    "created_at",
  ],
  matches: ["matches", "id,user_a,user_b,active,created_at", "created_at"],
  staff: [
    "admin_users",
    "id,email,role,active,created_at,last_active_at",
    "created_at",
  ],
  audit: [
    "audit_logs",
    "id,admin_id,action,target,reason,metadata,created_at",
    "created_at",
  ],
  settings: ["settings", "key,value", "key"],
  safety: [
    "reports",
    "id,subject,photo_id,conversation_id,category,detail,state,priority,assigned_to,created_at",
    "created_at",
  ],
  photos: [
    "reports",
    "id,subject,photo_id,category,state,priority,created_at",
    "created_at",
  ],
} as const;
admin.get("/api/list/:section", async (c) => {
  const section = z
    .enum(Object.keys(lists) as [keyof typeof lists, ...(keyof typeof lists)[]])
    .parse(c.req.param("section"));
  if (
    ["staff", "settings"].includes(section) &&
    c.get("staff").role !== "OWNER"
  )
    return c.json({ error: "Forbidden" }, 403);
  const [table, fields, order] = lists[section];
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .parse(c.req.query("offset") ?? 0);
  let q = c
    .get("db")
    .from(table)
    .select(fields)
    .order(order, { ascending: section === "premium" })
    .range(offset, offset + 49);
  if (section === "premium") q = q.eq("premium", true);
  if (section === "photos") q = q.not("photo_id", "is", null);
  if (section === "safety")
    q = q.in("state", ["NEW", "UNDER_REVIEW", "ESCALATED"]);
  return c.json(await result(q));
});
admin.get("/api/photo/:id", async (c) => {
  const id = z.uuid().parse(c.req.param("id"));
  const { data, error } = await c
    .get("db")
    .from("photos")
    .select("storage_path,status")
    .eq("id", id)
    .in("status", ["APPROVED", "HIDDEN"])
    .single();
  if (error || !data.storage_path) return c.json({ error: "Not found" }, 404);
  const { data: photo, error: e } = await c
    .get("db")
    .storage.from("profile-photos")
    .download(data.storage_path);
  if (e || !photo) return c.json({ error: "Not found" }, 404);
  return new Response(await photo.arrayBuffer(), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
});
admin.post("/api/action", async (c) => {
  const input = z
    .object({
      action: z.enum(actions),
      target: z.string().min(1).max(100),
      reason: z.string().trim().min(5).max(1000),
      data: z.record(z.string(), z.unknown()).default({}),
    })
    .strict()
    .parse(
      JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, 16384))),
    );
  if (!allowed(c.get("staff").role, input.action))
    return c.json({ error: "Forbidden" }, 403);
  return c.json(
    await result(
      c.get("db").rpc("admin_action", {
        p_admin: c.get("staff").id,
        p_action: input.action,
        p_target: input.target,
        p_reason: input.reason,
        p_data: input.data,
      }),
    ),
  );
});
// Deliberate owner-only invitation; Supabase Auth handles email delivery and one-time links.
admin.post("/api/invite", async (c) => {
  if (c.get("staff").role !== "OWNER")
    return c.json({ error: "Forbidden" }, 403);
  const x = z
    .object({
      email: z.email(),
      role: z.enum(["SUPER_ADMIN", "MODERATOR", "SUPPORT"]),
      reason: z.string().trim().min(5).max(1000),
    })
    .strict()
    .parse(
      JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, 4096))),
    );
  const db = c.get("db");
  const { data, error } = await db.auth.admin.inviteUserByEmail(x.email, {
    redirectTo: c.env.ADMIN_ORIGIN,
  });
  if (error || !data.user) throw new Error("INVITE_FAILED");
  try {
    await result(
      db.rpc("admin_action", {
        p_admin: c.get("staff").id,
        p_action: "CHANGE_STAFF_ROLE",
        p_target: data.user.id,
        p_reason: x.reason,
        p_data: { role: x.role, email: x.email },
      }),
    );
  } catch {
    await db.auth.admin.deleteUser(data.user.id);
    throw new Error("INVITE_FAILED");
  }
  return c.json({ ok: true });
});
admin.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
admin.onError((e, c) =>
  c.json(
    {
      error:
        e instanceof z.ZodError
          ? "Invalid input"
          : "Request could not be completed",
    },
    e instanceof z.ZodError ? 400 : 409,
  ),
);
export default admin;
