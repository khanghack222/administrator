@echo off
cd /d "%~dp0"
echo [edu-create] tao mail → acc/N.json + acc/latest.json
node getedumail-auto.mjs --no-open %*
echo.
echo Xong. Extension 1b (edu-bridge) | menu [2] login.
pause
