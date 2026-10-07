# AI SHOP — Монгол хэлтэй AI худалдааны туслах

[![Tests](https://github.com/sanki-69/diplom/actions/workflows/tests.yml/badge.svg)](https://github.com/sanki-69/diplom/actions/workflows/tests.yml)

An AI shopping assistant for Mongolian speakers. Type what you want in Mongolian
(Cyrillic or Latin letters, e.g. *"nada hyamd gaming hulgana olood ogooch"*) or
English. The AI understands it, searches six online stores at once, converts
every price to tögrög (₮), and answers questions about products in Mongolian.

Diploma project. The thesis is in [`thesis.tex`](thesis.tex).

---

## Features

| | |
|---|---|
| **Mongolian AI search** | Understands Mongolian (Cyrillic and Latin-typed) and English, turns it into English product searches |
| **Price comparison** | AliExpress, Amazon, eBay, Walmart, BestBuy, Newegg — prices converted to ₮, cheapest highlighted |
| **AI assistant** | Chat about products, pros and cons, "should I buy it?", can start searches and filter results |
| **Chrome extension** | Floating chat on any shop page, plus one-click translation of the page into Mongolian |
| **Accounts** | Sign-up/login, saved chat history |
| **Admin panel** | Users, products, database viewer, statistics |
| **Free AI providers** | Gemini, Mistral, OpenRouter (e.g. NVIDIA Nemotron), Groq — automatic fallback between them |

## Architecture

```
 Browser / Chrome extension
          │  HTTPS (JSON)
          ▼
 ┌──────────────────────────┐      ┌──────────────────────────────┐
 │ FastAPI backend          │ ───► │ AI providers (fallback chain) │
 │ backend/main.py          │      │ Gemini · Mistral · OpenRouter │
 │ backend/security.py      │      │ · Groq · any OpenAI-compatible│
 └──────────┬───────────────┘      └──────────────────────────────┘
            │ scrape            │ store
            ▼                   ▼
   6 online stores        MongoDB (local or Atlas)
```

* **Frontend** (`extension/`): React 19 + Vite. The same build is the website and the Chrome extension.
* **Backend** (`backend/`): Python FastAPI, BeautifulSoup scrapers, APScheduler for a daily price re-check.
* **Database**: MongoDB. Users, products, chat history, cached search results.

## Project structure

```
backend/
  main.py              API, AI chain, scrapers
  security.py          rate limits, login lockout, safe URL fetching
  tests/               pytest suite (no internet / keys / database needed)
  backup_to_atlas.py   copy local MongoDB → MongoDB Atlas
  requirements.txt     runtime packages; requirements-dev.txt for tests
extension/
  src/                 React website (pages, components, api.js)
  public/content.js    Chrome extension content script (chat widget, translate)
  public/manifest.json Chrome extension manifest
  scripts/make_icons.py  regenerates the extension PNG icons
render.yaml            one-click backend deploy on Render
.github/workflows/     tests on every push + keep-awake ping
start.bat              start everything locally on Windows
```

---

## Run it locally

**You need:** Python 3.12+, Node.js 20+, MongoDB 7+ (optional — chat and search work without it), and at least one free AI key.

### 1. Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
copy .env.example .env           # then fill in at least one AI key (see below)
uvicorn main:app --reload --port 8000
```

Check http://127.0.0.1:8000/health — it lists the MongoDB status and which AI providers are active.

### 2. Website

```bash
cd extension
npm install
npm run dev                      # http://localhost:5173
```

On Windows, `start.bat` starts MongoDB, the backend and the website together.

### 3. Chrome extension

```bash
cd extension
npm run build
```

Chrome → `chrome://extensions` → enable *Developer mode* → **Load unpacked** → choose `extension/dist`.

### First admin account

Put your username in `ADMIN_USERNAMES` (in `backend/.env`), then sign up or log in with it — it becomes admin automatically.

---

## Configuration (`backend/.env`)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key (free): https://aistudio.google.com/ — also used for product embeddings |
| `MISTRAL_API_KEY` | Mistral free "Experiment" plan: https://console.mistral.ai/ |
| `OPENROUTER_API_KEY` | OpenRouter, ~20 free models with one key: https://openrouter.ai/keys |
| `GROQ_API_KEY` | Groq (free, very fast): https://console.groq.com/ |
| `AI_PROVIDER_ORDER` | Order for chat answers, e.g. `gemini,mistral,openrouter,groq,custom` |
| `AI_FAST_PROVIDER_ORDER` | Order for quick helper calls (query understanding, page translation) |
| `GEMINI_MODELS`, `OPENROUTER_MODELS`, … | Model fallback lists per provider |
| `CUSTOM_AI_BASE_URL` / `_API_KEY` / `_MODEL` | Any other OpenAI-compatible service |
| `MONGODB_URL`, `MONGODB_DB` | Database (local `mongodb://localhost:27017` or Atlas `mongodb+srv://…`) |
| `SECRET_KEY` | Signs login tokens. Long random string; keep secret |
| `ADMIN_USERNAMES` | Comma-separated usernames that become admin |
| `ALLOWED_ORIGINS` | Websites allowed to call the API. Default `*` (needed for the Chrome extension) |
| `CLIENT_IP_HEADER` | Header with the real visitor IP behind a proxy (`cf-connecting-ip` on Render) |
| `RATE_CHAT`, `RATE_SEARCH`, … | Override rate limits, format `count/seconds,count/seconds` |
| `GLOBAL_DAILY_CHAT`, … | Whole-site daily caps that protect free AI quotas |
| `SCRAPER_PROXY_URL` | Optional proxy for shop scraping (helps when stores block cloud servers) |

Providers without a key are skipped automatically. When a provider is rate-limited
or overloaded, it is paused for a while and the next one answers.

---

## Deploy (free tiers)

1. **Database — MongoDB Atlas.** Create a free M0 cluster, a database user, allow
   network access from `0.0.0.0/0`, copy the `mongodb+srv://` string. To copy your
   local data: put it in `ATLAS_URL` and run `python backup_to_atlas.py`.
2. **Backend — Render.** *New → Blueprint →* this repo. `render.yaml` sets everything
   up and asks for your keys, `MONGODB_URL` and `ADMIN_USERNAMES`.
3. **Website — Vercel.** *Add New → Project →* this repo, root directory `extension`,
   environment variable `VITE_API_URL=https://<your-backend>.onrender.com`.
4. **Keep it awake.** GitHub → *Settings → Secrets and variables → Actions → Variables*
   → add `BACKEND_URL` = your Render URL. The `keep-awake` workflow pings it every
   10 minutes so visitors never wait for a cold start.
5. **Extension for the deployed site.** Build with the deployed addresses:
   ```bash
   cd extension
   set VITE_API_URL=https://<your-backend>.onrender.com
   set VITE_WEB_URL=https://<your-site>.vercel.app
   npm run build                 # then load extension/dist in Chrome
   ```

**Never commit `backend/.env`** — it is in `.gitignore`. Keys go into the hosting dashboards.

---

## Security measures

* **Rate limits** per visitor on chat, search, translation, sign-up and login, plus
  whole-site daily caps so a bot can't drain the free AI quotas (`backend/security.py`).
* **Login protection:** 5 wrong passwords lock that username for 15 minutes; passwords are bcrypt-hashed.
* **Admin endpoints** require an admin token; the first admin can only be created from
  the server itself or via `ADMIN_USERNAMES`.
* **Safe outbound requests:** the image proxy and crawler only fetch public internet
  addresses (never localhost, private networks or cloud metadata), re-check every
  redirect, accept only images (proxy) and cap the size.
* **Input limits** on chat history, search queries and translation batches; database
  searches escape user text.
* Internal error details stay in the server log; users see a short Mongolian message.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest -q
```

48 tests cover login and lockout, admin protection, rate limits, the URL guard,
the AI provider fallback chain, response parsing and the price/deduplication helpers.
They use an in-memory fake MongoDB and fake AI providers, so they need no internet,
keys or database. GitHub Actions runs them, plus the frontend lint and build, on every push.

## Known limitations

* **Scraping from the cloud:** Amazon and Walmart block many data-center addresses, so
  a deployed server finds fewer results than a home computer. `SCRAPER_PROXY_URL` helps.
  eBay, BestBuy and Newegg often block scrapers entirely; the app then shows a
  "search on this store" link instead.
* **Free AI quotas:** free tiers are limited per minute and per day; the provider chain
  and daily caps keep the app working, but heavy use can still exhaust them.
* **In-memory limits:** rate-limit counters reset when the server restarts and assume a
  single server process (true on Render's free plan).
* **Exchange rate** is a fixed 3,450 ₮ per USD.
* The backend is still mostly one large file (`main.py`); new code goes into separate modules.
