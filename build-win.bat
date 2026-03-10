@echo off
title Building Pitcher Dashboard for Windows
echo ============================================
echo   Building Pitcher Dashboard (Windows)
echo ============================================
echo.

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo [0/5] Installing dependencies...
echo    Installing root npm packages...
call npm install --no-optional
echo    Installing frontend npm packages...
cd frontend
call npm install
cd ..
echo    Installing Python packages...
pip install pyinstaller --quiet
pip install -r backend\requirements.txt --quiet
echo    Done.

echo.
echo [1/5] Building frontend...
cd frontend
call npm run build
if errorlevel 1 (
    echo ERROR: Frontend build failed!
    pause
    exit /b 1
)
cd ..

echo.
echo [2/5] Copying frontend build...
if exist frontend-build rmdir /s /q frontend-build
xcopy /e /i /q frontend\build frontend-build
echo    Done.

echo.
echo [3/5] Building Python backend with PyInstaller...
cd backend
python -m PyInstaller --onefile --name backend ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import uvicorn.lifespan.on ^
    --hidden-import uvicorn.lifespan.off ^
    --hidden-import httptools.parser.parser ^
    --hidden-import anyio._backends._asyncio ^
    app.py
if errorlevel 1 (
    echo ERROR: PyInstaller build failed!
    pause
    exit /b 1
)
cd ..
echo    Done.

echo.
echo [4/5] Verifying backend binary...
if not exist backend\dist\backend.exe (
    echo ERROR: backend.exe not found in backend\dist\
    pause
    exit /b 1
)
echo    Found backend\dist\backend.exe

echo.
echo [5/5] Packaging Electron app...
echo    Stopping any running instances...
taskkill /f /im "Pitcher Dashboard.exe" >nul 2>&1
taskkill /f /im "backend.exe" >nul 2>&1
timeout /t 3 /nobreak >nul
echo    Cleaning previous build output...
if exist dist rmdir /s /q dist
if exist dist (
    echo    WARNING: Could not delete dist folder. Please close any running
    echo    instances of Pitcher Dashboard and delete the dist folder manually.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
echo    Clearing winCodeSign cache (symlink fix)...
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
call npx electron-builder --win --config.forceCodeSigning=false
if errorlevel 1 (
    echo ERROR: Electron build failed!
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build complete!
echo   Output: dist\
echo ============================================
pause
