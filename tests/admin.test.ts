import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  access: true,
  aal: "aal2",
  active: true,
  role: "OWNER",
  session: true,
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    if (!state.access || token !== "access-token") throw new Error("DENIED");
    return { payload: {} };
  }),
}));
const id = "123e4567-e89b-42d3-a456-426614174000";
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string) => ({
      data: name === "consume_limit" ? true : { ok: true },
      error: null,
    }),
    auth: {
      getClaims: async () => ({
        data: state.session
          ? {
              claims: {
                sub: "123e4567-e89b-42d3-a456-426614174000",
                aal: state.aal,
              },
            }
          : null,
        error: state.session ? null : "bad",
      }),
      getUser: async () => ({
        data: { user: { id: "123e4567-e89b-42d3-a456-426614174000" } },
        error: null,
      }),
    },
    from: () => {
      const q = {
        select: () => q,
        update: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: {
            id: "123e4567-e89b-42d3-a456-426614174000",
            role: state.role,
            active: state.active,
          },
          error: null,
        }),
      };
      return q;
    },
  }),
}));
import { admin, allowed, authorize } from "../apps/admin/worker/index";
const env = {
  ACCESS_TEAM_DOMAIN: "closeme.cloudflareaccess.com",
  ACCESS_AUD: "expected",
  ADMIN_ORIGIN: "https://closeme-admin.example",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test-public",
  SUPABASE_SECRET_KEY: "test-server",
};
function request(
  path = "/api/me",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return admin.request(
    path,
    {
      method: body ? "POST" : "GET",
      headers: {
        "Cf-Access-Jwt-Assertion": "access-token",
        Authorization: "Bearer user-token",
        Origin: env.ADMIN_ORIGIN,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    env,
  );
}
beforeEach(() =>
  Object.assign(state, {
    access: true,
    aal: "aal2",
    active: true,
    role: "OWNER",
    session: true,
  }),
);
describe("private admin boundary", () => {
  it("requires Access even for config", async () => {
    state.access = false;
    expect((await request("/api/config")).status).toBe(403);
  });
  it("denies missing session", async () =>
    expect(
      (await request("/api/me", undefined, { Authorization: "" })).status,
    ).toBe(401));
  it("denies revoked session", async () => {
    state.session = false;
    expect((await request()).status).toBe(403);
  });
  it("denies AAL1", async () => {
    state.aal = "aal1";
    expect((await request()).status).toBe(403);
  });
  it("denies disabled staff", async () => {
    state.active = false;
    expect((await request()).status).toBe(403);
  });
  it("accepts verified AAL2 active staff", async () => {
    const r = await request();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id, role: "OWNER" });
    expect(r.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("denies SUPPORT premium assignment", async () => {
    state.role = "SUPPORT";
    expect(
      (
        await request("/api/action", {
          action: "GIFT_USERNAME",
          target: "x",
          reason: "Support cannot assign",
          data: { recipient: id },
        })
      ).status,
    ).toBe(403);
  });
  it("denies MODERATOR staff management", async () => {
    state.role = "MODERATOR";
    expect(
      (
        await request("/api/action", {
          action: "CHANGE_STAFF_ROLE",
          target: id,
          reason: "Unauthorized escalation",
          data: { role: "SUPER_ADMIN" },
        })
      ).status,
    ).toBe(403);
  });
  it("rejects cross-origin changes", async () =>
    expect(
      (await request("/api/action", {}, { Origin: "https://attacker.example" }))
        .status,
    ).toBe(403));
  it("rejects oversized bodies", async () =>
    expect(
      (
        await request("/api/action", {
          action: "WARN_USER",
          target: id,
          reason: "x".repeat(17000),
        })
      ).status,
    ).not.toBe(200));
  it("requires a reason and valid action", async () =>
    expect(
      (
        await request("/api/action", {
          action: "READ_ALL_MESSAGES",
          target: id,
          reason: "why",
        })
      ).status,
    ).toBe(400));
  it("binds claims to the actual user and staff record", () => {
    expect(() =>
      authorize({ sub: id, aal: "aal2" }, "other", {
        id,
        role: "OWNER",
        active: true,
      }),
    ).toThrow();
    expect(allowed("SUPPORT", "VIEW_REPORTED_CONVERSATION")).toBe(false);
  });
});
