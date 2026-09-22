import { Hono } from "hono";
import { Bot, Keyboard, Api } from "grammy";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  canonicalUsername,
  isAdult,
  language,
  ownContact,
  phoneHmac,
  type Language,
} from "../../../packages/shared/src/index";
import { t } from "../../../packages/shared/src/i18n";
import { boundedBody } from "../../../packages/shared/src/safety";
import {
  product,
  memberSchema,
  languageButtons,
  deliver,
  reportReason,
} from "./product";
export interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  PHOTO_MODERATION_MONTHLY_LIMIT?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PHONE_HMAC_SECRET: string;
  TELEGRAM_BOT_ID: string;
  TELEGRAM_BOT_USERNAME: string;
}
const userSchema = z.object({
  id: z.string().uuid(),
  telegram_id: z.number(),
  locale: z.enum(["en", "uz", "ru"]),
  state: z.enum([
    "AGE",
    "DOB",
    "CONTACT",
    "USERNAME",
    "PROFILE",
    "READY",
    "DENIED",
  ]),
  status: z.string(),
});
const updateSchema = z
  .object({ update_id: z.number().int().nonnegative() })
  .passthrough();
export function validSecret(
  received: string | undefined,
  expected: string | undefined,
): boolean {
  if (
    !received ||
    !expected ||
    expected.length < 32 ||
    received.length !== expected.length
  )
    return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++)
    different |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}
