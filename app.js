/* ══════════════════════════════════════════════════════════════
   Steward — a private, two-person expense tracker.

   Data model is an append-only event log. Every device appends
   immutable, uniquely-IDed events; syncing is a set union, so two
   phones editing offline can never conflict-clobber each other.

   The GitHub token is sealed with the passcode (PBKDF2 + AES-GCM)
   and only ever decrypted into memory.
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ───────────────────────── Constants ───────────────────────── */

const CATS = [
  { k: 'food', e: '🍜', n: 'Eating out' },
  { k: 'groc', e: '🛒', n: 'Groceries'  },
  { k: 'home', e: '🏠', n: 'Home'       },
  { k: 'tran', e: '🚕', n: 'Transport'  },
  { k: 'bill', e: '📱', n: 'Bills'      },
  { k: 'heal', e: '💊', n: 'Health'     },
  { k: 'fun',  e: '🎬', n: 'Fun'        },
  { k: 'trip', e: '✈️', n: 'Travel'     },
  { k: 'gift', e: '🎁', n: 'Gifts'      },
  { k: 'pers', e: '💅', n: 'Personal'   },
  { k: 'kids', e: '👶', n: 'Kids'       },
  { k: 'misc', e: '📦', n: 'Other'      },
];
const CAT = Object.fromEntries(CATS.map(c => [c.k, c]));

const SYMBOL = { HKD: 'HK$', USD: '$', PHP: '₱', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', AUD: 'A$' };
const ZERO_DP = new Set(['JPY']);

const LEDGER_PATH = 'ledger.json';
const GH_API = 'https://api.github.com';
const SYNC_EVERY_MS = 60_000;

const K = { vault: 'st.vault', cfg: 'st.cfg', log: 'st.log', dev: 'st.dev', synced: 'st.synced' };

/* ───────────────────────── Tiny helpers ───────────────────────── */

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'x'.repeat(8).replace(/x/g, () => Math.floor(Math.random() * 36).toString(36)) + Date.now().toString(36));

const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
const bufToB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64ToBuf = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

function haptic() { if (navigator.vibrate) navigator.vibrate(8); }

const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/* ── receipt photos live in IndexedDB, not localStorage —
      they're blobs, and they must survive being offline. ── */
const IDB = (() => {
  const NAME = 'steward', STORE = 'receipts';
  let dbp = null;

  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };

  return {
    put:  (k, v) => tx('readwrite', s => s.put(v, k)),
    get:  k      => tx('readonly',  s => s.get(k)),
    del:  k      => tx('readwrite', s => s.delete(k)),
    keys: ()     => tx('readonly',  s => s.getAllKeys()),
  };
})();

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2100);
}

