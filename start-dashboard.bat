@echo off
title Baseball Dashboard Launcher
echo ============================================
echo   Nick's Live Pitcher Data Dashboard
echo ============================================
echo.

:: Get the directory where this .bat file lives
set "PROJECT_DIR=%~dp0"

echo Starting backend server...
start "Dashboard Backend" cmd /k "cd /d "%PROJECT_DIR%backend" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload"

:: Give the backend a moment to start
timeout /t 3 /nobreak >nul

echo Starting frontend dev server...
start "Dashboard Frontend" cmd /k "cd /d "%PROJECT_DIR%frontend" && npm start"

echo.
echo Both servers are starting in separate windows.
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo.
echo Close this window anytime - the servers will keep running.
echo To stop everything, close the Backend and Frontend windows.
pause
