@echo off
cd /d "%~dp0"
echo Playwright reg Grok (Chrome + NopeCHA)
node reg-grok.mjs %*
