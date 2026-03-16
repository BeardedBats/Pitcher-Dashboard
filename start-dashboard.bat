@echo off
title Baseball Dashboard Launcher
set "PROJECT_DIR=%~dp0"

:: Hide this console window immediately (SW_HIDE = 0)
powershell -command "& {Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'; [WinAPI]::ShowWindow([WinAPI]::GetConsoleWindow(), 0)}"

:: Start backend server in a fully hidden window
powershell -windowstyle hidden -command "Start-Process cmd -ArgumentList '/c cd /d \"%PROJECT_DIR%backend\" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul

:: Start frontend dev server in a fully hidden window
powershell -windowstyle hidden -command "Start-Process cmd -ArgumentList '/c cd /d \"%PROJECT_DIR%frontend\" && npm start' -WindowStyle Hidden"