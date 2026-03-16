@echo off
title Pitcher Dashboard
set "PROJECT_DIR=%~dp0"

:: Hide this console window immediately (SW_HIDE = 0)
powershell -command "& {Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'; [WinAPI]::ShowWindow([WinAPI]::GetConsoleWindow(), 0)}"

:: Start backend server (minimized — VBS hides the launcher itself)
start /MIN "Pitcher Dashboard Backend" cmd /k "cd /d "%PROJECT_DIR%backend" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 3 /nobreak >nul

:: Start frontend dev server
start /MIN "Pitcher Dashboard Frontend" cmd /k "cd /d "%PROJECT_DIR%frontend" && npm start"
