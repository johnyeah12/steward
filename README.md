# Steward

*Stewarding together what we've been given.*

A private expense tracker for two people. Installs on the iPhone Home Screen like
a normal app, works with no signal, and syncs between both phones.

No App Store, no Apple Developer account, no server to run, no monthly cost.

## How the privacy actually works

| Layer | Where it lives | Who can see it |
|---|---|---|
| App code | GitHub Pages | Anyone with the URL — it's just an empty shell |
| Your expenses | A **private** GitHub repo | Only accounts you grant access to |
| Access token | Encrypted on each phone (PBKDF2 → AES-GCM, unlocked by the 6-digit passcode) | Nobody without the passcode |

Someone who guessed the URL would see a setup screen and nothing else. The data
never touches the Pages site.

## Setup

**1. Sign in to GitHub**

```bash
gh auth login
```

**2. Deploy**

```bash
./deploy.sh
```

This creates `steward` (published via Pages) and `steward-data` (private, holds
`ledger.json`), then prints your app URL.

> **On the free plan** GitHub refuses to publish Pages from a private repo. Re-run
> as `PUBLIC_APP=1 ./deploy.sh` to make just the *app* repo public. That is safe:
> it contains no expenses and no token, and `steward-data` stays private either
> way. Upgrading to GitHub Pro instead lets both repos stay private.

**3. Create the access token**

At <https://github.com/settings/personal-access-tokens/new>:

- **Repository access** → Only select repositories → `steward-data`
- **Permissions** → Repository permissions → **Contents: Read and write**

Copy the token. The setup screen refuses to continue if the repo turns out to be
public or the token can't write, so a mistake here can't quietly leak anything.

**4. Install on both phones**

Open the app URL in Safari → Share → **Add to Home Screen**. Then run through
setup on each phone using the *same* repo, token, and passcode.

For your wife's own GitHub account to reach the data repo, invite her as a
collaborator on `steward-data` and have her generate her own token. Sharing one
token also works and is simpler.

## Using it

- **Add** — tap an amount, pick a category, choose who paid and how it splits
- **Scan a receipt** — photograph or pick a bill and it fills the amount, shop, date and category in
- **Home** — month total, budget, settle-up, category breakdown, who paid what
- **History** — search, tap any row to edit, delete, or view its receipt (🧾)
- **Settle up** — running "who owes whom" across all time; *Mark as settled* zeroes it
- **Export** — CSV out of the History tab

## Scanning receipts

Reading happens **entirely on the phone** — no image is ever sent to any OCR
service. Tesseract is vendored under `vendor/` and loaded the first time you
scan (~6MB, cached afterwards), so scanning works offline from then on.

The pipeline is: downscale → grayscale → **Bradley–Roth adaptive threshold** →
Tesseract → parse. The adaptive threshold is the part that matters. A single
global cutoff loses whichever half of the receipt is in shadow; thresholding each
pixel against its own neighbourhood survives a shadow falling across the paper or
a photo lit from one side. On a test receipt with a heavy diagonal shadow, that
one change took the result from *no amount found at all* to the correct total at
92% confidence.

Finding the total is deliberately fussy. It looks for a labelled line (`TOTAL`,
`AMOUNT DUE`, `合計`…), explicitly rejecting the near-misses that sit right next to
it — `SUBTOTAL`, `CASH`, `CHANGE`, `DISCOUNT`, `TAX`. It also handles the common
case where the number wraps onto the line *below* its label. With no label at all
it falls back to the largest properly-decimalised number and marks the result low
confidence.

**It always shows you what it read before saving.** Nothing is committed silently:
the panel says whether it's confident, and you can correct any field or remove the
photo. Treat it as a good first guess, not gospel — English receipts are its
strength, Chinese-only ones will usually still yield the amount but not the shop.

The photo is compressed to ~60KB and stored as `receipts/<id>.jpg` in the data
repo — one file per receipt, written once, so it never bloats a ledger sync. Shot
while offline, it queues on the phone and uploads on the next sync.

Everything saves instantly on the phone. Sync happens in the background, on
reopen, and when the connection comes back. The pill under the month shows where
it stands.

## Monthly bills and reminders

The **Bills** tab holds recurring commitments — rent, utilities, subscriptions —
each with an amount and a day of the month. Tap **Paste** to bring in a whole list
at once; it reads spreadsheet tabs, CSV, markdown tables, column-aligned text, or
plain lines like `Netflix 78 15th`, and maps columns by header when there is one.
You always get a preview first, with unusable rows flagged and skipped rather than
guessed at.

Home shows what's due, one tap marks a bill paid, and paying it logs a real
expense dated to the due day — so it lands in the month it belongs to even if you
pay late.

### Getting reminded

```bash
./setup-reminders.sh
```

An installed web app cannot wake itself up to notify you, so the reminder runs as
a daily GitHub Actions job **inside your private data repo**. That means it fires
whether or not the phones and the Mac are asleep — the reason it doesn't live in
the app or in `launchd`.

It sends one digest per day covering everything that needs attention, and nags on
a schedule rather than every single day: at your lead time, the day before, the
due day, then every third day while overdue.

Channels are chosen purely by which secrets exist:

| Channel | Setup | Notes |
|---|---|---|
| **GitHub issue** | none | Works immediately. GitHub emails everyone watching the repo. |
| **Telegram** | `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_IDS` | Real push notification on both phones. |
| **Email** | `SMTP_HOST`/`PORT`/`USER`/`PASS`, `MAIL_TO` | Gmail needs an App Password, not your login. |

`setup-reminders.sh` prints the exact commands. Test any time with:

```bash
gh workflow run 'Bill reminders' --repo <you>/steward-data
```

## How sync works

The ledger is an append-only event log. Each phone appends immutable, uniquely-IDed
events; syncing unions the two sets and writes the result back. There is no
last-writer-wins clobbering — if you both log an expense while offline, both
survive. A `409` from GitHub (you both pushed at once) triggers a re-merge and retry.

Edits and deletes are themselves events, applied in timestamp order, so the log is
also a full history of every change.

## Development

```bash
python3 -m http.server 8765 --directory .
```

Open <http://localhost:8765/?nosw> — the `?nosw` flag skips service-worker
registration so edits show up on reload instead of being served from cache.

After changing any shell file, bump `VERSION` in `sw.js` so installed phones pick
the update up.

## Files

```
index.html            markup for all five views
app.js                event log, crypto vault, sync, bills, receipts, rendering
ocr.js                image preprocessing, Tesseract, receipt parsing
styles.css            iOS-flavoured styling, light + dark
sw.js                 offline shell cache (vendor/ cached on first scan, not precached)
vendor/               Tesseract runtime + English model, ~5.8MB
reminders/            the daily bill-reminder job, installed into the data repo
deploy.sh             creates both repos, pushes, enables Pages
setup-reminders.sh    installs the reminder workflow + prints secret setup
```

Bills, expenses, receipts and shared settings all ride in the same append-only
event log, so they sync and merge by exactly the same rules.
