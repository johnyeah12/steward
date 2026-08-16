/* ══════════════════════════════════════════════════════════════
   Card-statement import — CSV, XLSX and PDF, all read on-device.

   XLSX needs no library: an .xlsx is a ZIP of XML, and Safari can
   inflate raw-deflate natively, so the reader below is ~150 lines
   instead of a 900KB dependency. PDF does need pdf.js, which is
   vendored and loaded only when a PDF is actually picked.
   ══════════════════════════════════════════════════════════════ */

'use strict';

const Statement = (() => {

  /* ─────────────── CSV ─────────────── */

  /** Proper CSV: quoted fields, escaped quotes, newlines inside quotes. */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const s = String(text).replace(/^﻿/, '');       // strip BOM

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',' || c === '\t' || c === ';') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return fixSplitNumbers(rows.map(r => r.map(c => c.trim())))
      .filter(r => r.some(c => c !== ''));
  }

  /**
   * Banks routinely emit `4,820.00` unquoted, which a comma-delimited parser
   * splits into "4" and "820.00".
   *
   * Rejoining on shape alone is too eager — an amount-and-balance layout can
   * legitimately hold `4` beside `820.00`. So only repair rows that have MORE
   * cells than the table's usual width, and stop the moment a row is back to
   * that width. A well-formed row is never touched.
   */
  const HEAD = /^-?\(?\s*\d{1,3}$/;
  const TAIL = /^\d{3}(?:\.\d{1,2})?\)?(?:\s*(?:CR|DR))?$/i;

  function fixSplitNumbers(rows) {
    if (rows.length < 2) return rows;
    const tally = new Map();
    for (const r of rows) tally.set(r.length, (tally.get(r.length) || 0) + 1);
    const width = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return rows.map(r => (r.length > width ? rejoinRow(r, width) : r));
  }

  function rejoinRow(cells, width) {
    const out = [];
    for (let i = 0; i < cells.length; i++) {
      let cur = cells[i];
      // only while this row is still too wide
      while (out.length + (cells.length - i) > width &&
             HEAD.test(cur) && i + 1 < cells.length && TAIL.test(cells[i + 1])) {
        cur += ',' + cells[i + 1];
        i++;
        if (/\.\d/.test(cur)) break;              // a decimal ends the number
      }
      out.push(cur);
    }
    return out;
  }

  /* ─────────────── XLSX ─────────────── */

  const dv = buf => new DataView(buf);

  /** Unzip an .xlsx into {filename: Uint8Array}. Reads the central directory
      rather than scanning local headers, which streaming zips get wrong. */
  async function unzip(buffer) {
    const view = dv(buffer);
    const len = buffer.byteLength;

    // End Of Central Directory — scan back over the optional comment
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file');

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = {};

    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method   = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen  = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const cmtLen   = view.getUint16(p + 32, true);
      const localAt  = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen));
      p += 46 + nameLen + extraLen + cmtLen;

      // the local header repeats name/extra with possibly different lengths
      const lNameLen  = view.getUint16(localAt + 26, true);
      const lExtraLen = view.getUint16(localAt + 28, true);
      const start = localAt + 30 + lNameLen + lExtraLen;
      const raw = new Uint8Array(buffer, start, compSize);

      if (method === 0) files[name] = raw;
      else if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
        files[name] = new Uint8Array(out);
      }
      // any other method (rare in xlsx) is skipped
    }
    return files;
  }

  const xml = bytes => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');

  const colIndex = ref => {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  /** Excel serial → YYYY-MM-DD. Day 0 is 1899-12-30 thanks to the 1900 leap bug. */
  function serialToISO(n) {
    const ms = Math.round((n - 25569) * 86400000);       // 25569 = days to 1970-01-01
    const d = new Date(ms);
    if (isNaN(d)) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

  /** Which style indexes are date-formatted — the only reliable way to tell a
      date from a plain number, since both are just serials on the wire. */
  function dateStyles(files) {
    const out = new Set();
    if (!files['xl/styles.xml']) return out;
    const doc = xml(files['xl/styles.xml']);
    const custom = new Set();
    for (const f of doc.getElementsByTagName('numFmt')) {
      const code = (f.getAttribute('formatCode') || '').toLowerCase();
      if (/[dmy]/.test(code) && !/[#0]/.test(code.replace(/\[[^\]]*\]/g, ''))) {
        custom.add(f.getAttribute('numFmtId'));
      }
    }
    const xfs = doc.querySelector('cellXfs');
    if (!xfs) return out;
    [...xfs.getElementsByTagName('xf')].forEach((xf, i) => {
      const id = xf.getAttribute('numFmtId');
      if (BUILTIN_DATE_FMT.has(Number(id)) || custom.has(id)) out.add(i);
    });
    return out;
  }

  async function parseXlsx(file) {
    const files = await unzip(await file.arrayBuffer());

    const shared = [];
    if (files['xl/sharedStrings.xml']) {
      for (const si of xml(files['xl/sharedStrings.xml']).getElementsByTagName('si')) {
        shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
      }
    }
    const dateXf = dateStyles(files);

    const sheetName = Object.keys(files)
      .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort()[0];
    if (!sheetName) throw new Error('No sheet found in that file');

    const rows = [];
    for (const r of xml(files[sheetName]).getElementsByTagName('row')) {
      const cells = [];
      for (const c of r.getElementsByTagName('c')) {
        const idx = colIndex(c.getAttribute('r'));
        const type = c.getAttribute('t');
        const style = c.getAttribute('s');
        let val = '';

        if (type === 'inlineStr') {
          val = [...c.getElementsByTagName('t')].map(t => t.textContent).join('');
        } else {
          const v = c.getElementsByTagName('v')[0];
          const raw = v ? v.textContent : '';
          if (type === 's') val = shared[Number(raw)] ?? '';
          else if (type === 'str' || type === 'e') val = raw;
          else if (raw !== '') {
            const num = Number(raw);
            val = (style != null && dateXf.has(Number(style)) && num > 1 && num < 80000)
              ? (serialToISO(num) || raw) : raw;
          }
        }
        cells[idx] = String(val).trim();
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      if (cells.some(c => c !== '')) rows.push(cells);
    }
    return rows;
  }

  /* ─────────────── PDF ─────────────── */

  let pdfLib = null;

  async function getPdfLib(onProgress) {
    if (pdfLib) return pdfLib;
    if (onProgress) onProgress('Loading the PDF reader…', 0.2);
    const mod = await import('./vendor/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
    pdfLib = mod;
    return mod;
  }

  /** Rebuild visual rows: PDFs have no notion of a table, only glyphs at
      coordinates, so group text items by baseline and order them left to right. */
  async function parsePdf(file, onProgress) {
    const lib = await getPdfLib(onProgress);
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const rows = [];

    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(`Reading page ${p} of ${doc.numPages}…`, 0.3 + 0.6 * (p / doc.numPages));
      const page = await doc.getPage(p);
      const content = await page.getTextContent();

      const lines = new Map();
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const y = Math.round(item.transform[5] / 3) * 3;    // tolerate slight baseline drift
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x: item.transform[4], s: item.str });
      }
      // top of the page has the largest y in PDF space
      for (const [, items] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
        items.sort((a, b) => a.x - b.x);
        // a wide gap between glyphs is a column break
        let cells = [], cur = '', prevEnd = null;
        for (const it of items) {
          if (prevEnd !== null && it.x - prevEnd > 12) { cells.push(cur.trim()); cur = ''; }
          cur += (cur && !cur.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
          prevEnd = it.x + it.s.length * 4.2;               // rough advance estimate
        }
        if (cur.trim()) cells.push(cur.trim());
        if (cells.some(c => c !== '')) rows.push(cells);
      }
    }
    await doc.destroy();
    return rows;
  }

  /* ─────────────── transaction parsing ─────────────── */

  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  /** Things that are not spending: repayments, refunds, interest reversals. */
  /**
   * Things that are not spending. Deliberately does NOT include a bare
   * "autopay": on a card statement "SMARTONE AUTOPAY" is a merchant collecting
   * a bill, i.e. real spending. Only a repayment *of the card* is excluded, and
   * those are caught by "payment" or by their CR/negative sign anyway.
   */
  const NOT_SPEND = /\b(payment|paymt|pymt|thank\s*you|direct\s*debit\s*received|refund|reversal|credit\s*balance|rebate|cashback|cash\s*back|adjustment|previous\s*balance|opening\s*balance|closing\s*balance|balance\s*(?:b\/?f|forward|carried)|total|subtotal|minimum\s*due|min\.?\s*payment|statement\s*balance|credit\s*limit|available\s*credit|points?|pts|reward|mileage|miles\s*earned)\b/i;

  /** A statement usually declares its own date convention above the table. */
  function detectDateOrder(rows) {
    for (const cells of rows) {
      const line = cells.join(' ');
      if (!/date/i.test(line)) continue;
      if (!/(amount|description|詳列|銀碼)/i.test(line)) continue;
      const m = line.match(/\((MM\s*\/\s*DD|DD\s*\/\s*MM)/i);
      if (m) return /^MM/i.test(m[1].replace(/\s/g, '')) ? 'mdy' : 'dmy';
    }
    return null;
  }

  /**
   * `order` is 'mdy' or 'dmy' when the statement declares its own convention —
   * Standard Chartered prints "Date (MM/DD)" above the table while using
   * DD/MM/YYYY for the statement date itself, so guessing is not good enough.
   */
  function toISODate(s, fallbackYear, order) {
    if (!s) return null;
    const t = String(s).trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;

    m = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?$/);
    if (m) {
      let y = m[3] ? +m[3] : fallbackYear;
      if (y < 100) y += 2000;
      const a = +m[1], b = +m[2];
      let d, mo;
      if (order === 'mdy')      { mo = a; d = b; }
      else if (order === 'dmy') { d = a; mo = b; }
      else [d, mo] = a > 12 ? [a, b] : (b > 12 ? [b, a] : [a, b]);   // day-first by default
      if (mo > 12 && d <= 12) { const t2 = d; d = mo; mo = t2; }      // declared order was impossible
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      return null;
    }

    m = t.match(/^(\d{1,2})\s*[-\s]?\s*([A-Za-z]{3})[a-z]*\.?\s*[-\s]?\s*(\d{2,4})?$/);
    if (m && MONTHS[m[2].toLowerCase()]) {
      let y = m[3] ? +m[3] : fallbackYear;
      if (y < 100) y += 2000;
      return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
    }

    m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{2,4})?$/);
    if (m && MONTHS[m[1].toLowerCase()]) {
      let y = m[3] ? +m[3] : fallbackYear;
      if (y < 100) y += 2000;
      return `${y}-${String(MONTHS[m[1].toLowerCase()]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
    }
    return null;
  }

  /**
   * Returns {value, credit} — credit meaning money coming back to you.
   *
   * Finds the money *token* rather than stripping non-digits from the cell.
   * Statements routinely bury the amount next to other digits, e.g.
   * "Transaction Ref 55439136191688701739987 64.00"; stripping would have
   * yielded 5.5e+24. Amounts are also printed as "1,482 .42", with a space
   * before the decimals, so the pattern tolerates internal whitespace.
   */
  // Whitespace is tolerated only immediately around the decimal separator.
  // Allowing it through the integer part let the pattern bridge a reference
  // number and the amount beside it into one absurd figure.
  const MONEY_TOKEN = /(?:^|[^\d.,])(\d[\d,]*\s?[.,]\s?\d{2})(?![\d.,])/g;

  function toMoney(s) {
    if (s == null) return null;
    const raw = String(s).trim();
    if (!raw || !/\d/.test(raw)) return null;

    // CR/DR often sit flush against the digits ("3,086 .38CR"), so \b is useless
    let credit = /\d\s*CR\b|\bCR\s*$/i.test(raw);
    const bracketed = /\(\s*[\d,]/.test(raw) && /\)/.test(raw);
    if (bracketed) credit = true;
    if (/(^|\s)-\s*[\d(]/.test(raw)) credit = true;

    let token = null;
    MONEY_TOKEN.lastIndex = 0;
    for (let m; (m = MONEY_TOKEN.exec(raw)); ) token = m[1];   // last one wins

    if (token == null) {
      // No decimals anywhere. Only accept a cell that is essentially just a
      // number — and keep it short and unspaced, so a card number like
      // "5427 1340 0083 5018" or a long reference can never pass as an amount.
      const bare = raw.replace(/\s*(CR|DR)\s*$/i, '').replace(/[()+]/g, '').trim();
      if (!/^-?\d[\d,]*$/.test(bare)) return null;
      if (bare.replace(/\D/g, '').length > 7) return null;
      token = bare;
    }

    let t = token.replace(/\s/g, '');
    // 1.234,56 (European) vs 1,234.56
    if (/,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');

    const v = Math.abs(parseFloat(t));
    if (!Number.isFinite(v) || v === 0) return null;
    return { value: v, credit };
  }

  /**
   * Turn arbitrary statement rows into transactions.
   * Works positionally rather than by header, because PDF statements rarely
   * have usable headers and every bank orders its columns differently.
   */
  function extract(rows, opts = {}) {
    const year = opts.year || new Date().getFullYear();
    const order = opts.order || detectDateOrder(rows);
    const out = [];

    for (const cells of rows) {
      if (!cells || !cells.length) continue;
      const joined = cells.join(' ').trim();
      if (joined.length < 4) continue;

      // date: the first cell that parses as one. Statements often carry both a
      // transaction and a posting date, so consume the whole run of them —
      // otherwise the second date ends up glued to the description.
      //
      // A real transaction row never has money before its date. Summary panels
      // do ("1,482.42 | 300.00 | August 25, 2026 | Pts | 2,389,320"), so a date
      // appearing after an amount means this is not a transaction.
      let date = null, dateAt = -1;
      for (let i = 0; i < cells.length && i < 4; i++) {
        if (toMoney(cells[i])) break;
        const d = toISODate(cells[i], year, order);
        if (d) { date = d; dateAt = i; break; }
      }
      if (dateAt >= 0) {
        while (dateAt + 1 < cells.length && toISODate(cells[dateAt + 1], year, order)) dateAt++;
      }
      // some PDFs put the date inline at the start of one long cell
      if (!date) {
        const m = joined.match(/^(\d{1,2}\s*[-/ ]\s*(?:[A-Za-z]{3}|\d{1,2})(?:\s*[-/ ]\s*\d{2,4})?)/);
        if (m) { date = toISODate(m[1].trim(), year, order); }
      }
      if (!date) continue;

      // amount: the last cell that parses as money
      let amount = null, amtAt = -1;
      for (let i = cells.length - 1; i > dateAt; i--) {
        const m = toMoney(cells[i]);
        if (m) { amount = m; amtAt = i; break; }
      }
      if (!amount && cells.length === 1) {
        const m = joined.match(/(-?\(?[\d,]+\.\d{2}\)?\s*(?:CR|DR)?)\s*$/i);
        if (m) amount = toMoney(m[1]);
      }
      if (!amount) continue;

      // description: everything between date and amount
      let desc = cells.slice(dateAt + 1, amtAt > 0 ? amtAt : undefined)
        .filter(Boolean).join(' ').trim();
      if (!desc) {
        desc = joined
          .replace(/^\S+\s*/, '')
          .replace(/(-?\(?[\d,]+\.\d{2}\)?\s*(?:CR|DR)?)\s*$/i, '')
          .trim();
      }
      desc = desc
        .replace(/transaction\s*ref\.?\s*[:#]?\s*\d+/ig, '')   // SC prints a 23-digit ref inline
        .replace(/\s{2,}/g, ' ')
        .replace(/^[-–—:\s]+|[-–—:\s]+$/g, '');
      if (desc.length < 3) continue;

      const skip = amount.credit || NOT_SPEND.test(desc);
      out.push({ date, desc, amount: amount.value, credit: amount.credit, skip });
    }
    return out;
  }

  /** Route by file type. */
  async function read(file, onProgress) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xls') && !name.endsWith('.xlsx')) {
      throw new Error('Old .xls files are not supported — re-save it as .xlsx or CSV');
    }
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      return { rows: await parsePdf(file, onProgress), kind: 'PDF' };
    }
    if (name.endsWith('.xlsx') || /spreadsheetml/.test(file.type)) {
      if (onProgress) onProgress('Reading the spreadsheet…', 0.5);
      return { rows: await parseXlsx(file), kind: 'Excel' };
    }
    if (onProgress) onProgress('Reading the file…', 0.5);
    return { rows: parseCsv(await file.text()), kind: 'CSV' };
  }

  /* ─────────────── Airbnb payout export ─────────────── */

  const AB = {
    date:    /^date$/i,
    type:    /^type$/i,
    code:    /^confirmation\s*code$/i,
    start:   /^start\s*date$/i,
    nights:  /^nights$/i,
    guest:   /^guest$/i,
    listing: /^listing$/i,
    details: /^details$/i,
    currency:/^currency$/i,
    amount:  /^amount$/i,
    paidout: /^paid\s*out$/i,
    // Airbnb's commission is "Host Fee" in some exports and "Service fee" in
    // others — the same deduction under two names
    hostfee: /^(host|service)\s*fee$/i,
    fastpay: /^fast\s*pay\s*fee$/i,
    cleaning:/^cleaning\s*fee$/i,
    gross:   /^gross\s*earnings$/i,
    tax:     /^airbnb\s*remitted\s*tax$/i,
  };

  /** Does this look like an Airbnb transaction export rather than a statement? */
  function looksLikeAirbnb(rows) {
    return rows.slice(0, 8).some(r => {
      const cells = r.map(c => String(c).trim());
      return cells.some(c => AB.code.test(c)) &&
             cells.some(c => AB.type.test(c) || AB.gross.test(c) || AB.paidout.test(c));
    });
  }

  /**
   * Read an Airbnb export into earnings.
   *
   * The file mixes two views of the same money: a "Reservation" row per booking
   * and a "Payout" row per bank transfer. Importing both would double every
   * peso, so payouts are recognised and skipped — the reservations are what
   * actually earned, and they carry the guest, dates and nights with them.
   */
  function parseAirbnb(rows) {
    let idx = null, headerAt = -1;
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const cells = rows[i].map(c => String(c).trim());
      if (!cells.some(c => AB.code.test(c))) continue;
      idx = {};
      cells.forEach((c, n) => {
        for (const [key, re] of Object.entries(AB)) if (re.test(c)) idx[key] = n;
      });
      headerAt = i;
      break;
    }
    if (!idx) return [];

    const cell = (r, k) => (idx[k] != null ? String(r[idx[k]] ?? '').trim() : '');
    const num = s => { const m = toMoney(s); return m ? (/-|\(/.test(String(s)) ? -m.value : m.value) : null; };
    const out = [];

    // Airbnb exports dates as MM/DD/YYYY regardless of where you live, so the
    // day-first default would silently turn 06/05 into 6 May instead of 5 June.
    const ORDER = 'mdy';
    const year = new Date().getFullYear();

    for (const r of rows.slice(headerAt + 1)) {
      if (!r.some(c => String(c).trim())) continue;
      const type = cell(r, 'type');
      const code = cell(r, 'code');

      // a bank transfer, not a booking — the same money seen twice
      const isPayout = /payout/i.test(type) && !/resolution/i.test(type);

      const amount = num(cell(r, 'amount'));
      const gross  = num(cell(r, 'gross'));
      const paid   = num(cell(r, 'paidout'));
      // payout rows carry their figure in Paid Out; keep them so they can be
      // reported as skipped rather than vanishing without explanation
      const value  = amount != null ? amount : (gross != null ? gross : (isPayout ? paid : null));
      if (value == null || value === 0) continue;

      const date = toISODate(cell(r, 'start'), year, ORDER)
                || toISODate(cell(r, 'date'), year, ORDER);
      if (!date) continue;

      const guest = cell(r, 'guest');
      const nights = cell(r, 'nights');
      const listing = cell(r, 'listing');
      const label = guest
        ? `${guest}${nights ? ` · ${nights} night${nights === '1' ? '' : 's'}` : ''}`
        : (cell(r, 'details') || listing || type || 'Airbnb');

      out.push({
        date, code, type: type || 'Reservation',
        amount: Math.abs(value),
        refund: value < 0,
        skip: isPayout,
        skipWhy: isPayout ? 'payout to bank' : null,
        note: label,
        listing,
        currency: cell(r, 'currency') || null,
        // Gross is what the guest paid, cleaning fee included. Airbnb's service
        // fee is then deducted to give Amount, which is what actually lands.
        gross:    num(cell(r, 'gross')),
        cleaning: num(cell(r, 'cleaning')),
        fee:      Math.abs(num(cell(r, 'hostfee')) || 0) + Math.abs(num(cell(r, 'fastpay')) || 0),
      });
    }
    return out;
  }

  return { read, extract, parseCsv, parseXlsx, parsePdf, toISODate, toMoney,
           parseAirbnb, looksLikeAirbnb };
})();
