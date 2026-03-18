# FollowStocks

React + FastAPI starter to track stock positions, log hourly price snapshots, and view gains/losses.

## Docker
Run the prebuilt image:

```bash
docker pull meanouar/followstocks
docker run --name followstocks -p 8000:8000 -p 4173:4173 meanouar/followstocks
```

Set frontend API URL at runtime (useful for reverse-proxy/domain deployments):

```bash
docker run --name followstocks \
  -p 8000:8000 -p 4173:4173 \
  -e API_BASE_URL="https://api.your-domain.com" \
  meanouar/followstocks
```

Persist SQLite data locally:

```bash
touch data.db
docker run --name followstocks \
  --rm \
  -p 8000:8000 -p 4173:4173 \
  -v "$(pwd)/data.db:/app/backend/data.db" \
  meanouar/followstocks
```

Build the image yourself:

```bash
docker build -t meanouar/followstocks .
```

Frontend: `http://localhost:4173`  
API: `http://localhost:8000`

## Backend (FastAPI)
Requirements: Python 3.11+, virtualenv recommended.

With Pipenv:

```bash
cd backend
pipenv install
pipenv run uvicorn app.main:app --reload
```

API runs on `http://localhost:8000`.

Playwright browser binaries are required for the Boursorama flow:

```bash
cd backend
pipenv run playwright install chromium
```

### Key endpoints
- `GET /health` simple readiness check.
- `POST /auth/register` `{email, password, name?}` register and receive a JWT.
- `POST /auth/login` `{email, password}` receive a JWT.
- `GET /auth/me` get the current user (requires Bearer token).
- `POST /holdings` `{symbol, shares, cost_basis, currency?}` create a holding (duplicate symbols allowed).
- `GET /holdings` list holdings with computed stats (market value, gain %, hourly change).
- `PUT /holdings/{id}` partial update for shares/cost/currency/symbol.
- `DELETE /holdings/{id}` remove a holding and its snapshots.
- `POST /prices` `{holding_id, price, recorded_at?}` add a price snapshot; `recorded_at` defaults to now.
- `GET /prices/{holding_id}?limit=24` fetch recent snapshots for a holding.
- `GET /portfolio` portfolio summary + holdings stats.
- `GET /search?q=` uses Yahoo Finance search for symbol lookup (used for autocomplete).
- `GET /quotes/yfinance?symbol=` fetches latest price via Yahoo Finance.
- `GET /integrations/boursorama/session` inspect whether a saved Boursorama Playwright session exists for the current user.
- `POST /integrations/boursorama/cash/preview` reuse the saved Boursorama session and extract cash-like balances from the authenticated page.
- `POST /integrations/boursorama/cash/sync` extract balances from Boursorama and sync them into local account liquidity.
- `GET /analysis/cac40?metric=analyst_discount|pe_discount|dividend_yield` CAC40 undervaluation ranking.
- Background task (enabled by default) that refreshes prices hourly using Yahoo Finance symbols and stores them as snapshots. Control with `AUTO_REFRESH_ENABLED` (`true`/`false`) and `AUTO_REFRESH_SECONDS` (default `3600`).

Holdings, prices, and portfolio endpoints require `Authorization: Bearer <token>`.

Hourly change is computed as the delta between the latest snapshot and the most recent snapshot at least one hour earlier (or the previous snapshot if none are that old).
Currency is restricted to USD or EUR (default USD).

### Boursorama session + cash sync

This flow does not store your Boursorama password in the app. It opens a real Chromium window, lets you complete the login and MFA manually, then saves Playwright storage state (cookies + local storage) under `backend/private/boursorama/`.

Capture a session for a FollowStocks user id:

```bash
cd backend
pipenv run python -m app.boursorama_cash_sync auth --user-id 1
```

Preview extracted balances from the saved session:

```bash
cd backend
pipenv run python -m app.boursorama_cash_sync fetch --user-id 1
```

Sync those balances into local account liquidity:

```bash
cd backend
pipenv run python -m app.boursorama_cash_sync sync --user-id 1
```

The extractor is heuristic because Boursorama can change the authenticated DOM. If you need to inspect what the parser sees, dump the normalized page text:

```bash
cd backend
pipenv run python -m app.boursorama_cash_sync fetch --user-id 1 --dump-text /tmp/boursorama-lines.json
```

Notes:
- Matching is done by account name. With sync enabled, missing accounts are created automatically unless you pass `--no-create-missing`.
- Only EUR balances are synced into account liquidity because the account model does not store a cash currency.
- If the saved session expires, rerun the `auth` command.

