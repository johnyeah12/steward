/* ══════════════════════════════════════════════════════════════
   OurMoney — a private, two-person expense tracker.

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

const K = { vault: 'om.vault', cfg: 'om.cfg', log: 'om.log', dev: 'om.dev', synced: 'om.synced' };

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
  let settledAt = 0;

  for (const e of evs) {
    if (e.k === 'add')    map.set(e.x.id, { ...e.x, _born: e.t });
    else if (e.k === 'edit') { const cur = map.get(e.x); if (cur) map.set(e.x, { ...cur, ...e.p }); }
    else if (e.k === 'del')  map.delete(e.x);
    else if (e.k === 'settle') settledAt = e.t;
  }
  const txns = [...map.values()].sort((x, y) => (y.date < x.date ? -1 : y.date > x.date ? 1 : y._born - x._born));
  return { txns, settledAt };
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
            <span class="hist-meta">${nameOf(t.payer)} paid · ${t.split === 'both' ? 'shared' : nameOf(t.split) + ' only'}</span>
          </span>
          <span class="hist-amt">${money(t.amt)}</span>
        </button>`).join('')}</div>
    </div>`;
  }).join('');
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
  paintSyncInfo();
}

/* ───────────────────────── Add-expense view ───────────────────────── */

function newDraft() {
  S.draft = { raw: '0', cat: 'food', note: '', date: todayISO(), payer: iAm(), split: 'both' };
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

  appendEvent({
    k: 'add',
    x: {
      id: uid(),
      amt: Math.round(val * (ZERO_DP.has(S.cfg.cur) ? 1 : 100)),
      cat: d.cat, note: d.note.trim(), date: d.date, payer: d.payer, split: d.split,
    },
  });

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

  $('#edClose').onclick = closeSheet;
  $('#edDel').onclick = () => {
    appendEvent({ k: 'del', x: id });
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
  const name = `ourmoney-${todayISO()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'OurMoney export' }); return; } catch { /* user dismissed */ }
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── Navigation ───────────────────────── */

function go(view) {
  S.view = view;
  for (const v of ['home', 'add', 'hist', 'set']) $('#v-' + v).classList.toggle('hidden', v !== view);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  if (view === 'add') paintAdd();
  if (view === 'hist') renderHistory();
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
    try { await navigator.serviceWorker.register('sw.js'); } catch { /* offline shell just won't cache */ }
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

  // settle
  $('#settleBtn').addEventListener('click', () => {
    appendEvent({ k: 'settle' });
    toast('Settled up — back to zero');
    render(); sync();
  });

  // history
  $('#histSearch').addEventListener('input', e => { S.histQuery = e.target.value; renderHistory(); });
  $('#histExport').addEventListener('click', exportCsv);
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
  enterApp();
  toast('All set — add your first expense');
}

boot();
