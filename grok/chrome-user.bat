@echo off
REM Dong het Chrome roi mo lai profile user + remote debugging :9222

set PORT=9222
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if "%CHROME%"=="" (
  echo Khong tim thay chrome.exe
  pause
  exit /b 1
)

set "UD=%LOCALAPPDATA%\Google\Chrome\User Data"

echo.
echo  Canh bao: se DONG HET Google Chrome (moi tab).
echo  user-data: %UD%
echo  debug port: %PORT%
echo.
set /p ANS=Tiep tuc? [y/N]: 
if /i not "%ANS%"=="y" if /i not "%ANS%"=="yes" (
  echo Huy.
  exit /b 1
)

echo Dong chrome.exe ...
taskkill /IM chrome.exe /T /F >nul 2>&1
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

tasklist /FI "IMAGENAME eq chrome.exe" /NH 2>nul | find /I "chrome.exe" >nul
if %ERRORLEVEL%==0 (
  echo Chrome van con — dong tay Task Manager roi chay lai.
  pause
  exit /b 1
)

echo Mo Chrome user + debug ...
start "" "%CHROME%" --remote-debugging-port=%PORT% --remote-debugging-address=127.0.0.1 --user-data-dir="%UD%" --no-first-run --no-default-browser-check about:blank
timeout /t 3 /nobreak >nul

curl -s "http://127.0.0.1:%PORT%/json/version" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo CDP OK http://127.0.0.1:%PORT%
) else (
  echo Canh bao: CDP chua len — doi them hoac mo DevTools.
)
echo Xong. Menu [8]/[9] hoac: npm run grok:user
exit /b 0
