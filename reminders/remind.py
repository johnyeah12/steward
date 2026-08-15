#!/usr/bin/env python3
"""
Bill reminders for Steward.

Runs on a daily GitHub Actions cron inside the private data repo, reads
ledger.json, and sends one digest covering every bill that needs attention.

Because it runs on GitHub's machines it does not care whether the phones or
the Mac are awake — which is the whole reason it lives here rather than in
the app or in launchd.

Channels are opt-in, chosen purely by which secrets exist:
  Telegram  TELEGRAM_TOKEN, TELEGRAM_CHAT_IDS
  Email     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_TO
  Issue     always available — GitHub emails the repo's watchers for free
"""

import json
import os
import smtplib
import sys
import urllib.error
import urllib.request
from calendar import monthrange
from datetime import date, timedelta
from email.message import EmailMessage

try:
    from zoneinfo import ZoneInfo
except ImportError:                                   # pragma: no cover
    ZoneInfo = None

SYMBOLS = {"HKD": "HK$", "USD": "$", "PHP": "₱", "EUR": "€",
           "GBP": "£", "SGD": "S$", "JPY": "¥", "AUD": "A$"}
ZERO_DP = {"JPY"}


# ── ledger ────────────────────────────────────────────────────────────

def reduce_log(events):
    """Mirror of the app's reducer: replay events in order."""
    txns, bills, cfg = {}, {}, {}
    for e in sorted(events, key=lambda e: (e.get("t", 0), e.get("i", ""))):
        k, x = e.get("k"), e.get("x")
        if k == "add" and isinstance(x, dict):
            txns[x["id"]] = dict(x)
        elif k == "edit" and x in txns:
            txns[x].update(e.get("p") or {})
        elif k == "del":
            txns.pop(x, None)
        elif k == "badd" and isinstance(x, dict):
            bills[x["id"]] = dict(x)
        elif k == "bedit" and x in bills:
            bills[x].update(e.get("p") or {})
        elif k == "bdel":
            bills.pop(x, None)
        elif k == "cfg":
            cfg.update(e.get("p") or {})
    return list(txns.values()), list(bills.values()), cfg


def money(cents, cur):
    if cur in ZERO_DP:
        return f"{SYMBOLS.get(cur, '')}{cents:,.0f}"
    return f"{SYMBOLS.get(cur, '')}{cents / 100:,.2f}"


def due_date(bill, today):
    day = min(int(bill.get("day", 1)), monthrange(today.year, today.month)[1])
    return date(today.year, today.month, day)


def paid_this_month(bill, txns, today):
    tag = f"{today.year:04d}-{today.month:02d}"
    return any(t.get("bill") == bill["id"] and str(t.get("date", "")).startswith(tag)
               for t in txns)


def should_ping(days, lead):
    """Nag on a schedule rather than every single day."""
    if days < 0:
        late = -days
        return late == 1 or late % 3 == 0
    return days in (0, 1, lead)


# ── delivery ──────────────────────────────────────────────────────────

def post(url, payload=None, headers=None, method="POST"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          **(headers or {})})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def send_telegram(text):
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    chats = [c.strip() for c in os.environ.get("TELEGRAM_CHAT_IDS", "").split(",") if c.strip()]
    if not token or not chats:
        return None
    ok = 0
    for chat in chats:
        try:
            post(f"https://api.telegram.org/bot{token}/sendMessage",
                 {"chat_id": chat, "text": text, "parse_mode": "HTML",
                  "disable_web_page_preview": True})
            ok += 1
        except Exception as exc:                       # noqa: BLE001
            print(f"  telegram {chat}: {exc}", file=sys.stderr)
    return f"telegram → {ok}/{len(chats)}"


def send_email(subject, text):
    host = os.environ.get("SMTP_HOST", "").strip()
    to = [a.strip() for a in os.environ.get("MAIL_TO", "").split(",") if a.strip()]
    if not host or not to:
        return None
    user = os.environ.get("SMTP_USER", "")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("MAIL_FROM", user or "steward@localhost")
    msg["To"] = ", ".join(to)
    msg.set_content(text)
    port = int(os.environ.get("SMTP_PORT", "587"))
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=25)
        else:
            server = smtplib.SMTP(host, port, timeout=25)
            server.starttls()
        with server:
            if user:
                server.login(user, os.environ.get("SMTP_PASS", ""))
            server.send_message(msg)
        return f"email → {len(to)}"
    except Exception as exc:                           # noqa: BLE001
        print(f"  email: {exc}", file=sys.stderr)
        return None


