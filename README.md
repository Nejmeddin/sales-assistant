# Sales Assistant — AI replies for Messenger & Instagram

Backend that answers your Facebook Page and Instagram DMs automatically, in the client's language:

- 🛍️ identifies the product (ad click, shared post, or the client's words), answers **only** from verified sources (post text, product sheet, supplier specs, validated answers);
- 🧾 collects the order (name, phone, city/address, size/colour…) and writes it to **Google Sheets, one tab per day**;
- 📧 when it can't answer, it tells the client the team is checking and **e-mails you**; your answer is sent to the client and **saved so the bot learns**;
- 🙋 if a human replies from Meta Business Suite, the bot **pauses** for that conversation.

Everything (AI provider & keys, Meta pages, e-mails, Sheets, persona, policies) is configured from the dashboard API — `.env` only holds bootstrap secrets.

> Architecture, decisions and roadmap: [`docs/SPEC.md`](docs/SPEC.md)

## Quick start (local test — free)

Requirements: Node 22+, pnpm 10, Docker (or a free [Neon](https://neon.tech) Postgres).

```bash
pnpm install
cp .env.example .env          # fill ENCRYPTION_KEY, SESSION_SECRET, ADMIN_EMAIL/PASSWORD
docker compose up -d db       # or set DATABASE_URL to your Neon URL
pnpm dev                      # http://localhost:3000 — migrations run automatically
```

`pnpm dev` starts both apps: the API on **:3000** and the dashboard (hot reload) on **http://localhost:5173**, which proxies `/api` to the server. Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
In production `pnpm build` builds the dashboard and the server, and the server serves the dashboard itself on the same port.

### Dashboard (French / English, light / dark)
| Page | What you do there |
|---|---|
| Vue d'ensemble / Overview | 7-day KPIs, daily activity, setup checklist, pending questions |
| Conversations | Live inbox (Messenger + Instagram), pause / resume the bot per conversation |
| Questions à traiter / Questions to handle | Answer escalated questions (link from the e-mail), save the answer as knowledge |
| Commandes / Orders | Captured orders, Google Sheets sync status, retry, CSV export |
| Produits / Products | Catalog, options (size/colour), stock, ad/post links, AliExpress link, import from page posts |
| Base de connaissances / Knowledge | Validated answers reused by the AI (manual or learned) |
| Paramètres / Settings | AI, assistant behaviour, Meta, e-mails, Google Sheets, product sources — each with a "test connection" button |

Expose it over HTTPS for Meta (free static domain):

```bash
ngrok http --url=<your-name>.ngrok-free.app 3000
```

Set `PUBLIC_URL=https://<your-name>.ngrok-free.app` in `.env`.

Run the tests (they use a local Postgres and fake AI / Meta / Sheets):

```bash
pnpm test
```

## Configuration checklist

### 1. AI provider
| Phase | Provider | Where to get the key |
|---|---|---|
| Test (free) | Gemini — `gemini-2.5-flash` by default | [Google AI Studio → API keys](https://aistudio.google.com/apikey) |
| Production | Claude Haiku — `claude-haiku-5-5` | [Anthropic Console](https://console.anthropic.com/) |

Switch with `PUT /api/settings/ai` (`provider: "gemini" | "anthropic"`), optionally with the other one as `fallbackProvider`. `POST /api/settings/test/ai` checks the key and lists the Gemini models available to you.

> ⚠️ Gemini's free tier may use prompts to improve Google's products — fine for tests, prefer the paid tier or Claude in production since conversations contain phone numbers.

### 2. Meta app (Messenger + Instagram)
1. [developers.facebook.com](https://developers.facebook.com/apps) → **Create app** → *Business* type.
2. Add **Messenger** and **Instagram** (Instagram API with Facebook Login) products.
3. **Settings → Basic**: copy *App ID* and *App Secret* → dashboard `meta.appId`, `meta.appSecret`.
4. **Messenger → Settings**: generate the Page access token for your page → `meta.pages[].accessToken` (+ `pageId`, and `instagramId` of the linked IG professional account).
5. **Webhooks**: callback `https://<PUBLIC_URL>/webhooks/meta`, verify token = `meta.verifyToken` (any string you choose).
   Subscribe the page to `messages`, `messaging_postbacks`, `messaging_referrals`, `message_echoes`; for Instagram: `messages`, `messaging_postbacks`, `messaging_referral`.
6. In **Meta Business Suite → Inbox → Automations**, turn off instant replies to avoid double answers.
7. **Going live**: while the app is in *Development* mode only people with a role on the app (admins/testers) get bot replies — perfect for testing. To answer the public, request **Advanced Access** for `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages` (and the *Human Agent* feature to answer escalations after 24 h), which requires **Business Verification** and App Review.

### 3. Escalation e-mails (free)
Recommended: a dedicated Gmail for the bot (e.g. `yourshop.bot@gmail.com`) → enable 2-Step Verification → create an **App password** → settings `notifications`:
```json
{ "transport": "smtp", "escalationEmails": ["you@yourmail.com"],
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "yourshop.bot@gmail.com", "pass": "<app password>", "from": "Shop Bot <yourshop.bot@gmail.com>" } }
```
Your own Gmail works the same way. [Resend](https://resend.com) (free 3 000/month) is supported too (`transport: "resend"`).

### 4. Google Sheets (orders, one tab per day)
1. [Google Cloud console](https://console.cloud.google.com/) → new project → enable **Google Sheets API**.
2. **IAM → Service accounts** → create → *Keys* → add JSON key.
3. Share your spreadsheet with the service account's `client_email` (Editor).
4. Settings `sheets`: `enabled: true`, `spreadsheetId` (from the sheet URL), `serviceAccountJson` (paste the JSON). Tabs are named `YYYY-MM-DD` in `Africa/Tunis` time by default.

### 5. Products
- `POST /api/products/import-posts { "pageId": "…" }` reads your recent page posts and returns AI-extracted product drafts (name, price, sizes/colours) to confirm with `POST /api/products`.
- `inStock` left empty ⇒ treated as **available**; set `false` for out-of-stock.
- Link ads/posts (`adIds`, `fbPostIds`, `igMediaIds`) so a click on the ad tells the bot which product the client is asking about.
- `sourceUrl` = AliExpress/Alibaba link (optional; automatic matching is on the roadmap).

## Free hosting options
| Use | Option | Notes |
|---|---|---|
| Database | Neon free (0.5 GB) | Works out of the box (`sslmode=require` URL). |
| App, testing | Your PC + ngrok static domain | Zero cost, stable webhook URL. |
| App, 24/7 free | Oracle Cloud *Always Free* VM | Needs a card for verification; run `docker compose --profile prod up -d`. |
| App, cheapest paid | Any ~€4/month VPS (Hetzner…) | Same Docker command. |

Avoid platforms that sleep when idle (Render free…): the first message after a sleep would wait ~1 min.

## Project layout
```
apps/server/src
├── api/            HTTP routes: webhook (Meta), dashboard REST, auth
├── agent/          prompt, tools, reply orchestrator, providers (Gemini, Claude)
├── channels/meta/  webhook parser, Graph API client, ingestion
├── conversation/   contacts, conversations, messages
├── products/  orders/  knowledge/  escalation/
├── integrations/   Google Sheets writer
├── notify/         e-mail (SMTP / Resend)
├── queue/          Postgres job queue (debounce, retries, per-conversation lock)
└── settings/       dashboard-editable settings (secrets encrypted at rest)
```
