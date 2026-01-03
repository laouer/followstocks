# FollowStocks

React + FastAPI starter to track stock positions, log hourly price snapshots, and view gains/losses.

## Docker
Run the prebuilt image:

```bash
docker pull meanouar/followstocks
docker run --name followstocks -p 8000:8000 -p 4173:4173 meanouar/followstocks
```

Persist SQLite data locally:

```bash
touch data.db
docker run --name followstocks \
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
- `GET /analysis/cac40?metric=analyst_discount|pe_discount|dividend_yield` CAC40 undervaluation ranking.
- Background task (enabled by default) that refreshes prices hourly using Yahoo Finance symbols and stores them as snapshots. Control with `AUTO_REFRESH_ENABLED` (`true`/`false`) and `AUTO_REFRESH_SECONDS` (default `3600`).

Holdings, prices, and portfolio endpoints require `Authorization: Bearer <token>`.

Hourly change is computed as the delta between the latest snapshot and the most recent snapshot at least one hour earlier (or the previous snapshot if none are that old).
Currency is restricted to USD or EUR (default USD).

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
