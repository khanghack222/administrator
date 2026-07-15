@echo off
cd /d "%~dp0"
echo Playwright reg Grok FRESH profile
node reg-grok.mjs --fresh %*