/* ── dates: keep everything on local-calendar YYYY-MM-DD strings ── */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey  = iso => iso.slice(0, 7);
const shiftMonth = (mk, by) => {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthName = mk => {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  const now = new Date();
  const label = d.toLocaleDateString(undefined, { month: 'long' });
  return y === now.getFullYear() ? label : `${label} ${y}`;
};
const dayName = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const t = todayISO();
  if (iso === t) return 'Today';
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  if (iso === `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

/* ───────────────────────── App state ───────────────────────── */

const S = {
  cfg: null,          // { nameA, nameB, me, cur, budget }
  secret: null,       // { token, repo } — memory only
  log: { v: 1, events: [] },
  device: null,
  month: monthKey(todayISO()),
  view: 'home',
  draft: null,        // in-progress new expense
  syncing: false,
  histQuery: '',
};

const money = cents => {
  const dp = ZERO_DP.has(S.cfg?.cur) ? 0 : 2;
  const n = (ZERO_DP.has(S.cfg?.cur) ? cents : cents / 100);
  return (SYMBOL[S.cfg?.cur] || '') + n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const nameOf = who => (who === 'a' ? S.cfg.nameA : S.cfg.nameB);
const iAm     = () => S.cfg.me;
const theOther = () => (S.cfg.me === 'a' ? 'b' : 'a');

/* ───────────────────────── Vault (PIN → token) ───────────────────────── */

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function sealVault(pin, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(pin, salt);
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  lsSet(K.vault, { s: bufToB64(salt), i: bufToB64(iv), c: bufToB64(ct) });
}

async function openVault(pin) {
  const v = lsGet(K.vault, null);
  if (!v) throw new Error('no vault');
  const key = await deriveKey(pin, b64ToBuf(v.s));
  const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(v.i) }, key, b64ToBuf(v.c));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ───────────────────────── Event log ───────────────────────── */

function appendEvent(ev) {
  ev.i = uid();
  ev.t = Date.now();
  ev.d = S.device;
  S.log.events.push(ev);
  lsSet(K.log, S.log);
}

/** Fold the event log down to the current set of transactions. */
function reduceLog() {
  const evs = [...S.log.events].sort((x, y) => (x.t - y.t) || (x.i < y.i ? -1 : 1));
  const map = new Map();
  const bmap = new Map();
  let settledAt = 0;

  for (const e of evs) {
    if (e.k === 'add')    map.set(e.x.id, { ...e.x, _born: e.t });
    else if (e.k === 'edit') { const cur = map.get(e.x); if (cur) map.set(e.x, { ...cur, ...e.p }); }
    else if (e.k === 'del')  map.delete(e.x);
    else if (e.k === 'settle') settledAt = e.t;
    else if (e.k === 'badd')  bmap.set(e.x.id, { ...e.x });
    else if (e.k === 'bedit') { const cur = bmap.get(e.x); if (cur) bmap.set(e.x, { ...cur, ...e.p }); }
    else if (e.k === 'bdel')  bmap.delete(e.x);
  }
  const txns = [...map.values()].sort((x, y) => (y.date < x.date ? -1 : y.date > x.date ? 1 : y._born - x._born));
  // Keep the order things were entered — for a pasted budget that is the
  // order of the original sheet, which is how its owner reads it.
  const bills = [...bmap.values()].sort((x, y) =>
    (x.seq ?? 1e9) - (y.seq ?? 1e9) || (x.name > y.name ? 1 : -1));
  return { txns, bills, settledAt };
}

/* ───────────────────────── Bills ───────────────────────── */

const daysInMonth = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const billDueISO = (bill, mk) => `${mk}-${String(Math.min(bill.day, daysInMonth(mk))).padStart(2, '0')}`;
const daysBetween = (from, to) =>
  Math.round((Date.parse(to + 'T00:00:00') - Date.parse(from + 'T00:00:00')) / 864e5);

/** Where a bill stands for a given month: paid, late, due soon, or still ahead.
    Bills with no due day are plain monthly allocations — tracked, never chased. */
function billStatus(bill, txns, mk, today = todayISO(), lead = leadDays()) {
  const paid = txns.find(t => t.bill === bill.id && monthKey(t.date) === mk);
  if (paid) return { state: 'paid', due: bill.day ? billDueISO(bill, mk) : null, txn: paid };
  if (!bill.day) return { state: 'open', due: null, days: null };
  const due = billDueISO(bill, mk);
  const days = daysBetween(today, due);
  if (days < 0)     return { state: 'late', due, days };
  if (days <= lead) return { state: 'soon', due, days };
  return { state: 'idle', due, days };
}

/** Shared settings ride in the event log so both phones — and the reminder
    job — agree on them. Local cfg is only a fallback. */
function sharedSettings() {
  let out = {};
  for (const e of [...S.log.events].sort((x, y) => x.t - y.t)) {
    if (e.k === 'cfg') out = { ...out, ...e.p };
  }
  return out;
}

const leadDays = () => Number(sharedSettings().lead || (S.cfg && S.cfg.lead)) || 3;

function dueLabel(st) {
  if (st.state === 'paid') return 'Paid';
  if (st.state === 'open') return 'Not paid';
  if (st.days === 0)  return 'Due today';
  if (st.days === 1)  return 'Due tomorrow';
  if (st.days === -1) return '1 day late';
  if (st.days < 0)    return `${-st.days} days late`;
  return `Due in ${st.days} days`;
}

/* ── pasting a table out of a spreadsheet, Notes, or an email ── */

const HEAD_NAME = /^(name|bill|item|description|desc|payee|what|vendor|merchant|expense)s?$/i;
const HEAD_AMT  = /^(planned|budget|allocated|allocation|amount|amt|cost|price|total|sum|monthly|value|hk\$?|\$|fee)$/i;
const HEAD_CC   = /(via\s*cc|credit\s*card|on\s*card|^cc$|^card$|charged)/i;
const HEAD_DAY  = /^(due|day|date|due day|due date|dom|when)$/i;
const TOTALS_ROW = /^(totals?|sum|grand\s*total|subtotal)$/i;

/** "7: Pueblo Del Sol BOC BDO" → day 7. Plenty of budgets encode the date this way. */
function stripDayPrefix(name) {
  const m = String(name).match(/^\s*(\d{1,2})\s*[:.\)-]\s*(.+)$/);
  if (!m) return { name: String(name).trim(), day: null };
  const d = +m[1];
  return d >= 1 && d <= 31 ? { name: m[2].trim(), day: d } : { name: String(name).trim(), day: null };
}

/** A section heading like "HK HOUSEHOLD" — no figures, and shouting. */
function isSectionRow(cells) {
  const filled = cells.filter(c => c !== '');
  if (filled.length !== 1) return false;
  const t = filled[0];
  return t.length >= 3 && !/\d/.test(t) && t === t.toUpperCase() && /[A-Z]/.test(t);
}

function splitCells(line, delim) {
  let cells;
  if (delim === '\t')     cells = line.split('\t');
  else if (delim === '|') cells = line.replace(/^\||\|$/g, '').split('|');
  else if (delim === ',') cells = line.split(',');
  else                    cells = line.split(/\s{2,}/);
  return cells.map(c => c.trim());
}

function toAmount(s) {
  if (!s) return null;
  const m = String(s).replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const v = parseFloat(m.replace(/,/g, '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function toDay(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);           // 2026-08-15
  if (m) return +m[3];
  m = str.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/);     // 15/08
  if (m) return +m[1];
  m = str.match(/(\d{1,2})\s*(?:st|nd|rd|th)?/i);                // 15th, "due 15"
  if (m) { const d = +m[1]; return d >= 1 && d <= 31 ? d : null; }
  return null;
}

/**
 * Parse pasted bill rows. Accepts spreadsheet tabs, CSV, markdown tables,
 * column-aligned text, or one bill per line. Always returns rows for review —
 * nothing is imported without the user seeing it first.
 */
function parseBillTable(text) {
  const raw = String(text || '').split(/\r?\n/)
    .filter(l => l.trim() && !/^[|+\s:-]+$/.test(l));   // drop blanks + markdown rules
  if (!raw.length) return [];

  const has = (re) => raw.filter(l => re.test(l)).length / raw.length > 0.4;
  const delim = has(/\t/) ? '\t' : has(/\|/) ? '|' : has(/,/) ? ',' : has(/\s{2,}/) ? '  ' : null;

  let rows = delim ? raw.map(l => splitCells(l, delim)) : raw.map(l => [l.trim()]);

  // Find a header row anywhere in the first few lines — real budgets often
  // start with a title line above the actual column names.
  let idx = { name: 0, amt: 1, cc: -1, day: -1 };
  let headerAt = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i];
    if (r.length < 2) continue;
    if (r.some(c => c && (HEAD_AMT.test(c) || HEAD_CC.test(c) || HEAD_DAY.test(c)))) { headerAt = i; break; }
  }
  if (headerAt >= 0) {
    const hdr = rows[headerAt];
    let sawName = false;
    hdr.forEach((c, i) => {
      if (!c) return;
      if (HEAD_CC.test(c))        idx.cc = i;
      else if (HEAD_DAY.test(c))  idx.day = i;
      else if (HEAD_AMT.test(c))  idx.amt = i;
      else if (HEAD_NAME.test(c)) { idx.name = i; sawName = true; }
    });
    if (!sawName) idx.name = 0;               // labels usually sit in column A
    rows = rows.slice(headerAt + 1);
  }

  let group = null;
  const out = [];

  for (const cells of rows) {
    if (!cells.some(c => c !== '')) continue;

    if (isSectionRow(cells)) { group = cells.find(c => c !== ''); continue; }
    if (TOTALS_ROW.test((cells[0] || '').trim())) continue;   // their own totals row

    out.push(parseBillRow(cells, idx, group));
  }
  return out;
}

function parseBillRow(cells, idx, group) {
    let name = null, amount = null, day = null, cc = null;

    if (cells.length === 1) {
      // "Netflix 78 15th"  /  "Netflix $78 due 15"
      const line = cells[0];
      const nums = [...line.matchAll(/(?:HK\$|US\$|\$|₱|€|£|¥)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(st|nd|rd|th)?/gi)];
      name = line.slice(0, nums.length ? nums[0].index : line.length)
                 .replace(/[-–:,]+$/, '').trim() || null;
      const vals = nums.map(m => ({ v: parseFloat(m[1].replace(/,/g, '')), ord: !!m[2], txt: m[0] }));
      if (vals.length === 1) amount = vals[0].v;
      else if (vals.length >= 2) {
        const ordinal = vals.find(x => x.ord && x.v <= 31);
        const dayPick = ordinal || vals.slice(1).find(x => Number.isInteger(x.v) && x.v <= 31) || vals[vals.length - 1];
        const amtPick = vals.find(x => x !== dayPick);
        day = dayPick ? Math.round(dayPick.v) : null;
        amount = amtPick ? amtPick.v : null;
      }
    } else {
      name   = (cells[idx.name] || '').replace(/[*_`]/g, '').trim() || null;
      amount = toAmount(cells[idx.amt]);
      if (idx.day >= 0) day = toDay(cells[idx.day]);

      if (idx.cc >= 0) {
        const raw = (cells[idx.cc] || '').trim();
        if (raw) {
          const v = toAmount(raw);
          // a tick or a "yes" means the whole line goes on the card
          cc = v != null ? v : (/^(y|yes|x|✓|✔|true|cc)$/i.test(raw) ? amount : null);
        }
      }

      // columns not where we guessed — recover by shape
      if (amount == null) {
        for (let i = 0; i < cells.length; i++) {
          if (i === idx.cc || i === idx.day) continue;
          const v = toAmount(cells[i]);
          if (v != null) { amount = v; break; }
        }
      }
      if (day == null && idx.day < 0 && cells.length > 2) {
        for (let i = cells.length - 1; i > 0; i--) {
          if (i === idx.amt || i === idx.cc) continue;
          const d = toDay(cells[i]);
          if (d != null) { day = d; break; }
        }
      }
      if (!name) name = cells.find(c => /[A-Za-z一-鿿]{2,}/.test(c)) || null;
    }

    // a leading "7:" on the label is a due day
    if (name) {
      const s = stripDayPrefix(name);
      name = s.name;
      if (day == null) day = s.day;
    }
    if (cc != null && amount != null && cc > amount) cc = amount;

    const issues = [];
    if (!name)          issues.push('no name');
    if (amount == null) issues.push('no amount');
    if (day != null && (day < 1 || day > 31)) { issues.push('day out of range'); day = null; }

    return { name, amount, day, cc, grp: group || null, ok: issues.length === 0, issues };
}

/** Net balance in cents. Positive ⇒ person A is owed. */
function balanceOf(txns, settledAt) {
  let bal = 0;
  for (const t of txns) {
    if (t._born <= settledAt) continue;
    const paidA  = t.payer === 'a' ? t.amt : 0;
    const shareA = t.split === 'both' ? t.amt / 2 : (t.split === 'a' ? t.amt : 0);
    bal += paidA - shareA;
  }
  return Math.round(bal);
}

const inMonth = (txns, mk) => txns.filter(t => monthKey(t.date) === mk);

/* ───────────────────────── GitHub sync ───────────────────────── */

async function gh(path, opts = {}) {
  const res = await fetch(GH_API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${S.secret.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  return res;
}

async function pullRemote() {
  const res = await gh(`/repos/${S.secret.repo}/contents/${LEDGER_PATH}?ref=HEAD&t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return { log: { v: 1, events: [] }, sha: null };
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const j = await res.json();
  let parsed;
  try { parsed = JSON.parse(b64dec(j.content)); } catch { parsed = { v: 1, events: [] }; }
  if (!parsed || !Array.isArray(parsed.events)) parsed = { v: 1, events: [] };
  return { log: parsed, sha: j.sha };
}

async function pushRemote(log, sha) {
  const res = await gh(`/repos/${S.secret.repo}/contents/${LEDGER_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${log.events.length} entries)`,
      content: b64enc(JSON.stringify(log, null, 0)),
      ...(sha ? { sha } : {}),
    }),
  });
  return res;
}

/* ── receipts: one file per photo, written once and never rewritten,
      so they never bloat a ledger.json sync ── */

const receiptPath = id => `receipts/${id}.jpg`;

async function uploadReceipt(id, blob) {
  const res = await gh(`/repos/${S.secret.repo}/contents/${receiptPath(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `receipt ${id}`, content: await blobToB64(blob) }),
  });
  return res.ok || res.status === 422;   // 422 ⇒ already up there
}

/** Push any photos taken while offline. Best-effort: never blocks the ledger. */
async function flushReceipts() {
  let keys;
  try { keys = await IDB.keys(); } catch { return; }
  for (const id of keys) {
    let rec;
    try { rec = await IDB.get(id); } catch { continue; }
    if (!rec || rec.uploaded || !rec.blob) continue;
    try {
      if (await uploadReceipt(id, rec.blob)) await IDB.put(id, { ...rec, uploaded: true });
    } catch { return; }                 // still offline — try again next sync
  }
}

/** Get a receipt for display: local copy first, else pull it down and cache. */
async function fetchReceipt(id) {
  try {
    const local = await IDB.get(id);
    if (local && local.blob) return local.blob;
  } catch { /* fall through to network */ }
  if (!S.secret) return null;
  const res = await gh(`/repos/${S.secret.repo}/contents/${receiptPath(id)}`);
  if (!res.ok) return null;
  const j = await res.json();
  const bin = atob(String(j.content).replace(/\s/g, ''));
  const blob = new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))], { type: 'image/jpeg' });
  try { await IDB.put(id, { blob, uploaded: true }); } catch { /* cache is optional */ }
  return blob;
}

