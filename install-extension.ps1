# Browser Extension — quick install helper
# Run this once on any machine to load the extension into Edge.

$extDir = Join-Path $PSScriptRoot ".output\chrome-mv3"

if (-not (Test-Path $extDir)) {
    Write-Host "ERROR: Extension build not found at $extDir" -ForegroundColor Red
    Write-Host "Run 'npm run build' inside the browser-extension folder first." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Browser Extension — Install" -ForegroundColor Cyan
Write-Host "----------------------------"
Write-Host ""
Write-Host "Extension folder:" -ForegroundColor Gray
Write-Host "  $extDir" -ForegroundColor White
Write-Host ""
Write-Host "Steps:" -ForegroundColor Gray
Write-Host "  1. Open Edge and go to:  edge://extensions" -ForegroundColor White
Write-Host "  2. Turn on 'Developer mode' (toggle, top-right)" -ForegroundColor White
Write-Host "  3. Click 'Load unpacked'" -ForegroundColor White
Write-Host "  4. Select the folder shown above" -ForegroundColor White
Write-Host ""

# Copy path to clipboard so the user can paste it straight into the folder picker
$extDir | Set-Clipboard
Write-Host "The folder path has been copied to your clipboard." -ForegroundColor Green
Write-Host ""

# Open the Edge extensions page automatically
Start-Process "msedge" "edge://extensions"
