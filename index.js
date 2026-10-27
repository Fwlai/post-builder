const express = require("express");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");
const PORT = Number(process.env.PORT || 10000);
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

if (!TOKEN) {
  console.error("Missing BOT_TOKEN environment variable.");
  process.exit(1);
}
if (!PUBLIC_URL || !/^https:\/\//i.test(PUBLIC_URL)) {
  console.error("Missing PUBLIC_URL. Set it to the full HTTPS Render service URL.");
  process.exit(1);
}

const bot = new Telegraf(TOKEN);
const app = express();
const sessions = new Map();
const webhookPath = "/telegram/" + WEBHOOK_SECRET;

const COLOR_LABELS = {
  success: "Green",
  primary: "Blue",
  danger: "Red",
  none: "No color"
};

function userKey(ctx) {
  return String(ctx.from && ctx.from.id);
}

function isAllowed(ctx) {
  return ADMIN_IDS.size === 0 || ADMIN_IDS.has(userKey(ctx));
}

function getSession(ctx) {
  return sessions.get(userKey(ctx));
}

function setSession(ctx, session) {
  sessions.set(userKey(ctx), session);
}

function clearSession(ctx) {
  sessions.delete(userKey(ctx));
}

function parseChannel(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Send a public channel link or @username.");

  if (value.startsWith("@")) {
    value = value.slice(1);
  } else {
    value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    if (!/^(t\.me|telegram\.me)\//i.test(value)) {
      throw new Error("Use https://t.me/channelname or @channelname.");
    }
    value = value.replace(/^(t\.me|telegram\.me)\//i, "").split(/[/?#]/)[0];
  }

  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
    throw new Error("Invalid public channel username. The destination must be public.");
  }
  return "@" + value;
}

function validateUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Button URL cannot be empty.");
  if (/\s/.test(value)) throw new Error("URL cannot contain spaces.");
  if (!/^https?:\/\/\S+$/i.test(value)) {
    throw new Error("Enter a complete URL beginning with https:// or http://.");
  }
  const host = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  if (!host || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    throw new Error("URL hostname is invalid.");
  }
  if (host.includes("@")) throw new Error("URLs with embedded credentials are not supported.");
  return value;
}

function errorDescription(error) {
  const data = error && error.response && error.response.data;
  return String((data && (data.description || data.message)) || error.message || "Unknown error").slice(0, 1000);
}

function preview(session) {
  return [
    "POST PREVIEW",
    "",
    "Channel: " + session.channel,
    "Button: " + session.buttonText,
    "URL: " + session.buttonUrl,
    "Color: " + COLOR_LABELS[session.color],
    "",
    "Message:",
    session.body || "(Button-only post, no visible text)",
    "",
    "Publish this post?"
  ].join("\n");
}

async function sendRichPost(session) {
  const blocks = [];

  if (session.body) {
    blocks.push({ type: "paragraph", text: session.body });
  }

  const button = {
    text: session.buttonText,
    url: session.buttonUrl
  };

  if (session.color !== "none") button.style = session.color;

  blocks.push({
    type: "buttons",
    buttons: [button],
    align: "center"
  });

  const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/sendRichMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: session.channel,
      rich_message: { blocks }
    }),
    signal: AbortSignal.timeout(25000)
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Telegram returned a non-JSON response (HTTP " + response.status + ").");
  }

  if (!response.ok || !data.ok) {
    throw new Error("Telegram API " + response.status + ": " + (data.description || "Unknown API error"));
  }
  return data.result;
}

bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");
  await ctx.reply(
    "Post Builder\n\n" +
    "/post - Create a channel post\n" +
    "/cancel - Cancel the current draft\n\n" +
    "Choose the channel, post text, button text, URL and button color for every post."
  );
});

bot.command("post", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Use this command in a private chat.");
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");

  setSession(ctx, {
    stage: "channel",
    channel: "",
    body: "",
    buttonText: "",
    buttonUrl: "",
    color: "none"
  });

  await ctx.reply(
    "Step 1 of 5\n\nSend the destination public channel link or username.\n\n" +
    "Examples:\nhttps://t.me/channelname\n@channelname"
  );
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx);
  await ctx.reply("Draft cancelled.");
});

