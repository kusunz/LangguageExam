#!/usr/bin/env pwsh
# Pre-commit checks script

Write-Host "🔍 Running pre-commit checks..." -ForegroundColor Cyan

# 1. Syntax check
Write-Host "`n1️⃣ Syntax check..." -ForegroundColor Yellow
node --check server/db.js
if ($LASTEXITCODE -ne 0) { 
    Write-Host "❌ db.js has syntax errors!" -ForegroundColor Red
    exit 1 
}

node --check server/server.js
if ($LASTEXITCODE -ne 0) { 
    Write-Host "❌ server.js has syntax errors!" -ForegroundColor Red
    exit 1 
}

Write-Host "✅ Syntax OK" -ForegroundColor Green

# 2. Quick startup test
Write-Host "`n2️⃣ Testing server startup (5s)..." -ForegroundColor Yellow
$env:DB_RUN_MIGRATIONS = "0"
$env:NODE_ENV = "test"

$job = Start-Job -ScriptBlock { 
    Set-Location $using:PWD
    node server/server.js 
}

Start-Sleep -Seconds 5

$output = Receive-Job $job -ErrorAction SilentlyContinue
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -ErrorAction SilentlyContinue

if ($output -match "error|Error|ERROR") {
    Write-Host "❌ Server startup errors detected!" -ForegroundColor Red
    Write-Host $output
    exit 1
}

Write-Host "✅ Server starts OK" -ForegroundColor Green

# 3. Check for console.log debugging statements (optional)
Write-Host "`n3️⃣ Checking for debug statements..." -ForegroundColor Yellow
$debugLogs = Select-String -Path "server/server.js","server/db.js" -Pattern "console\.log\('DEBUG" -SimpleMatch
if ($debugLogs) {
    Write-Host "⚠️  Found DEBUG console.logs (consider removing):" -ForegroundColor Yellow
    $debugLogs | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}

Write-Host "`n✨ All checks passed! Safe to commit & push." -ForegroundColor Green
Write-Host "Run: git add . && git commit -m 'message' && git push origin develop" -ForegroundColor Cyan