async function deleteReceipt(id) {
  try { await IDB.del(id); } catch { /* nothing local */ }
  if (!S.secret) return;
  try {
    const res = await gh(`/repos/${S.secret.repo}/contents/${receiptPath(id)}`);
    if (!res.ok) return;
    const j = await res.json();
    await gh(`/repos/${S.secret.repo}/contents/${receiptPath(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `remove receipt ${id}`, sha: j.sha }),
    });
  } catch { /* it'll just linger in the repo */ }
}

function unionLogs(a, b) {
  const seen = new Map();
  for (const e of [...a.events, ...b.events]) if (e && e.i && !seen.has(e.i)) seen.set(e.i, e);
  return { v: 1, events: [...seen.values()].sort((x, y) => (x.t - y.t) || (x.i < y.i ? -1 : 1)) };
}

const pendingCount = () => Math.max(0, S.log.events.length - lsGet(K.synced, 0));

async function sync({ quiet = true } = {}) {
  if (S.syncing || !S.secret) return;
  S.syncing = true;
  paintSync('busy', 'Syncing…');

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { log: remote, sha } = await pullRemote();
      const merged = unionLogs(S.log, remote);

      // Nothing new in either direction — we're already in step.
      if (merged.events.length === remote.events.length && merged.events.length === S.log.events.length) {
        S.log = merged; lsSet(K.log, S.log); lsSet(K.synced, S.log.events.length);
        break;
      }

      const res = await pushRemote(merged, sha);
      if (res.ok) {
        S.log = merged; lsSet(K.log, S.log); lsSet(K.synced, S.log.events.length);
        break;
      }
      if (res.status === 409 || res.status === 422) continue;   // someone else wrote first — re-merge
      throw new Error(`push ${res.status}`);
    }
    await flushReceipts();
    paintSync('ok', 'Synced');
    render();
  } catch (err) {
    const n = pendingCount();
    paintSync('bad', navigator.onLine ? 'Sync failed' : (n ? `Offline · ${n} to send` : 'Offline'));
    if (!quiet) toast(navigator.onLine ? `Couldn't sync: ${err.message}` : 'No connection — saved on this phone');
  } finally {
    S.syncing = false;
  }
}

function paintSync(kind, text) {
  const pill = $('#syncPill');
  pill.className = 'sync-pill' + (kind === 'ok' ? '' : ' ' + kind);
  pill.textContent = text;
  paintSyncInfo();
}

function paintSyncInfo() {
  const info = $('#setSyncInfo');
  if (info) info.textContent = `${S.log.events.length} entries · ${pendingCount()} waiting to send · ${S.secret ? S.secret.repo : '—'}`;
}

/* ───────────────────────── Rendering ───────────────────────── */

function render() {
  if (!S.cfg) return;
  renderHome();
  renderDueCard();
  renderBills();
  renderHistory();
  renderSettings();
}

function renderHome() {
  const { txns, settledAt } = reduceLog();
  const mt = inMonth(txns, S.month);
  const total = mt.reduce((s, t) => s + t.amt, 0);

  $('#monthLabel').textContent = monthName(S.month);
  $('#heroAmount').textContent = money(total);

  // month-over-month
  const prev = inMonth(txns, shiftMonth(S.month, -1)).reduce((s, t) => s + t.amt, 0);
  const dEl = $('#heroDelta');
  if (prev > 0) {
    const pct = Math.round(((total - prev) / prev) * 100);
    dEl.textContent = pct === 0 ? 'Same as last month'
      : `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs last month`;
    dEl.className = 'hero-delta ' + (pct > 0 ? 'up' : 'down');
  } else { dEl.textContent = ''; dEl.className = 'hero-delta'; }

  // budget
  const budget = Number(S.cfg.budget) || 0;
  const bc = $('#budgetCard');
  if (budget > 0) {
    bc.classList.remove('hidden');
    const cents = Math.round(budget * (ZERO_DP.has(S.cfg.cur) ? 1 : 100));
    const pct = Math.min(100, Math.round((total / cents) * 100));
    const left = cents - total;
    $('#budgetText').textContent = left >= 0 ? `${money(left)} left of ${money(cents)}` : `${money(-left)} over ${money(cents)}`;
    $('#budgetPct').textContent = Math.round((total / cents) * 100) + '%';
    const fill = $('#budgetFill');
    fill.style.width = pct + '%';
    fill.className = 'bar-fill' + (total > cents ? ' over' : '');
  } else bc.classList.add('hidden');

  // settle up — computed across all time, not just this month
  const bal = balanceOf(txns, settledAt);
  const body = $('#settleBody');
  const btn  = $('#settleBtn');
  if (Math.abs(bal) < 1) {
    body.innerHTML = `<span class="settle-even">All square 🎉</span>`;
    btn.classList.add('hidden');
  } else {
    const creditor = bal > 0 ? 'a' : 'b';
    const debtor   = bal > 0 ? 'b' : 'a';
    const who = debtor === iAm() ? `You owe ${nameOf(creditor)}` : `${nameOf(debtor)} owes you`;
    body.innerHTML = `${who}<span class="settle-big">${money(Math.abs(bal))}</span>`;
    btn.classList.remove('hidden');
  }

  // category breakdown
  const byCat = new Map();
  for (const t of mt) byCat.set(t.cat, (byCat.get(t.cat) || 0) + t.amt);
  const cats = [...byCat.entries()].sort((x, y) => y[1] - x[1]);
  const max = cats.length ? cats[0][1] : 1;
  $('#catBreakdown').innerHTML = cats.length ? cats.map(([k, v]) => `
    <div class="cat-row">
      <div class="cat-emoji">${(CAT[k] || CAT.misc).e}</div>
      <div class="cat-mid">
        <div class="cat-name">${(CAT[k] || CAT.misc).n}</div>
        <div class="cat-bar"><div class="cat-fill" style="width:${Math.max(4, (v / max) * 100)}%"></div></div>
      </div>
      <div class="cat-amt">${money(v)}</div>
    </div>`).join('') : `<div class="empty">Nothing logged yet</div>`;

  // who paid
  const paid = { a: 0, b: 0 };
  for (const t of mt) paid[t.payer] += t.amt;
  const pmax = Math.max(paid.a, paid.b, 1);
  $('#whoPaid').innerHTML = (paid.a + paid.b) ? ['a', 'b'].map(w => `
    <div class="cat-row">
      <div class="cat-emoji">${w === iAm() ? '🙋' : '💁'}</div>
      <div class="cat-mid">
        <div class="cat-name">${nameOf(w)}${w === iAm() ? ' (you)' : ''}</div>
        <div class="cat-bar"><div class="cat-fill" style="width:${Math.max(4, (paid[w] / pmax) * 100)}%"></div></div>
      </div>
      <div class="cat-amt">${money(paid[w])}</div>
    </div>`).join('') : `<div class="empty">Nothing logged yet</div>`;
}

function renderHistory() {
  const { txns } = reduceLog();
  const q = S.histQuery.trim().toLowerCase();
  const list = q
    ? txns.filter(t => (t.note || '').toLowerCase().includes(q) || (CAT[t.cat] || CAT.misc).n.toLowerCase().includes(q))
    : txns;

  if (!list.length) {
    $('#histList').innerHTML = `<div class="empty">${q ? 'No matches' : 'No expenses yet.\nTap Add to log the first one.'}</div>`;
    return;
  }

  const days = new Map();
  for (const t of list) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }

  $('#histList').innerHTML = [...days.entries()].map(([date, items]) => {
    const sum = items.reduce((s, t) => s + t.amt, 0);
    return `<div class="hist-day">
      <div class="hist-day-hd"><span class="hist-day-name">${dayName(date)}</span><span class="hist-day-sum">${money(sum)}</span></div>
      <div class="hist-items">${items.map(t => `
        <button class="hist-item" data-id="${t.id}">
          <span class="hist-emoji">${(CAT[t.cat] || CAT.misc).e}</span>
          <span class="hist-mid">
            <span class="hist-note">${escapeHtml(t.note || (CAT[t.cat] || CAT.misc).n)}</span>
            <span class="hist-meta">${t.rcpt ? '🧾 ' : ''}${nameOf(t.payer)} paid · ${t.split === 'both' ? 'shared' : nameOf(t.split) + ' only'}</span>
          </span>
          <span class="hist-amt">${money(t.amt)}</span>
        </button>`).join('')}</div>
    </div>`;
  }).join('');
}

