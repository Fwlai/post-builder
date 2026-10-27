# Telegram Post Builder

A Telegram bot for publishing channel posts with colored Rich Message URL buttons, designed for deployment on Render.

## Features

- Choose the public destination channel for each post using `@username` or `https://t.me/username`
- Optional post text; use `/skip` for a button-only Rich Message
- Choose the button label and destination URL every time
- Supports HTTP/HTTPS URLs, including Telegram invite links such as `https://t.me/+...`
- Choose green, blue, red, or no explicit button style
- Preview and confirmation before publishing
- Direct Bot API `sendRichMessage` call, with Telegram error details shown in the chat
- Optional user allowlist via `ADMIN_IDS`

## Render setup

Create a Render Web Service connected to this repository.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Set these environment variables in Render:

- `BOT_TOKEN`: token from BotFather
- `PUBLIC_URL`: full HTTPS service URL, for example `https://your-service.onrender.com`
- `WEBHOOK_SECRET`: optional; Render Blueprint generates one automatically
- `ADMIN_IDS`: optional comma-separated Telegram numeric user IDs. If omitted, anyone who opens the bot can use it.

The bot configures its Telegram webhook on startup. Do not run another polling process for the same bot token at the same time.

## Usage

In a private chat with the bot:

1. Send `/start`
2. Send `/post`
3. Enter a public channel username/link
4. Enter post text or `/skip`
5. Enter button label
6. Enter button URL
7. Choose button color
8. Review the preview and press Publish

The bot must be an administrator in the destination channel with permission to publish messages.

## Notes

- Draft sessions are stored in memory. A Render restart clears unfinished drafts.
- Button colors depend on the Telegram client and theme.
- Rich Messages require a Telegram Bot API server that supports `sendRichMessage`.
