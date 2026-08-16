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
- **Home** — month total, budget, category chart, who paid what
- **History** — search, tap any row to edit, delete, or view its receipt (🧾)
- **Export** — CSV out of the History tab

There is deliberately no "who owes whom". This is a shared record of what the two
of you spend and a reminder to pay it — not a ledger of debts between you.

## The category chart

Home ranks the month's spending by category. Tap a bar to open it: the entries
appear underneath, largest first. Tap any entry to re-file it, and anything the
importer couldn't identify lands in **Other** with a prompt to sort it out.

Categories are extensible — **New category** in that picker adds one with your own
name and icon. Custom categories ride in the same event log, so they appear on
both phones.

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

The **Bills** tab is the monthly budget: what's committed, what's on the card, and
what has a date attached.

Tap **Paste** to bring in a whole budget at once. It handles a real spreadsheet,
not just a tidy three-column list:

- **Sections** — an all-caps row with no figures (`HK HOUSEHOLD`) becomes a heading,
  and each section gets its own subtotal
- **A "via CC" column** — the portion of each line charged to a credit card, rolled
  up per section and across the whole budget. A tick or `yes` means the whole line.
- **Due days embedded in labels** — `7: Pueblo Del Sol BOC BDO` becomes day 7
- **Undated lines** — tithes, rent, weekly grocery allowances. These are budgeted
  and totalled, but never chased for a date they don't have.
- **Its own totals row** — recognised and skipped, not imported as a bill

It also reads plain tabs, CSV, markdown tables, column-aligned text, and lines like
`Netflix 78 15th`, mapping columns by header when there is one.

You always get a preview with per-row results and running totals, so you can check
them against your sheet before anything is imported. Rows it can't read are flagged
in red and skipped. Lines already in your list are skipped too — so pasting twice,
or pasting the same sheet on both phones, can't silently double your budget.

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

## Importing a card statement

**History → Import.** Takes a statement as **CSV, Excel (.xlsx) or PDF**, and reads
it entirely on the phone — the file is never uploaded anywhere.

- **Excel** needs no library. An `.xlsx` is a ZIP of XML and Safari can inflate
  raw-deflate natively, so `statement.js` reads the zip, `sharedStrings.xml` and
  the sheet directly — including consulting `styles.xml` to tell a real date cell
  from a plain number, since on the wire both are just serials.
- **PDF** uses vendored pdf.js (~1.7MB, loaded only when you pick a PDF). A PDF has
  no tables, only glyphs at coordinates, so rows are rebuilt by grouping text on
  its baseline and splitting columns on wide horizontal gaps.
- **CSV** handles quoted fields, tabs and semicolons.

It then works out each transaction positionally rather than by header, because
statements rarely have usable ones:

- **Payments, refunds, reversals and totals are skipped** — those aren't spending
- **Credits** (`CR`, a leading minus, or bracketed) are recognised and excluded
- **Two date columns** (transaction and posting) are consumed together, so the
  second one doesn't end up glued to the description
- **Split thousands are repaired** — banks emit `4,820.00` unquoted, which splits
  into `4` and `820.00`. Repair only runs on rows *wider than the table's usual
  width*, so a genuine `4` beside `820.00` in an amount-and-balance layout is left
  alone.
- **Categories are guessed** from the merchant, reusing the receipt-scanner's rules

**Charges are matched against your bills.** A statement line that looks like a
monthly bill, for a similar amount, marks that bill paid — for the month of the
charge, not today, so a July charge settles July even if August is already paid.

Nothing imports without a preview, and every charge carries a fingerprint of its
date, description and amount. Re-importing an overlapping statement recognises
what it has already seen and imports only what's new.

## Uptown

The Uptown flat is tracked apart from household spending, because it is a small
business rather than a cost: earnings, its own expenses, the monthly net and a
year-to-date table.

**Import Airbnb export** takes the CSV from Airbnb → Account → Transaction
History → Export, read on the phone like everything else. Two details matter:

- The export mixes **Reservation** rows (what a booking earned) with **Payout**
  rows (that same money reaching your bank). Importing both would double every
  peso, so payouts are recognised and reported as skipped rather than silently
  dropped.
- Airbnb writes dates as **MM/DD/YYYY** wherever you live, so the reader is told
  that explicitly. Left to guess, `06/05` becomes 6 May instead of 5 June.

Each booking is keyed by its **confirmation code**, so re-importing an
overlapping export imports nothing twice. If the export's currency differs from
yours, the preview says so and offers a rate — rows stay in the source currency
and the total shows both, so nothing is silently mislabelled.

Income is a distinct kind of entry and never counts towards household spending.

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
statement.js          CSV / XLSX / PDF readers and transaction extraction
styles.css            iOS-flavoured styling, light + dark
sw.js                 offline shell cache (vendor/ cached on demand, not precached)
vendor/               Tesseract + English model, pdf.js — ~7.5MB, all lazy-loaded
reminders/            the daily bill-reminder job, installed into the data repo
deploy.sh             creates both repos, pushes, enables Pages
setup-reminders.sh    installs the reminder workflow + prints secret setup
```

Bills, expenses, receipts and shared settings all ride in the same append-only
event log, so they sync and merge by exactly the same rules.
