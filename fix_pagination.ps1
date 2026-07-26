Set-Location $PSScriptRoot

@(".git\index.lock", ".git\HEAD.lock") | ForEach-Object {
    $f = Join-Path $PSScriptRoot $_
    if (Test-Path $f) { Remove-Item $f -Force }
}

git update-index --no-assume-unchanged index.html 2>$null
git update-index --no-skip-worktree index.html 2>$null
git update-index --really-refresh 2>$null

$fileSize = (Get-Item "index.html").Length
Write-Host "index.html: $fileSize bytes" -ForegroundColor Cyan
git diff --stat HEAD index.html

git add -f index.html
git status --short
git commit -m "feat: portal updates"
if ($LASTEXITCODE -ne 0) {
    git commit --allow-empty -m "feat: portal updates force"
}

git push origin main
Write-Host "Deploy OK" -ForegroundColor Green
