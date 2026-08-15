#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Install the daily bill-reminder job into your private data repo.
#
#  It runs on GitHub's machines, so reminders arrive even when both
#  phones and the Mac are asleep. Safe to re-run.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DATA_REPO="${DATA_REPO:-steward-data}"
HERE="$(cd "$(dirname "$0")" && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "GitHub CLI not found.  brew install gh"
gh auth status >/dev/null 2>&1 || die "Not signed in.  Run: gh auth login"

USER="$(gh api user --jq .login)"
REPO="$USER/$DATA_REPO"
gh repo view "$REPO" >/dev/null 2>&1 || die "Can't see $REPO. Run ./deploy.sh first."

bold "Installing the reminder job into $REPO"

put_file() {           # path, local source, message
  local path="$1" src="$2" msg="$3" sha args
  sha="$(gh api "/repos/$REPO/contents/$path" --jq .sha 2>/dev/null || true)"
  args=(-f "message=$msg" -f "content=$(base64 < "$src" | tr -d '\n')")
  [ -n "$sha" ] && args+=(-f "sha=$sha")
  gh api --method PUT "/repos/$REPO/contents/$path" "${args[@]}" >/dev/null
}

if ! put_file ".github/scripts/remind.py" "$HERE/reminders/remind.py" "Add bill reminder script" 2>/dev/null; then
  die "Could not write to the repo. If this mentions 'workflow' scope, run:
    gh auth refresh -h github.com -s workflow
  then run this script again."
fi
ok "added .github/scripts/remind.py"

if ! put_file ".github/workflows/bill-reminders.yml" "$HERE/reminders/bill-reminders.yml" "Add daily bill reminder workflow" 2>/dev/null; then
  die "Could not write the workflow file. Run:
    gh auth refresh -h github.com -s workflow
  then run this script again."
fi
ok "added .github/workflows/bill-reminders.yml"

echo
bold "Pick how you want to be reminded"
cat <<EOF

  Nothing more is needed for the FREE option — with no secrets set, the job
  opens an issue in $DATA_REPO, and GitHub emails everyone watching the repo.
  Add your wife as a collaborator and she gets them too.

  For a push notification on your phone (Telegram):
    gh secret set TELEGRAM_TOKEN    --repo $REPO
    gh secret set TELEGRAM_CHAT_IDS --repo $REPO   # both chat ids, comma-separated

  For proper email instead (Gmail needs an App Password, not your login):
    gh secret set SMTP_HOST --repo $REPO           # smtp.gmail.com
    gh secret set SMTP_PORT --repo $REPO           # 587
    gh secret set SMTP_USER --repo $REPO
    gh secret set SMTP_PASS --repo $REPO
    gh secret set MAIL_TO   --repo $REPO           # both addresses, comma-separated

  To silence the issue fallback once another channel works:
    gh variable set USE_ISSUE --repo $REPO --body 0

EOF
bold "Test it right now"
echo "  gh workflow run 'Bill reminders' --repo $REPO"
echo "  gh run list --repo $REPO --workflow 'Bill reminders'"
echo
echo "  It runs daily at 09:00 Hong Kong time. Change the cron in"
echo "  .github/workflows/bill-reminders.yml if you'd rather have it elsewhere."
