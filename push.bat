@echo off
del .git\HEAD.lock 2>nul
del .git\index.lock 2>nul
git push
pause
