# ── Stage 1: Build React frontend ──
FROM node:20-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python backend + frontend static files ──
FROM python:3.11-slim

# Install Python dependencies first (cached layer)
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy backend code to /app/backend/
COPY backend/ /app/backend/

# Copy frontend build to /app/frontend-build/
# (app.py resolves to ../frontend-build relative to backend/)
COPY --from=frontend-build /build/frontend/build /app/frontend-build/

# Backend runs from its own directory so `from data import ...` works
WORKDIR /app/backend

EXPOSE 8000

# Railway/Render inject $PORT; default to 8000
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
