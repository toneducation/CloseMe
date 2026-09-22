import { describe, it, expect } from "vitest";
import {
  canonicalUsername,
  isAdult,
  ownContact,
  phoneHmac,
  ManualModerationProvider,
  canManageUsernames,
} from "../packages/shared/src/index";
import { dictionaries } from "../packages/shared/src/i18n";
import { app, validSecret } from "../apps/bot/src/index";
describe("identity boundary", () => {
  it("canonicalizes case and optional @", () => {
    expect(canonicalUsername("@AzIz")).toBe("aziz");
  });
  it.each(["a_b", "a.b", "a-b", "hello world", "😀", "a".repeat(26), ""])(
    "rejects invalid username %s",
    (v) => expect(() => canonicalUsername(v)).toThrow(),
  );
  it("rejects under 18 on the day before birthday", () => {
    expect(isAdult("2008-09-23", new Date("2026-09-22"))).toBe(false);
    expect(isAdult("2008-09-22", new Date("2026-09-22"))).toBe(true);
  });
  it("rejects invalid calendar dates", () =>
    expect(() => isAdult("2000-02-31")).toThrow());
  it("rejects someone else’s contact and missing contact owner", () => {
    expect(ownContact(123, { user_id: 456 })).toBe(false);
    expect(ownContact(123, {})).toBe(false);
    expect(ownContact(123, { user_id: 123 })).toBe(true);
  });
  it("uses normalized keyed HMAC without retaining number", async () => {
    const a = await phoneHmac("+998 90 123-45-67", "s".repeat(32));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(await phoneHmac("998901234567", "s".repeat(32)));
    expect(a).not.toBe(await phoneHmac("998901234567", "t".repeat(32)));
  });
  it("keeps all language keys in sync", () => {
    expect(Object.keys(dictionaries.uz).sort()).toEqual(
      Object.keys(dictionaries.en).sort(),
    );
    expect(Object.keys(dictionaries.ru).sort()).toEqual(
      Object.keys(dictionaries.en).sort(),
    );
  });
  it("does not auto-approve unreviewed images", async () =>
    expect((await new ManualModerationProvider().moderate()).status).toBe(
      "NEEDS_REVIEW",
    ));
  it("denies premium management to support and moderators", () => {
    expect(canManageUsernames("SUPPORT")).toBe(false);
    expect(canManageUsernames("MODERATOR")).toBe(false);
    expect(canManageUsernames("OWNER")).toBe(true);
  });
  it("requires a strong exact webhook secret", () => {
    expect(validSecret(undefined, "x".repeat(32))).toBe(false);
    expect(validSecret("a", "a")).toBe(false);
    expect(validSecret("y".repeat(32), "x".repeat(32))).toBe(false);
    expect(validSecret("x".repeat(32), "x".repeat(32))).toBe(true);
  });
  it("rejects unauthorized webhook before accessing database", async () => {
    const r = await app.request(
      "/telegram/webhook",
      { method: "POST", body: "{}" },
      { TELEGRAM_WEBHOOK_SECRET: "x".repeat(32) },
    );
    expect(r.status).toBe(401);
  });
});
