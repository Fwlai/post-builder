const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");

const originalStart = Telegraf.prototype.start;
Telegraf.prototype.start = function (...args) {
  const html = fs.readFileSync(path.join(__dirname, "snake-widget.html"), "utf8");
  this.command("wid", async (ctx) => {
    if (!ctx.chat || ctx.chat.type !== "private") {
      return ctx.reply("Use /wid in a private chat with me.");
    }
    if (!ctx.from || !["6530793575", "5272351424"].includes(String(ctx.from.id))) {
      return ctx.reply("You are not authorized to use this bot.");
    }
    try {
      await ctx.telegram.callApi("sendWidget", {
        chat_id: ctx.chat.id,
        html,
        width: 320,
        height: 470,
        caption: "SNAKE / A tiny snack-sized game. Eat the golden orbs, grow longer, and try not to eat yourself."
      });
    } catch (error) {
      const description = error && error.response && error.response.description
        ? error.response.description
        : error.message || "Unknown Telegram API error";
      console.error("Failed to send Snake widget:", description);
      await ctx.reply("I couldn't send the Snake widget: " + String(description).slice(0, 700));
    }
  });
  Telegraf.prototype.start = originalStart;
  return originalStart.apply(this, args);
};

require("./index");
