import {
  InlineKeyboard,
  InputFile,
  Keyboard,
  type Context,
  type Api,
} from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  canonicalUsername,
  escapeHtml,
  phoneHmac,
  type Language,
} from "../../../packages/shared/src/index";
import {
  p,
  intents,
  reasons,
  type ProductKey,
} from "../../../packages/shared/src/product-i18n";
import {
  boundedBody,
  GoogleSafeSearchProvider,
  sha256,
} from "../../../packages/shared/src/safety";
import type { Env } from "./index";
const uuid = z.string().uuid();
const flowSchema = z.object({
  kind: z.string().default(""),
  step: z.string().optional(),
  target: uuid.optional(),
  replace: uuid.optional(),
  draft: z.record(z.string(), z.unknown()).default({}),
  interests: z.array(z.string()).default([]),
});
export const memberSchema = z.object({
  id: uuid,
  locale: z.enum(["en", "uz", "ru"]),
  state: z.string(),
  status: z.string(),
  language_selected: z.boolean(),
  flow: flowSchema,
});
type Member = z.infer<typeof memberSchema>;
const cardSchema = z.object({
  id: uuid,
  username: z.string(),
  display_name: z.string(),
  age: z.number(),
  city: z.string(),
  intent: z.enum(intents),
  bio: z.string(),
  instagram_username: z.string().nullable().optional(),
  photo: z.string().nullable(),
  photo_id: uuid.nullable(),
  interests: z.array(z.string()),
  distance: z.number().optional(),
});
export async function rpc(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
async function write(query: PromiseLike<{ error: unknown }>) {
  const { error } = await query;
  if (error) throw new Error("DB");
}
export function languageButtons() {
  return new InlineKeyboard()
    .text("🇬🇧 English", "lang:en")
    .style("primary")
    .row()
    .text("🇺🇿 O‘zbekcha", "lang:uz")
    .style("primary")
    .row()
    .text("🇷🇺 Русский", "lang:ru")
    .style("primary");
}
export function menu(l: Language) {
  return new InlineKeyboard()
    .text(p(l, "find"), "m:find")
    .style("primary")
    .text(p(l, "near"), "m:near")
    .row()
    .text(p(l, "search"), "m:search")
    .text(p(l, "likes"), "m:likes")
    .row()
    .text(p(l, "matches"), "m:matches")
    .style("success")
    .text(p(l, "messages"), "m:messages")
    .style("primary")
    .row()
    .text(p(l, "profile"), "m:profile")
    .text(p(l, "settings"), "m:settings");
}
export async function showMenu(ctx: Context, l: Language) {
  await ctx.reply(p(l, "menu"), { reply_markup: menu(l) });
}
type InterestLabel = { id: string; label: string };
const interestCache = new Map<
  Language,
  { expires: number; rows: InterestLabel[] }
>();

async function labels(db: SupabaseClient, l: Language) {
  const cached = interestCache.get(l);
  if (cached && cached.expires > Date.now()) return cached.rows;

  const { data, error } = await db
    .from("interests")
    .select("id,label_en,label_uz,label_ru")
    .eq("active", true)
    .order("id");
  if (error) throw new Error("DB");
  const rows = (data ?? []).map((x) => ({
    id: String(x.id),
    label: String(x[`label_${l}`]),
  }));
  interestCache.set(l, { expires: Date.now() + 10 * 60_000, rows });
  return rows;
}

type PhotoDecision = "SAFE" | "UNSAFE" | "ERROR";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function aiText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (typeof record.result === "string") return record.result;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message =
    first?.message && typeof first.message === "object"
      ? (first.message as Record<string, unknown>)
      : undefined;
  return typeof message?.content === "string" ? message.content : "";
}

async function workersAiPhotoCheck(
  env: Env,
  bytes: Uint8Array,
): Promise<PhotoDecision> {
  try {
    const response = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
      messages: [
        {
          role: "system",
          content:
            "You are a strict profile-photo safety classifier. Reply with exactly SAFE or UNSAFE and nothing else.",
        },
        {
          role: "user",
          content:
            "Classify this image. UNSAFE means nudity, exposed genitals or breasts, sexual or strongly racy content, graphic violence, gore, or an image that is unsafe for a general adult relationship profile. If uncertain, choose UNSAFE.",
        },
      ],
      image: `data:image/jpeg;base64,${base64(bytes)}`,
      temperature: 0,
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
    });
    const answer = aiText(response).trim().toUpperCase();
    if (answer.startsWith("SAFE")) return "SAFE";
    if (answer.startsWith("UNSAFE")) return "UNSAFE";
    return "ERROR";
  } catch {
    return "ERROR";
  }
}

