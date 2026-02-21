# Multi-stage build: frontend (Vite) + backend (FastAPI)

# ---------- Frontend build ----------
FROM node:18-slim AS frontend-builder
WORKDIR /app/frontend
ARG VITE_API_BASE=http://localhost:8000
ENV VITE_API_BASE=${VITE_API_BASE}
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Backend deps build ----------
FROM python:3.14-slim AS backend-builder
WORKDIR /app/backend
ENV PIP_NO_CACHE_DIR=1 \
    PIPENV_VENV_IN_PROJECT=1 \
    PIPENV_IGNORE_VIRTUALENVS=1 \
    PIPENV_NOSPIN=1

# Build deps (only in builder)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential binutils \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps into a local venv
COPY backend/Pipfile backend/Pipfile.lock ./
RUN pip install --no-cache-dir pipenv \
    && pipenv sync --clear

# Trim venv size: drop tests/caches and strip shared libs
RUN find .venv -type d -name "__pycache__" -exec rm -rf '{}' + \
    && find .venv -type f -name "*.pyc" -delete \
    && find .venv -type d \( -name "tests" -o -name "test" \) -exec rm -rf '{}' + \
    && find .venv -type f -name "*.so" -exec strip --strip-unneeded '{}' + || true

# ---------- Backend runtime ----------
FROM python:3.14-slim
WORKDIR /app/backend

ENV VIRTUAL_ENV=/app/backend/.venv \
    PATH="/app/backend/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    FRONTEND_DIST=/app/frontend/dist

# Copy only the built venv from the builder stage
COPY --from=backend-builder /app/backend/.venv /app/backend/.venv

# Copy backend code
COPY backend/ /app/backend/

# Copy built frontend assets
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8000 4173

# Serve frontend statically on 4173 and backend API on 8000
CMD ["/app/start.sh"]