bot.on("text", async (ctx, next) => {
  if (ctx.chat.type !== "private" || !isAllowed(ctx)) return next();

  const text = String(ctx.message.text || "").trim();
  const session = getSession(ctx);
  if (!session) return next();
  if (text.startsWith("/") && !/^\/skip(?:@\w+)?$/i.test(text)) return next();

  try {
    if (session.stage === "channel") {
      session.channel = parseChannel(text);
      session.stage = "body";
      setSession(ctx, session);
      return ctx.reply("Step 2 of 5\n\nSend the post text, or /skip for a button-only post.");
    }

    if (session.stage === "body") {
      session.body = /^\/skip(?:@\w+)?$/i.test(text) ? "" : text;
      if (session.body.length > 4096) {
        return ctx.reply("Post text exceeds 4096 characters. Send a shorter text or use /skip.");
      }
      session.stage = "buttonText";
      setSession(ctx, session);
      return ctx.reply("Step 3 of 5\n\nSend the exact button text.");
    }

    if (session.stage === "buttonText") {
      if (!text) return ctx.reply("Button text cannot be empty.");
      if ([...text].length > 64) return ctx.reply("Button text must be 64 characters or fewer.");
      session.buttonText = text;
      session.stage = "buttonUrl";
      setSession(ctx, session);
      return ctx.reply("Step 4 of 5\n\nSend the button destination URL, including https://.");
    }

    if (session.stage === "buttonUrl") {
      session.buttonUrl = validateUrl(text);
      session.stage = "color";
      setSession(ctx, session);
      return ctx.reply("Step 5 of 5\n\nChoose button color.", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Green", callback_data: "pb:color:success" },
              { text: "Blue", callback_data: "pb:color:primary" }
            ],
            [
              { text: "Red", callback_data: "pb:color:danger" },
              { text: "No color", callback_data: "pb:color:none" }
            ]
          ]
        }
      });
    }

    if (session.stage === "confirm") {
      return ctx.reply("Use Publish or Cancel in the preview.");
    }
  } catch (error) {
    await ctx.reply("Input error: " + errorDescription(error) + "\n\nSend /post to start again.");
    clearSession(ctx);
  }
});

bot.on("callback_query", async (ctx, next) => {
  const data = String((ctx.callbackQuery && ctx.callbackQuery.data) || "");
  if (!data.startsWith("pb:")) return next();

  try {
    await ctx.answerCbQuery();
    if (ctx.chat && ctx.chat.type !== "private") return;
    if (!isAllowed(ctx)) return;

    const session = getSession(ctx);
    if (!session) return ctx.reply("Draft expired. Send /post to start again.");

    if (data.startsWith("pb:color:")) {
      if (session.stage !== "color") return ctx.reply("This color selection is no longer active.");
      const color = data.slice("pb:color:".length);
      if (!Object.prototype.hasOwnProperty.call(COLOR_LABELS, color)) {
        return ctx.reply("Invalid color.");
      }

      session.color = color;
      session.stage = "confirm";
      setSession(ctx, session);

      return ctx.reply(preview(session), {
        reply_markup: {
          inline_keyboard: [[
            { text: "Publish", callback_data: "pb:publish" },
            { text: "Cancel", callback_data: "pb:cancel" }
          ]]
        }
      });
    }

    if (data === "pb:cancel") {
      clearSession(ctx);
      return ctx.reply("Draft cancelled.");
    }

    if (data === "pb:publish") {
      if (session.stage !== "confirm") return ctx.reply("This draft is not ready to publish.");

      try {
        await sendRichPost(session);
        clearSession(ctx);
        return ctx.reply("Published successfully to " + session.channel + ".");
      } catch (error) {
        return ctx.reply(
          "Publishing failed:\n\n" + errorDescription(error) +
          "\n\nYour draft has been kept. Press Publish to retry or send /cancel."
        );
      }
    }
  } catch (error) {
    try { await ctx.reply("Error: " + errorDescription(error)); } catch {}
  }
});

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "post-builder" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post(webhookPath, express.json({ limit: "1mb" }), async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook update failed:", errorDescription(error));
    res.sendStatus(500);
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Post Builder listening on port " + PORT);
  try {
    await bot.telegram.setWebhook(PUBLIC_URL + webhookPath, {
      secret_token: WEBHOOK_SECRET
    });
    console.log("Telegram webhook configured.");
  } catch (error) {
    console.error("Failed to configure Telegram webhook:", errorDescription(error));
    process.exit(1);
  }
});

process.once("SIGINT", () => bot.telegram.deleteWebhook().finally(() => process.exit(0)));
process.once("SIGTERM", () => bot.telegram.deleteWebhook().finally(() => process.exit(0)));
