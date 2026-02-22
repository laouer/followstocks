#!/bin/sh
set -eu

API_BASE_URL_VALUE="${API_BASE_URL:-http://localhost:8000}"
ESCAPED_API_BASE_URL="$(printf '%s' "$API_BASE_URL_VALUE" | sed 's/\\/\\\\/g; s/"/\\"/g')"

cat > /app/frontend/dist/runtime-config.js <<EOF
window.__FOLLOWSTOCKS_CONFIG__ = Object.assign({}, window.__FOLLOWSTOCKS_CONFIG__, {
  API_BASE_URL: "${ESCAPED_API_BASE_URL}"
});
EOF

python /app/spa_server.py --host 0.0.0.0 --port 4173 --directory /app/frontend/dist &
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
