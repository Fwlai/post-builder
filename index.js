const express = require("express");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");
const { listChannels, addChannel, deleteChannel, getChannel, loadDraft, saveDraft, deleteDraft } = require("./storage");

const TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");
const PORT = Number(process.env.PORT || 10000);
// Only these Telegram accounts may use the bot.
const ADMIN_IDS = new Set(["6530793575", "5272351424"]);

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
const hydratedUsers = new Set();
const persistenceQueues = new Map();
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
  return Boolean(ctx.from) && ADMIN_IDS.has(userKey(ctx));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

// Apply the allowlist before every command, message, and callback handler.
// Every /start except the primary owner's notifies the primary owner. The
// secondary admin is still allowed through to the normal /start handler.
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type === "private" && ctx.from) {
    const messageText = ctx.message && ctx.message.text;
    const isStart = typeof messageText === "string" &&
      /^\/start(?:@\w+)?(?:\s|$)/i.test(messageText);
    const currentUserId = userKey(ctx);

    if (isStart && currentUserId !== "6530793575") {
      const displayName = [ctx.from.first_name, ctx.from.last_name]
        .filter(Boolean)
        .join(" ") || "Telegram user";
      const notification =
        '<a href="tg://openmessage?user_id=' + currentUserId + '">' +
        escapeHtml(displayName) +
        "</a> started the bot";

      try {
        await ctx.telegram.sendMessage("6530793575", notification, {
          parse_mode: "HTML"
        });
      } catch (error) {
        console.error("Failed to send /start notification to primary owner:", errorDescription(error));
      }
    }

    if (!isAllowed(ctx)) {
      if (isStart) await ctx.reply("Sorry, This bot is private.");
      return;
    }

    if (!hydratedUsers.has(currentUserId)) {
      try {
        const savedDraft = await loadDraft(currentUserId);
        if (savedDraft) sessions.set(currentUserId, savedDraft);
        hydratedUsers.add(currentUserId);
      } catch (error) {
        console.error("Failed to restore the user draft:", errorDescription(error));
        await ctx.reply("Storage is temporarily unavailable. Please try again shortly.");
        return;
      }
    }
  }

  return next();
});

function getSession(ctx) {
  return sessions.get(userKey(ctx));
}

function queuePersistence(owner, operation) {
  const previous = persistenceQueues.get(owner) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  persistenceQueues.set(owner, next);
  next.catch((error) => console.error("Draft persistence failed:", errorDescription(error)));
  return next;
}

function setSession(ctx, session) {
  const owner = userKey(ctx);
  sessions.set(owner, session);
  if (session.type !== "channel-management") {
    queuePersistence(owner, () => saveDraft(owner, session));
  }
}

function clearSession(ctx) {
  const owner = userKey(ctx);
  const previous = sessions.get(owner);
  sessions.delete(owner);
  if (previous && previous.type === "channel-management") {
    queuePersistence(owner, async () => {
      const saved = await loadDraft(owner);
      if (saved) sessions.set(owner, saved);
    });
  } else {
    queuePersistence(owner, () => deleteDraft(owner));
  }
}

async function showChannelPicker(ctx) {
  const channels = await listChannels(userKey(ctx));
  if (!channels.length) {
    return ctx.reply("You have no saved channels yet. Send /addchannel to register one.");
  }
  const rows = channels.map((channel) => [{
    text: channel.title + (channel.username ? " (" + channel.username + ")" : ""),
    callback_data: "ch:use:" + channel.id
  }]);
  rows.push([{ text: "Add a channel", callback_data: "ch:add" }]);
  rows.push([{ text: "Cancel", callback_data: "ch:cancel" }]);
  return ctx.reply("Choose a saved destination channel:", {
    reply_markup: { inline_keyboard: rows }
  });
}

async function beginDraft(ctx, type) {
  const session = {
    type,
    stage: "chooseChannel",
    nextStage: type === "post2" ? "albumCollect" : type === "post3" ? "post3Mode" : "body",
    channel: "",
    channelRecordId: "",
    ...(type === "post" ? { body: "", buttonText: "", buttonUrl: "", color: "none" } : {}),
    ...(type === "post2" || type === "post3" ? { photoFileIds: [], description: "" } : {})
  };
  setSession(ctx, session);
  return showChannelPicker(ctx);
}

