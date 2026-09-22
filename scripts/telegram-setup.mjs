// Run in a trusted terminal with secrets provided through environment variables.
// Never paste tokens into a browser address bar, repository, or chat.
const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !WORKER_URL)
  throw new Error(
    "Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL in the environment.",
  );
if (!/^[A-Za-z0-9_-]{32,256}$/.test(TELEGRAM_WEBHOOK_SECRET))
  throw new Error(
    "Webhook secret must be 32–256 letters, digits, underscores or hyphens.",
  );
const worker = new URL(WORKER_URL);
if (worker.protocol !== "https:") throw new Error("HTTPS required.");
async function api(method, body) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error();
    return d.result;
  } catch {
    throw new Error(`Telegram ${method} failed; no secret values logged.`);
  }
}
const me = await api("getMe", {});
console.log(`TELEGRAM_BOT_ID=${me.id}\nTELEGRAM_BOT_USERNAME=${me.username}`);
await api("setWebhook", {
  url: new URL("/telegram/webhook", worker).href,
  secret_token: TELEGRAM_WEBHOOK_SECRET,
  max_connections: 1,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});
const info = await api("getWebhookInfo", {});
if (info.url !== new URL("/telegram/webhook", worker).href)
  throw new Error("Webhook URL mismatch");
console.log(
  `Webhook verified. Pending updates: ${info.pending_update_count}. Test /start in a private chat.`,
);