def send_issue(subject, text):
    """Open an issue. GitHub emails everyone watching the repo — no SMTP setup."""
    if os.environ.get("USE_ISSUE", "1") != "1":
        return None
    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token or not repo:
        return None
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    try:
        # tidy up: close any reminder issue from a previous run
        old = json.loads(post(f"{api}/repos/{repo}/issues?state=open&labels=bill-reminder",
                              None, headers, method="GET"))
        for issue in old:
            post(f"{api}/repos/{repo}/issues/{issue['number']}",
                 {"state": "closed"}, headers, method="PATCH")
        post(f"{api}/repos/{repo}/issues",
             {"title": subject, "body": text, "labels": ["bill-reminder"]}, headers)
        return "issue → opened"
    except Exception as exc:                           # noqa: BLE001
        print(f"  issue: {exc}", file=sys.stderr)
        return None


# ── main ──────────────────────────────────────────────────────────────

def main():
    ledger_path = os.environ.get("LEDGER_PATH", "ledger.json")
    tz = os.environ.get("TIMEZONE", "Asia/Hong_Kong")
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            ledger = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"No usable ledger ({exc}) — nothing to do.")
        return 0

    txns, bills, cfg = reduce_log(ledger.get("events") or [])
    if not bills:
        print("No bills configured — nothing to do.")
        return 0

    today = date.today()
    if ZoneInfo:
        from datetime import datetime
        today = datetime.now(ZoneInfo(tz)).date()

    lead = int(cfg.get("lead") or 3)
    cur = cfg.get("cur") or "HKD"

    # Undated lines are monthly allocations (groceries, tithes) — budgeted,
    # but there is no date to chase, so they are never nagged about.
    dated = [b for b in bills if b.get("day")]

    hits = []
    for bill in sorted(dated, key=lambda b: int(b["day"])):
        if paid_this_month(bill, txns, today):
            continue
        days = (due_date(bill, today) - today).days
        if should_ping(days, lead):
            hits.append((days, bill))

    if not hits:
        print(f"{len(dated)} dated bill(s) checked "
              f"({len(bills) - len(dated)} undated), nothing due within {lead} day(s).")
        return 0

    def phrase(d):
        if d == 0:
            return "due today"
        if d == 1:
            return "due tomorrow"
        if d < 0:
            return f"{-d} day{'s' if d != -1 else ''} late"
        return f"due in {d} days"

    lines, total, on_card = [], 0, 0
    # sort on the day only — several bills commonly share a due date, and
    # tuple comparison would otherwise fall through to comparing dicts
    for days, bill in sorted(hits, key=lambda h: (h[0], h[1].get("name", ""))):
        amt = int(bill.get("amt", 0))
        cc = int(bill.get("cc") or 0)
        total += amt
        on_card += cc
        mark = "⚠️" if days < 0 else ("\U0001f514" if days <= 1 else "\U0001f4c5")
        card = " · 💳 on card" if cc >= amt > 0 else (f" · 💳 {money(cc, cur)} on card" if cc else "")
        lines.append(f"{mark} {bill.get('name', 'Bill')} — {money(amt, cur)} · {phrase(days)}{card}")

    late = sum(1 for d, _ in hits if d < 0)
    subject = f"{len(hits)} bill{'s' if len(hits) != 1 else ''} to pay" + (f" ({late} late)" if late else "")
    body = ("\n".join(lines)
            + f"\n\nTotal outstanding: {money(total, cur)}"
            + (f"\nOf that, on the card: {money(on_card, cur)}" if on_card else "")
            + "\n\nOpen Steward to mark them paid.")

    print(subject)
    print(body)

    results = [send_telegram(f"<b>Steward</b>\n\n{body}"),
               send_email(f"Steward — {subject}", body),
               send_issue(f"Steward — {subject}", body)]
    sent = [r for r in results if r]
    if not sent:
        print("No channel configured — see setup-reminders.sh.", file=sys.stderr)
    else:
        print("Sent via: " + ", ".join(sent))
    return 0


if __name__ == "__main__":
    sys.exit(main())
