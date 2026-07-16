@echo off
cd /d "%~dp0"
echo Reg Grok (Chrome USER / CDP)
node reg-grok.mjs %*