export const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) =>
  c.json({ service: "closeme", phase: "relationship-platform", ok: true }),
);
app.post("/telegram/webhook", async (c) => {
  if (
    !validSecret(
      c.req.header("X-Telegram-Bot-Api-Secret-Token"),
      c.env.TELEGRAM_WEBHOOK_SECRET,
    )
  )
    return c.json({ error: "Unauthorized" }, 401);
  let raw: string;
  try {
    raw = new TextDecoder().decode(await boundedBody(c.req.raw, 262144));
  } catch {
    return c.json({ error: "Too large" }, 413);
  }
  let update;
  try {
    update = updateSchema.parse(JSON.parse(raw));
  } catch {
    return c.json({ error: "Invalid update" }, 400);
  }
  const db = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: receipt, error: receiptError } = await db
    .from("webhook_receipts")
    .select("update_id")
    .eq("update_id", update.update_id)
    .maybeSingle();
  if (receiptError) return c.json({ error: "Unavailable" }, 503);
  if (receipt) return c.json({ ok: true });
  const lease = crypto.randomUUID();
  const { data: claimed, error: leaseError } = await db.rpc("claim_update", {
    p_id: update.update_id,
    p_token: lease,
  });
  if (leaseError || !claimed) return c.json({ error: "Retry later" }, 503);
  const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN, {
    botInfo: {
      id: Number(c.env.TELEGRAM_BOT_ID),
      is_bot: true,
      first_name: "CloseMe",
      username: c.env.TELEGRAM_BOT_USERNAME,
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  }
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // User-level denials must not poison Telegram's single-connection retry queue.
      if (
        message.includes("ACCOUNT_UNAVAILABLE") ||
        message.includes("users_phone_hmac_key")
      ) {
        if (ctx.chat?.type === "private")
          await ctx.reply(t(language(ctx.from?.language_code), "unavailable"));
        return;
      }
      if (
        error instanceof z.ZodError ||
        /LIMIT|PAUSED|NOT_FOUND|INVALID|PROFILE_REQUIRED|PHOTO_|BUSY|REQUEST_|TRANSFER|COOLDOWN|PREMIUM|EXPIRED|CONFIRM|TOKEN|REPLAY|PRIMARY_REQUIRED/.test(
          message,
        )
      ) {
        if (ctx.chat?.type === "private")
          await ctx.reply(
            t(
              language(ctx.from?.language_code),
              message.includes("LIMIT") ? "limited" : "error",
            ),
          );
        return;
      }
      throw error;
    }
  });
  bot.on(["message", "callback_query:data"], async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.from || ctx.from.is_bot) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    const locale = language(ctx.from.language_code);
    if (
      !(await rpc("consume_limit", {
        p_actor: String(ctx.from.id),
        p_action: "updates",
        p_limit: 30,
        p_seconds: 60,
      }))
    ) {
      await ctx.reply(t(locale, "limited"));
      return;
    }
    let user = userSchema.parse(
      await rpc("onboard", { p_telegram: ctx.from.id, p_locale: locale }),
    );
    const { data: stored, error: storedError } = await db
      .from("users")
      .select("id,locale,state,status,language_selected,flow")
      .eq("id", user.id)
      .single();
    if (storedError) throw new Error("DB");
    let member = memberSchema.parse(stored);
    const callback = ctx.callbackQuery?.data;
    if (callback?.startsWith("lang:")) {
      const selected = z.enum(["en", "uz", "ru"]).parse(callback.slice(5));
      const { error } = await db
        .from("users")
        .update({ locale: selected, language_selected: true })
        .eq("id", user.id);
      if (error) throw new Error("DB");
      user = { ...user, locale: selected };
      member = { ...member, locale: selected, language_selected: true };
    }
    if (!member.language_selected) {
      await ctx.reply("English · O‘zbekcha · Русский", {
        reply_markup: languageButtons(),
      });
      return;
    }
    const l: Language = user.locale;
    const text = ctx.message?.text;
    if (text === "/start" || text === "/cancel") {
      const { error } = await db
        .from("users")
        .update({ flow: {} })
        .eq("id", user.id);
      if (error) throw new Error("DB");
      member = { ...member, flow: { kind: "", draft: {}, interests: [] } };
    }
    if (callback?.startsWith("t:")) return product(ctx, db, member, c.env);
    if (user.state === "PROFILE" || user.state === "READY") {
      if (callback?.startsWith("reason:")) return reportReason(ctx, db, member);
      return product(ctx, db, member, c.env);
    }
    async function prompt() {
      const remove = { reply_markup: { remove_keyboard: true } as const };
      if (user.state === "AGE")
        await ctx.reply(t(l, "welcome"), {
          reply_markup: new Keyboard()
            .text(t(l, "adult"))
            .row()
            .text(t(l, "underage"))
            .resized()
            .oneTime(),
        });
      else if (user.state === "DOB") await ctx.reply(t(l, "dob"), remove);
      else if (user.state === "CONTACT")
        await ctx.reply(t(l, "contact"), {
          reply_markup: new Keyboard()
            .requestContact(t(l, "share"))
            .resized()
            .oneTime(),
        });
      else if (user.state === "USERNAME")
        await ctx.reply(t(l, "username"), remove);
      else if (user.state === "DENIED") await ctx.reply(t(l, "denied"), remove);
      else {
        const { data, error } = await db
          .from("users")
          .select("id,locale,state,status,language_selected,flow")
          .eq("id", user.id)
          .single();
        if (error) throw new Error("DB");
        await product(ctx, db, memberSchema.parse(data), c.env);
      }
    }
    if (text === "/help") {
      await ctx.reply(t(l, "help"));
      return;
    }
    if (text?.startsWith("/start")) {
      await prompt();
      return;
    }
    if (user.state === "DENIED") {
      await prompt();
      return;
    }
    if (user.state === "AGE") {
      if (text !== t(l, "adult") && text !== t(l, "underage")) {
        await prompt();
        return;
      }
      user = userSchema.parse(
        await rpc("onboard", {
          p_telegram: ctx.from.id,
          p_locale: l,
          p_action: text === t(l, "adult") ? "adult" : "deny",
        }),
      );
    } else if (user.state === "DOB") {
      let adult: boolean;
      try {
        adult = isAdult(text ?? "");
      } catch {
        await ctx.reply(t(l, "dob_invalid"));
        return;
      }
      user = userSchema.parse(
        await rpc("onboard", {
          p_telegram: ctx.from.id,
          p_locale: l,
          p_action: adult ? "dob" : "deny",
          p_value: text,
        }),
      );
    } else if (user.state === "CONTACT") {
      if (
        !ctx.message?.contact ||
        !ownContact(ctx.from.id, ctx.message?.contact)
      ) {
        await ctx.reply(t(l, "wrong_contact"));
        return;
      }
      const hash = await phoneHmac(
        ctx.message?.contact.phone_number,
        c.env.PHONE_HMAC_SECRET,
      );
      user = userSchema.parse(
        await rpc("onboard", {
          p_telegram: ctx.from.id,
          p_locale: l,
          p_action: "contact",
          p_value: hash,
        }),
      );
    } else if (user.state === "USERNAME") {
      if (
        !(await rpc("consume_limit", {
          p_actor: user.id,
          p_action: "username_claim",
          p_limit: 10,
          p_seconds: 60,
        }))
      ) {
        await ctx.reply(t(l, "limited"));
        return;
      }
      let name: string;
      try {
        name = canonicalUsername(text ?? "");
      } catch {
        await ctx.reply(t(l, "invalid"));
        return;
      }
      try {
        await rpc("claim_username", { p_user: user.id, p_name: name });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        const k = msg.includes("PREMIUM")
          ? "premium"
          : msg.includes("TAKEN")
            ? "taken"
            : msg.includes("RESERVED")
              ? "reserved"
              : msg.includes("FROZEN")
                ? "frozen"
                : null;
        if (!k) throw error;
        await ctx.reply(t(l, k));
        return;
      }
      user = userSchema.parse(
        await rpc("onboard", { p_telegram: ctx.from.id, p_locale: l }),
      );
    }
    await prompt();
  });
  try {
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
    const { error } = await db.rpc("finish_update", {
      p_id: update.update_id,
      p_token: lease,
      p_ok: true,
    });
    if (error) return c.json({ error: "Unavailable" }, 503);
    c.executionCtx.waitUntil(deliver(bot.api, db).catch(() => undefined));
    return c.json({ ok: true });
  } catch {
    await db.rpc("finish_update", {
      p_id: update.update_id,
      p_token: lease,
      p_ok: false,
    });
    // Never log request bodies, contacts, token-bearing URLs or Supabase errors.
    console.error(
      JSON.stringify({ event: "webhook_failed", update_id: update.update_id }),
    );
    return c.json({ error: "Processing failed" }, 503);
  }
});
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });
    ctx.waitUntil(deliver(new Api(env.TELEGRAM_BOT_TOKEN), db));
  },
};
