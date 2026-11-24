@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1 || (echo 请先安装 Node.js 24 & pause & exit /b 1)
if not exist node_modules\express\package.json (
  where pnpm >nul 2>&1 || (echo 请先安装 pnpm 或在本目录运行 npm install & pause & exit /b 1)
  call pnpm install --frozen-lockfile || (pause & exit /b 1)
)
echo 打开 http://localhost:3210
node src/server.js
pause
