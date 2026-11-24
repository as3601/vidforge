@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, this happens only once...
  call npm install || (pause & exit /b 1)
)
start "" http://localhost:5190
call npm run dev
