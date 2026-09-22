import { it, expect } from "vitest";
import {
  normalizeSafeSearch,
  GoogleSafeSearchProvider,
  boundedBody,
} from "../packages/shared/src/safety";
const result = (a = "VERY_UNLIKELY", r = "UNLIKELY", v = "POSSIBLE") => ({
  responses: [{ safeSearchAnnotation: { adult: a, racy: r, violence: v } }],
});
it("approves safe categories", () =>
  expect(normalizeSafeSearch(result())).toBe("SAFE"));
it.each(["LIKELY", "VERY_LIKELY"])(
  "rejects adult, racy or violence %s",
  (v) => {
    expect(normalizeSafeSearch(result(v))).toBe("UNSAFE");
    expect(normalizeSafeSearch(result("UNLIKELY", v))).toBe("UNSAFE");
    expect(normalizeSafeSearch(result("UNLIKELY", "UNLIKELY", v))).toBe(
      "UNSAFE",
    );
  },
);
it.each([{}, null, { responses: [] }, result("UNKNOWN"), result("nonsense")])(
  "fails closed on malformed/unknown %j",
  (v) => expect(normalizeSafeSearch(v)).toBe("ERROR"),
);
it("fails closed with unusable credentials", async () =>
  expect(
    await new GoogleSafeSearchProvider("{}").check(new Uint8Array(5)),
  ).toBe("ERROR"));
it("bounds streaming bodies even without Content-Length", async () =>
  await expect(boundedBody(new Response("123456"), 3)).rejects.toThrow(
    "BODY_LIMIT",
  ));
