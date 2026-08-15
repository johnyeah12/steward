#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Steward — one-shot deploy.
#
#  Creates two repos under your account:
#    <app repo>   private, holds this code, published via GitHub Pages
#    <data repo>  private, holds ledger.json — your actual expenses
#
#  Re-running is safe: existing repos are reused, code is re-pushed.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_REPO="${APP_REPO:-steward}"
DATA_REPO="${DATA_REPO:-steward-data}"
HERE="$(cd "$(dirname "$0")" && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh  >/dev/null || die "GitHub CLI not found.  brew install gh"
command -v git >/dev/null || die "git not found."
gh auth status >/dev/null 2>&1 || die "Not signed in to GitHub.  Run: gh auth login"

USER="$(gh api user --jq .login)"
bold "Deploying as $USER"

# ── 1. private data repo ─────────────────────────────────────
if gh repo view "$USER/$DATA_REPO" >/dev/null 2>&1; then
  ok "data repo $USER/$DATA_REPO already exists"
else
  gh repo create "$USER/$DATA_REPO" --private --add-readme \
    --description "Private ledger for Steward. Do not make this public." >/dev/null
  ok "created private data repo $USER/$DATA_REPO"
fi

if ! gh api "/repos/$USER/$DATA_REPO/contents/ledger.json" >/dev/null 2>&1; then
  gh api --method PUT "/repos/$USER/$DATA_REPO/contents/ledger.json" \
    -f message="Start the ledger" \
    -f content="$(printf '{"v":1,"events":[]}' | base64)" >/dev/null
  ok "seeded empty ledger.json"
else
  ok "ledger.json already present — left untouched"
fi

# ── 2. app repo + push ───────────────────────────────────────
if gh repo view "$USER/$APP_REPO" >/dev/null 2>&1; then
  ok "app repo $USER/$APP_REPO already exists"
else
  gh repo create "$USER/$APP_REPO" --private \
    --description "Steward — a private expense tracker for two." >/dev/null
  ok "created private app repo $USER/$APP_REPO"
fi

cd "$HERE"

# Stamp the service-worker cache name so installed phones actually pick this
# build up. Without a fresh name the old shell keeps being served.
STAMP="steward-$(date +%Y%m%d%H%M%S)"
/usr/bin/sed -i '' -E "s/^const VERSION = '[^']*';/const VERSION = '$STAMP';/" sw.js
ok "service worker cache stamped $STAMP"

[ -d .git ] || { git init -q; git branch -M main; }
# Keep statements, ledgers and scratch files out of a repo that may be public.
cat > .gitignore <<'EOF'
.DS_Store
_stmt/
_check.json
*.pdf
test-stmt.*
eStatement*
EOF
git add -A
git -c user.email="$USER@users.noreply.github.com" \
    -c user.name="$USER" \
    commit -qm "Deploy Steward" 2>/dev/null || ok "nothing new to commit"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$USER/$APP_REPO.git"
git push -qu origin main --force
ok "pushed app code"

# ── 3. GitHub Pages ──────────────────────────────────────────
enable_pages() {
  gh api --method POST "/repos/$USER/$APP_REPO/pages" \
    -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1
}

if gh api "/repos/$USER/$APP_REPO/pages" >/dev/null 2>&1; then
  ok "Pages already enabled"
elif enable_pages; then
  ok "enabled GitHub Pages"
elif [ "${PUBLIC_APP:-0}" = "1" ]; then
  warn "Private Pages needs GitHub Pro — making the APP repo public as asked."
  warn "Only app code becomes public. $DATA_REPO stays private."
  gh repo edit "$USER/$APP_REPO" --visibility public --accept-visibility-change-consequences >/dev/null
  sleep 2
  if enable_pages; then
    ok "app repo is public; Pages enabled"
  else
    die "Still could not enable Pages. Check github.com/$USER/$APP_REPO/settings/pages"
  fi
else
  echo
  warn "Could not enable Pages: publishing from a PRIVATE repo needs GitHub Pro."
  echo
  echo "  Your data repo ($DATA_REPO) is private either way — this is only about"
  echo "  the app code, which holds no expenses and no token."
  echo
  echo "  Free fix — make just the app repo public, then re-run:"
  echo "      PUBLIC_APP=1 ./deploy.sh"
  echo
  echo "  Or upgrade to GitHub Pro and re-run ./deploy.sh unchanged."
  exit 1
fi

URL="https://$USER.github.io/$APP_REPO/"
echo
bold "Done."
echo "  App URL    $URL"
echo "  Data repo  $USER/$DATA_REPO  (private)"
echo
echo "  Pages takes a minute or two to go live on the very first deploy."
echo
bold "First time only: create the access token"
echo "  Skip this if you've already set the app up — the token is stored"
echo "  encrypted on each phone and survives redeploys. You only need a new"
echo "  one if it expires, you revoke it, or you sign out of a phone."
echo
echo "  1. Open  https://github.com/settings/personal-access-tokens/new"
echo "  2. Name it Steward, set an expiry you're happy with"
echo "  3. Repository access → Only select repositories → $DATA_REPO"
echo "  4. Permissions → Repository permissions → Contents → Read and write"
echo "  5. Generate, copy the token"
echo
echo "  Then open $URL on both phones, Share → Add to Home Screen,"
echo "  and run through setup with the same repo, token and passcode."
echo
echo "  Already set up? Nothing to do — just open the app. It refreshes"
echo "  itself to this build, and your passcode and data are unchanged."
echo
bold "Then, for bill reminders"
echo "  ./setup-reminders.sh"
