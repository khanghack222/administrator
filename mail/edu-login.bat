@echo off
cd /d "%~dp0"
echo Login form Chrome (email+pass tu getedumail-latest.json)
node getedumail-auto.mjs --login %*
