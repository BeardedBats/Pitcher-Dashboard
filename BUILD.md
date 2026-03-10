# Building Pitcher Dashboard as a Desktop App

## Prerequisites

1. **Node.js** (v18+): https://nodejs.org
2. **Python** (3.9+): https://python.org
3. **Python packages**: `pip install -r backend/requirements.txt pyinstaller`
4. **Node packages**: Run `npm install` in both the root directory and `frontend/`

## Quick Build

### Windows
```
npm install
cd frontend && npm install && cd ..
build-win.bat
```
The installer will be in `dist/`.

### macOS
```
npm install
cd frontend && npm install && cd ..
./build-mac.sh
```
The `.dmg` will be in `dist/`.

## Manual Build Steps

### 1. Build the frontend
```
cd frontend
npm run build
cd ..
cp -r frontend/build frontend-build
```

### 2. Build the Python backend
```
cd backend
pyinstaller --onefile --name backend \
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
```

### 3. Package with Electron
```
npx electron-builder --win   # Windows
npx electron-builder --mac   # macOS
```

## Development Mode

To run the Electron app in dev mode (using live React dev server + Python):

1. Start the backend: `cd backend && python -m uvicorn app:app --port 8000`
2. Start the frontend: `cd frontend && npm start`
3. Start Electron: `npm run electron:dev`

## How It Works

- The Electron app spawns the bundled Python backend on a random available port
- The backend port is injected into the frontend HTML before it loads
- The frontend communicates with the backend via HTTP on localhost
- When the Electron window closes, the backend process is automatically terminated