async function moderatePhoto(
  env: Env,
  bytes: Uint8Array,
  diagnostic: (code: string) => void,
): Promise<PhotoDecision> {
  const edge = await workersAiPhotoCheck(env, bytes);
  if (edge !== "ERROR") return edge;

  const googleConfig = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!googleConfig) {
    diagnostic("AI");
    return "ERROR";
  }

  const provider = new GoogleSafeSearchProvider(
    googleConfig,
    fetch,
    diagnostic,
  );
  return provider.check(bytes);
}
function normalizeInstagram(value: string): string {
  let v = value.trim();
  v = v.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "");
  v = v.replace(/^instagram\.com\//i, "");
  v = v.split(/[/?#]/, 1)[0] ?? "";
  v = v.replace(/^@/, "").toLowerCase();
  if (
    !/^[a-z0-9._]{1,30}$/.test(v) ||
    v.startsWith(".") ||
    v.endsWith(".") ||
    v.includes("..")
  )
    throw new Error("INVALID_INSTAGRAM");
  return v;
}

export async function showCard(
  ctx: Context,
  db: SupabaseClient,
  u: Member,
  value: unknown,
  own = false,
) {
  const parsed = cardSchema.safeParse(value);
  if (!parsed.success) {
    await ctx.reply(p(u.locale, "empty"));
    return;
  }
  const c = parsed.data,
    l = u.locale,
    ls = await labels(db, l);
  const instagram = c.instagram_username
    ? `\n📸 <a href="https://instagram.com/${escapeHtml(c.instagram_username)}">@${escapeHtml(c.instagram_username)}</a>`
    : "";
  const caption = `<b>@${escapeHtml(c.username)}</b>\n\n<b>${escapeHtml(c.display_name)}</b> · ${c.age}\n📍 ${escapeHtml(c.city)}${c.distance ? " · " + p(l, "distance", { n: c.distance }) : ""}\n\n💫 ${p(l, c.intent)}\n${escapeHtml(c.interests.map((i) => ls.find((x) => x.id === i)?.label ?? i).join(" · "))}\n\n${escapeHtml(c.bio)}${instagram}`;
  const k = own
    ? new InlineKeyboard()
        .text(p(l, "edit"), "m:edit")
        .text(p(l, "photos"), "m:photos")
        .row()
        .text(p(l, "link_instagram"), "m:instagram")
    : new InlineKeyboard()
        .text(p(l, "like"), `like:${c.id}`)
        .text(p(l, "message"), `compose:${c.id}`)
        .row()
        .text(p(l, "super"), `super:${c.id}`)
        .text(p(l, "skip"), `skip:${c.id}`)
        .row();
  k.row().copyText(`📋 @${c.username}`, `@${c.username}`);
  if (c.instagram_username) {
    k.url(
      p(l, "instagram"),
      `https://instagram.com/${c.instagram_username}`,
    ).style("primary");
    if (own)
      k.text(p(l, "unlink_instagram"), "m:unlink_instagram").style("danger");
    k.row();
  }
  if (!own)
    k.text(p(l, "report"), `report:${c.id}`)
      .style("danger")
      .text(p(l, "block"), `block:${c.id}`)
      .style("danger")
      .row();
  k.text(p(l, "back"), "m:home");
  if (c.photo) {
    const { data, error } = await db.storage
      .from("profile-photos")
      .download(c.photo);
    if (error || !data) throw new Error("PHOTO");
    await ctx.replyWithPhoto(
      new InputFile(new Uint8Array(await data.arrayBuffer()), "profile.jpg"),
      { caption, parse_mode: "HTML", reply_markup: k },
    );
  } else await ctx.reply(caption, { parse_mode: "HTML", reply_markup: k });
}
async function upload(ctx: Context, db: SupabaseClient, u: Member, env: Env) {
  const l = u.locale;
  const variants = [...(ctx.message?.photo ?? [])]
    .filter((item) => (item.file_size ?? 0) <= 5 * 1024 * 1024)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  if (!variants.length) return;
  const pid = String(
    await rpc(db, "photo_begin", {
      p_user: u.id,
      p_replace: u.flow.replace ?? null,
      p_event: String(ctx.update.update_id),
    }),
  );
  let path: string | undefined;
  let stage = "TELEGRAM_FILE";
  const diagnostic = (code: string) => {
    stage = code;
    console.warn(
      JSON.stringify({
        event: "photo_upload_failed",
        photo_id: pid,
        stage: code,
      }),
    );
  };
  try {
    const configuredLimit = Number(env.PHOTO_MODERATION_MONTHLY_LIMIT);
    const lim =
      Number.isInteger(configuredLimit) &&
      configuredLimit >= 1 &&
      configuredLimit <= 950
        ? configuredLimit
        : 950;

    let bytes: Uint8Array | undefined;
    // Telegram returns several sizes. Try the best variants in order so a
    // transient CDN/getFile issue does not make photo upload look broken.
    for (const photo of variants.slice(0, 3)) {
      try {
        const f = await ctx.api.getFile(photo.file_id);
        if (
          !f.file_path ||
          !/^photos\/[a-zA-Z0-9_./-]+$/.test(f.file_path) ||
          f.file_path.includes("..")
        )
          continue;
        const response = await fetch(
          `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`,
          { signal: AbortSignal.timeout(12000) },
        );
        if (!response.ok) continue;
        const candidate = await boundedBody(response, 5 * 1024 * 1024);
        if (
          candidate.byteLength >= 4 &&
          candidate[0] === 255 &&
          candidate[1] === 216
        ) {
          bytes = candidate;
          break;
        }
      } catch {
        // Fall through to a smaller Telegram photo variant.
      }
    }
    if (!bytes) throw new Error("TELEGRAM_FILE");
    if (
      !(await rpc(db, "reserve_photo_quota", { p_photo: pid, p_limit: lim }))
    ) {
      await rpc(db, "photo_finish", {
        p_user: u.id,
        p_photo: pid,
        p_decision: "ERROR",
      });
      await write(
        db.from("photos").update({ failure_stage: "QUOTA" }).eq("id", pid),
      );
      await ctx.reply(p(l, "photo_unavailable"));
      return;
    }
    stage = "MODERATION";
    const decision = await moderatePhoto(env, bytes, diagnostic);
    if (decision === "SAFE") {
      stage = "STORAGE";
      path = `${u.id}/${pid}.jpg`;
      const { error } = await db.storage
        .from("profile-photos")
        .upload(path, bytes, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error("STORAGE");
    }
    stage = "DATABASE";
    const approved = await rpc(db, "photo_finish", {
      p_user: u.id,
      p_photo: pid,
      p_decision: decision,
      p_path: path ?? null,
    });
    if (!approved && path)
      await db.storage.from("profile-photos").remove([path]);
    if (!approved && decision === "ERROR")
      await write(
        db.from("photos").update({ failure_stage: stage }).eq("id", pid),
      );
    await ctx.reply(
      p(
        l,
        approved
          ? "photo_ok"
          : decision === "UNSAFE"
            ? "photo_no"
            : "photo_unavailable",
      ),
      {
        reply_markup: approved
          ? menu(l)
          : new InlineKeyboard().text(
              p(l, "replace"),
              u.flow.replace ? `replace:${u.flow.replace}` : "m:upload",
            ),
      },
    );
    if (approved)
      await write(db.from("users").update({ flow: {} }).eq("id", u.id));
  } catch {
    diagnostic(stage);
    if (path) {
      // A reply failure or ambiguous RPC response must never delete a committed photo.
      const { data: state, error: stateError } = await db
        .from("photos")
        .select("status")
        .eq("id", pid)
        .single();
      if (!stateError && state?.status !== "APPROVED")
        await db.storage.from("profile-photos").remove([path]);
    }
    await rpc(db, "photo_finish", {
      p_user: u.id,
      p_photo: pid,
      p_decision: "ERROR",
    });
    await write(
      db.from("photos").update({ failure_stage: stage }).eq("id", pid),
    );
    await ctx.reply(p(l, "photo_unavailable"), {
      reply_markup: new InlineKeyboard().text(
        p(l, "replace"),
        u.flow.replace ? `replace:${u.flow.replace}` : "m:upload",
      ),
    });
  }
  // Delete only images already atomically removed from the active profile.
  const { data } = await db
    .from("photos")
    .select("storage_path")
    .eq("user_id", u.id)
    .eq("status", "REMOVED");
  const paths = (data ?? [])
    .map((x) => x.storage_path)
    .filter((x): x is string => typeof x === "string");
  if (paths.length) await db.storage.from("profile-photos").remove(paths);
}
export async function product(
  ctx: Context,
  db: SupabaseClient,
  u: Member,
  env: Env,
) {
  const l = u.locale,
    cb = ctx.callbackQuery?.data,
    text = ctx.message?.text,
    flow = u.flow;
  const setFlow = async (value: Record<string, unknown>) =>
    write(db.from("users").update({ flow: value }).eq("id", u.id));
  const social = (
    action: string,
    target: string,
    body = "",
    extra: Record<string, unknown> = {},
  ) =>
    rpc(db, "social_action", {
      p_user: u.id,
      p_action: action,
      p_target: uuid.parse(target),
      p_body: body,
      p_event: String(ctx.update.update_id),
      p_extra: extra,
    });
  async function wizard(
    step = "name",
    draft: Record<string, unknown> = {},
    interests: string[] = [],
  ) {
    await setFlow({ kind: "profile", step, draft, interests });
    const k = new InlineKeyboard();
    if (step === "gender" || step === "interested")
      (
        [
          "woman",
          "man",
          "other",
          ...(step === "interested" ? (["all"] as const) : []),
        ] as const
      ).forEach((x) => k.text(p(l, x), `choose:${x}`).row());
    if (step === "intent")
      intents.forEach((x, i) => k.text(p(l, x), `intent:${i}`).row());
    if (step === "interests") {
      (await labels(db, l)).forEach((x, i) => {
        k.text(
          `${interests.includes(x.id) ? "✓ " : ""}${x.label}`,
          `interest:${x.id}`,
        );
        if (i % 2) k.row();
      });
      k.row().text(p(l, "next"), "interests:done");
    }
    await ctx.reply(p(l, step as ProductKey), { reply_markup: k });
  }
  if (cb?.startsWith("uc:")) {
    if (flow.kind !== "username_change_confirm") throw new Error("INVALID");
    const requested = canonicalUsername(cb.slice(3));
    if (requested.length < 2 || requested !== flow.draft.name)
      throw new Error("INVALID");
    try {
      const changed = await rpc(db, "change_username", {
        p_user: u.id,
        p_name: requested,
      });
      await setFlow({});
      await ctx.reply(p(l, "change_done", { name: changed.username }), {
        reply_markup: menu(l),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("COOLDOWN")) {
        await ctx.reply(p(l, "transfer_cooldown"), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:username_settings",
          ),
        });
        return;
      }
      if (/TAKEN|RESERVED|FROZEN|PREMIUM|NOT_ALLOWED/.test(message)) {
        await ctx.reply(p(l, "username_unavailable"), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:change_username",
          ),
        });
        return;
      }
      throw error;
    }
    return;
  }
  if (cb?.startsWith("t:")) {
    const [, id, token] = cb.split(":");
    uuid.parse(id);
    if (!token || !/^[A-Za-z0-9_-]{22}$/.test(token))
      throw new Error("INVALID");
    const state = await rpc(db, "transfer_confirm", {
      p_id: id,
      p_actor: u.id,
      p_hash: await sha256(token),
      p_token: token,
    });
    await ctx.reply(p(l, state === "PENDING" ? "transfer_pending" : "saved"));
    return;
  }
  if (cb?.startsWith("m:")) {
    const action = cb.slice(2);
    if (flow.kind) await setFlow({});
    if (action === "home") return showMenu(ctx, l);
    if (action === "find" || action === "near") {
      if (action === "near") {
        const { data, error } = await db
          .from("location_preferences")
          .select("lat_cell")
          .eq("user_id", u.id)
          .maybeSingle();
        if (error) throw new Error("DB");
        if (data?.lat_cell == null) {
          await setFlow({ kind: "location" });
          await ctx.reply(p(l, "location"), {
            reply_markup: new Keyboard()
              .requestLocation(p(l, "share_location"))
              .resized()
              .oneTime(),
          });
          return;
        }
      }
      const found = await rpc(db, "discover", {
        p_user: u.id,
        p_near: action === "near",
      });
      if (!found) {
        await ctx.reply(p(l, action === "near" ? "no_nearby" : "no_discover"), {
          reply_markup: new InlineKeyboard()
            .text(p(l, "retry"), `m:${action}`)
            .row()
            .text(p(l, "back"), "m:home"),
        });
        return;
      }
      await showCard(ctx, db, u, found);
      return;
    }
    if (action === "search") {
      await setFlow({ kind: "search" });
      await ctx.reply(p(l, "query"));
      return;
    }
    if (action === "username_settings") {
      const status = await rpc(db, "username_self_status", { p_user: u.id });
      const k = new InlineKeyboard()
        .text(p(l, "change_username"), "m:change_username")
        .row()
        .text(p(l, "transfer"), "m:transfer")
        .row()
        .text(p(l, "back"), "m:settings");
      await ctx.reply(`${p(l, "username_settings")}: @${status.username}`, {
        reply_markup: k,
      });
      return;
    }
    if (action === "change_username") {
      const status = await rpc(db, "username_self_status", { p_user: u.id });
      if (!status.can_change) {
        const date = status.next_change_at
          ? new Date(status.next_change_at).toLocaleDateString(
              l === "uz" ? "uz-UZ" : l === "ru" ? "ru-RU" : "en-GB",
            )
          : "";
        await ctx.reply(p(l, "change_cooldown", { date }), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:username_settings",
          ),
        });
        return;
      }
      await setFlow({ kind: "username_change" });
      await ctx.reply(p(l, "change_query"), {
        reply_markup: new InlineKeyboard().text(
          p(l, "back"),
          "m:username_settings",
        ),
      });
      return;
    }
    if (action === "transfer") {
      const status = await rpc(db, "username_self_status", { p_user: u.id });
      if (status.premium) {
        await ctx.reply(p(l, "transfer_premium"), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:username_settings",
          ),
        });
        return;
      }
      if (!status.can_transfer) {
        await ctx.reply(p(l, "transfer_cooldown"), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:username_settings",
          ),
        });
        return;
      }
      await setFlow({ kind: "transfer" });
      await ctx.reply(p(l, "transfer_query"), {
        reply_markup: new InlineKeyboard().text(
          p(l, "back"),
          "m:username_settings",
        ),
      });
      return;
    }
    if (action === "edit") return wizard();
    if (action === "profile")
      return showCard(
        ctx,
        db,
        u,
        await rpc(db, "card", { p_viewer: u.id, p_target: u.id }),
        true,
      );
    if (action === "instagram") {
      await setFlow({ kind: "instagram" });
      await ctx.reply(p(l, "instagram_prompt"), {
        reply_markup: new InlineKeyboard().text(p(l, "back"), "m:profile"),
      });
      return;
    }
    if (action === "unlink_instagram") {
      await rpc(db, "set_instagram", { p_user: u.id, p_username: "" });
      await ctx.reply(p(l, "instagram_removed"), { reply_markup: menu(l) });
      return;
    }
    if (action === "upload") {
      await setFlow({ kind: "upload" });
      await ctx.reply(p(l, "upload"));
      return;
    }
    if (action === "photos") {
      const { data, error } = await db
        .from("photos")
        .select("id,primary_photo,storage_path")
        .eq("user_id", u.id)
        .eq("status", "APPROVED")
        .order("created_at");
      if (error) throw new Error("DB");
      for (const ph of data ?? []) {
        const k = new InlineKeyboard()
          .text(p(l, "primary"), `primary:${ph.id}`)
          .text(p(l, "replace"), `replace:${ph.id}`)
          .row()
          .text(p(l, "remove"), `delete:${ph.id}`);
        const { data: blob, error: e } = await db.storage
          .from("profile-photos")
          .download(ph.storage_path);
        if (e || !blob) continue;
        await ctx.replyWithPhoto(
          new InputFile(
            new Uint8Array(await blob.arrayBuffer()),
            "profile.jpg",
          ),
          { reply_markup: k },
        );
      }
      await ctx.reply(p(l, "photos"), {
        reply_markup: new InlineKeyboard()
          .text(p(l, "add"), "m:upload")
          .text(p(l, "back"), "m:home"),
      });
      return;
    }
    if (["likes", "matches", "messages", "requests"].includes(action)) {
      const rows = await rpc(db, "inbox", { p_user: u.id, p_kind: action });
      if (action === "requests") {
        const visible = (rows ?? []).filter((r: { profile?: unknown }) =>
          Boolean(r.profile),
        );
        if (!visible.length) {
          await ctx.reply(p(l, "no_requests"), {
            reply_markup: new InlineKeyboard().text(p(l, "back"), "m:messages"),
          });
          return;
        }
        for (const r of visible) {
          const profile = r.profile as { id: string; username: string };
          await ctx.reply(`@${profile.username}\n\n${r.body}`, {
            reply_markup: new InlineKeyboard()
              .text(p(l, "accept"), `accept:${r.id}`)
              .text(p(l, "decline"), `decline:${r.id}`)
              .row()
              .text(p(l, "view"), `view:${profile.id}`)
              .text(p(l, "block"), `block:${profile.id}`)
              .text(p(l, "report"), `report:${profile.id}`),
          });
        }
      } else {
        const visible = (rows ?? []).filter(Boolean);
        if (!visible.length) {
          const emptyKey =
            action === "likes"
              ? "no_likes"
              : action === "matches"
                ? "no_matches"
                : "no_messages";
          const k = new InlineKeyboard();
          if (action === "messages")
            k.text(p(l, "requests"), "m:requests").row();
          else k.text(p(l, "find"), "m:find").row();
          k.text(p(l, "back"), "m:home");
          await ctx.reply(p(l, emptyKey), { reply_markup: k });
          return;
        }
        const k = new InlineKeyboard();
        for (const card of visible)
          k.text(`@${card.username}`, `view:${card.id}`).row();
        if (action === "messages") k.text(p(l, "requests"), "m:requests").row();
        k.text(p(l, "back"), "m:home");
        await ctx.reply(p(l, action as ProductKey), { reply_markup: k });
      }
      return;
    }
    if (action === "settings") {
      const k = new InlineKeyboard();
      (
        [
          "username_settings",
          "link_instagram",
          "filters",
          "forget_location",
          "notifications",
          "pause_profile",
          "language",
        ] as const
      ).forEach((x) =>
        k.text(p(l, x === "filters" ? "filter_button" : x), `m:${x}`).row(),
      );
      await ctx.reply(p(l, "settings"), { reply_markup: k });
      return;
    }
    if (action === "language") {
      await ctx.reply("🌐 Choose your language\nTilni tanlang\nВыберите язык", {
        reply_markup: languageButtons(),
      });
      return;
    }
    if (action === "filters") {
      await setFlow({ kind: "filters" });
      await ctx.reply(p(l, "filters"));
      return;
    }
    if (action === "forget_location")
      await write(
        db
          .from("location_preferences")
          .update({ lat_cell: null, lon_cell: null })
          .eq("user_id", u.id),
      );
    if (action === "notifications") {
      const { data, error } = await db
        .from("notification_preferences")
        .select("enabled")
        .eq("user_id", u.id)
        .maybeSingle();
      if (error) throw new Error("DB");
      await write(
        db
          .from("notification_preferences")
          .upsert({ user_id: u.id, enabled: !(data?.enabled ?? true) }),
      );
    }
    if (action === "pause_profile") {
      const { data, error } = await db
        .from("profiles")
        .select("user_paused")
        .eq("user_id", u.id)
        .single();
      if (error) throw new Error("DB");
      await write(
        db
          .from("profiles")
          .update({ user_paused: !data.user_paused })
          .eq("user_id", u.id),
      );
    }
    await ctx.reply(p(l, "saved"), { reply_markup: menu(l) });
    return;
  }
  if (cb?.startsWith("choose:") && flow.kind === "profile") {
    const value = cb.slice(7);
    z.enum(["woman", "man", "other", "all"]).parse(value);
    if (flow.step === "gender" && value !== "all")
      return wizard("interested", { ...flow.draft, gender: value });
    if (flow.step === "interested")
      return wizard("city", {
        ...flow.draft,
        interested_in: value === "all" ? ["woman", "man", "other"] : [value],
      });
  }
  if (
    cb?.startsWith("interest:") &&
    flow.kind === "profile" &&
    flow.step === "interests"
  ) {
    const value = cb.slice(9);
    if (!(await labels(db, l)).some((x) => x.id === value))
      throw new Error("INVALID");
    const selected = flow.interests.includes(value)
      ? flow.interests.filter((x) => x !== value)
      : [...flow.interests, value];
    if (selected.length > 10) {
      await ctx.reply(p(l, "invalid"));
      return;
    }
    return wizard("interests", flow.draft, selected);
  }
  if (
    cb === "interests:done" &&
    flow.kind === "profile" &&
    flow.step === "interests"
  ) {
    if (flow.interests.length < 5) {
      await ctx.reply(p(l, "invalid"));
      return;
    }
    return wizard("intent", flow.draft, flow.interests);
  }
  if (
    cb?.startsWith("intent:") &&
    flow.kind === "profile" &&
    flow.step === "intent"
  ) {
    const intent = intents[Number(cb.slice(7))];
    if (!intent) throw new Error("INVALID");
    await rpc(db, "save_profile", {
      p_user: u.id,
      p_profile: { ...flow.draft, intent },
      p_interests: flow.interests,
    });
    await ctx.reply(p(l, "profile_ready"), { reply_markup: menu(l) });
    return;
  }
  if (cb) {
    const [action, id] = cb.split(":");
    if (!id || !action) throw new Error("INVALID");
    uuid.parse(id);
    if (["like", "super", "skip"].includes(action)) {
      await social(action, id);
      const next = await rpc(db, "discover", { p_user: u.id, p_near: false });
      if (next) await showCard(ctx, db, u, next);
      else
        await ctx.reply(p(l, "no_discover"), {
          reply_markup: new InlineKeyboard()
            .text(p(l, "retry"), "m:find")
            .row()
            .text(p(l, "back"), "m:home"),
        });
      return;
    }
    if (action === "block" || action === "unmatch") {
      await social(action, id);
      await ctx.reply(p(l, "saved"), { reply_markup: menu(l) });
      return;
    }
    if (action === "report") {
      await setFlow({ kind: "report", target: id });
      const k = new InlineKeyboard();
      reasons.forEach((x) => k.text(p(l, x), `reason:${x}`).row());
      await ctx.reply(p(l, "report_reason"), { reply_markup: k });
      return;
    }
    if (action === "view")
      return showCard(
        ctx,
        db,
        u,
        await rpc(db, "card", { p_viewer: u.id, p_target: id }),
      );
    if (action === "compose") {
      if (!(await rpc(db, "card", { p_viewer: u.id, p_target: id })))
        throw new Error("NOT_FOUND");
      await setFlow({ kind: "compose", target: id });
      await ctx.reply(p(l, "compose"), {
        reply_markup: new InlineKeyboard()
          .text(p(l, "unmatch"), `unmatch:${id}`)
          .text(p(l, "back"), "m:home"),
      });
      return;
    }
    if (action === "accept" || action === "decline") {
      const { data, error } = await db
        .from("message_requests")
        .select("sender")
        .eq("id", id)
        .eq("recipient", u.id)
        .eq("state", "PENDING")
        .single();
      if (error) throw new Error("NOT_FOUND");
      await social(action, data.sender, "", { id });
      await ctx.reply(p(l, "saved"), { reply_markup: menu(l) });
      return;
    }
    if (action === "replace") {
      await setFlow({ kind: "upload", replace: id });
      await ctx.reply(p(l, "upload"));
      return;
    }
    if (action === "primary" || action === "delete") {
      await rpc(db, "photo_edit", {
        p_user: u.id,
        p_photo: id,
        p_action: action,
      });
      await ctx.reply(p(l, "saved"), { reply_markup: menu(l) });
      return;
    }
  }
  if (ctx.message?.photo) {
    if (flow.kind !== "upload" && u.state !== "PROFILE") {
      await ctx.reply(p(l, "upload"), {
        reply_markup: new InlineKeyboard().text(p(l, "add"), "m:upload"),
      });
      return;
    }
    await upload(ctx, db, u, env);
    return;
  }
  if (ctx.message?.location && flow.kind === "location") {
    const loc = ctx.message.location;
    await write(
      db.from("location_preferences").upsert({
        user_id: u.id,
        lat_cell: Math.round(loc.latitude * 20) / 20,
        lon_cell: Math.round(loc.longitude * 20) / 20,
      }),
    );
    await setFlow({});
    await ctx.reply(p(l, "saved"), { reply_markup: { remove_keyboard: true } });
    const nearby = await rpc(db, "discover", { p_user: u.id, p_near: true });
    if (!nearby) {
      await ctx.reply(p(l, "no_nearby"), {
        reply_markup: new InlineKeyboard()
          .text(p(l, "retry"), "m:near")
          .row()
          .text(p(l, "back"), "m:home"),
      });
      return;
    }
    await showCard(ctx, db, u, nearby);
    return;
  }
  if (text && flow.kind === "filters") {
    const a = z
      .tuple([
        z.coerce.number().int().min(5).max(500),
        z.coerce.number().int().min(18).max(120),
        z.coerce.number().int().min(18).max(120),
      ])
      .parse(text.trim().split(/\s+/));
    if (a[1] > a[2]) throw new Error("INVALID");
    await write(
      db
        .from("location_preferences")
        .upsert({ user_id: u.id, radius: a[0], min_age: a[1], max_age: a[2] }),
    );
    await setFlow({});
    return showMenu(ctx, l);
  }
  if (text && flow.kind === "instagram") {
    let username: string;
    try {
      username = normalizeInstagram(text);
    } catch {
      await ctx.reply(p(l, "instagram_invalid"));
      return;
    }
    await rpc(db, "set_instagram", {
      p_user: u.id,
      p_username: username,
    });
    await setFlow({});
    await ctx.reply(p(l, "instagram_saved", { username }), {
      reply_markup: menu(l),
    });
    return;
  }

  if (text && flow.kind === "username_change") {
    let name: string;
    try {
      name = canonicalUsername(text);
      if (name.length < 2) throw new Error("INVALID");
    } catch {
      await ctx.reply(p(l, "username_unavailable"));
      return;
    }
    const status = await rpc(db, "username_status", { p_name: name });
    if (status !== "AVAILABLE") {
      await ctx.reply(p(l, "username_unavailable"));
      return;
    }
    const current = await rpc(db, "username_self_status", { p_user: u.id });
    await setFlow({
      kind: "username_change_confirm",
      draft: { name, old: current.username },
    });
    await ctx.reply(p(l, "change_preview", { old: current.username, name }), {
      reply_markup: new InlineKeyboard()
        .text(p(l, "confirm"), `uc:${name}`)
        .text(p(l, "back"), "m:username_settings"),
    });
    return;
  }

  if (text && flow.kind === "profile") {
    const d = { ...flow.draft };
    if (flow.step === "name") {
      d.display_name = z.string().trim().min(1).max(50).parse(text);
      return wizard("gender", d);
    }
    if (flow.step === "city") {
      d.city = z.string().trim().min(2).max(80).parse(text);
      return wizard("bio", d);
    }
    if (flow.step === "bio") {
      d.bio = z.string().trim().max(500).parse(text);
      return wizard("interests", d);
    }
  }
  if (text && flow.kind === "search") {
    let name: string;
    try {
      name = canonicalUsername(text);
    } catch {
      await ctx.reply(p(l, "notfound"));
      return;
    }
    const found = await rpc(db, "username_lookup", {
      p_user: u.id,
      p_name: name,
    });
    if (!found) await ctx.reply(p(l, "notfound"));
    else {
      if (found.id === u.id) await ctx.reply(p(l, "username_own_profile"));
      await showCard(ctx, db, u, found, found.id === u.id);
    }
    return;
  }
  if (text && flow.kind === "compose" && flow.target) {
    const body = z.string().trim().min(1).max(1000).parse(text);
    try {
      await social("message", flow.target, body);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("REQUEST_REQUIRED"))
        throw e;
      await social("request", flow.target, body);
    }
    await ctx.reply(p(l, "sent"), {
      reply_markup: new InlineKeyboard().text(p(l, "back"), "m:home"),
    });
    return;
  }
  if ((text || ctx.message?.contact) && flow.kind === "transfer") {
    let recipientId: string | undefined;
    let recipientName: string | undefined;

    if (ctx.message?.contact) {
      const hash = await phoneHmac(
        ctx.message.contact.phone_number,
        env.PHONE_HMAC_SECRET,
      );
      const { data, error } = await db
        .from("users")
        .select("id")
        .eq("phone_hmac", hash)
        .eq("status", "ACTIVE")
        .maybeSingle();
      if (error) throw new Error("DB");
      recipientId = data?.id;
    } else {
      const raw = (text ?? "").trim();
      const maybeUsername = raw.replace(/^@/, "");
      if (/^[A-Za-z0-9]{1,25}$/.test(maybeUsername)) {
        const name = maybeUsername.toLowerCase();
        const { data, error } = await db
          .from("usernames")
          .select("owner_id,canonical")
          .eq("canonical", name)
          .eq("status", "ASSIGNED")
          .maybeSingle();
        if (error) throw new Error("DB");
        recipientId = data?.owner_id ?? undefined;
        recipientName = data?.canonical ?? undefined;
      } else {
        try {
          const hash = await phoneHmac(raw, env.PHONE_HMAC_SECRET);
          const { data, error } = await db
            .from("users")
            .select("id")
            .eq("phone_hmac", hash)
            .eq("status", "ACTIVE")
            .maybeSingle();
          if (error) throw new Error("DB");
          recipientId = data?.id;
        } catch {
          recipientId = undefined;
        }
      }
    }

    if (!recipientId || recipientId === u.id) {
      await ctx.reply(p(l, "recipient_not_found"), {
        reply_markup: new InlineKeyboard().text(
          p(l, "back"),
          "m:username_settings",
        ),
      });
      return;
    }
    if (!recipientName) {
      const { data, error } = await db
        .from("usernames")
        .select("canonical")
        .eq("owner_id", recipientId)
        .eq("status", "ASSIGNED")
        .maybeSingle();
      if (error) throw new Error("DB");
      recipientName = data?.canonical ?? undefined;
    }
    if (!recipientName) {
      await ctx.reply(p(l, "recipient_not_found"));
      return;
    }

    const token = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    try {
      const id = await rpc(db, "begin_transfer", {
        p_sender: u.id,
        p_recipient: recipientId,
        p_hash: await sha256(token),
      });
      const { data: tr, error: e } = await db
        .from("username_transfers")
        .select("canonical")
        .eq("id", id)
        .single();
      if (e) throw new Error("DB");
      await setFlow({});
      await ctx.reply(
        p(l, "transfer_confirm", {
          name: tr.canonical,
          recipient: `@${recipientName}`,
        }),
        {
          reply_markup: new InlineKeyboard()
            .text(p(l, "confirm"), `t:${id}:${token}`)
            .text(p(l, "back"), "m:username_settings"),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("COOLDOWN")) {
        await ctx.reply(p(l, "transfer_cooldown"), {
          reply_markup: new InlineKeyboard().text(
            p(l, "back"),
            "m:username_settings",
          ),
        });
        return;
      }
      if (message.includes("PREMIUM_ADMIN_ONLY")) {
        await ctx.reply(p(l, "transfer_premium"));
        return;
      }
      if (/ACCOUNT_UNAVAILABLE|SAME_USER|NOT_FOUND/.test(message)) {
        await ctx.reply(p(l, "recipient_not_found"));
        return;
      }
      throw error;
    }
    return;
  }
  if (u.state === "PROFILE") {
    const { data, error } = await db
      .from("profiles")
      .select("user_id")
      .eq("user_id", u.id)
      .maybeSingle();
    if (error) throw new Error("DB");
    if (!data) return wizard();
    await ctx.reply(p(l, "upload"));
    return;
  }
  return showMenu(ctx, l);
}
export async function reportReason(
  ctx: Context,
  db: SupabaseClient,
  u: Member,
) {
  const reason = z.enum(reasons).parse(ctx.callbackQuery?.data?.slice(7));
  if (u.flow.kind !== "report" || !u.flow.target) throw new Error("INVALID");
  const { data } = await db
    .from("photos")
    .select("id")
    .eq("user_id", u.flow.target)
    .eq("primary_photo", true)
    .eq("status", "APPROVED")
    .maybeSingle();
  await rpc(db, "social_action", {
    p_user: u.id,
    p_action: "report",
    p_target: u.flow.target,
    p_body: "",
    p_event: String(ctx.update.update_id),
    p_extra: {
      category: reason,
      photo_id:
        reason === "photo" || reason === "sexual" ? (data?.id ?? null) : null,
    },
  });
  await write(db.from("users").update({ flow: {} }).eq("id", u.id));
  await ctx.reply(p(u.locale, "saved"), { reply_markup: menu(u.locale) });
}
export async function deliver(api: Api, db: SupabaseClient) {
  const notices = await rpc(db, "notification_claim");
  for (const n of notices ?? []) {
    try {
      const l = z.enum(["en", "uz", "ru"]).parse(n.locale);
      const { data } = await db
        .from("notifications")
        .select("state")
        .eq("id", n.id)
        .single();
      if (data?.state !== "SENDING") continue;
      if (
        n.actor &&
        (await rpc(db, "blocked_pair", { a: n.recipient, b: n.actor }))
      )
        continue;
      const key: ProductKey =
        (
          {
            like: "new_like",
            match: "new_match",
            request: "new_request",
            message: "new_message",
            accepted: "accepted",
            transfer: "transfer_notice",
            transfer_done: "transfer_done",
            notice: "notice",
          } as Record<string, ProductKey>
        )[n.kind] ?? "notice";
      const k = new InlineKeyboard();
      if (n.actor)
        k.text(p(l, "view"), `view:${n.actor}`)
          .text(p(l, "message"), `compose:${n.actor}`)
          .row();
      if (n.kind === "request")
        k.text(p(l, "accept"), `accept:${n.payload.request_id}`)
          .text(p(l, "decline"), `decline:${n.payload.request_id}`)
          .row()
          .text(p(l, "block"), `block:${n.actor}`)
          .text(p(l, "report"), `report:${n.actor}`);
      if (n.kind === "transfer")
        k.text(p(l, "confirm"), `t:${n.payload.id}:${n.payload.token}`);
      await api.sendMessage(
        n.telegram_id,
        p(l, key, { username: n.payload.username ?? n.username ?? "" }) +
          (n.body ? `\n\n${n.body}` : "") +
          (n.kind === "notice" ? `\n${n.payload.reason ?? ""}` : ""),
        { reply_markup: k.row().text(p(l, "back"), "m:home") },
      );
      await write(
        db
          .from("notifications")
          .update({
            state: "SENT",
            payload: n.kind === "transfer" ? {} : n.payload,
          })
          .eq("id", n.id)
          .eq("state", "SENDING"),
      );
    } catch {
      /* Bounded retries via leased outbox. Never log bodies or credentials. */
    }
  }
}
