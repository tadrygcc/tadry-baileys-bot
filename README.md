# tadry-baileys-bot

WhatsApp bot for **Tadry**, running on [Baileys](https://github.com/WhiskeySockets/Baileys). Handles inbound user messages on the Tadry-branded WhatsApp Business number, forwards each to the `tadry-web` `/api/bot` endpoint, and sends the reply back through WhatsApp.

This is the **unofficial** path — Baileys links a WhatsApp session the same way WhatsApp Web does, so it works without Meta business verification. It does mean the number must stay on good behaviour (user-initiated only, no bulk send). See "Risk profile" below.

## What it does not

- **No broadcast, no unsolicited messages.** The bot only ever replies to something a user sent it.
- **No group messages.** Group JIDs (ending in `@g.us`) are ignored.
- **No status stories.** Broadcast JIDs are ignored.
- **No template messages.** Just plain text and video attachments (16 MB cap per WhatsApp Cloud API rules — matches what `/api/bot` returns).

## Env vars

| Var | Purpose |
|---|---|
| `TADRY_API_URL` | Full URL of your `tadry-web` deployment's `/api/bot`. |
| `BOT_SHARED_SECRET` | Any random string. Set the same value in Vercel env vars on `tadry-web` so `/api/bot` will accept our requests. |
| `AUTH_DIR` | Where to persist the Baileys session (`creds.json` + key files). On Railway, mount a volume and point this here (e.g. `/data/auth_info`). If not persisted, the QR pairing is lost on every restart. |
| `LOG_LEVEL` | `info` (default), `debug`, `warn`, `error`. |

## Running locally (once, to pair)

```bash
npm install
export TADRY_API_URL=https://your-tadry-web.vercel.app/api/bot
export BOT_SHARED_SECRET=some-random-string
npm start
```

A QR code renders in the terminal. On the phone that owns the Tadry number, open **WhatsApp Business App → Settings → Linked Devices → Link a device**, scan the code. The bot is now paired.

The pairing produces files in `./auth_info/`. **Keep those files private** — anyone who has them can read/send from the number.

## Running on Railway (production)

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub Repo** → pick this repo.
3. Add these env vars in Railway → Variables:
   - `TADRY_API_URL`
   - `BOT_SHARED_SECRET`
   - `AUTH_DIR=/data/auth_info`
4. Railway → this service → **Volumes** → **Add Volume** → mount at `/data`. (Free tier allows one 1 GB volume — plenty.)
5. First deploy: open **Logs**. You'll see the QR code render in the log stream. Scan it from your Tadry phone (same steps as above).
6. Once "connected to WhatsApp as Tadry" appears in the logs, you're live.

Redeploys will re-use the session from the volume — no need to re-scan.

## Risk profile (honest)

Baileys uses WhatsApp's multi-device protocol and is against WhatsApp's ToS. In practice, numbers get banned when they look like spam: bulk unsolicited outbound, unnatural send patterns, high report-rates. A support-style bot answering user-initiated messages is much lower risk — many creators run this exact setup for years without issues. But zero risk is not the same as low risk. If the number ever does get banned, you'd need to migrate to the official WhatsApp Cloud API path (which requires business verification).

Guard rails baked in:
- Reply only to direct incoming user messages (no groups, no broadcasts).
- Rate-limited on the tadry-web side (per user).
- `markOnlineOnConnect: false` — the bot doesn't advertise itself as always-online.
- Browser identity set to `Tadry Bot` — legible in the "Linked Devices" list on the phone.

## Files

- `index.js` — the whole bot (~200 lines).
- `auth_info/` — WhatsApp session (git-ignored). Do not check in.
- `railway.json` — Railway build/deploy config.
