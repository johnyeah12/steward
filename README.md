# OurMoney

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

This creates `ourmoney` (private, published via Pages) and `ourmoney-data`
(private, holds `ledger.json`), then prints your app URL.

> Publishing Pages from a private repo requires GitHub Pro. On the free plan the
> script tells you how to make the app repo public instead — the code contains no
> data, so this is safe, just less tidy.

**3. Create the access token**

At <https://github.com/settings/personal-access-tokens/new>:

- **Repository access** → Only select repositories → `ourmoney-data`
- **Permissions** → Repository permissions → **Contents: Read and write**

Copy the token. The setup screen refuses to continue if the repo turns out to be
public or the token can't write, so a mistake here can't quietly leak anything.

**4. Install on both phones**

Open the app URL in Safari → Share → **Add to Home Screen**. Then run through
setup on each phone using the *same* repo, token, and passcode.

For your wife's own GitHub account to reach the data repo, invite her as a
collaborator on `ourmoney-data` and have her generate her own token. Sharing one
token also works and is simpler.

## Using it

- **Add** — tap an amount, pick a category, choose who paid and how it splits
- **Home** — month total, budget, settle-up, category breakdown, who paid what
- **History** — search, tap any row to edit or delete
- **Settle up** — running "who owes whom" across all time; *Mark as settled* zeroes it
- **Export** — CSV out of the History tab

Everything saves instantly on the phone. Sync happens in the background, on
reopen, and when the connection comes back. The pill under the month shows where
it stands.

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
index.html   markup for all four views
app.js       event log, crypto vault, GitHub sync, rendering
styles.css   iOS-flavoured styling, light + dark
sw.js        offline shell cache
deploy.sh    creates both repos, pushes, enables Pages
```
