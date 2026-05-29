# GitHub setup

## Initialize and push

```powershell
git init
git add .
git commit -m "chore: initial project snapshot"
git branch -M main
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

## Daily workflow

```powershell
git status
git add <changed-files>
git commit -m "feat: describe the change"
git push
```

## Pre-upload checks

```powershell
git status --ignored
git diff --cached
git ls-files | Select-String -Pattern '\.env|\.db|\.log|_tmp|token|secret|password'
```

Do not upload `.env` files, SQLite databases, logs, packet captures, reverse-engineering temp folders, internal design/research notes, or real tokens. Share configuration through `.env.example` only.
