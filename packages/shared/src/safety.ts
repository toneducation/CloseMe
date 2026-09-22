import { z } from "zod";
import { SignJWT, importPKCS8 } from "jose";
export type PhotoSafetyResult = "SAFE" | "UNSAFE" | "ERROR";
export interface PhotoSafetyProvider {
  check(image: Uint8Array): Promise<PhotoSafetyResult>;
}
const likelihood = z.enum([
  "VERY_UNLIKELY",
  "UNLIKELY",
  "POSSIBLE",
  "LIKELY",
  "VERY_LIKELY",
]);
const responseSchema = z.object({
  responses: z
    .array(
      z.object({
        safeSearchAnnotation: z.object({
          adult: likelihood,
          racy: likelihood,
          violence: likelihood,
        }),
        error: z.unknown().optional(),
      }),
    )
    .length(1),
});
export function normalizeSafeSearch(response: unknown): PhotoSafetyResult {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) return "ERROR";
  const r = parsed.data.responses[0]!;
  if (r.error) return "ERROR";
  return Object.values(r.safeSearchAnnotation).some(
    (x) => x === "LIKELY" || x === "VERY_LIKELY",
  )
    ? "UNSAFE"
    : "SAFE";
}
export const credentialSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(100),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/),
});
export class GoogleSafeSearchProvider implements PhotoSafetyProvider {
  constructor(
    private credentials: string,
    private request: typeof fetch = fetch,
  ) {}
  async check(image: Uint8Array): Promise<PhotoSafetyResult> {
    try {
      if (image.byteLength > 5 * 1024 * 1024 || image.byteLength < 4)
        return "ERROR";
      const c = credentialSchema.parse(JSON.parse(this.credentials));
      const key = await importPKCS8(c.private_key, "RS256");
      const assertion = await new SignJWT({
        scope: "https://www.googleapis.com/auth/cloud-vision",
      })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(c.client_email)
        .setAudience("https://oauth2.googleapis.com/token")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
      const tokenResponse = await this.request(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!tokenResponse.ok) return "ERROR";
      const token = z
        .object({ access_token: z.string().min(10) })
        .parse(await tokenResponse.json());
      let binary = "";
      for (let i = 0; i < image.length; i += 8192)
        binary += String.fromCharCode(...image.subarray(i, i + 8192));
      // Exactly one feature and one image, no auto-retry or paid overflow provider.
      const response = await this.request(
        "https://vision.googleapis.com/v1/images:annotate",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": c.project_id,
          },
          body: JSON.stringify({
            requests: [
              {
                image: { content: btoa(binary) },
                features: [{ type: "SAFE_SEARCH_DETECTION", maxResults: 1 }],
              },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      return response.ok ? normalizeSafeSearch(await response.json()) : "ERROR";
    } catch {
      return "ERROR";
    }
  }
}
export async function boundedBody(
  request: Request | Response,
  max: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new Error("BODY_LIMIT");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new Error("BODY_LIMIT");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
