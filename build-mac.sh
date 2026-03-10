#!/bin/bash
set -e

echo "============================================"
echo "  Building Pitcher Dashboard (macOS)"
echo "============================================"
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# ── Check prerequisites ──
echo "Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js required — install from https://nodejs.org"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3 required — install from https://python.org"; exit 1; }
echo "   Node $(node -v), Python $(python3 --version | awk '{print $2}')"
echo ""

# ── Step 1: Install dependencies ──
echo "[1/5] Installing dependencies..."
npm install
cd frontend && npm install && cd ..
pip3 install pyinstaller fastapi uvicorn pandas numpy requests pybaseball --quiet
echo "   Done."

# ── Step 2: Build frontend ──
echo ""
echo "[2/5] Building frontend..."
cd frontend
npm run build
cd ..
rm -rf frontend-build
cp -r frontend/build frontend-build
echo "   Done."

# ── Step 3: Build Python backend ──
echo ""
echo "[3/5] Building Python backend with PyInstaller..."
cd backend
rm -rf build dist __pycache__ *.spec
pyinstaller --onefile --name backend \
    --add-data 'aggregation.py:.' \
    --add-data 'data.py:.' \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import uvicorn.lifespan.off \
    --hidden-import httptools.parser.parser \
    --hidden-import anyio._backends._asyncio \
    app.py
cd ..
echo "   Done."

# ── Step 4: Package as .dmg ──
echo ""
echo "[4/5] Packaging Electron app as .dmg..."
npx electron-builder --mac

# ── Done ──
echo ""
echo "[5/5] Verifying output..."
DMG=$(ls -1 dist/*.dmg 2>/dev/null | head -1)
if [ -n "$DMG" ]; then
    echo ""
    echo "============================================"
    echo "  BUILD COMPLETE!"
    echo "  $DMG ($(du -h "$DMG" | awk '{print $1}'))"
    echo "============================================"
    echo ""
    echo "  Send that .dmg to your friend —"
    echo "  double-click → drag to Applications → done."
else
    echo ""
    echo "============================================"
    echo "  Build finished — check dist/ for output"
    echo "============================================"
fi
