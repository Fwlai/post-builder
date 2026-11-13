# Telegram Post Builder

A Telegram bot for publishing channel posts with colored Rich Message URL buttons, designed for deployment on Render.

## Features

- Register destination channels by public `@username`; the bot resolves and stores each numeric Telegram chat ID
- Optional post text; use `/skip` for a button-only Rich Message
- Choose the button label and destination URL every time
- Supports HTTP/HTTPS URLs, including Telegram invite links such as `https://t.me/+...`
- Choose green, blue, red, or no explicit button style
- Preview and confirmation before publishing
- Direct Bot API `sendRichMessage` call, with Telegram error details shown in the chat
- Private bot access restricted to Telegram user IDs `6530793575` and `5272351424`
- `/post2` photo slideshow builder with an optional description and inline Done/Cancel controls
- `/post3` text-plus-slideshow builder with paragraph or h6 heading above a quoted slideshow
- Per-account saved channel workspaces using numeric Telegram chat IDs
- Persistent drafts stored in Supabase and restored after Render restarts
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

1. Send `/start`.
2. Register each destination with `/addchannel` using its public `@username`. The bot must be an administrator with posting permission.
3. Use `/channels` to review saved destinations.
4. Send `/post`, `/post2`, or `/post3` and choose a saved channel.
5. Follow the prompts, review the preview, then publish.

For `/post2`, choose a saved channel, send up to 50 photos, then use `/done` or the inline Done button. Add an optional description or skip it, review, then publish. It sends one Rich Message with the slideshow inside one block quote.

For `/post3`, choose a saved channel, select **Plain text** or **Small heading (h6)**, enter the text that appears outside and above the quote, then send up to 50 photos. Finish with `/done`, add or skip the slideshow description, review, and publish. The bot sends exactly one Rich Message with this structure: `paragraph/heading → blockquote → slideshow → photo blocks`. The description is the slideshow caption, so it remains inside the quote with the slideshow. This is not a `sendMediaGroup` album and it does not split into multiple messages.

The bot must be an administrator in the destination channel with permission to publish messages.

## Notes

- Saved channels and active drafts are stored in Supabase. Drafts are scoped to each allowed Telegram account and restored after a Render restart.
- Button colors depend on the Telegram client and theme.
- Rich Messages require a Telegram Bot API server that supports `sendRichMessage`.


## Supabase setup for saved channels and drafts

The connected Supabase project has already been provisioned with the tables defined in `supabase/migrations/20261113153402_post_builder_storage.sql`. For a fresh project, apply that migration before deploying.

In the Render service environment, set:
- `SUPABASE_URL`: the project URL.
- `SUPABASE_SECRET_KEY`: a Supabase secret key. The legacy `SUPABASE_SERVICE_ROLE_KEY` variable is also accepted.

Keep this key only in Render's server-side environment. Never put it in the repository or expose it to a client app. Deploy `feature/post3-channel-workspaces` only after verifying the required environment variables.

Channel and draft queries are always scoped by the Telegram sender ID. The service-role key is used only by the server; do not expose it to users or frontend code.

## New commands

- `/channels`: list and remove channels saved by the current Telegram account.
- `/addchannel`: register a public channel by username. The bot must be an administrator with posting permission.
- `/post3`: create a text-plus-slideshow Rich Message. The text is a paragraph or an h6 heading above the slideshow; the slideshow remains inside one block quote.

Each allowed Telegram account has a separate channel list and one persistent active draft. The stored numeric channel ID is used for publishing, so a later username change does not change the destination.