function renderBills() {
  const { txns, bills } = reduceLog();
  const mk = S.month;

  const total = bills.reduce((s, b) => s + b.amt, 0);
  const onCard = bills.reduce((s, b) => s + (b.cc || 0), 0);
  $('#billTotal').textContent = bills.length ? money(total) : '—';

  const states = bills.map(b => billStatus(b, txns, mk));
  const unpaidCount = states.filter(s => s.state !== 'paid').length;
  $('#billUnpaid').innerHTML = bills.length
    ? (onCard ? `💳 ${money(onCard)} of it on the card · ` : '') +
      (unpaidCount ? `${unpaidCount} still to pay` : `all paid for ${monthName(mk)} 🎉`)
    : '';
  $('#billUnpaid').className = 'hero-delta' + (bills.length && !unpaidCount ? ' down' : '');

  if (!bills.length) {
    $('#billList').innerHTML = `<div class="empty">No bills yet.\nTap ＋ to add one, or Paste to bring in a whole list.</div>`;
    return;
  }

  const PILL = { paid: 'pill-paid', soon: 'pill-soon', late: 'pill-late', idle: 'pill-idle', open: 'pill-idle' };

  // keep the sections from the sheet, in the order they first appear
  const groups = [];
  bills.forEach((b, i) => {
    const key = b.grp || 'Other';
    let g = groups.find(x => x.key === key);
    if (!g) groups.push(g = { key, rows: [] });
    g.rows.push({ b, st: states[i] });
  });

  $('#billList').innerHTML = groups.map(g => {
    const sub = g.rows.reduce((s, r) => s + r.b.amt, 0);
    const subCC = g.rows.reduce((s, r) => s + (r.b.cc || 0), 0);
    return `<div class="bill-group">
      <div class="bill-group-hd">
        <span>${escapeHtml(g.key)}</span>
        <span class="bill-group-sum">${money(sub)}${subCC ? ` · 💳 ${money(subCC)}` : ''}</span>
      </div>
      <div class="bill-items">
        ${g.rows.map(({ b, st }) => `
          <button class="bill-row" data-bill="${b.id}">
            <span>
              <span class="bill-name">${escapeHtml(b.name)}</span>
              <span class="bill-when">${b.day ? 'Due the ' + ordinal(b.day) : 'Monthly'}${b.cc ? ' · 💳 ' + money(b.cc) : ''}</span>
            </span>
            <span class="bill-right">
              <span class="bill-amt">${money(b.amt)}</span>
              <span class="pill ${PILL[st.state]}">${dueLabel(st)}</span>
            </span>
          </button>`).join('')}
      </div>
    </div>`;
  }).join('');
}

const ordinal = n => n + (['th','st','nd','rd'][(n % 100 - 20) % 10] || ['th','st','nd','rd'][n % 100] || 'th');

