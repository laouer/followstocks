# Multi-stage build: frontend (Vite) + backend (FastAPI)

# ---------- Frontend build ----------
FROM node:18 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Backend runtime ----------
FROM python:3.11-slim
WORKDIR /app/backend

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ /app/backend/

# Copy built frontend assets
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

ENV PYTHONUNBUFFERED=1 \
    FRONTEND_DIST=/app/frontend/dist

EXPOSE 8000 4173

# Serve frontend statically on 4173 and backend API on 8000
CMD bash -c "python -m http.server 4173 --directory /app/frontend/dist & uvicorn app.main:app --host 0.0.0.0 --port 8000"
