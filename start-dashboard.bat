@echo off
title Baseball Dashboard Launcher
echo ============================================
echo   Nick's Live Pitcher Data Dashboard
echo ============================================
echo.
set "PROJECT_DIR=%~dp0"
echo Starting backend server...
start /MIN "Dashboard Backend" cmd /k "cd /d "%PROJECT_DIR%backend" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 3 /nobreak >nul
echo Starting frontend dev server...
start /MIN "Dashboard Frontend" cmd /k "cd /d "%PROJECT_DIR%frontend" && npm start"
echo.
echo Both servers are starting in separate windows.
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo.
timeout /t 3 /nobreak >nul
powershell -command "& {Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'; [WinAPI]::ShowWindow([WinAPI]::GetConsoleWindow(), 2)}"