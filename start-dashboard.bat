@echo off
set "PROJECT_DIR=%~dp0"
start /MIN "Pitcher Dashboard Backend" cmd /k "cd /d "%PROJECT_DIR%backend" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 3 /nobreak >nul
start /MIN "Pitcher Dashboard Frontend" cmd /k "cd /d "%PROJECT_DIR%frontend" && set BROWSER=none&& npm start"
