Set-Location $PSScriptRoot

git update-index --no-assume-unchanged index.html 2>$null
git update-index --no-skip-worktree index.html 2>$null
git add -f index.html
git status --short
git commit -m "fix: invalidar cache historico apos guardar nota"
git push origin main
Write-Host "Deploy OK" -ForegroundColor Green