### Boursorama onboarding import

There is also a higher-level importer that can create or reuse a FollowStocks user, capture the Boursorama session, then import:
- every detected Boursorama account into FollowStocks `accounts`
- securities inside PEA / PEA-PME / ORD / CTO style accounts into FollowStocks `holdings`
- savings-style products like assurance vie and livrets into FollowStocks `placements`

Create a new FollowStocks user, open the Boursorama login, then import:

```bash
cd backend
pipenv run python -m app.boursorama_import \
  --email you@example.com \
  --password changeme123 \
  --name "Your Name" \
  --capture-session
```

Reuse an existing FollowStocks user and an already-saved Boursorama session:

```bash
cd backend
pipenv run python -m app.boursorama_import --user-id 1
```

Useful options:
- `--headed` keeps the import browser visible after the session is already saved.
- `--dump-dir /tmp/boursorama-import` stores HTML and normalized text for the landing page and each parsed account page to help tune the heuristics.
- `--reset-user-data` deletes the target user's current portfolio data before importing, but keeps the user account and saved Boursorama session.
- `--engine browser-use` switches the discovery phase to a `browser-use` agent that starts from `https://clients.boursobank.com/`, uses the saved authenticated session, and is instructed to parse `div.c-panel__body` panels first before opening detail pages only when needed.
- `--browser-use-max-steps 20` limits how far the `browser-use` agent is allowed to explore.

Optional `browser-use` setup:

```bash
cd backend
pipenv install browser-use
pipenv run python -m app.boursorama_import --user-id 1 --engine browser-use --headed --dump-dir /tmp/boursorama-import
```

If your default `OPENAI_MODEL` is not accepted by `browser-use`, set a dedicated override such as `BOURSORAMA_BROWSER_USE_MODEL=gpt-4.1-mini`.

Notes:
- The importer is heuristic because the authenticated Boursorama DOM can change.
- If the saved session is expired, the importer now reopens the Boursorama login for the same FollowStocks user and retries once automatically.
- If detailed holdings inside a security account cannot be parsed, the importer falls back to one aggregate placement for that account instead of dropping the value entirely.
- The `browser-use` engine is opt-in and requires a working LLM configuration (`OPENAI_API_KEY` or Azure OpenAI settings). It also disables `browser-use` telemetry by default for this bank-import path.
- The importer captures daily history after import so the portfolio view reflects the imported state immediately.

#### Quick seed (optional)
```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"changeme123"}'

# Copy the access_token from the response and set it here:
TOKEN="PASTE_TOKEN_HERE"

curl -X POST http://localhost:8000/holdings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"symbol":"AAPL","shares":10,"cost_basis":150}'
curl -X POST http://localhost:8000/holdings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"symbol":"MSFT","shares":5,"cost_basis":280}'

# Copy the holding ids from the responses and use them here:
curl -X POST http://localhost:8000/prices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"holding_id":1,"price":180}'
curl -X POST http://localhost:8000/prices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"holding_id":2,"price":320}'
```

## Frontend (React + Vite)
Requirements: Node 18+.

```bash
cd frontend
npm install
npm run dev    # opens http://localhost:5173
```

Set `VITE_API_BASE` in `.env` if the API is not on `http://localhost:8000`.

## iOS (SwiftUI)

A native iOS starter app is available in `ios/`.

```bash
open ios/FollowStocks.xcodeproj
```

Then run the `FollowStocks` scheme in a simulator.  
Setup details are in `ios/README.md`.

### What it shows
- Portfolio summary (invested, market value, unrealized P/L, last-hour change).
- Table of holdings with per-position gain %, hourly delta, and last price timestamp.
- Forms to add holdings and log hourly price snapshots.
- Add-holding form with live Yahoo Finance symbol suggestions.
- Quick correction form to update shares if you entered them incorrectly.

### Deployment
- Keep the FastAPI app running with a process manager (systemd, supervisord) or a container.
- Serve the frontend as static files (`npm run build` → `dist/`) behind any web server; proxy `/` to the built assets and `/api` (or `/`) to the FastAPI service.

## Notes
- Prices are user-supplied; integrate a market data source by posting snapshots hourly.
- SQLite database (`backend/data.db`) is created automatically on first run. Back it up if needed.
- JWT settings: set `JWT_SECRET` and optionally `ACCESS_TOKEN_EXPIRE_MINUTES` (default 1440).
- If you already have a `data.db`, add a migration for the new `users` table + `holdings.user_id`, or delete the file to recreate the schema.
