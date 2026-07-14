# Starts the NameSync API (port 4000) and frontend (port 3000) in separate windows.
# Usage:  .\run-dev.ps1   (run from the code\ directory, or anywhere)

$root = $PSScriptRoot

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\api'; npm run dev"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\frontend'; npm run dev"

Write-Host "API starting on http://localhost:4000  -  frontend on http://localhost:3000"
Write-Host "Open http://localhost:3000 once both windows show they are ready."
