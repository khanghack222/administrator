@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: edu-reg-multi.bat [count] [workers]
  echo   edu-reg-multi.bat 5 2
  set /p N=Count: 
  set /p W=Workers: 
) else (
  set N=%~1
  set W=%~2
)
if "%W%"=="" set W=2
echo reg multi n=%N% w=%W%
node reg-multi.mjs --count %N% --workers %W%
pause