function parseMessageLink(input) {
  const raw = String(input || "").trim();
  const match = raw.match(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/(\d+)(?:[/?#].*)?$/i);
  if (!match) {
    throw new Error("Send a public Telegram message link like https://t.me/channelname/39.");
  }
  const messageId = Number(match[2]);
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    throw new Error("The message ID in that link is invalid.");
  }
  return {
    chatId: "@" + match[1],
    messageId,
    url: raw
  };
}

function parseChannel(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Send a public channel link or @username.");

  const messageLink = value.match(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/(\d+)(?:[/?#].*)?$/i);
  if (messageLink) {
    const replyTo = parseMessageLink(value);
    return { channel: replyTo.chatId, replyTo };
  }

  if (value.startsWith("@")) {
    value = value.slice(1);
  } else {
    value = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    if (!/^(t\.me|telegram\.me)\//i.test(value)) {
      throw new Error("Use https://t.me/channelname, a message link like https://t.me/channelname/39, or @channelname.");
    }
    value = value.replace(/^(t\.me|telegram\.me)\//i, "").split(/[/?#]/)[0];
  }

  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
    throw new Error("Invalid public channel username. The destination must be public.");
  }
  return { channel: "@" + value, replyTo: null };
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
    "Reply: " + (session.replyTo ? session.replyTo.chatId + " / message " + session.replyTo.messageId : "No reply"),
    "",
    "Message:",
    session.body || "(Button-only post, no visible text)",
    "",
    "Publish this post?"
  ].join("\n");
}

function slideshowPreview(session) {
  return [
    "SLIDESHOW PREVIEW",
    "",
    "Channel: " + session.channel,
    "Photos: " + session.photoFileIds.length,
    "Format: One Rich Message (slideshow inside block quote)",
    ...(session.type === "post3" ? ["Top text (" + (session.textMode === "heading" ? "h6 heading" : "paragraph") + "): " + session.topText] : []),
    "Description: " + (session.description || "(none)"),
    "",
    "Publish this slideshow?"
  ].join("\n");
}

function slideshowPreviewKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Publish", callback_data: "pb2:publish" }],
      [{ text: "Cancel", callback_data: "pb2:cancel" }]
    ]
  };
}

function buildRichSlideshow(session) {
  if (!Array.isArray(session.photoFileIds) || session.photoFileIds.length < 1) {
    throw new Error("Add at least one photo before publishing.");
  }
  if (session.photoFileIds.length > 50) {
    throw new Error("A Telegram Rich Message can contain at most 50 media attachments.");
  }

  const orderedPhotos = [...session.photoFileIds].sort((a, b) => a.messageId - b.messageId);
  if (orderedPhotos.some((photo) => !photo || typeof photo.fileId !== "string" || !photo.fileId)) {
    throw new Error("One or more collected photos are invalid. Remove the last photo or restart the slideshow.");
  }

  const slideshow = {
    type: "slideshow",
    blocks: orderedPhotos.map((photo) => ({
      type: "photo",
      photo: { type: "photo", media: photo.fileId }
    }))
  };

  if (session.description) {
    slideshow.caption = { text: session.description };
  }

  const blocks = [];
  if (session.type === "post3") {
    if (!session.topText || !["paragraph", "heading"].includes(session.textMode)) {
      throw new Error("The top text is missing or its format is invalid.");
    }
    blocks.push(session.textMode === "heading"
      ? { type: "heading", size: 6, text: session.topText }
      : { type: "paragraph", text: session.topText });
  }
  blocks.push({
    type: "blockquote",
    blocks: [slideshow]
  });
  return { blocks };
}

async function sendRichSlideshow(session) {
  const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/sendRichMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: session.channel,
      rich_message: buildRichSlideshow(session)
    }),
    signal: AbortSignal.timeout(30000)
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Telegram returned a non-JSON response (HTTP " + response.status + ").");
  }

  if (!response.ok || !data || !data.ok) {
    throw new Error("Telegram API " + response.status + ": " + ((data && data.description) || "Unknown API error"));
  }
  if (!data.result) {
    throw new Error("Telegram reported success but returned no message result.");
  }
  return data.result;
}

function previewKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Reply to message", callback_data: "pb:replylink" },
        { text: "No reply", callback_data: "pb:noreply" }
      ],
      [{ text: "Publish", callback_data: "pb:publish" }],
      [{ text: "Cancel", callback_data: "pb:cancel" }]
    ]
  };
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
      rich_message: { blocks },
      ...(session.replyTo ? {
        reply_parameters: {
          chat_id: session.replyTo.chatId === session.channel ? undefined : session.replyTo.chatId,
          message_id: session.replyTo.messageId,
          allow_sending_without_reply: false
        }
      } : {})
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
    "/post - Create a channel post with a URL button\n" +
    "/post2 - Build a photo slideshow for a channel\n" +
    "/done - Finish collecting slideshow photos\n" +
    "/undo - Remove the last collected slideshow photo\n" +
    "/cancel - Cancel the current draft\n\n" +
    "/post3 - Add text above a quoted photo slideshow\n" +
    "/channels - Manage your saved channels\n" +
    "/addchannel - Register a channel\n\n" +
    "Use /post, /post2, or /post3 to create a post."
  );
});

bot.command("post", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Use this command in a private chat.");
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");

  await beginDraft(ctx, "post");
});


bot.command("post2", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Use this command in a private chat.");
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");

  await beginDraft(ctx, "post2");
});


bot.command("post3", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Use this command in a private chat.");
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");
  await beginDraft(ctx, "post3");
});

bot.command("addchannel", async (ctx) => {
  if (ctx.chat.type !== "private" || !isAllowed(ctx)) return;
  const session = { type: "channel-management", stage: "registerChannel" };
  setSession(ctx, session);
  await ctx.reply("Send the public channel @username or https://t.me/channelname. The bot must be an administrator with permission to post.");
});

bot.command("channels", async (ctx) => {
  if (ctx.chat.type !== "private" || !isAllowed(ctx)) return;
  const channels = await listChannels(userKey(ctx));
  if (!channels.length) return ctx.reply("No saved channels. Use /addchannel to add one.");
  const lines = channels.map((c, i) => (i + 1) + ". " + c.title + (c.username ? " (" + c.username + ")" : "") + "\nID: " + c.chat_id);
  const rows = channels.map((c) => [{ text: "Delete " + c.title, callback_data: "ch:delete:" + c.id }]);
  rows.push([{ text: "Add channel", callback_data: "ch:add" }]);
  await ctx.reply("Your saved channels:\n\n" + lines.join("\n\n"), { reply_markup: { inline_keyboard: rows } });
});

bot.command("done", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");
  const session = getSession(ctx);
  if (!session || !["albumCollect", "post3Collect"].includes(session.stage)) {
    return ctx.reply("There is no slideshow currently collecting photos. Send /post2 or /post3 to start.");
  }
  if (session.photoFileIds.length === 0) {
    return ctx.reply("Send at least one photo before finishing.");
  }
  session.stage = "albumDescriptionChoice";
  setSession(ctx, session);
  return ctx.reply(
    "Collected " + session.photoFileIds.length + " photo(s). Should the slideshow have a description?\n\n" +
    "Choose Skip description or Add description.",
    { reply_markup: { inline_keyboard: [[
      { text: "Skip description", callback_data: "pb2:skipdesc" },
      { text: "Add description", callback_data: "pb2:adddesc" }
    ], [{ text: "Cancel", callback_data: "pb2:cancel" }]] } }
  );
});

bot.command("undo", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Use this command in a private chat.");
  if (!isAllowed(ctx)) return ctx.reply("You are not authorized to use this bot.");
  const session = getSession(ctx);
  if (!session || !["albumCollect", "post3Collect"].includes(session.stage)) {
    return ctx.reply("There is no slideshow currently collecting photos.");
  }
  if (!session.photoFileIds.length) return ctx.reply("There are no photos to remove.");
  session.photoFileIds.pop();
  setSession(ctx, session);
  return ctx.reply("Removed the last photo. " + session.photoFileIds.length + " photo(s) remain.");
});

