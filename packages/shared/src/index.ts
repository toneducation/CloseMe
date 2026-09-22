import { z } from "zod";
export const usernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,25}$/)
  .transform((v) => v.toLowerCase());
export function canonicalUsername(input: string): string {
  return usernameSchema.parse(input.replace(/^@/, ""));
}
export const languages = ["en", "uz", "ru"] as const;
export type Language = (typeof languages)[number];
export function language(value?: string | null): Language {
  return value?.startsWith("uz") ? "uz" : value?.startsWith("ru") ? "ru" : "en";
}
export function ageOn(dob: string, now = new Date()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new Error("INVALID_DOB");
  const d = new Date(`${dob}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== dob)
    throw new Error("INVALID_DOB");
  return (
    now.getUTCFullYear() -
    d.getUTCFullYear() -
    Number(
      now.getUTCMonth() < d.getUTCMonth() ||
        (now.getUTCMonth() === d.getUTCMonth() &&
          now.getUTCDate() < d.getUTCDate()),
    )
  );
}
export function isAdult(dob: string, now = new Date()): boolean {
  const age = ageOn(dob, now);
  return age >= 18 && age <= 120;
}
export function ownContact(
  sender: number,
  contact: { user_id?: number },
): boolean {
  return contact.user_id === sender;
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export async function phoneHmac(
  phone: string,
  secret: string,
): Promise<string> {
  const normalized = phone.replace(/[\s()+-]/g, "");
  if (!/^\d{7,15}$/.test(normalized) || secret.length < 32)
    throw new Error("INVALID_PHONE_CONFIG");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(normalized),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(50),
  gender: z.enum(["woman", "man", "other"]),
  interested_in: z
    .array(z.enum(["woman", "man", "other"]))
    .min(1)
    .max(3),
  city: z.string().trim().min(2).max(80),
  intent: z.enum(["serious", "dating", "long_term", "friendship", "unsure"]),
  bio: z.string().max(500),
  interests: z.array(z.string().max(30)).min(5).max(10),
});
export const roles = ["OWNER", "SUPER_ADMIN", "MODERATOR", "SUPPORT"] as const;
export type Role = (typeof roles)[number];
export function canManageUsernames(role: Role): boolean {
  return role === "OWNER" || role === "SUPER_ADMIN";
}
export type PhotoDecision = {
  status: "APPROVED" | "REJECTED" | "NEEDS_REVIEW";
  reason: string;
};
export interface ModerationProvider {
  moderate(bytes: Uint8Array, primary: boolean): Promise<PhotoDecision>;
}
/** Safe free baseline: no image is published without an actual reviewer. */
export class ManualModerationProvider implements ModerationProvider {
  async moderate(): Promise<PhotoDecision> {
    return {
      status: "NEEDS_REVIEW",
      reason: "Human review required before publication",
    };
  }
}
