# GeeBot Status Summary

## Project Overview
GeeBot is a Kick.com chatbot platform (competitor to kickbot.com / botrix.live). Streamers link their channel via OAuth and the bot (the `gee-bot` Kick account) chats in their channel with AI responses, point systems, and OBS overlays.

## Tech Stack
- **Backend:** Node.js, Express.js, TypeScript (`ts-node` in prod)
- **Real-time:** Socket.IO
- **Database:** SQLite (`better-sqlite3`), Railway Volume at `/app/data/geebot.db`
- **Auth:** Kick OAuth 2.1 PKCE (Authorization Code Flow for users, Client Credentials for public API reads)

## Hosting
- **Live URL:** `https://geebot-production-7894.up.railway.app`
- **Provider:** Railway.app (GitHub → main branch auto-deploy)

## Bot Account
- **Kick slug:** `gee-bot`
- **broadcaster_user_id:** `98951740`
- **Developer App Client ID:** `01KJYGD33HSJ3CNMJFK7GRZ2D8`

## Railway Environment Variables (must be set)
| Key | Value |
|---|---|
| `KICK_API_CLIENT_ID` | `01KJYGD33HSJ3CNMJFK7GRZ2D8` |
| `KICK_API_CLIENT_SECRET` | (from .env) |
| `KICK_REDIRECT_URI` | `https://geebot-production-7894.up.railway.app/auth/kick/callback` |
| `GROK_API_KEY` | (from .env) |
| `BOT_KICK_SLUG` | `gee-bot` |
| `DATABASE_PATH` | `/app/data` |
| `PORT` | `3000` |

## ✅ What Works
1. OAuth PKCE flow (link channel → Kick → callback → token exchange)
2. User info fetching from `/public/v1/users`
3. Token stored in SQLite per channel_id
4. Webhook endpoint with RSA signature verification (Kick public key hardcoded)
5. Dashboard, OBS overlays, WebSocket broadcaster
6. Railway deployment + persistent DB volume
7. App Access Token (Client Credentials) for public API reads (channels, etc.)

## ✅ Bugs Fixed (by Claude Code, March 2026)
1. **`sendChatMessage`** — was using App Token (Client Credentials) which Kick rejects for chat. Now accepts optional `userToken`. Uses `broadcaster_user_id` (integer) not `channel_id` (string).
2. **Webhook event type** — was `'ChatMessageSent'`, now correctly `'chat.message.sent'`
3. **Webhook payload fields** — sender ID now `data.sender.user_id`, channel ID now `data.broadcaster.user_id`
4. **`chat_history` INSERT** — was missing `channel_id` param (3 params instead of 4)
5. **Bot self-link detection** — `/api/auth/complete` now detects when the `gee-bot` account itself does OAuth and stores as `__bot__/bot_user_token` globally
6. **`getSendToken()` helper** — prioritises bot token, falls back to channel streamer token
7. **`.env` duplicate PORT** — removed
8. **`simulate_chat.ts`** — updated to real Kick webhook format for local testing

## ❌ Current Blocker — Bot Token Not Yet Stored
The bot (`gee-bot`) needs to do OAuth **once** to store its User Access Token in the DB. Until that's done, `getSendToken()` will return `undefined` and chat sends will fail.

### How to link the bot account (MUST DO NEXT)
1. Deploy current code to Railway (push to GitHub main)
2. Open the dashboard: `https://geebot-production-7894.up.railway.app`
3. **Log into Kick as `gee-bot` in the same browser session**
4. Click **"Link Channel"** on the dashboard
5. Complete the Kick OAuth flow
6. The server detects `gee-bot` slug → stores token as `__bot__/bot_user_token` in DB
7. All future `sendChatMessage` calls will use this token

### Then link a streamer channel to test
1. While logged in as a streamer on Kick
2. Click "Link Channel" again
3. Bot sends welcome message using the stored bot token → should appear as `gee-bot` in chat

## Kick Developer Portal Checklist (https://kick.com/dashboard/developer)
These settings must be correct on the app registered under the `gee-bot` account:

- [ ] **Redirect URI registered:** `https://geebot-production-7894.up.railway.app/auth/kick/callback`
- [ ] **Webhook URL set:** `https://geebot-production-7894.up.railway.app/webhook/kick`
- [ ] **Webhook event subscribed:** `chat.message.sent`
- [ ] **OAuth Scopes enabled:** `user:read`, `channel:read`, `chat:write`, `events:subscribe`

## Architecture — How Token Sending Works
```
gee-bot does OAuth once → stored as settings('__bot__', 'bot_user_token')
                                         ↓
Webhook fires (streamer chat) → getSendToken(channelId)
    → tries __bot__ bot_user_token first   ← CORRECT: messages appear as gee-bot
    → falls back to channel's kick_user_token  ← messages appear as the streamer
                                         ↓
sendChatMessage(broadcaster_user_id, message, token)
    → POST /public/v1/chat { broadcaster_user_id: int, type: 'bot', content: '...' }
```

## Key Files
- `src/index.ts` — Express server, OAuth, webhook, `getSendToken()`, `BOT_KICK_SLUG`
- `src/kick_api.ts` — All Kick API calls, `sendChatMessage(broadcasterUserId, message, userToken?)`
- `src/ai.ts` — Grok AI via xAI API (OpenAI-compatible)
- `src/db.ts` — SQLite schema
- `public/js/dashboard.js` — OAuth initiation (PKCE), requests scopes: `user:read channel:read chat:write events:subscribe`
