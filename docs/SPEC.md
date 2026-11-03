# Spec — Sales Assistant

## 1. Decisions (validated with the owner)

| Topic | Decision |
|---|---|
| Channels | Messenger + Instagram DMs of the page *Africa Smile* (one Meta app, one webhook). |
| Products | Facebook posts / ads + YouCan store. The post text is the source of truth for details and policies. |
| Price | From the post / product sheet only. |
| Stock | Configurable per product; empty ⇒ available. |
| Payment | Cash on delivery only. Anything else unknown ⇒ escalation. |
| Language | Mostly French; always mirror the client's language and script. Friendly tone with emojis. |
| Order flow | Answer first. Buying intent ⇒ ask name, phone, city (+ full address if given) and required options (size, colour…). No intent ⇒ propose once how to order. |
| Sheets | One spreadsheet, one tab per day (`YYYY-MM-DD`, shop timezone). |
| Escalation | E-mail to configurable addresses (dedicated free Gmail bot via SMTP, or own mailbox). Team answer ⇒ sent to client + saved as knowledge. |
| AI | Gemini (AI Studio, free) for tests → Claude Haiku (`claude-haiku-5-5`) in production. Selectable + fallback from the dashboard. |
| Source matching | Manual AliExpress/Alibaba link per product; else automatic visual search; alert the owner when nothing is found. |
| Hosting | Free first (local + ngrok, Neon, Oracle Always Free); Postgres is the only infrastructure. |

## 2. Message lifecycle

```
Meta webhook ──► verify X-Hub-Signature-256 ──► parse (Messenger | Instagram)
   │                                               │
   │   echo from a human (not our app id) ─────────┴─► store + pause bot N minutes
   ▼
store message (idempotent on mid) ─► resolve product (ad referral / shared post)
   ▼
enqueue conversation.reply (debounced 4 s, one running job per conversation)
   ▼
ReplyService
  ├─ skip if bot disabled / paused / page not configured
  ├─ history (30 msgs) + [CONTEXTE INTERNE] (product, draft order, missing fields, open escalation)
  ├─ images from pending messages → multimodal input
  ├─ provider.runAgent(system prompt (stable, cache-friendly), tools)
  │     get_product · search_products · search_knowledge · update_order · submit_order · escalate_to_human
  ├─ empty / refused / error ⇒ escalate + polite holding message (client never ignored)
  └─ send (split to 2000/1000 chars) ─► store outbound ─► agent_runs (tokens, latency, tools)

submit_order ─► order.sheet job ─► Google Sheets tab of the day (retries, status synced/sync_failed)
escalate     ─► email.escalation job ─► mail with "Répondre" link ─► dashboard answer
                 └─► Send API (HUMAN_AGENT tag after 24 h) ─► knowledge entry
```

## 3. Data model
`products` · `contacts` · `conversations` (status, stage, current product, bot pause) · `messages` · `orders` (draft → submitted → synced) · `escalations` · `knowledge` (French full-text index) · `settings` (one row per section, secrets AES-256-GCM) · `jobs` · `agent_runs` · `users`.

## 4. Guardrails
- Answers only from tools / validated knowledge / configured policies; otherwise escalate.
- Client text treated as data (prompt-injection rule in the system prompt).
- Phone validation with libphonenumber (default country TN), option values validated against the product variants, `submit_order` refuses incomplete orders and out-of-stock products.
- Secrets encrypted at rest and masked in API responses; webhook signature mandatory.

## 5. Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Repo, DB schema, settings, queue, Meta webhook + Send API | ✅ done |
| 1 | AI agent (Gemini + Claude adapters), tools, order capture, Sheets daily tabs | ✅ done |
| 2 | Escalation e-mails, team answer, learning loop, human takeover | ✅ done |
| 3 | Dashboard FR/EN (React SPA served by the server): overview, inbox, escalations, products, orders, knowledge, settings with "test connection" | ✅ done |
| 4 | Source matching: Google Lens (SerpApi) → AliExpress/Alibaba candidates, spec extraction, "not found" alert | ⏭ next |
| 5 | YouCan import (Partner app OAuth), post → product import UI, analytics & AI cost | planned |
| 6 | Reply to answers by e-mail (inbound parsing), comment auto-replies, multi-user roles | ideas |
