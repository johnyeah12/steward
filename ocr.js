/* ══════════════════════════════════════════════════════════════
   Receipt reading — entirely on-device.

   Tesseract is vendored under vendor/ and loaded lazily the first
   time a receipt is scanned, so it never slows the app's cold start.
   Nothing about a photo leaves the phone except the compressed copy
   that goes into your own private repo.
   ══════════════════════════════════════════════════════════════ */

'use strict';

const OCR = (() => {

  const V = {
    lib:    'vendor/tesseract.min.js',
    worker: 'vendor/worker.min.js',
    core:   'vendor/tesseract-core-simd-lstm.wasm.js',
    lang:   'vendor',
  };

  let workerPromise = null;

  /* ── lazy load ────────────────────────────────────────────── */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load the receipt reader'));
      document.head.appendChild(s);
    });
  }

  async function getWorker(onProgress) {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      await loadScript(V.lib);
      const w = await Tesseract.createWorker('eng', 1, {
        workerPath: V.worker,
        corePath:   V.core,
        langPath:   V.lang,
        gzip:       true,
        legacyCore: false,
        legacyLang: false,
        logger: m => {
          if (!onProgress) return;
          if (m.status === 'loading tesseract core')      onProgress('Preparing the reader…', m.progress * 0.4);
          else if (m.status === 'loading language traineddata') onProgress('Preparing the reader…', 0.4 + m.progress * 0.4);
          else if (m.status === 'initializing api')       onProgress('Preparing the reader…', 0.85);
        },
      });
      await w.setParameters({ tessedit_pageseg_mode: '4' }); // a receipt is one column
      return w;
    })().catch(err => { workerPromise = null; throw err; });
    return workerPromise;
  }

  /* ── image prep ───────────────────────────────────────────── */

  const loadBitmap = file =>
    (self.createImageBitmap ? createImageBitmap(file) : new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    }));

  /** Grayscale + Bradley–Roth adaptive threshold.

      Each pixel is compared against the mean of its own neighbourhood rather
      than one global cutoff, which is what makes a shadow falling across the
      paper — or a photo lit from one side — survive. A global stretch loses
      the darker half of the receipt entirely. Computed off an integral image,
      so it stays O(pixels) and runs in a few ms even on a phone. */
  function prepare(bmp, maxDim = 1700, minDim = 1200) {
    let scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    // Tesseract needs a decent x-height; upscale anything shot small.
    if (Math.max(bmp.width, bmp.height) * scale < minDim) {
      scale = minDim / Math.max(bmp.width, bmp.height);
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }

    // integral image, padded by one row/column
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }

    const radius = Math.max(8, Math.round(w / 24));   // ~half a window
    const T = 0.14;                                    // how far below local mean counts as ink

    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
                  - integral[y0 * (w + 1) + (x1 + 1)]
                  - integral[(y1 + 1) * (w + 1) + x0]
                  + integral[y0 * (w + 1) + x0];
        const v = gray[y * w + x] * count < sum * (1 - T) ? 0 : 255;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** A small JPEG for storage — this is what gets kept, not the original. */
  function thumbnail(bmp, maxDim = 900, quality = 0.55) {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  }

  /* ── parsing ──────────────────────────────────────────────── */

  // Lines that mean "this is the number you want"…
  const TOTAL_HINTS = [
    [/\bGRAND\s*TOTAL\b/i, 100], [/\bTOTAL\s*DUE\b/i, 100], [/\bAMOUNT\s*DUE\b/i, 100],
    [/\bBALANCE\s*DUE\b/i, 95], [/\bNET\s*TOTAL\b/i, 90],   [/\bTOTAL\s*AMOUNT\b/i, 90],
    [/\bTOTAL\b/i, 70],         [/\bAMOUNT\b/i, 45],
    [/應\s*付|合\s*計|總\s*計|總\s*額|實\s*收/, 90],
  ];
  // …and lines that look similar but are the wrong number.
  const TOTAL_TRAPS = /\b(SUB\s*-?\s*TOTAL|CHANGE|CASH|TENDER(ED)?|PAID|ROUNDING|SAVING|DISCOUNT|POINT|TAX|VAT|GST|SERVICE|TIP|QTY|ITEM|CARD|VISA|MASTER|BALANCE\s*OF)\b/i;

  const MONEY = /(?:HK\$|US\$|RMB|\$|₱|€|£|¥)?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{2})?|\d+\.\d{2}|\d+)(?!\d*\s*%)/g;

  function numbersOn(line) {
    const out = [];
    for (const m of line.matchAll(MONEY)) {
      const raw = m[1].replace(/[,\s]/g, '');
      const val = parseFloat(raw);
      if (Number.isFinite(val) && val > 0 && val < 1e7) {
        out.push({ val, hasDecimals: /\.\d{2}$/.test(raw), index: m.index });
      }
    }
    return out;
  }

  function findTotal(lines) {
    const candidates = [];

    lines.forEach((line, i) => {
      if (TOTAL_TRAPS.test(line)) return;
      let hint = 0;
      for (const [re, score] of TOTAL_HINTS) if (re.test(line)) { hint = Math.max(hint, score); }
      if (!hint) return;
      // The total is the last number on its line — or the first number on the next
      // line, which is how a lot of receipts wrap it.
      let nums = numbersOn(line);
      if (!nums.length && lines[i + 1]) nums = numbersOn(lines[i + 1]);
      if (!nums.length) return;
      const pick = nums[nums.length - 1];
      // later in the receipt = more likely the real total
      candidates.push({ ...pick, score: hint + (i / lines.length) * 15 + (pick.hasDecimals ? 10 : 0) });
    });

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score || b.val - a.val);
      return { amount: candidates[0].val, confidence: candidates[0].score >= 80 ? 'high' : 'medium' };
    }

    // Nothing labelled — fall back to the largest properly-decimalised number.
    const all = lines.flatMap(numbersOn).filter(n => n.hasDecimals);
    if (all.length) {
      all.sort((a, b) => b.val - a.val);
      return { amount: all[0].val, confidence: 'low' };
    }
    return { amount: null, confidence: 'none' };
  }

  /* Card statements route through payment processors, so the descriptor often
     reads "fp*Food Panda" or "2C2P*SALADSTOP" — the real merchant is what
     follows. Strip the processor before trying to categorise. */
  const PROCESSOR = /^(?:pp\*|paypal\s*\*|2c2p\*|kpay\w*\*|alipayhk\*|alipay\*|fp\*|pym\*|sq\s*\*|tst\*|wechat\s*pay\s*|dash\s*\*|www\.)/i;

  const CAT_HINTS = [
    ['give', /VICTORY\s*CHRIST|CHRISTIAN\s*FELLOWSHIP|\bCCF\b|\bCHURCH\b|TITHE|OFFERING|MINISTR|CATHEDRAL|PARISH|教會|奉獻/i],
    ['food', /FOOD\s*PANDA|FOODPANDA|DELIVEROO|UBER\s*EATS|SALADSTOP|SHAKE\s*SHACK|OOLAA|STARBUCKS|PACIFIC\s*COFFEE|MCDONALD|KFC\b|PIZZA|BURGER|SUSHI|RAMEN|NOODLE|DIM\s*SUM|CAFE|CAFFE|COFFEE|BISTRO|BRASSERIE|EATERY|CANTEEN|CATERING|CATHERING|BAKEHOUSE|BAKERY|TEAHOUSE|RESTAURAN|GRAND\s*HYATT\s*F\s*&?\s*B|BALAY\s*DAKO|ITALIANNI|WILD\s*FLOUR|CAFE\s*MARY|MAXIM|CRYSTAL\s*JADE|TIM\s*HO\s*WAN|PRET\b|SUBWAY/i],
    ['groc', /WELLCOME|PARKNSHOP|PARK\s*N\s*SHOP|MARKET\s*PLACE|JASONS|CITY\s*SUPER|CITYSUPER|759|AEON|VANGUARD|FUSION|SUPERMARKET|GROCER|SAVEMORE|PUREGOLD|ROBINSONS\s*SUPER|RUSTAN|LANDERS|S&R\b|市場|超級|超市/i],
    ['tran', /\bMTR\b|OCTOPUS|TAXI|\bUBER\b(?!\s*EATS)|\bGRAB\b|BOLT\b|FERRY|TRAM\b|PARKING|PETROL|SHELL\b|CALTEX|ESSO|AIRPORT\s*EXPRESS|LOCOBIKE|CITYBUS|KMB\b|八達通|的士|停車/i],
    ['bill', /HKBN|\bHKT\b|PCCW|\bCSL\b|SMARTONE|SMART\s*ONE|3\s*HONG\s*KONG|HUTCHISON|CLP\s*POWER|TOWNGAS|WATER\s*SUPPL|NETFLIX|SPOTIFY|DISNEY|GOOGLE\s*\*?\s*(?:ONE|STORAGE|YOUTUBE)|YOUTUBEPREMIUM|APPLE\.COM\/BILL|MICROSOFT|ADOBE|DROPBOX|OPENAI|ANTHROPIC|CLAUDE|AIA\b|PRUDENTIAL|PHILAMLIFE|INSURANCE|PREMIUM|SUBSCRIPTION|DCC\s*FEE|ANNUAL\s*FEE|SERVICE\s*CHARGE|INTEREST/i],
    ['heal', /WATSONS|MANNINGS|PHARMACY|CLINIC|HOSPITAL|DENTAL|DOCTOR|MEDICAL|OPTICAL|IHERB|VITAMIN|DR\s*KONG|PHYSIO|藥房|診所|醫/i],
    ['home', /IKEA|FURNITURE|HARDWARE|JAPAN\s*HOME|DAISO|PRICERITE|HOME\s*(?:DEPOT|STORE)|家居/i],
    ['fun',  /CINEMA|MOVIE|BROADWAY|\bCGV\b|GOLDEN\s*HARVEST|KARAOKE|NETFLIX\s*GAME|STEAM\s*GAMES|PLAYSTATION|NINTENDO|THEATRE|CONCERT|TICKETFLAP|KLOOK|HMV/i],
    ['pers', /SALON|BARBER|\bHAIR\b|\bSPA\b|NAIL|COSMETIC|SASA\b|BONJOUR|SEPHORA|UNIQLO|ZARA|H&M\b|DECATHLON|NIKE\b|ADIDAS|PARFUM|PERFUME|LULULEMON|MUJI/i],
    ['trip', /HOTEL|RESORT|AIRLINE|CATHAY\s*PACIFIC|HK\s*EXPRESS|AIRWAYS|AIR\s*ASIA|CEBU\s*PAC|TRAVEL|AGODA|BOOKING\.COM|AIRBNB|EXPEDIA|TRIP\.COM|ST\s*REGIS|STREGIS|HYATT|MARRIOTT|SHANGRI|JIUDIAN/i],
    ['kids', /\bTOY\b|TOYS.?R.?US|\bKIDS\b|CHILD|BABY|MOTHERCARE|SCHOOL|TUTOR|TAEKWONDO|GYMNASTIC|SWIMMING/i],
    // generic fallbacks, tried only after the specific merchants above
    ['food', /\bRESTAURAN|\bDINER\b|\bGRILL\b|\bKITCHEN\b|CHA\s*CHAAN|茶餐廳|飯|麵|餐廳|咖啡/i],
    ['groc', /SUPERMARKET|GROCER|市場|超級|超市/i],
    ['bill', /BROADBAND|TELECOM|UTILIT|ELECTRIC|INVOICE/i],
  ];

  function guessCategory(text) {
    const cleaned = String(text).replace(PROCESSOR, '').trim();
    for (const [cat, re] of CAT_HINTS) if (re.test(cleaned) || re.test(text)) return cat;
    return null;
  }

  function findMerchant(lines) {
    for (const line of lines.slice(0, 6)) {
      const clean = line.replace(/[^A-Za-z0-9一-鿿&'. -]/g, '').trim();
      if (clean.length < 3) continue;
      if (/^\d[\d\s/.:-]*$/.test(clean)) continue;             // a date or a number
      if (/(RECEIPT|INVOICE|TAX|COPY|WELCOME|THANK)/i.test(clean) && clean.length < 14) continue;
      const letters = (clean.match(/[A-Za-z一-鿿]/g) || []).length;
      if (letters < 3) continue;
      return clean.slice(0, 40).replace(/\s{2,}/g, ' ').trim();
    }
    return null;
  }

  const MONTHS = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };

  function findDate(text, todayIso) {
    const [ty, tm, td] = todayIso.split('-').map(Number);
    const today = new Date(ty, tm - 1, td);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sane = d => d instanceof Date && !isNaN(d) && d <= today && (today - d) < 400 * 864e5;

    let m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); if (sane(d)) return iso(d); }

    m = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2})\b/);
    if (m) {
      const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      // day-first, then month-first — whichever lands in the past year
      for (const [a, b] of [[+m[1], +m[2]], [+m[2], +m[1]]]) {
        const d = new Date(yr, b - 1, a);
        if (sane(d)) return iso(d);
      }
    }

    m = text.match(/\b(\d{1,2})\s*[-\s]\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*[-\s]?\s*(20\d{2}|\d{2})?\b/i);
    if (m) {
      const yr = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : ty;
      const d = new Date(yr, MONTHS[m[2].toUpperCase().slice(0, 3)] - 1, +m[1]);
      if (sane(d)) return iso(d);
    }
    return null;
  }

  function parse(text, todayIso) {
    const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const { amount, confidence } = findTotal(lines);
    const merchant = findMerchant(lines);
    return {
      amount,
      confidence,
      merchant,
      category: guessCategory(text) || (merchant ? guessCategory(merchant) : null),
      date: findDate(text, todayIso),
      lineCount: lines.length,
    };
  }

  /* ── public ───────────────────────────────────────────────── */

  /** Read a receipt. Returns {amount, merchant, category, date, confidence, thumb}. */
  async function read(file, todayIso, onProgress) {
    const bmp = await loadBitmap(file);
    const thumb = await thumbnail(bmp);

    const worker = await getWorker(onProgress);
    if (onProgress) onProgress('Reading the receipt…', 0.9);

    const { data } = await worker.recognize(prepare(bmp));
    let result = parse(data.text || '', todayIso);
    let conf = data.confidence;

    // Thresholding wins on nearly every real photo, but on very faint or
    // glossy paper it can erase the print. Only then, retry on the original.
    if (result.amount == null) {
      if (onProgress) onProgress('Trying a second pass…', 0.95);
      const retry = await worker.recognize(bmp);
      const alt = parse(retry.data.text || '', todayIso);
      if (alt.amount != null) { result = alt; conf = retry.data.confidence; }
    }

    result.thumb = thumb;
    if (result.confidence !== 'none' && conf < 55) {
      result.confidence = result.confidence === 'high' ? 'medium' : 'low';
    }
    return result;
  }

  async function dispose() {
    if (!workerPromise) return;
    try { (await workerPromise).terminate(); } catch { /* already gone */ }
    workerPromise = null;
  }

  return { read, parse, dispose, thumbnail, loadBitmap, prepare };
})();