bot.on("photo", async (ctx, next) => {
  if (ctx.chat.type !== "private" || !isAllowed(ctx)) return next();
  const session = getSession(ctx);
  if (!session || !["albumCollect", "post3Collect"].includes(session.stage)) return next();

  if (session.photoFileIds.length >= 50) {
    return ctx.reply("This slideshow has reached Telegram's 50-photo Rich Message limit. Use /done to continue or /undo to remove the last photo.");
  }

  const photos = ctx.message.photo || [];
  const largest = photos[photos.length - 1];
  if (!largest || !largest.file_id) return ctx.reply("I couldn't read that photo. Please send it again.");
  session.photoFileIds.push({ messageId: ctx.message.message_id, fileId: largest.file_id });
  session.photoFileIds.sort((a, b) => a.messageId - b.messageId);
  setSession(ctx, session);
  return ctx.reply(
    "Photo " + session.photoFileIds.length + " added. " +
    (session.photoFileIds.length >= 50 ? "The 50-photo limit is reached. Use /done or /undo." : "Send more photos, /undo to remove the last one, or /done to finish."),
    { reply_markup: { inline_keyboard: [
      [
        { text: "Done, continue", callback_data: "pb2:done" },
        { text: "Undo last photo", callback_data: "pb2:undo" }
      ],
      [{ text: "Cancel", callback_data: "pb2:cancel" }]
    ] } }
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

    if (session.stage === "registerChannel") {
      const parsed = parseChannel(text);
      if (parsed.replyTo) throw new Error("Send the channel username or channel link, not a message link.");
      const chat = await ctx.telegram.getChat(parsed.channel);
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chat.id, me.id);
      if (!["administrator", "creator"].includes(member.status)) {
        throw new Error("The bot is not an administrator in that channel. Add it as an admin first.");
      }
      if (member.status === "administrator" && member.can_post_messages === false) {
        throw new Error("The bot is an admin but does not have permission to post messages.");
      }
      const username = chat.username ? "@" + chat.username : null;
      await addChannel(userKey(ctx), { chatId: chat.id, username, title: chat.title || username || String(chat.id) });
      clearSession(ctx);
      return ctx.reply("Channel saved to this account: " + (chat.title || username) + "\nNumeric chat ID stored: " + chat.id);
    }

    if (session.stage === "post3Text") {
      if (!text || text.startsWith("/")) return ctx.reply("Send the top text, or use /cancel to discard the draft.");
      if ([...text].length > 4096) return ctx.reply("Top text must be 4096 characters or fewer.");
      session.topText = text;
      session.stage = "post3Collect";
      setSession(ctx, session);
      return ctx.reply("Top text saved. Now send up to 50 photos for the slideshow. Use /done when finished.");
    }

    if (session.stage === "albumChannel") {
      const parsed = parseChannel(text);
      if (parsed.replyTo) throw new Error("For /post2, send a channel link or @username, not a specific message link.");
      session.channel = parsed.channel;
      session.stage = "albumCollect";
      setSession(ctx, session);
      return ctx.reply("Destination saved: " + session.channel + "\n\nNow send photos one by one or in batches. Use /done when you've sent them all.");
    }

    if (session.stage === "albumDescription") {
      if ([...text].length > 1024) return ctx.reply("Description must be 1024 characters or fewer. Send a shorter description or /skip.");
      session.description = /^\/skip(?:@\w+)?$/i.test(text) ? "" : text;
      session.stage = "albumConfirm";
      setSession(ctx, session);
      return ctx.reply(slideshowPreview(session), { reply_markup: slideshowPreviewKeyboard() });
    }

    if (session.stage === "albumConfirm") {
      return ctx.reply("Use the preview buttons to publish or cancel this slideshow.");
    }

    if (session.stage === "channel") {
      const parsed = parseChannel(text);
      session.channel = parsed.channel;
      session.replyTo = parsed.replyTo;
      session.stage = "body";
      setSession(ctx, session);
      const replyNote = session.replyTo
        ? "\nDetected message link. This post will reply to message " + session.replyTo.messageId + " unless you change it in the preview."
        : "";
      return ctx.reply("Step 2 of 5\n\nSend the post text, or /skip for a button-only post." + replyNote);
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

    if (session.stage === "replyLink") {
      const target = parseMessageLink(text);
      session.replyTo = target;
      session.stage = "confirm";
      setSession(ctx, session);
      return ctx.reply(
        "Reply target saved.\n\n" + preview(session),
        { reply_markup: previewKeyboard() }
      );
    }

    if (session.stage === "confirm") {
      return ctx.reply("Use the preview buttons to change the reply target, publish, or cancel.");
    }
  } catch (error) {
    if (session.stage === "replyLink") {
      await ctx.reply("Reply link error: " + errorDescription(error) + "\n\nSend a valid public message link, or use /cancel to discard the draft.");
      return;
    }
    await ctx.reply("Input error: " + errorDescription(error) + "\n\nPlease try again for the current step, or send /cancel to discard the draft.");
  }
});

