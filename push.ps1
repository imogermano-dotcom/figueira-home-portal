Set-Location $PSScriptRoot
# Limpar lock files se existirem
@(".git\HEAD.lock", ".git\index.lock", ".git\objects\maintenance.lock") | ForEach-Object {
    $f = Join-Path $PSScriptRoot $_
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "Lock removido: $_" -ForegroundColor Yellow }
}
# Commitar alteracoes pendentes (se houver)
$status = git status --porcelain index.html dashboard.html
if ($status) {
    git add index.html dashboard.html
    git commit -m "feat: actualizacoes dashboard portal"
    Write-Host "Commit feito" -ForegroundColor Cyan
} else {
    Write-Host "Nada para commitar - a fazer push dos commits existentes..." -ForegroundColor Yellow
}
git push origin main
Write-Host "Deploy em curso - aguarda 30 segundos e refresca portal.miguelgermano.com" -ForegroundColor Green
