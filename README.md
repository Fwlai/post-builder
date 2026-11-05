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
- Private bot access restricted to Telegram user IDs `6530793575` and `5272351424`
- `/post2` photo slideshow builder with an optional description and inline Done/Cancel controls
- Each `/post2` draft is published as exactly one `sendRichMessage` containing one `blockquote` with one nested `slideshow` block
- Each slideshow photo is an `InputRichBlockPhoto` using the photo's Telegram `file_id`; the Rich Message is limited to 50 media attachments

## Render setup

Create a Render Web Service connected to this repository.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

Set these environment variables in Render:

- `BOT_TOKEN`: token from BotFather
- `PUBLIC_URL`: full HTTPS service URL, for example `https://your-service.onrender.com`
- `WEBHOOK_SECRET`: optional; Render Blueprint generates one automatically

Only the two IDs listed above can use the bot. When an unauthorized user sends `/start` in a private chat, the bot replies `Sorry, This bot is private.` and sends the primary owner (ID `6530793575`) a separate notification in the format `[Display Name](tg://openmessage?user_id=USER_ID) started the bot`. The secondary admin (ID `5272351424`) is also allowed to use the bot; each `/start` from that account sends the same notification to the primary owner before the normal welcome message. Every `/start` from a non-primary account generates a separate notification, including repeated starts. The primary owner does not receive a notification about their own `/start`. No messages are deleted. Other updates from unauthorized private users are ignored.

The bot configures its Telegram webhook on startup. Do not run another polling process for the same bot token at the same time.

## Usage

In a private chat with the bot:

1. Send `/start`
2. Send `/post` for a button post, or `/post2` for a photo slideshow
3. Enter a public channel username/link
4. Enter post text or `/skip`
5. Enter button label
6. Enter button URL
7. Choose button color
8. Review the preview and press Publish

For `/post2`, send the destination channel, then send up to 50 photos. Each photo is added to the same slideshow. Use `/undo` to remove the last photo, then `/done` or the inline Done button to finish. Choose whether to add a description or skip it, review, then publish. The bot sends exactly one Rich Message whose structure is `blockquote → slideshow → photo blocks`. The optional description is the slideshow caption. This is not a `sendMediaGroup` album and it does not split into multiple messages.

The bot must be an administrator in the destination channel with permission to publish messages.

## Notes

- Draft sessions are stored in memory. A Render restart clears unfinished drafts.
- Button colors depend on the Telegram client and theme.
- Rich Messages require a Telegram Bot API server that supports `sendRichMessage`.
