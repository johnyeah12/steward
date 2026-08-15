"""Write the monthly allocation budget into johnyeah12/steward-data.

Appends `badd` events to ledger.json in exactly the shape the app writes, so
the phones treat them as if they had been pasted in. Refuses to run unless the
figures reconcile against the source spreadsheet totals.

  --dry-run   show what would happen, touch nothing
"""
import base64
import json
import re
import subprocess
import sys
import time
import uuid

REPO = "johnyeah12/steward-data"
PATH = "ledger.json"
BACKUP = "/private/tmp/claude-501/-Users-japetadan-Code/59d48952-2889-4b2c-90ef-70aa460c5fa4/scratchpad/ledger_backup.json"

SHEET_PLANNED = 14397276   # HK$143,972.76 in cents, per the sheet's own Totals row
SHEET_CC = 1984895         # HK$19,848.95

# (section, [(label, planned, via_cc), ...]) — label keeps the "NN:" due-day prefix
BUDGET = [
    ("HK HOUSEHOLD", [
        ("CCF Tithes", 7000, 0),
        ("Ate Bhel", 5300, 0),
        ("Coastal Skyline Rent", 21500, 0),
        ("Utilities - WiFi", 300, 300),
        ("Utilities - Electricity", 2000, 2000),
        ("Utilities - Gas", 500, 500),
        ("Utilities - Phone", 500, 500),
    ]),
    ("INVESTMENTS", [
        ("PRU Life Insurance Eliana", 2105, 2105),
        ("PHILAMLIFE Future Scholar Gabriel", 1500, 1500),
        ("PHILAMLIFE Gezelle", 570, 570),
    ]),
    ("EDUCATION", [
        ("GAB YD Taekwondo", 1100, 0),
        ("Eliana Gymnastics Standout Performance", 1200, 0),
        ("Eliana Jack Swimming", 1200, 0),
        ("Chinese Online", 855, 0),
        ("Annual Educ Fees", 1974, 1974),
    ]),
    ("PINAS CONDO + EL PUEBLO", [
        ("7: Pueblo Del Sol BOC BDO", 24434, 0),
        ("10: Uptown PLDT GCASH", 210, 0),
        ("15: Birchwood Assoc Dues GCASH", 855, 0),
        ("15: Birchwood SORC GCASH", 200, 0),
        ("15: APO 311 Assoc Dues GCASH", 341, 0),
        ("15: Sojourn Fees BDO", 2000, 0),
        ("22: Meralco Uptown Arts", 658, 0),
        ("22: Meralco Birchwood", 132, 0),
        ("26: Uptown Arts Assoc Dues BDO", 764, 0),
        ("28: Uptown Arts Home Loan BDO", 12500, 0),
    ]),
    ("PINAS MISC.", [
        ("Rivera Family", 1974, 0),
    ]),
    ("HK HOUSEHOLD BUDGET", [
        ("Groceries Ate (2400/wk)", 8400, 0),
        ("Dinner Date / Entertainment (1200/wk)", 4800, 4800),
        ("Friday Pizza / Sunday Food (700/wk)", 2800, 2800),
        ("Clothes / Shoes Shopping / Vitamins (700/wk)", 2800, 2800),
    ]),
    ("TAX & LOAN, ETC.", [
        ("LOAN PAYMENT - HSBC", 7300, 0),
        ("JAPE BAON", 7000, 0),
        ("TAX SAVINGS (12% ONLY)", 19200, 0),
    ]),
]

DRY = "--dry-run" in sys.argv


def gh(args, stdin=None):
    r = subprocess.run(["/opt/homebrew/bin/gh"] + args, capture_output=True,
                       text=True, input=stdin)
    if r.returncode:
        sys.exit(f"gh failed: {r.stderr.strip()}")
    return r.stdout


def strip_day(label):
    m = re.match(r"^\s*(\d{1,2})\s*[:.)-]\s*(.+)$", label)
    if m and 1 <= int(m.group(1)) <= 31:
        return m.group(2).strip(), int(m.group(1))
    return label.strip(), None


# ── build the events ───────────────────────────────────────────────────
now = int(time.time() * 1000)
device = str(uuid.uuid4())
events, seq = [], 1
total_planned = total_cc = 0

for group, rows in BUDGET:
    for label, planned, cc in rows:
        name, day = strip_day(label)
        amt, ccc = planned * 100, cc * 100
        total_planned += amt
        total_cc += ccc
        events.append({
            "k": "badd",
            "x": {"id": str(uuid.uuid4()), "name": name, "amt": amt, "cc": ccc,
                  "grp": group, "seq": seq, "day": day,
                  "cat": "bill", "payer": "a", "split": "both"},
            "i": str(uuid.uuid4()),
            "t": now + seq,          # keep a stable, increasing order
            "d": device,
        })
        seq += 1

dated = [e for e in events if e["x"]["day"]]
print(f"{len(events)} bills, {len(dated)} with a due day, {len(events)-len(dated)} undated allocations")
print(f"planned  {total_planned/100:>12,.2f}   sheet {SHEET_PLANNED/100:>12,.2f}   diff {(total_planned-SHEET_PLANNED)/100:+.2f}")
print(f"on card  {total_cc/100:>12,.2f}   sheet {SHEET_CC/100:>12,.2f}   diff {(total_cc-SHEET_CC)/100:+.2f}")

# The sheet's own totals carry sub-dollar rounding; anything beyond that is a
# transcription error and must stop the import.
assert len(events) == 33, "expected 33 lines"
assert abs(total_planned - SHEET_PLANNED) <= 100, "planned total does not reconcile"
assert abs(total_cc - SHEET_CC) <= 100, "card total does not reconcile"
for g, rows in BUDGET:
    print(f"  {g:26} {sum(r[1] for r in rows):>9,}")
print("reconciled OK")

# ── merge into the live ledger ─────────────────────────────────────────
meta = json.loads(gh(["api", f"/repos/{REPO}/contents/{PATH}"]))
ledger = json.loads(base64.b64decode(meta["content"]))
existing = {e["x"]["name"].lower().strip()
            for e in ledger.get("events", []) if e.get("k") == "badd"}
if existing:
    before = len(events)
    events = [e for e in events if e["x"]["name"].lower().strip() not in existing]
    print(f"skipped {before - len(events)} already present")

with open(BACKUP, "w") as fh:
    json.dump(ledger, fh)
print(f"backup written: {BACKUP}  ({len(ledger.get('events', []))} events)")

if not events:
    sys.exit("nothing new to add")

ledger["events"] = ledger.get("events", []) + events
payload = json.dumps(ledger, separators=(",", ":"))

if DRY:
    print(f"\nDRY RUN — would write {len(ledger['events'])} events ({len(payload)} bytes)")
    sys.exit(0)

body = json.dumps({
    "message": f"Import monthly allocation budget ({len(events)} bills)",
    "content": base64.b64encode(payload.encode()).decode(),
    "sha": meta["sha"],
})
gh(["api", "--method", "PUT", f"/repos/{REPO}/contents/{PATH}", "--input", "-"], stdin=body)
print(f"\nwrote {len(events)} bills — ledger now has {len(ledger['events'])} events")
