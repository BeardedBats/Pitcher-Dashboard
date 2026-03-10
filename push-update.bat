@echo off
echo Pushing latest changes to GitHub...
cd /d "%~dp0"
git add -A
git status
echo.
set /p msg="Commit message (or press Enter for default): "
if "%msg%"=="" set msg=Update dashboard
git commit -m "%msg%"
git push origin main
echo.
echo Done! Railway will auto-redeploy in a few minutes.
pause
