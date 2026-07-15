@echo off
cd /d "%~dp0"
title edu-bridge :3847
echo Bridge: http://127.0.0.1:3847/latest
echo Doc ../mail/acc/latest.json
echo Giu cua so nay mo.
echo.
node bridge-server.mjs