function renderDueCard() {
  const { txns, bills } = reduceLog();
  const mk = monthKey(todayISO());
  const rows = bills
    .map(b => ({ b, st: billStatus(b, txns, mk) }))
    .filter(x => x.st.state === 'soon' || x.st.state === 'late')
    .sort((x, y) => x.st.days - y.st.days);

  const card = $('#dueCard');
  if (!rows.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#dueList').innerHTML = rows.map(({ b, st }) => `
    <div class="due-row">
      <span style="min-width:0">
        <span class="due-name">${escapeHtml(b.name)}</span>
        <span class="due-meta"> · ${dueLabel(st)}</span>
      </span>
      <button class="due-pay" data-pay="${b.id}">${money(b.amt)} · Pay</button>
    </div>`).join('');
}

function markBillPaid(billId) {
  const { bills } = reduceLog();
  const b = bills.find(x => x.id === billId);
  if (!b) return;
  const mk = monthKey(todayISO());
  // dated to the due day so it always lands in the month it belongs to
  appendEvent({
    k: 'add',
    x: {
      id: uid(), amt: b.amt, cat: b.cat, note: b.name,
      date: billDueISO(b, mk), payer: b.payer, split: b.split, bill: b.id,
    },
  });
  haptic();
  toast(`${b.name} marked paid`);
  render();
  sync();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSettings() {
  $('#setNameA').value = S.cfg.nameA;
  $('#setNameB').value = S.cfg.nameB;
  $('#setMe').innerHTML = `<option value="a">${escapeHtml(S.cfg.nameA)}</option><option value="b">${escapeHtml(S.cfg.nameB)}</option>`;
  $('#setMe').value = S.cfg.me;
  $('#setBudget').value = S.cfg.budget || '';
  $('#setBudgetCur').textContent = `Amount (${S.cfg.cur})`;
  $('#setLead').value = String(leadDays());
  const n = reduceLog().bills.length;
  $('#setLeadNote').textContent = n
    ? `${n} bill${n === 1 ? '' : 's'} being watched. Both of you get the reminder.`
    : 'No bills yet — add some on the Bills tab.';
  paintSyncInfo();
}

/* ───────────────────────── Add-expense view ───────────────────────── */

function newDraft() {
  if (S.draft && S.draft.thumbUrl) URL.revokeObjectURL(S.draft.thumbUrl);
  S.draft = {
    raw: '0', cat: 'food', note: '', date: todayISO(), payer: iAm(), split: 'both',
    photo: null, thumbUrl: null, scan: null,
  };
}

function paintAdd() {
  const d = S.draft;
  $('#addAmount').textContent = d.raw;
  $('#addCur').textContent = S.cfg.cur;
  $('#addNote').value = d.note;
  $('#addDate').value = d.date;

  $('#addCats').innerHTML = CATS.map(c =>
    `<button class="chip${c.k === d.cat ? ' on' : ''}" data-cat="${c.k}"><span>${c.e}</span>${c.n}</button>`).join('');

  const payer = $('#addPayer').children;
  payer[0].textContent = S.cfg.nameA; payer[1].textContent = S.cfg.nameB;
  [...payer].forEach(b => b.classList.toggle('on', b.dataset.v === d.payer));

  const split = $('#addSplit').children;
  split[1].textContent = `${S.cfg.nameA} only`; split[2].textContent = `${S.cfg.nameB} only`;
  [...split].forEach(b => b.classList.toggle('on', b.dataset.v === d.split));

  paintScanResult();
}

/* ── the read-back panel: OCR never silently sets an amount ── */
function paintScanResult() {
  const d = S.draft;
  const box = $('#scanResult');
  if (!d.photo) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const s = d.scan || {};
  const shopName = s.merchant && s.merchant.length > 22 ? s.merchant.slice(0, 21) + '…' : s.merchant;
  let head, sub, cls = '';
  if (!s.amountFound) {
    head = 'Receipt attached';
    sub = "Couldn't make out a total — type the amount in yourself.";
    cls = 'bad';
  } else if (s.confidence === 'high') {
    head = shopName ? `Read from ${escapeHtml(shopName)}` : 'Read from receipt';
    sub = 'Looks clear. Worth a glance anyway.';
  } else {
    head = shopName ? `Read from ${escapeHtml(shopName)}` : 'Read from receipt';
    sub = 'Not fully sure of this one — please check the amount.';
    cls = 'warn';
  }

  box.className = 'scan-card-result';
  box.innerHTML = `
    <img class="scan-thumb" src="${d.thumbUrl}" alt="Receipt">
    <div class="scan-body">
      <div class="scan-head">${head}</div>
      <div class="scan-sub ${cls}">${sub}</div>
      <button class="scan-drop" id="scanDrop">Remove photo</button>
    </div>`;
  $('#scanDrop').onclick = () => {
    if (d.thumbUrl) URL.revokeObjectURL(d.thumbUrl);
    d.photo = null; d.thumbUrl = null; d.scan = null;
    paintScanResult();
  };
}

/* ── scanning ── */

let scanAborted = false;

function showScan(msg, pct) {
  $('#scanOverlay').classList.remove('hidden');
  $('#scanMsg').textContent = msg;
  $('#scanBar').style.width = Math.round(pct * 100) + '%';
}
const hideScan = () => $('#scanOverlay').classList.add('hidden');

async function onScanFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('That file is not an image'); return; }

  scanAborted = false;
  showScan('Preparing the reader…', 0.04);
  try {
    const r = await OCR.read(file, todayISO(), (msg, p) => { if (!scanAborted) showScan(msg, p); });
    if (scanAborted) return;

    const d = S.draft;
    if (d.thumbUrl) URL.revokeObjectURL(d.thumbUrl);
    d.photo = r.thumb;
    d.thumbUrl = URL.createObjectURL(r.thumb);
    d.scan = { confidence: r.confidence, merchant: r.merchant, amountFound: r.amount != null };

    if (r.amount != null) {
      d.raw = ZERO_DP.has(S.cfg.cur) ? String(Math.round(r.amount))
            : (Number.isInteger(r.amount) ? String(r.amount) : r.amount.toFixed(2));
    }
    if (r.merchant && !d.note) d.note = r.merchant;
    if (r.category) d.cat = r.category;
    if (r.date) d.date = r.date;

    paintAdd();
    haptic();
    toast(r.amount != null ? `Read ${money(Math.round(r.amount * (ZERO_DP.has(S.cfg.cur) ? 1 : 100)))}` : 'Receipt attached');
  } catch (e) {
    if (!scanAborted) toast(e.message || 'Could not read that receipt');
  } finally {
    hideScan();
    $('#scanInput').value = '';   // let the same file be picked again
  }
}

function pressAmount(k) {
  const d = S.draft;
  if (k === 'del') d.raw = d.raw.length > 1 ? d.raw.slice(0, -1) : '0';
  else if (k === '.') { if (!d.raw.includes('.') && !ZERO_DP.has(S.cfg.cur)) d.raw += '.'; }
  else {
    const dec = d.raw.split('.')[1];
    if (dec && dec.length >= 2) return;
    d.raw = d.raw === '0' ? k : d.raw + k;
    if (d.raw.replace('.', '').length > 9) d.raw = d.raw.slice(0, -1);
  }
  $('#addAmount').textContent = d.raw;
  haptic();
}

function saveDraft() {
  const d = S.draft;
  const val = parseFloat(d.raw);
  if (!val || val <= 0) { toast('Enter an amount first'); return; }

  const id = uid();
  appendEvent({
    k: 'add',
    x: {
      id,
      amt: Math.round(val * (ZERO_DP.has(S.cfg.cur) ? 1 : 100)),
      cat: d.cat, note: d.note.trim(), date: d.date, payer: d.payer, split: d.split,
      ...(d.photo ? { rcpt: 1 } : {}),
    },
  });

  // Store the photo locally right away; sync uploads it when there's a connection.
  if (d.photo) IDB.put(id, { blob: d.photo, uploaded: false }).catch(() => toast('Could not save the photo on this phone'));

  haptic();
  toast(`${money(Math.round(val * (ZERO_DP.has(S.cfg.cur) ? 1 : 100)))} logged`);
  newDraft();
  paintAdd();
  go('home');
  render();
  sync();
}

/* ───────────────────────── Edit sheet ───────────────────────── */

function openSheet(id) {
  const { txns } = reduceLog();
  const t = txns.find(x => x.id === id);
  if (!t) return;
  const dp = ZERO_DP.has(S.cfg.cur) ? 0 : 2;

  $('#sheetBody').innerHTML = `
    <h3 class="sheet-title">Edit expense</h3>
    <p class="sheet-sub">${dayName(t.date)}</p>
    ${t.rcpt ? '<div id="edReceipt"></div>' : ''}
    <div class="card">
      <label class="field"><span>Amount</span><input id="edAmt" type="number" inputmode="decimal" step="any" value="${(ZERO_DP.has(S.cfg.cur) ? t.amt : t.amt / 100).toFixed(dp)}"></label>
      <label class="field"><span>Note</span><input id="edNote" type="text" value="${escapeHtml(t.note || '')}" placeholder="Optional"></label>
      <label class="field"><span>Date</span><input id="edDate" type="date" value="${t.date}"></label>
      <label class="field"><span>Category</span><select id="edCat">${CATS.map(c => `<option value="${c.k}"${c.k === t.cat ? ' selected' : ''}>${c.e} ${c.n}</option>`).join('')}</select></label>
      <label class="field"><span>Paid by</span><select id="edPayer"><option value="a"${t.payer === 'a' ? ' selected' : ''}>${escapeHtml(S.cfg.nameA)}</option><option value="b"${t.payer === 'b' ? ' selected' : ''}>${escapeHtml(S.cfg.nameB)}</option></select></label>
      <label class="field"><span>Split</span><select id="edSplit">
        <option value="both"${t.split === 'both' ? ' selected' : ''}>Shared 50/50</option>
        <option value="a"${t.split === 'a' ? ' selected' : ''}>${escapeHtml(S.cfg.nameA)} only</option>
        <option value="b"${t.split === 'b' ? ' selected' : ''}>${escapeHtml(S.cfg.nameB)} only</option>
      </select></label>
    </div>
    <button id="edSave" class="btn btn-primary">Save changes</button>
    <div style="height:10px"></div>
    <button id="edDel" class="btn btn-danger">Delete expense</button>
    <div style="height:10px"></div>
    <button id="edClose" class="btn btn-secondary">Cancel</button>`;

  $('#sheet').classList.remove('hidden');

  if (t.rcpt) {
    const slot = $('#edReceipt');
    slot.innerHTML = '<p class="card-note">Loading receipt…</p>';
    fetchReceipt(id).then(blob => {
      if (!blob) { slot.innerHTML = '<p class="card-note">Receipt not downloaded yet — sync and reopen.</p>'; return; }
      const url = URL.createObjectURL(blob);
      slot.innerHTML = `<img class="receipt-view" src="${url}" alt="Receipt">`;
      slot.querySelector('img').onload = () => URL.revokeObjectURL(url);
    }).catch(() => { slot.innerHTML = '<p class="card-note">Could not load the receipt.</p>'; });
  }

  $('#edClose').onclick = closeSheet;
  $('#edDel').onclick = () => {
    appendEvent({ k: 'del', x: id });
    if (t.rcpt) deleteReceipt(id);
    closeSheet(); toast('Deleted'); render(); sync();
  };
  $('#edSave').onclick = () => {
    const v = parseFloat($('#edAmt').value);
    if (!v || v <= 0) { toast('Enter a valid amount'); return; }
    appendEvent({
      k: 'edit', x: id,
      p: {
        amt: Math.round(v * (ZERO_DP.has(S.cfg.cur) ? 1 : 100)),
        note: $('#edNote').value.trim(),
        date: $('#edDate').value || t.date,
        cat: $('#edCat').value,
        payer: $('#edPayer').value,
        split: $('#edSplit').value,
      },
    });
    closeSheet(); toast('Updated'); render(); sync();
  };
}
const closeSheet = () => $('#sheet').classList.add('hidden');

/* ── bill editor ── */

function openBillSheet(billId) {
  const { txns, bills } = reduceLog();
  const b = billId ? bills.find(x => x.id === billId) : null;
  const dp = ZERO_DP.has(S.cfg.cur) ? 0 : 2;
  const st = b ? billStatus(b, txns, S.month) : null;

  $('#sheetBody').innerHTML = `
    <h3 class="sheet-title">${b ? 'Edit bill' : 'New monthly bill'}</h3>
    <p class="sheet-sub">${b ? dueLabel(st) + ' · ' + monthName(S.month) : 'Repeats every month'}</p>
    <div class="card">
      <label class="field"><span>Name</span><input id="bName" type="text" value="${b ? escapeHtml(b.name) : ''}" placeholder="e.g. Internet" autocapitalize="words"></label>
      <label class="field"><span>Amount (${S.cfg.cur})</span><input id="bAmt" type="number" inputmode="decimal" step="any" value="${b ? (ZERO_DP.has(S.cfg.cur) ? b.amt : b.amt / 100).toFixed(dp) : ''}" placeholder="0"></label>
      <label class="field"><span>On card</span><input id="bCC" type="number" inputmode="decimal" step="any" value="${b && b.cc ? (ZERO_DP.has(S.cfg.cur) ? b.cc : b.cc / 100).toFixed(dp) : ''}" placeholder="0 = not on card"></label>
      <label class="field"><span>Section</span><input id="bGrp" type="text" value="${b && b.grp ? escapeHtml(b.grp) : ''}" placeholder="e.g. HK HOUSEHOLD" autocapitalize="characters"></label>
      <label class="field"><span>Due day</span><input id="bDay" type="number" inputmode="numeric" min="1" max="31" value="${b && b.day ? b.day : ''}" placeholder="blank = no reminder"></label>
      <label class="field"><span>Category</span><select id="bCat">${CATS.map(c => `<option value="${c.k}"${b && c.k === b.cat ? ' selected' : (!b && c.k === 'bill' ? ' selected' : '')}>${c.e} ${c.n}</option>`).join('')}</select></label>
      <label class="field"><span>Paid by</span><select id="bPayer">
        <option value="a"${b && b.payer === 'a' ? ' selected' : ''}>${escapeHtml(S.cfg.nameA)}</option>
        <option value="b"${b && b.payer === 'b' ? ' selected' : ''}>${escapeHtml(S.cfg.nameB)}</option></select></label>
      <label class="field"><span>Split</span><select id="bSplit">
        <option value="both"${!b || b.split === 'both' ? ' selected' : ''}>Shared 50/50</option>
        <option value="a"${b && b.split === 'a' ? ' selected' : ''}>${escapeHtml(S.cfg.nameA)} only</option>
        <option value="b"${b && b.split === 'b' ? ' selected' : ''}>${escapeHtml(S.cfg.nameB)} only</option></select></label>
    </div>
    ${b && st.state !== 'paid' ? '<button id="bPay" class="btn btn-primary">Mark paid for ' + escapeHtml(monthName(S.month)) + '</button><div style="height:10px"></div>' : ''}
    ${b && st.state === 'paid' ? '<button id="bUnpay" class="btn btn-secondary">Undo this month\'s payment</button><div style="height:10px"></div>' : ''}
    <button id="bSave" class="btn ${b && st.state !== 'paid' ? 'btn-secondary' : 'btn-primary'}">${b ? 'Save changes' : 'Add bill'}</button>
    ${b ? '<div style="height:10px"></div><button id="bDel" class="btn btn-danger">Delete bill</button>' : ''}
    <div style="height:10px"></div>
    <button id="bClose" class="btn btn-secondary">Cancel</button>`;

  $('#sheet').classList.remove('hidden');
  $('#bClose').onclick = closeSheet;

  $('#bSave').onclick = () => {
    const name = $('#bName').value.trim();
    const amt = parseFloat($('#bAmt').value);
    const dayRaw = $('#bDay').value.trim();
    const day = dayRaw === '' ? null : parseInt(dayRaw, 10);
    if (!name)                                   { toast('Give the bill a name'); return; }
    if (!amt || amt <= 0)                        { toast('Enter an amount'); return; }
    if (day !== null && !(day >= 1 && day <= 31)) { toast('Due day must be 1–31, or blank'); return; }

    const unit = ZERO_DP.has(S.cfg.cur) ? 1 : 100;
    const ccVal = parseFloat($('#bCC').value);
    const payload = {
      name, amt: Math.round(amt * unit), day,
      cc: ccVal > 0 ? Math.min(Math.round(ccVal * unit), Math.round(amt * unit)) : 0,
      grp: $('#bGrp').value.trim() || null,
      cat: $('#bCat').value, payer: $('#bPayer').value, split: $('#bSplit').value,
    };
    if (b) appendEvent({ k: 'bedit', x: b.id, p: payload });
    else   appendEvent({ k: 'badd', x: { id: uid(), seq: bills.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1, ...payload } });
    closeSheet(); toast(b ? 'Bill updated' : 'Bill added'); render(); sync();
  };

  if ($('#bPay'))   $('#bPay').onclick = () => { closeSheet(); markBillPaid(b.id); };
  if ($('#bUnpay')) $('#bUnpay').onclick = () => {
    appendEvent({ k: 'del', x: st.txn.id });
    closeSheet(); toast('Payment undone'); render(); sync();
  };
  if ($('#bDel')) $('#bDel').onclick = () => {
    if (!confirm(`Delete "${b.name}"? Past payments stay in your history.`)) return;
    appendEvent({ k: 'bdel', x: b.id });
    closeSheet(); toast('Bill deleted'); render(); sync();
  };
}

/* ── import a card statement (CSV / Excel / PDF) ── */

/** Stable per-charge key so re-importing an overlapping statement is a no-op. */
const stmtKey = (date, desc, amtCents) =>
  `${date}|${String(desc).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24)}|${amtCents}`;

/** Does this charge look like one of the monthly bills?
    `mk` must be the month of the CHARGE, not today — a July charge settles the
    July bill, and August's may legitimately still be outstanding. */
function matchBill(desc, amtCents, bills, txns, mk) {
  const d = String(desc).toLowerCase();
  let best = null;
  for (const b of bills) {
    if (!b.amt) continue;
    const words = String(b.name).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
    if (!words.length) continue;
    const hits = words.filter(w => d.includes(w)).length;
    if (!hits) continue;
    const close = Math.abs(b.amt - amtCents) <= Math.max(200, b.amt * 0.05);
    const score = hits / words.length + (close ? 1 : 0);
    if (score >= 0.75 && (!best || score > best.score)) best = { bill: b, score, close };
  }
  if (!best) return null;
  if (billStatus(best.bill, txns, mk).state === 'paid') return null;   // already handled
  return best.bill;
}

function openStatementSheet() {
  $('#sheetBody').innerHTML = `
    <h3 class="sheet-title">Import a statement</h3>
    <p class="sheet-sub">A card statement as CSV, Excel or PDF. It's read on this phone — the file is never uploaded anywhere.</p>
    <button id="stmtPick" class="btn btn-primary">Choose a file</button>
    <div id="stmtOut"></div>
    <div style="height:10px"></div>
    <button id="stmtClose" class="btn btn-secondary">Cancel</button>`;
  $('#sheet').classList.remove('hidden');
  $('#stmtClose').onclick = closeSheet;
  $('#stmtPick').onclick = () => $('#stmtInput').click();
}

async function onStatementFile(file) {
  if (!file) return;
  const out = $('#stmtOut');
  out.innerHTML = `<div style="height:16px"></div><div class="card"><div class="scan-spinner"></div>
    <p id="stmtMsg" class="scan-msg" style="text-align:center">Reading…</p>
    <div class="bar"><div id="stmtBar" class="bar-fill" style="width:8%"></div></div></div>`;

  const progress = (msg, p) => {
    if ($('#stmtMsg')) $('#stmtMsg').textContent = msg;
    if ($('#stmtBar')) $('#stmtBar').style.width = Math.round(p * 100) + '%';
  };

  let rows, kind;
  try {
    ({ rows, kind } = await Statement.read(file, progress));
  } catch (e) {
    out.innerHTML = `<div style="height:16px"></div><p class="card-note bad-note">${escapeHtml(e.message || 'Could not read that file')}</p>`;
    $('#stmtInput').value = '';
    return;
  }

  const unit = ZERO_DP.has(S.cfg.cur) ? 1 : 100;
  const { txns, bills } = reduceLog();
  const seen = new Set(txns.filter(t => t.sk).map(t => t.sk));

  const found = Statement.extract(rows, { year: new Date().getFullYear() });
  const claimed = new Set();          // one charge per bill per month
  const occurrence = new Map();       // genuine same-day repeats must survive
  for (const r of found) {
    r.cents = Math.round(r.amount * unit);
    // Two identical charges on one day are real (two bike hires, two coffees).
    // Number them so both import, while re-importing the same statement still
    // produces the same numbering and so still dedupes.
    const base = stmtKey(r.date, r.desc, r.cents);
    const n = (occurrence.get(base) || 0) + 1;
    occurrence.set(base, n);
    r.sk = n > 1 ? `${base}#${n}` : base;
    r.dup = seen.has(r.sk);
    r.cat = (typeof OCR !== 'undefined' && OCR.parse) ? (OCR.parse(r.desc, todayISO()).category || 'misc') : 'misc';
    r.use = !r.skip && !r.dup;
    r.bill = null;
    if (r.use) {
      const b = matchBill(r.desc, r.cents, bills, txns, monthKey(r.date));
      if (b && !claimed.has(b.id + monthKey(r.date))) {
        r.bill = b;
        claimed.add(b.id + monthKey(r.date));
      }
    }
  }

  const usable = found.filter(r => r.use);
  const skipped = found.filter(r => r.skip).length;
  const dupes = found.filter(r => r.dup).length;
  const matched = usable.filter(r => r.bill).length;
  const total = usable.reduce((s, r) => s + r.cents, 0);

  if (!found.length) {
    out.innerHTML = `<div style="height:16px"></div>
      <p class="card-note bad-note">Read the ${kind} but found no transactions in it — ${rows.length} rows of text.
      If it's a PDF that's a scan rather than real text, export CSV from your bank instead.</p>`;
    $('#stmtInput').value = '';
    return;
  }

  out.innerHTML = `
    <div style="height:16px"></div>
    <div class="card">
      <div class="card-head">${usable.length} to import · from ${kind}</div>
      <div class="preview-wrap">
        <table class="preview-table">
          <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${found.map((r, i) => `
            <tr class="${r.use ? '' : 'row-muted'}">
              <td>${r.date.slice(5)}</td>
              <td>${escapeHtml(r.desc.slice(0, 34))}${r.bill ? `<br><span class="prev-grp">matches ${escapeHtml(r.bill.name)}</span>`
                    : r.dup ? '<br><span class="prev-grp">already imported</span>'
                    : r.skip ? '<br><span class="prev-grp">not a charge</span>' : ''}</td>
              <td>${r.use ? `${(CAT[r.cat] || CAT.misc).e} ${money(r.cents)}` : money(r.cents)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="preview-total"><span>Total to import</span><span>${money(total)}</span></div>
      ${matched ? `<div class="preview-total"><span>Matched to bills</span><span>${matched}</span></div>` : ''}
    </div>
    ${skipped || dupes ? `<p class="card-note">${[
        skipped ? `${skipped} skipped as payments, refunds or totals` : '',
        dupes ? `${dupes} already imported` : ''].filter(Boolean).join(' · ')}.</p>` : ''}
    ${usable.length ? `<button id="stmtGo" class="btn btn-primary">Import ${usable.length} charge${usable.length === 1 ? '' : 's'}</button>` : '<p class="card-note">Nothing new to import.</p>'}`;

  $('#stmtInput').value = '';
  if (!usable.length) return;

  $('#stmtGo').onclick = () => {
    for (const r of usable) {
      appendEvent({
        k: 'add',
        x: {
          id: uid(), amt: r.cents, cat: r.bill ? (r.bill.cat || 'bill') : r.cat,
          note: r.desc.slice(0, 60), date: r.date,
          payer: r.bill ? r.bill.payer : iAm(),
          split: r.bill ? r.bill.split : 'both',
          sk: r.sk, ...(r.bill ? { bill: r.bill.id } : {}),
        },
      });
    }
    closeSheet();
    toast(`${usable.length} imported${matched ? `, ${matched} bill${matched === 1 ? '' : 's'} marked paid` : ''}`);
    render(); sync();
  };
}

/* ── paste a whole table of bills ── */

function openPasteSheet() {
  $('#sheetBody').innerHTML = `
    <h3 class="sheet-title">Paste your bills</h3>
    <p class="sheet-sub">Copy straight out of a spreadsheet, Notes, or an email. Name, amount, and due day — in any common layout.</p>
    <textarea id="pasteBox" class="paste-area" placeholder="Internet&#9;380&#9;15
Electricity&#9;520&#9;20
Netflix&#9;78&#9;3"></textarea>
    <div style="height:12px"></div>
    <button id="pasteGo" class="btn btn-primary">Preview</button>
    <div id="pasteOut"></div>
    <div style="height:10px"></div>
    <button id="pasteClose" class="btn btn-secondary">Cancel</button>`;

  $('#sheet').classList.remove('hidden');
  $('#pasteClose').onclick = closeSheet;
  setTimeout(() => $('#pasteBox').focus(), 250);

  $('#pasteGo').onclick = () => {
    const rows = parseBillTable($('#pasteBox').value);
    const out = $('#pasteOut');
    if (!rows.length) { out.innerHTML = '<p class="card-note" style="margin-top:14px">Nothing to read yet.</p>'; return; }

    // Guard against pasting twice — or against both phones importing the same
    // sheet, which would otherwise merge into two of everything.
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = new Set(reduceLog().bills.map(b => norm(b.name)));
    for (const r of rows) {
      if (r.ok && existing.has(norm(r.name))) { r.ok = false; r.dup = true; r.issues = ['already added']; }
    }

    const good = rows.filter(r => r.ok);
    const dupes = rows.filter(r => r.dup).length;

    const unit = ZERO_DP.has(S.cfg.cur) ? 1 : 100;
    const sumPlanned = good.reduce((s, r) => s + Math.round(r.amount * unit), 0);
    const sumCard = good.reduce((s, r) => s + (r.cc ? Math.round(r.cc * unit) : 0), 0);
    const anyCard = good.some(r => r.cc);
    const sections = [...new Set(good.map(r => r.grp).filter(Boolean))];

    out.innerHTML = `
      <div style="height:16px"></div>
      <div class="card">
        <div class="card-head">${good.length} of ${rows.length} ready</div>
        <div class="preview-wrap">
          <table class="preview-table">
            <thead><tr><th>Name</th><th>Due</th>${anyCard ? '<th>Card</th>' : ''}<th>Planned</th></tr></thead>
            <tbody>${rows.map(r => `
              <tr class="${r.ok ? '' : 'row-bad'}">
                <td>${escapeHtml(r.name || '—')}${r.grp ? `<br><span class="prev-grp">${escapeHtml(r.grp)}</span>` : ''}</td>
                <td>${r.day ? ordinal(r.day) : '—'}</td>
                ${anyCard ? `<td>${r.cc ? money(Math.round(r.cc * unit)) : '—'}</td>` : ''}
                <td>${r.ok ? money(Math.round(r.amount * unit)) : escapeHtml(r.issues.join(', '))}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="preview-total">
          <span>Total planned</span><span>${money(sumPlanned)}</span>
        </div>
        ${anyCard ? `<div class="preview-total"><span>Of that, on the card</span><span>${money(sumCard)}</span></div>` : ''}
        ${sections.length ? `<p class="card-note" style="margin:10px 0 0">${sections.length} section${sections.length === 1 ? '' : 's'}: ${escapeHtml(sections.join(' · '))}</p>` : ''}
      </div>
      ${good.length ? `<button id="pasteImport" class="btn btn-primary">Import ${good.length} bill${good.length === 1 ? '' : 's'}</button>` : ''}
      ${dupes ? `<p class="card-note" style="margin-top:12px">${dupes} already in your list and skipped, so nothing gets doubled up. Edit those on the Bills tab instead.</p>` : ''}
      ${rows.length > good.length + dupes ? '<p class="card-note" style="margin-top:12px">Rows in red could not be read — fix them above and preview again, or add those by hand.</p>' : ''}`;

    if (!good.length) return;
    $('#pasteImport').onclick = () => {
      const unit = ZERO_DP.has(S.cfg.cur) ? 1 : 100;
      const base = reduceLog().bills.reduce((m, b) => Math.max(m, b.seq ?? 0), 0) + 1;
      good.forEach((r, i) => {
        appendEvent({
          k: 'badd',
          x: {
            id: uid(), name: r.name,
            amt: Math.round(r.amount * unit),
            cc: r.cc ? Math.round(r.cc * unit) : 0,
            grp: r.grp || null, seq: base + i,
            day: r.day, cat: 'bill', payer: iAm(), split: 'both',
          },
        });
      });
      closeSheet();
      toast(`${good.length} bill${good.length === 1 ? '' : 's'} imported`);
      render(); sync();
    };
  };
}

/* ───────────────────────── Export ───────────────────────── */

async function exportCsv() {
  const { txns } = reduceLog();
  if (!txns.length) { toast('Nothing to export yet'); return; }
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Category', 'Note', `Amount (${S.cfg.cur})`, 'Paid by', 'Split'].map(esc).join(',')];
  for (const t of [...txns].reverse()) {
    rows.push([
      t.date, (CAT[t.cat] || CAT.misc).n, t.note || '',
      (ZERO_DP.has(S.cfg.cur) ? t.amt : t.amt / 100).toFixed(ZERO_DP.has(S.cfg.cur) ? 0 : 2),
      nameOf(t.payer), t.split === 'both' ? 'Shared' : nameOf(t.split) + ' only',
    ].map(esc).join(','));
  }
  const csv  = rows.join('\n');
  const name = `steward-${todayISO()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Steward export' }); return; } catch { /* user dismissed */ }
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── Navigation ───────────────────────── */

function go(view) {
  S.view = view;
  for (const v of ['home', 'add', 'bills', 'hist', 'set']) $('#v-' + v).classList.toggle('hidden', v !== view);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  if (view === 'add') paintAdd();
  if (view === 'hist') renderHistory();
  if (view === 'bills') renderBills();
}

/* ───────────────────────── Lock screen ───────────────────────── */

let pinBuf = '';

function paintPin() {
  $$('#pinDots i').forEach((d, idx) => d.classList.toggle('on', idx < pinBuf.length));
}

async function pinPress(k) {
  if (k === 'del') { pinBuf = pinBuf.slice(0, -1); paintPin(); return; }
  if (pinBuf.length >= 6) return;
  pinBuf += k; paintPin(); haptic();
  if (pinBuf.length < 6) return;

  const pin = pinBuf;
  $('#lockMsg').textContent = 'Unlocking…';
  $('#lockMsg').classList.remove('err');
  try {
    S.secret = await openVault(pin);
    pinBuf = ''; paintPin();
    enterApp();
  } catch {
    $('#pinDots').classList.add('shake');
    $('#lockMsg').textContent = 'Wrong passcode';
    $('#lockMsg').classList.add('err');
    if (navigator.vibrate) navigator.vibrate([12, 60, 12]);
    setTimeout(() => { $('#pinDots').classList.remove('shake'); pinBuf = ''; paintPin(); }, 450);
  }
}

/* ───────────────────────── Boot ───────────────────────── */

function enterApp() {
  $('#lock').classList.add('hidden');
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  newDraft();
  go('home');
  render();
  sync();
}

async function boot() {
  S.device = lsGet(K.dev, null);
  if (!S.device) { S.device = uid(); lsSet(K.dev, S.device); }

  S.cfg = lsGet(K.cfg, null);
  S.log = lsGet(K.log, { v: 1, events: [] });
  if (!S.log || !Array.isArray(S.log.events)) S.log = { v: 1, events: [] };

  wireEvents();

  const hasVault = !!lsGet(K.vault, null);
  if (S.cfg && hasVault) {
    $('#setup').classList.add('hidden');
    $('#lock').classList.remove('hidden');
  } else {
    $('#lock').classList.add('hidden');
    $('#setup').classList.remove('hidden');
  }

  // ?nosw disables the offline cache — only used while developing.
  if ('serviceWorker' in navigator && !location.search.includes('nosw')) {
    try {
      // If a worker was already in charge, a new one taking over means a new
      // build landed — reload once so the phone shows it straight away instead
      // of waiting for a future launch.
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.update().catch(() => { /* offline — nothing to check against */ });
    } catch { /* offline shell just won't cache */ }
  }
}

/* ───────────────────────── Wiring ───────────────────────── */

function wireEvents() {
  // lock keypad
  $('#lockPad').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (b) pinPress(b.dataset.k);
  });

  // setup
  $('#suTest').addEventListener('click', testConnection);
  $('#suGo').addEventListener('click', finishSetup);
  const syncMeOptions = () => {
    const a = $('#suNameA').value.trim() || 'the first name';
    const b = $('#suNameB').value.trim() || 'the second name';
    const keep = $('#suMe').value;
    $('#suMe').innerHTML = `<option value="a">${escapeHtml(a)}</option><option value="b">${escapeHtml(b)}</option>`;
    $('#suMe').value = keep;
  };
  $('#suNameA').addEventListener('input', syncMeOptions);
  $('#suNameB').addEventListener('input', syncMeOptions);

  // tabs
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.v === 'add') { newDraft(); }
    go(b.dataset.v); haptic();
  }));

  // month nav
  $('#monthPrev').addEventListener('click', () => { S.month = shiftMonth(S.month, -1); renderHome(); });
  $('#monthNext').addEventListener('click', () => { S.month = shiftMonth(S.month, 1); renderHome(); });
  $('#syncPill').addEventListener('click', () => sync({ quiet: false }));

  // add view
  $('#addPad').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (b) pressAmount(b.dataset.k);
  });
  $('#addCats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    S.draft.cat = b.dataset.cat; paintAdd(); haptic();
  });
  $('#addPayer').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    S.draft.payer = b.dataset.v; paintAdd();
  });
  $('#addSplit').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    S.draft.split = b.dataset.v; paintAdd();
  });
  $('#addNote').addEventListener('input', e => { S.draft.note = e.target.value; });
  $('#addDate').addEventListener('change', e => { S.draft.date = e.target.value || todayISO(); });
  $('#addSave').addEventListener('click', saveDraft);
  $('#addCancel').addEventListener('click', () => { newDraft(); paintAdd(); go('home'); });

  // receipt scanning
  $('#scanBtn').addEventListener('click', () => $('#scanInput').click());
  $('#scanInput').addEventListener('change', e => onScanFile(e.target.files && e.target.files[0]));
  $('#scanCancel').addEventListener('click', () => { scanAborted = true; hideScan(); });

  // settle
  $('#settleBtn').addEventListener('click', () => {
    appendEvent({ k: 'settle' });
    toast('Settled up — back to zero');
    render(); sync();
  });

  // bills
  $('#billAdd').addEventListener('click', () => openBillSheet(null));
  $('#billPaste').addEventListener('click', openPasteSheet);
  $('#billList').addEventListener('click', e => {
    const b = e.target.closest('[data-bill]'); if (b) openBillSheet(b.dataset.bill);
  });
  $('#dueList').addEventListener('click', e => {
    const b = e.target.closest('[data-pay]'); if (b) markBillPaid(b.dataset.pay);
  });

  // history
  $('#histSearch').addEventListener('input', e => { S.histQuery = e.target.value; renderHistory(); });
  $('#histExport').addEventListener('click', exportCsv);
  $('#histImport').addEventListener('click', openStatementSheet);
  $('#stmtInput').addEventListener('change', e => onStatementFile(e.target.files && e.target.files[0]));
  $('#histList').addEventListener('click', e => {
    const b = e.target.closest('.hist-item'); if (b) openSheet(b.dataset.id);
  });
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

  // settings
  const saveCfg = () => { lsSet(K.cfg, S.cfg); render(); };
  $('#setNameA').addEventListener('change', e => { S.cfg.nameA = e.target.value.trim() || 'Me'; saveCfg(); });
  $('#setNameB').addEventListener('change', e => { S.cfg.nameB = e.target.value.trim() || 'Partner'; saveCfg(); });
  $('#setMe').addEventListener('change', e => { S.cfg.me = e.target.value; saveCfg(); });
  $('#setBudget').addEventListener('change', e => { S.cfg.budget = parseFloat(e.target.value) || 0; saveCfg(); });
  $('#setLead').addEventListener('change', e => {
    S.cfg.lead = Number(e.target.value) || 3;
    lsSet(K.cfg, S.cfg);
    appendEvent({ k: 'cfg', p: { lead: S.cfg.lead } });   // the reminder job reads this
    render(); sync();
  });
  $('#setSyncNow').addEventListener('click', () => sync({ quiet: false }));
  $('#setForget').addEventListener('click', () => {
    if (!confirm('Erase the token and local copy from this phone? Your data stays safe in the repo.')) return;
    [K.vault, K.cfg, K.log, K.synced].forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  // background sync
  setInterval(() => { if (document.visibilityState === 'visible' && S.secret) sync(); }, SYNC_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.secret) sync(); });
  window.addEventListener('online', () => { if (S.secret) sync(); });
}

/* ───────────────────────── Setup flow ───────────────────────── */

async function testConnection() {
  const repo  = $('#suRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const token = $('#suToken').value.trim();
  const msg = $('#suTestMsg');
  msg.className = 'test-msg';

  if (!/^[^/]+\/[^/]+$/.test(repo)) { msg.textContent = 'Repo should look like owner/name'; msg.classList.add('bad'); return false; }
  if (!token) { msg.textContent = 'Paste your token'; msg.classList.add('bad'); return false; }

  msg.textContent = 'Checking…';
  const prev = S.secret;
  S.secret = { repo, token };
  try {
    const res = await gh(`/repos/${repo}`);
    if (res.status === 404) throw new Error('Repo not found, or the token has no access to it');
    if (res.status === 401) throw new Error('Token rejected — check it was copied in full');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const j = await res.json();
    if (!j.permissions || !j.permissions.push) throw new Error('Token can read but not write — needs Contents: Read and write');
    msg.textContent = `Connected to ${j.full_name}${j.private ? ' (private ✓)' : ' — ⚠️ this repo is PUBLIC'}`;
    msg.classList.add(j.private ? 'ok' : 'bad');
    return true;
  } catch (e) {
    S.secret = prev;
    msg.textContent = e.message;
    msg.classList.add('bad');
    return false;
  }
}

async function finishSetup() {
  const err = $('#suErr');
  err.textContent = '';

  const nameA = $('#suNameA').value.trim();
  const nameB = $('#suNameB').value.trim();
  const pin   = $('#suPin').value.trim();
  const pin2  = $('#suPin2').value.trim();

  if (!nameA || !nameB)        { err.textContent = 'Both names are needed'; return; }
  if (!/^\d{6}$/.test(pin))    { err.textContent = 'Passcode must be exactly 6 digits'; return; }
  if (pin !== pin2)            { err.textContent = "Passcodes don't match"; return; }
  if (!(await testConnection())) { err.textContent = 'Fix the sync details above first'; return; }

  S.cfg = {
    nameA, nameB,
    me: $('#suMe').value,
    cur: $('#suCur').value,
    budget: 0,
  };
  lsSet(K.cfg, S.cfg);
  await sealVault(pin, S.secret);
  // share what the reminder job needs to format its messages
  appendEvent({ k: 'cfg', p: { cur: S.cfg.cur, lead: 3, nameA, nameB } });
  enterApp();
  toast('All set — add your first expense');
}

boot();