bot.on("callback_query", async (ctx, next) => {
  const data = String((ctx.callbackQuery && ctx.callbackQuery.data) || "");
  if (!data.startsWith("pb:") && !data.startsWith("pb2:") && !data.startsWith("pb3:") && !data.startsWith("ch:")) return next();

  try {
    await ctx.answerCbQuery();
    if (ctx.chat && ctx.chat.type !== "private") return;
    if (!isAllowed(ctx)) return;

    if (data === "ch:cancel") {
      clearSession(ctx);
      return ctx.reply("Draft cancelled.");
    }
    if (data === "ch:add") {
      setSession(ctx, { type: "channel-management", stage: "registerChannel" });
      return ctx.reply("Send the public channel @username or https://t.me/channelname. The bot must be an administrator with posting rights.");
    }
    if (data.startsWith("ch:delete:")) {
      const removed = await deleteChannel(userKey(ctx), data.slice("ch:delete:".length));
      return ctx.reply(removed ? "Channel removed from your saved list." : "That saved channel was not found in your account.");
    }
    if (data.startsWith("ch:use:")) {
      const session = getSession(ctx);
      if (!session || session.stage !== "chooseChannel") return ctx.reply("Start a post first with /post, /post2, or /post3.");
      const channel = await getChannel(userKey(ctx), data.slice("ch:use:".length));
      if (!channel) return ctx.reply("That channel is not saved in your account.");
      session.channel = String(channel.chat_id);
      session.channelRecordId = channel.id;
      session.channelTitle = channel.title;
      session.stage = session.nextStage;
      delete session.nextStage;
      setSession(ctx, session);
      if (session.type === "post") return ctx.reply("Destination: " + channel.title + "\n\nStep 1: Send the post text, or /skip for a button-only post.");
      if (session.type === "post2") return ctx.reply("Destination: " + channel.title + "\n\nNow send up to 50 photos. Use /done when finished.");
      return ctx.reply("Destination: " + channel.title + "\n\nChoose the format for the top text:", { reply_markup: { inline_keyboard: [[
        { text: "Plain text", callback_data: "pb3:plain" },
        { text: "Small heading (h6)", callback_data: "pb3:heading" }
      ], [{ text: "Cancel", callback_data: "ch:cancel" }]] } });
    }

    const session = getSession(ctx);
    if (!session) return ctx.reply("Draft expired. Send /post, /post2, or /post3 to start again.");

    if (data === "pb3:plain" || data === "pb3:heading") {
      if (session.type !== "post3" || session.stage !== "post3Mode") return ctx.reply("Text format selection is not active.");
      session.textMode = data === "pb3:heading" ? "heading" : "paragraph";
      session.stage = "post3Text";
      setSession(ctx, session);
      return ctx.reply("Send the text that should appear above the quoted slideshow.");
    }

    if (data.startsWith("pb2:")) {
      if (data === "pb2:cancel") {
        clearSession(ctx);
        return ctx.reply("Slideshow cancelled.");
      }
      if (data === "pb2:undo") {
        if (!["albumCollect", "post3Collect"].includes(session.stage)) return ctx.reply("Photo collection is not active.");
        if (!session.photoFileIds.length) return ctx.reply("There are no photos to remove.");
        session.photoFileIds.pop();
        setSession(ctx, session);
        return ctx.reply("Removed the last photo. " + session.photoFileIds.length + " photo(s) remain.");
      }
      if (data === "pb2:done") {
        if (!["albumCollect", "post3Collect"].includes(session.stage)) return ctx.reply("Photo collection is not active.");
        if (!session.photoFileIds.length) return ctx.reply("Send at least one photo first.");
        session.stage = "albumDescriptionChoice";
        setSession(ctx, session);
        return ctx.reply("Collected " + session.photoFileIds.length + " photo(s). Add a description or skip it?", {
          reply_markup: { inline_keyboard: [[
            { text: "Skip description", callback_data: "pb2:skipdesc" },
            { text: "Add description", callback_data: "pb2:adddesc" }
          ], [{ text: "Cancel", callback_data: "pb2:cancel" }]] }
        });
      }
      if (data === "pb2:skipdesc" || data === "pb2:adddesc") {
        if (session.stage !== "albumDescriptionChoice") return ctx.reply("Description choice is not active.");
        if (data === "pb2:skipdesc") {
          session.description = "";
          session.stage = "albumConfirm";
          setSession(ctx, session);
          return ctx.reply(slideshowPreview(session), { reply_markup: slideshowPreviewKeyboard() });
        }
        session.stage = "albumDescription";
        setSession(ctx, session);
        return ctx.reply("Send the slideshow description (up to 1024 characters), or /skip for no description.");
      }
      if (data === "pb2:publish") {
        if (session.stage !== "albumConfirm") return ctx.reply("This slideshow is not ready to publish.");
        if (session.publishing) return ctx.reply("This slideshow is already being published.");
        if (!session.photoFileIds.length) return ctx.reply("Add at least one photo first.");
        if (session.photoFileIds.length > 50) return ctx.reply("A Telegram Rich Message can contain at most 50 photos.");

        session.publishing = true;
        setSession(ctx, session);

        try {
          await sendRichSlideshow(session);
          const photoCount = session.photoFileIds.length;
          clearSession(ctx);
          return ctx.reply("One Rich Message slideshow was published to " + session.channel + " (" + photoCount + " photo(s), inside one block quote).");
        } catch (error) {
          session.publishing = false;
          setSession(ctx, session);
          const timeoutNote = error && (error.name === "TimeoutError" || error.name === "AbortError")
            ? "\n\nThe request timed out. Telegram may still have received it, so check the channel before retrying to avoid a duplicate."
            : "";
          return ctx.reply("Publishing failed:\n\n" + errorDescription(error) + timeoutNote + "\n\nYour slideshow draft has been kept. Press Publish to retry or send /cancel.");
        }
      }
    }

    if (data.startsWith("pb:color:")) {
      if (session.stage !== "color") return ctx.reply("This color selection is no longer active.");
      const color = data.slice("pb:color:".length);
      if (!Object.prototype.hasOwnProperty.call(COLOR_LABELS, color)) {
        return ctx.reply("Invalid color.");
      }

      session.color = color;
      session.stage = "confirm";
      setSession(ctx, session);

      return ctx.reply(preview(session), { reply_markup: previewKeyboard() });
    }

    if (data === "pb:replylink") {
      if (session.stage !== "confirm") return ctx.reply("Finish the draft first.");
      session.stage = "replyLink";
      setSession(ctx, session);
      return ctx.reply("Send the direct link to the message this post should reply to, for example https://t.me/channelname/39.");
    }

    if (data === "pb:noreply") {
      if (session.stage !== "confirm") return ctx.reply("This draft is not ready.");
      session.replyTo = null;
      setSession(ctx, session);
      return ctx.reply(preview(session), { reply_markup: previewKeyboard() });
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
