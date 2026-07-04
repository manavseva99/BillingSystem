'use strict';
/* ══════════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════════ */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyvRE-T1EQJ61oO50EPx9gNAmAa7TgxP6KqQmbz_wsf_LdjMESFLudb42dGTbSeoDOCUg/exec';
// Must match API_SECRET in the Apps Script backend exactly, or every
// request gets rejected as Unauthorized.
const GAS_SECRET = 'PatientCare9819086415&ManavSeva9920700815';
const PAGE_SIZE = 50;
// Admin credentials — change these. For production deploy via
// GitHub Actions secret or server-side env; never ship in plaintext.
const ADMIN_CREDS = { username: 'admin', password: 'ManavSeva@2024' };
const SESSION_KEY = 'hbm_auth_v1';

/* ══════════════════════════════════════════════════════════
   AUTH  — Simple session-based gate
══════════════════════════════════════════════════════════ */
function doLogin() {
  const u = (document.getElementById('l-user').value || '').trim();
  const p = (document.getElementById('l-pass').value || '').trim();
  if (u === ADMIN_CREDS.username && p === ADMIN_CREDS.password) {
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = '';
    if (typeof APP === 'undefined') initApp(); else APP.render();
    toast('Login Successful ✓', 'success', 2800);
  } else {
    const e = document.getElementById('l-err');
    e.style.display = 'block';
    document.getElementById('l-pass').value = '';
    setTimeout(() => { e.style.display = 'none' }, 3000);
  }
}
function checkAuth() {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = '';
    return true;
  }
  return false;
}
function doLogout() {
  // The page reloads right after this, so the toast itself wouldn't have
  // time to show — instead, flag it and display it once the login screen
  // is back up after reload.
  sessionStorage.setItem('hbm_logout_msg', '1');
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}
(function () {
  if (sessionStorage.getItem('hbm_logout_msg') === '1') {
    sessionStorage.removeItem('hbm_logout_msg');
    window.addEventListener('DOMContentLoaded', () => toast('Logout Successful ✓', 'info', 2800));
  }
})();
// Block right-click and devtools in production (basic deterrent)
// TEMPORARILY DISABLED for debugging the Google Sheets sync issue.
// Uncomment these 4 lines before final deploy if you want this back:
// document.addEventListener('contextmenu', e => e.preventDefault());
// document.addEventListener('keydown', e => {
//     if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) e.preventDefault();
//     if (e.key === 'F12') e.preventDefault();
// });

/* ══════════════════════════════════════════════════════════
   OFFLINE DETECTION
══════════════════════════════════════════════════════════ */
function onlineChange() { document.body.classList.toggle('offline', !navigator.onLine); if (navigator.onLine) drainQueue() }
window.addEventListener('online', onlineChange);
window.addEventListener('offline', onlineChange);
document.body.classList.toggle('offline', !navigator.onLine); // initial banner state only; drainQueue() runs once declared below

/* ══════════════════════════════════════════════════════════
   IndexedDB
══════════════════════════════════════════════════════════ */
const DB_NAME = 'HospitalBMS3', DB_VER = 4;
let _db = null;
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      [{ name: 'patients', indexes: ['createdAt', 'name', 'mobile'] },
      { name: 'staff', indexes: ['createdAt', 'name', 'type'] },
      { name: 'bills', indexes: ['createdAt', 'center', 'patientName', 'billNo'] },
      { name: 'online', indexes: ['createdAt', 'company', 'date'] },
      { name: 'worker', indexes: ['createdAt', 'staffName', 'dutyDate'] }
      ].forEach(({ name, indexes }) => {
        if (!d.objectStoreNames.contains(name)) {
          const s = d.createObjectStore(name, { keyPath: 'id' });
          indexes.forEach(i => s.createIndex(i, i, { unique: false }));
        }
      });
      // Offline sync queue — moved off localStorage (hard ~5-10MB quota
      // that base64 photo payloads blow through fast) and into
      // IndexedDB (typically hundreds of MB+), one item per record
      // instead of one giant JSON blob rewritten on every change.
      if (!d.objectStoreNames.contains('syncQueue')) {
        d.createObjectStore('syncQueue', { keyPath: 'qid', autoIncrement: true });
      }
    };
    r.onsuccess = e => { _db = e.target.result; res(_db) };
    r.onerror = e => rej(e.target.error);
  });
  return _dbPromise;
}
const _tx = (store, mode = 'readonly') => _db.transaction(store, mode).objectStore(store);
const dbAll = store => new Promise((r, j) => { const q = _tx(store).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error) });
const dbPut = (store, obj) => new Promise((r, j) => { const q = _tx(store, 'readwrite').put(obj); q.onsuccess = () => r(); q.onerror = () => j(q.error) });
const dbDel = (store, id) => new Promise((r, j) => { const q = _tx(store, 'readwrite').delete(id); q.onsuccess = () => r(); q.onerror = () => j(q.error) });


/* ══════════════════════════════════════════════════════════
   SEARCH INDEX  — prefix-trie, O(1) per keystroke
══════════════════════════════════════════════════════════ */
class SearchIndex {
  constructor() { this._m = new Map() }
  _tok(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f ]/g, ' ').split(/\s+/).filter(Boolean) }
  _flat(r) { return Object.values(r).filter(v => typeof v === 'string' || typeof v === 'number').join(' ') }
  build(records) { this._m.clear(); records.forEach(r => this._add(r)) }
  _add(r) {
    this._tok(this._flat(r)).forEach(tok => {
      for (let i = 1; i <= tok.length; i++) {
        const p = tok.slice(0, i);
        if (!this._m.has(p)) this._m.set(p, new Set());
        this._m.get(p).add(r.id);
      }
    });
  }
  add(r) { this._add(r) }
  remove(id) { this._m.forEach(s => s.delete(id)) }
  search(q, records) {
    if (!q) return records;
    const terms = this._tok(q);
    if (!terms.length) return records;
    let ids = null;
    for (const t of terms) {
      const s = this._m.get(t) || new Set();
      ids = ids ? new Set([...ids].filter(x => s.has(x))) : new Set(s);
    }
    if (!ids || !ids.size) return [];
    return records.filter(r => ids.has(r.id));
  }
}
const IDX = { patients: new SearchIndex(), staff: new SearchIndex(), bills: new SearchIndex() };

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function n2w(n) {
  n = Math.round(Number(n) || 0);
  if (!n) return 'Zero Only'; if (n < 0) return 'Minus ' + n2w(-n);
  const O = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const T = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const D = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const b2 = x => x < 10 ? O[x] : x < 20 ? T[x - 10] : D[~~(x / 10)] + (x % 10 ? ' ' + O[x % 10] : '');
  let r = '';
  const cr = ~~(n / 1e7), la = ~~(n % 1e7 / 1e5), th = ~~(n % 1e5 / 1e3), hu = ~~(n % 1e3 / 1e2), re = n % 1e2;
  if (cr) r += b2(cr) + ' Crore '; if (la) r += b2(la) + ' Lakh ';
  if (th) r += b2(th) + ' Thousand '; if (hu) r += O[hu] + ' Hundred ';
  if (re >= 20) r += D[~~(re / 10)] + (re % 10 ? ' ' + O[re % 10] : '');
  else if (re >= 10) r += T[re - 10]; else if (re > 0) r += O[re];
  return r.trim() + ' Only';
}
const safe = v => (v == null) ? '' : String(v);
const esc = v => safe(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const todayStr = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDate = d => { if (!d) return ''; const p = d.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d };
// Full date + time from an ISO string, e.g. "03/07/2026, 11:44 AM".
const fmtDateTime = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  let h = d.getHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}, ${p(h)}:${p(d.getMinutes())} ${ap}`;
};
// Accept dd/mm/yyyy OR yyyy-mm-dd and always return yyyy-mm-dd (needed to
// re-populate <input type=date> after pulling dd/mm/yyyy values from sheets).
function toYmd(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}
const calcDays = (s, e) => { if (!s || !e) return 0; const ms = new Date(e) - new Date(s); return ms < 0 ? 0 : Math.round(ms / 864e5) + 1 };
const byDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
// Ascending by numeric id (1,2,3…); non-numeric ids sort last, tie-broken by
// creation time. Used to give the dashboard list tabs a clean 1,2,3 sequence.
const byIdAsc = (a, b) => {
  const na = /^\d+$/.test(String(a.id)) ? parseInt(a.id, 10) : Infinity;
  const nb = /^\d+$/.test(String(b.id)) ? parseInt(b.id, 10) : Infinity;
  if (na !== nb) return na - nb;
  return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
};
// ══════════════════════════════════════════════════════════
// CENTRES — single source of truth for every centre-specific
// value (bill header, address, sheet name, prefix, badge colors).
// Add a new centre here and it shows up everywhere automatically.
// ══════════════════════════════════════════════════════════
const CENTERS = {
  MANAV_SEVA: {
    key: 'MANAV_SEVA', label: 'Manav Seva Kalyan', badge: 'MSK',
    title: 'MANAV SEVA KALYAN', sub: 'CARE CENTRE',
    addr: 'BMC MARKET OFFICE NO. 21, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056',
    sheet: 'Manav Seva Kalyan Bill', prefix: 'MSK',
    color: '#7c3aed', bg: '#ede9fe',
    // Watermark logo printed on this centre's bill (Patient Name → before
    // Total in Words). Swap this data-URI for another to change the logo.
    logo: 'data:image/webp;base64,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'
  },
  PATIENT_CARE: {
    key: 'PATIENT_CARE', label: 'Patient Care Centre', badge: 'PCC',
    title: 'PATIENT CARE CENTRE', sub: '',
    addr: 'BMC MARKET OFFICE NO. 22, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056',
    sheet: 'Patient Care Centre Bill', prefix: 'PCC',
    color: '#0d9488', bg: '#ccfbf1',
    logo: 'data:image/webp;base64,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'
  },
  // Third centre — shares Office No. 22 with Patient Care Centre.
  // Manav Seva Kalyan remains Office No. 21.
  MANAV_SEVA_CARE: {
    key: 'MANAV_SEVA_CARE', label: 'Manav Seva Care Centre', badge: 'MSC',
    title: 'MANAV SEVA CARE CENTRE', sub: '',
    addr: 'BMC MARKET OFFICE NO. 22, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056',
    sheet: 'Manav Seva Care Centre Bill', prefix: 'MSC',
    color: '#dc2626', bg: '#fee2e2',
    logo: 'data:image/webp;base64,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'
  }
};
const centerOf = c => CENTERS[c] || CENTERS.MANAV_SEVA;
// Bill numbers are derived from existing records (not a separate persisted
// counter), so MSK-0001 / PCC-0001 are always the true next number for that
// prefix — starts at 1 and stays correct even after deletions or a fresh backend.
function nextBillNo(pfx, bills) {
  let max = 0;
  (bills || []).forEach(b => {
    if (b.billNo && b.billNo.indexOf(pfx + '-') === 0) {
      const n = parseInt(b.billNo.slice(pfx.length + 1), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  });
  return `${pfx}-${String(max + 1).padStart(4, '0')}`;
}
// Sequential numeric IDs per store (1, 2, 3…) so the spreadsheet's ID column
// always starts at 1 and increments — independent of deletions/timestamps.
function nextSeqId(records) {
  let max = 0;
  (records || []).forEach(r => {
    const id = String(r.id);
    if (/^\d+$/.test(id)) {
      const n = parseInt(id, 10);
      // ignore leftover giant/random numeric ids so numbering restarts small
      if (n <= 1000000 && n > max) max = n;
    }
  });
  return max + 1;
}
// Globally-unique record id. Sequential per-device numbering (nextSeqId)
// meant two devices both minted "1", "2", "3"… so a record made on the
// phone and a different one made on the laptop shared an id — and sync
// then skipped whichever one the device thought it "already had". A random
// id can't collide across devices, which is what actually lets records
// flow both ways. Compact + string.
function newRecordId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Identify a file's kind from its MIME type / filename for display badges.
function fileKind(f) {
  if (!f) return 'file';
  const type = (typeof f === 'string') ? (f.match(/^data:([^;]+);/) || [, ''])[1] : (f.type || '');
  const name = (typeof f === 'string') ? '' : (f.name || '');
  if (/^image\//.test(type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(name)) return 'image';
  if (/pdf/i.test(type) || /\.pdf$/i.test(name)) return 'pdf';
  if (/word|msword|officedocument/i.test(type) || /\.docx?$/i.test(name)) return 'doc';
  return 'file';
}
const FILE_KIND_META = {
  image: { icon: '🖼️', label: 'IMG', bg: '#eff6ff', fg: '#2563eb' },
  pdf: { icon: '📕', label: 'PDF', bg: '#fef2f2', fg: '#dc2626' },
  doc: { icon: '📝', label: 'DOC', bg: '#eef2ff', fg: '#4338ca' },
  file: { icon: '📎', label: 'FILE', bg: '#f1f5f9', fg: '#475569' }
};
function fileChip(f, onclick, name) {
  const kind = fileKind(f);
  const meta = FILE_KIND_META[kind];
  const label = esc(name || (typeof f === 'object' && f.name) || 'File');
  return `<button onclick="${esc(onclick)}" class="fbtn text-sm" style="background:${meta.bg};color:${meta.fg};border:1px solid ${meta.fg}33;gap:6px">
    <span>${meta.icon}</span><span style="font-weight:800;font-size:.65rem;letter-spacing:.03em">${meta.label}</span><span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
  </button>`;
}

// Renders one or more "Open in Drive" buttons for a record pulled from
// another device — where the raw file bytes aren't local but the Google
// Drive link(s) are. Accepts a single URL or several joined by commas.
// Returns '' when there's no usable https link.
// Extracts the file ID out of common Google Drive share-link formats
// (".../d/FILE_ID/...", "...?id=FILE_ID...", "...open?id=FILE_ID") and turns
// it into a URL that renders as an actual <img>, instead of only being
// usable as a click-through link. Returns '' if no ID can be found.
function driveThumbUrl(raw) {
  if (!raw) return '';
  const url = String(raw).split(/\s*,\s*/)[0].trim();
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (!m) return '';
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200`;
}
// A small round photo, given either a local (base64) photo, a Drive share
// link, or neither. Falls back to the 👤 placeholder icon only when there's
// truly no photo to show — including if a linked Drive image fails to load
// (broken/private link), via the onerror swap.
function staffAvatar(s, sizeClass, emojiSizeClass) {
  emojiSizeClass = emojiSizeClass || 'text-xs';
  if (s.photo) return `<img src="${s.photo}" class="${sizeClass} rounded-full object-cover flex-shrink-0 border border-green-200">`;
  const thumb = driveThumbUrl(s.photoLink);
  if (thumb) {
    return `<img src="${thumb}" class="${sizeClass} rounded-full object-cover flex-shrink-0 border border-green-200" onerror="this.replaceWith(Object.assign(document.createElement('a'),{href:'${esc(String(s.photoLink).split(/\s*,\s*/)[0])}',target:'_blank',rel:'noopener',className:'${sizeClass} rounded-full bg-green-50 flex items-center justify-center flex-shrink-0 ${emojiSizeClass} border border-green-200',innerHTML:'👤',title:'Open photo in Google Drive'}))">`;
  }
  return `<div class="${sizeClass} rounded-full bg-green-50 flex items-center justify-center flex-shrink-0 text-green-600 ${emojiSizeClass}">👤</div>`;
}

function driveLinkBtns(raw, label) {
  if (!raw) return '';
  const urls = String(raw).split(/\s*,\s*/).map(u => u.trim()).filter(u => /^https?:\/\//.test(u));
  if (!urls.length) return '';
  return urls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener" class="fbtn text-xs" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;text-decoration:none;gap:5px;display:inline-flex;align-items:center;margin:2px 4px 2px 0">🔗 ${esc(label)}${urls.length > 1 ? ' ' + (i + 1) : ''} — Open in Drive</a>`).join('');
}
let _rfPending = false;
const schedRender = () => { if (_rfPending) return; _rfPending = true; requestAnimationFrame(() => { _rfPending = false; APP && APP.render() }) };

/* ══════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════ */
function toast(msg, type = 'info', dur = 3200) {
  const w = document.getElementById('toast-wrap'); if (!w) return;
  const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg; w.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350) }, dur);
}

/* ══════════════════════════════════════════════════════════
   DIALOG — styled card/modal replacement for window.prompt()
══════════════════════════════════════════════════════════ */
function askCopies() {
  return new Promise((resolve) => {
    const ov = document.getElementById('dlg-overlay');
    ov.innerHTML = `
<div id="dlg-card">
  <h3>Print Copies</h3>
  <p>How many copies do you want to print? (2 bills fit on each A4 sheet)</p>
  <input id="dlg-input" type="number" min="1" max="20" value="1" inputmode="numeric">
  <div id="dlg-actions">
    <button class="dlg-btn cancel" id="dlg-cancel">Cancel</button>
    <button class="dlg-btn ok" id="dlg-ok">OK</button>
  </div>
</div>`;
    ov.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    const inp = document.getElementById('dlg-input');
    inp.focus(); inp.select();

    const close = (val) => {
      ov.classList.remove('show');
      setTimeout(() => { ov.style.display = 'none'; ov.innerHTML = ''; }, 180);
      resolve(val);
    };
    document.getElementById('dlg-ok').onclick = () => {
      let n = parseInt(inp.value, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 20) n = 20;
      close(n);
    };
    document.getElementById('dlg-cancel').onclick = () => close(null);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('dlg-ok').click();
      if (e.key === 'Escape') document.getElementById('dlg-cancel').click();
    });
    ov.addEventListener('click', (e) => { if (e.target === ov) document.getElementById('dlg-cancel').click(); }, { once: true });
  });
}

/* ══════════════════════════════════════════════════════════
   DOCUMENT VIEWER DIALOG
   — Shows images inline, PDFs in an embedded frame,
   — and offers a download for Word docs / anything else.
══════════════════════════════════════════════════════════ */
function viewDoc(doc, title) {
  if (!doc) return;
  const isStr = typeof doc === 'string';
  const data = isStr ? doc : doc.data;
  const name = isStr ? '' : (doc.name || '');
  const type = isStr ? (data.match(/^data:([^;]+);/) || [, ''])[1] : (doc.type || (data.match(/^data:([^;]+);/) || [, ''])[1]);
  const isImg = /^image\//.test(type);
  const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(name);
  let body;
  if (isImg) {
    body = `<img src="${data}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:10px">`;
  } else if (isPdf) {
    body = `<iframe src="${data}" style="width:100%;height:70vh;border:1px solid #e2e8f0;border-radius:10px"></iframe>`;
  } else {
    body = `<div style="text-align:center;padding:2.5rem 1rem">
      <div style="font-size:3rem;margin-bottom:.5rem">📄</div>
      <p style="font-weight:700;margin-bottom:1rem">${esc(name || 'Document')}</p>
      <p style="color:#94a3b8;font-size:.85rem;margin-bottom:1rem">Preview isn't available for this file type — download it instead.</p>
      <a href="${data}" download="${esc(name || 'document')}" class="fbtn fbtn-green" style="display:inline-flex">⬇ Download</a>
    </div>`;
  }
  const ov = document.getElementById('dlg-overlay');
  ov.innerHTML = `
<div id="dlg-card" style="max-width:560px;width:92vw">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.8rem">
    <h3 style="margin:0">${esc(title || name || 'Document')}</h3>
    <button id="dlg-close-x" style="border:none;background:#f1f5f9;width:28px;height:28px;border-radius:50%;cursor:pointer;font-weight:700;color:#64748b">✕</button>
  </div>
  ${body}
  ${(!isImg && !isPdf) ? '' : `<div style="text-align:right;margin-top:1rem"><a href="${data}" download="${esc(name || title || 'document')}" class="fbtn" style="background:#f1f5f9;color:#374151;display:inline-flex">⬇ Download</a></div>`}
</div>`;
  ov.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
  const close = () => {
    ov.classList.remove('show');
    setTimeout(() => { ov.style.display = 'none'; ov.innerHTML = ''; }, 180);
  };
  document.getElementById('dlg-close-x').onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); }, { once: true });
  function kHandler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', kHandler); } }
  document.addEventListener('keydown', kHandler);
}

/* ══════════════════════════════════════════════════════════
   CONFIRM DELETE DIALOG
══════════════════════════════════════════════════════════ */
function confirmDelete(name, type) {
  return new Promise((resolve) => {
    const ov = document.getElementById('dlg-overlay');
    ov.innerHTML = `
<div id="dlg-card">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:.6rem">
    <span style="width:36px;height:36px;border-radius:50%;background:#fef2f2;display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
    </span>
    <h3 style="margin:0">Delete ${type}?</h3>
  </div>
  <p style="margin:0 0 1.1rem;padding-left:46px">
    <b>${name}</b> will be permanently removed from the app and Google Sheets. This cannot be undone.
  </p>
  <div id="dlg-actions">
    <button class="dlg-btn cancel" id="dlg-cancel">Cancel</button>
    <button class="dlg-btn ok" id="dlg-ok" style="background:#dc2626">Delete</button>
  </div>
</div>`;
    ov.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    const close = (val) => {
      ov.classList.remove('show');
      setTimeout(() => { ov.style.display = 'none'; ov.innerHTML = ''; }, 180);
      resolve(val);
    };
    document.getElementById('dlg-ok').onclick = () => close(true);
    document.getElementById('dlg-cancel').onclick = () => close(false);
    function kHandler(e) {
      if (e.key === 'Enter') { close(true); document.removeEventListener('keydown', kHandler); }
      if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', kHandler); }
    }
    document.addEventListener('keydown', kHandler);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(false); }, { once: true });
  });
}

// Shared token so a lingering close-animation from one dialog can't wipe the next.
let _dlgSeq = 0;
// Simple date-picker dialog -> resolves yyyy-mm-dd or null (cancel).
function askDate(title, msg, defaultYmd) {
  return new Promise((resolve) => {
    const ov = document.getElementById('dlg-overlay');
    ov.innerHTML = `
<div id="dlg-card">
  <h3>${title}</h3>
  <p>${msg}</p>
  <input id="dlg-date" type="date" value="${defaultYmd || ''}" style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:1rem;font-weight:700;outline:none;margin-bottom:1.1rem">
  <div id="dlg-actions">
    <button class="dlg-btn cancel" id="dlg-cancel">Cancel</button>
    <button class="dlg-btn ok" id="dlg-ok">OK</button>
  </div>
</div>`;
    ov.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    const myTok = ++_dlgSeq;
    const close = (val) => { ov.classList.remove('show'); setTimeout(() => { if (_dlgSeq === myTok) { ov.style.display = 'none'; ov.innerHTML = ''; } }, 180); resolve(val); };
    document.getElementById('dlg-ok').onclick = () => { const v = document.getElementById('dlg-date').value; close(v || null); };
    document.getElementById('dlg-cancel').onclick = () => close(null);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); }, { once: true });
  });
}

// Multi-choice dialog -> resolves the chosen option key or null (cancel).
function askChoice(title, msg, options) {
  return new Promise((resolve) => {
    const ov = document.getElementById('dlg-overlay');
    ov.innerHTML = `
<div id="dlg-card">
  <h3>${title}</h3>
  <p>${msg}</p>
  <div id="dlg-actions" style="flex-direction:column;gap:.5rem">
    ${options.map(o => `<button class="dlg-btn ok" data-k="${o.key}" style="width:100%;background:${o.color || '#7c3aed'}">${o.label}</button>`).join('')}
    <button class="dlg-btn cancel" id="dlg-cancel" style="width:100%">Cancel</button>
  </div>
</div>`;
    ov.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
    const myTok = ++_dlgSeq;
    const close = (val) => { ov.classList.remove('show'); setTimeout(() => { if (_dlgSeq === myTok) { ov.style.display = 'none'; ov.innerHTML = ''; } }, 180); resolve(val); };
    ov.querySelectorAll('[data-k]').forEach(b => b.onclick = () => close(b.getAttribute('data-k')));
    document.getElementById('dlg-cancel').onclick = () => close(null);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); }, { once: true });
  });
}

/* ══════════════════════════════════════════════════════════
   GOOGLE SHEETS SYNC
   — Persistent offline queue, 3-retry with exponential backoff
   — Uses text/plain to bypass CORS preflight (GAS limitation)
══════════════════════════════════════════════════════════ */
const Q_KEY = 'hbm_q3'; // legacy localStorage key — migrated once, then unused
let _draining = false;

async function qAll() {
  await openDB();
  return new Promise((res, rej) => { const q = _tx('syncQueue').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) });
}
async function qPush(item) {
  await openDB();
  return new Promise((res, rej) => { const q = _tx('syncQueue', 'readwrite').add(item); q.onsuccess = () => res(); q.onerror = () => rej(q.error) });
}
async function qDelete(qid) {
  await openDB();
  return new Promise((res, rej) => { const q = _tx('syncQueue', 'readwrite').delete(qid); q.onsuccess = () => res(); q.onerror = () => rej(q.error) });
}

// One-time move of any items stuck in the old localStorage queue (from
// before this fix) into the new IndexedDB queue, then clears the old
// key so it's never read again. Safe to call every load — it's a
// no-op once the old key is gone.
async function migrateLegacyQueue_() {
  let raw;
  try { raw = localStorage.getItem(Q_KEY) } catch { return }
  if (!raw) return;
  try {
    const old = JSON.parse(raw);
    if (Array.isArray(old)) {
      for (const item of old) { try { await qPush(item) } catch (e) { console.warn('Legacy queue item migration failed', e) } }
    }
  } catch (e) {
    console.warn('Legacy queue parse failed — discarding', e);
  }
  try { localStorage.removeItem(Q_KEY) } catch { }
}

async function enq(payload) {
  try {
    await qPush({ secret: GAS_SECRET, ...payload, _ts: Date.now() });
  } catch (e) {
    // IndexedDB has a much larger quota than localStorage ever did, so
    // this should be rare — but if it ever happens, surface it instead
    // of silently dropping the sync like the old localStorage version did.
    console.warn('Queue save failed', e);
    toast('Could not queue this change for sync — device storage is full', 'error', 6000);
    if (APP) { APP.syncStatus = 'err'; schedRender() }
    return;
  }
  await refreshPendingCount_();
  if (APP) { APP.syncStatus = 'syncing'; schedRender() }
  if (!_draining) drainQueue();
}

// render() is synchronous and runs constantly, but the queue now lives
// in IndexedDB (async) — so we keep a small cached count here, kept in
// sync right after every push/delete, instead of render() reading the
// queue directly.
let _qPendingCount = 0;
async function refreshPendingCount_() {
  try { _qPendingCount = (await qAll()).length } catch (e) { console.warn('Pending count refresh failed', e) }
}

async function _post(p) {
  const r = await fetch(GAS_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(p)
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt) } catch { throw new Error('Non-JSON GAS response. Check deployment & "Anyone" access. Preview: ' + txt.slice(0, 100)) }
  if (j && j.ok === false) throw new Error(j.error || 'GAS returned ok:false');
  return j;
}

async function drainQueue() {
  if (_draining || !navigator.onLine) return;
  _draining = true;
  let q;
  try { q = await qAll() } catch (e) { console.warn('Queue read failed', e); _draining = false; return }
  if (!q.length) { _draining = false; return }
  let anyFailed = false;
  for (const item of q) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try { await _post(item); ok = true }
      catch (e) { if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt)); else console.warn('[GAS]', e.message) }
    }
    if (ok) {
      // Remove the instant it succeeds — one huge item can't block the rest.
      try { await qDelete(item.qid) } catch (e) { console.warn('Queue cleanup failed', e) }
    } else if (item.action === 'delete') {
      // A delete that keeps failing almost always means the row is already
      // gone from the sheet (deleted from another device / earlier). The end
      // state is identical, so drop it instead of retrying it forever — this
      // is what clears a stuck "Sync failed / N pending".
      try { await qDelete(item.qid) } catch (e) { }
      console.warn('[GAS] dropped un-syncable delete for', item.sheetName, (item.data || {}).ID);
    } else {
      // Keep appends/updates queued on failure so no data is ever lost.
      anyFailed = true;
    }
  }
  await refreshPendingCount_();
  _draining = false;
  if (APP) {
    APP.syncStatus = anyFailed ? 'err' : 'ok';
    if (anyFailed) toast(`Some item(s) queued for retry — data safe locally`, 'warn', 5000);
    else toast('Synced to Google Sheets ✓', 'success', 2000);
    schedRender();
    if (anyFailed) setTimeout(drainQueue, 20000);
  }
}
const syncPat = (p, act) => enq({
  action: act, sheetName: 'Patient Details', data: {
    ID: p.id,
    Name: p.name,
    Address: p.address || '',
    Mobile: p.mobile,
    Date: todayStr(),
    // Base64 data URL — the Apps Script backend decodes this and
    // embeds it directly into the sheet cell as an image, no
    // Google Drive connection needed.
    Photo: p.photo || ''
  }
});

// changed = { photo, aadhar, pan, doc } booleans, telling us which file
// fields the user actually re-picked in THIS session (see markChanged).
// On a brand-new record we always send every file. On an EDIT we only
// send a file field if it was changed here — otherwise we omit the key
// entirely so the payload stays tiny (instant sync) and the backend
// leaves the already-saved Drive file + its <field>Link hyperlink
// exactly as they are, instead of re-uploading and creating a duplicate
// Drive file every time you edit unrelated details.
const syncStaff = (s, act, changed) => {
  changed = changed || {};
  const isNew = act === 'append';
  const data = {
    ID: s.id,
    Name: s.name,
    Nickname: s.nickname || '',
    Mobile: s.mobile,
    Type: s.type,
    AADHAR: s.aadhar || '',
    PAN: s.pan || '',
    Rate: s.rate || '',
    StartDate: fmtDate(s.startDate || ''),
    Date: todayStr()
  };
  // Base64 data URL(s). The Apps Script backend decodes each one, saves
  // it to Google Drive, writes "Yes"/"No" in the main column and a
  // working "Open in Drive" link in the matching <field>Link column.
  if (isNew || changed.photo) {
    data.Photo = s.photo || '';
  }
  // Every Aadhar/PAN file is sent as an ARRAY so the backend saves each
  // one to Drive individually and links every single one.
  if (isNew || changed.aadhar) {
    data.AadharPhoto = (s.saadharPhotos || []).map(f => f.data);
    data.AadharPhotoNames = (s.saadharPhotos || []).map(f => f.name).join(', ');
  }
  if (isNew || changed.pan) {
    data.PanPhoto = (s.panPhotos || []).map(f => f.data);
    data.PanPhotoNames = (s.panPhotos || []).map(f => f.name).join(', ');
  }
  if (isNew || changed.doc) {
    data.AdditionalDocName = (s.additionalDoc && s.additionalDoc.name) || '';
    data.AdditionalDoc = (s.additionalDoc && s.additionalDoc.data) || (typeof s.additionalDoc === 'string' ? s.additionalDoc : '');
  }
  return enq({ action: act, sheetName: 'Staff Details', data });
};

const syncDel = (sheet, key, val) => enq({ action: 'delete', sheetName: sheet, data: { [key]: val } });

// Online payment record -> "Online Details" sheet. Company / Online are
// stored already-resolved (the custom text when "Others" / "Other App" was
// picked), so the sheet is human-readable.
const syncOnline = (o, act) => enq({
  action: act, sheetName: 'Online Details', data: {
    ID: o.id,
    Date: fmtDate(o.date),
    Company: o.company || '',
    Bank: o.bank || '',
    Amount: o.amount || '',
    Online: o.onlineApp || '',
    PaymentDetails: o.paymentDetails || ''
  }
});

// Worker duty record -> "Worker Details" sheet.
const syncWorker = (w, act) => enq({
  action: act, sheetName: 'Worker Details', data: {
    ID: w.id,
    StaffName: w.staffName || '',
    DutyDate: fmtDate(w.dutyDate),
    StaffMobile: w.staffMobile || '',
    PartyMobile: w.partyMobile || '',
    PartyAddress: w.partyAddress || '',
    Status: w.status === 'off' ? 'Off Duty' : (w.status === 'on' ? 'On Duty' : ''),
    History: JSON.stringify(w.history || [])
  }
});

function syncBill(b) {
  const sheet = centerOf(b.center).sheet;
  (b.lines || []).forEach((l, i) => enq({
    action: 'append', sheetName: sheet, data: {
      ID: b.serial,
      BillNo: b.billNo,
      Date: b.date,
      Patient: b.patientName,
      Staff: b.staffName,
      StaffType: b.staffType || '',
      SNo: l.no || '',
      Duty: l.duty || '',
      Shift: l.shift || '',
      StartDate: fmtDate(l.startDate || ''),
      EndDate: fmtDate(l.endDate || ''),
      Days: l.days || '',
      Rate: l.rate || '',
      Amount: l.amount || '',
      Total: i === 0 ? b.totalAmount : '',
      Words: i === 0 ? b.amountInWords : '',
      Printed: i === 0 ? (b.printCount || 0) : '',
      CreatedAt: i === 0 ? (b.createdAt || '') : '',
      PrintedAt: i === 0 ? (b.printedAt || '') : ''
    }
  }));
}

/* ══════════════════════════════════════════════════════════
   PRINT  — Single bill, exact size.
   User is asked via prompt() how many copies (1-4) to print on the page.
══════════════════════════════════════════════════════════ */
function buildBillHTML(bill) {
  const c = centerOf(bill.center);
  const cTitle = c.title;
  const cSub = c.sub;
  const addr = c.addr;
  const total = Number(bill.totalAmount) || 0;
  const words = bill.amountInWords || n2w(total);
  const foot = c.title;
  const rows = (bill.lines || []).map(l => `
  <tr>
    <td class="c">${safe(l.no)}</td>
    <td>${esc(l.duty)} — ${esc(l.shift)}</td>
    <td class="c">${fmtDate(l.startDate || '')}</td>
    <td class="c">${fmtDate(l.endDate || '')}</td>
    <td class="c">${safe(l.days)}</td>
    <td class="r">&#8377;${Number(l.rate || 0).toLocaleString('en-IN')}</td>
    <td class="r">&#8377;${Number(l.amount || 0).toLocaleString('en-IN')}</td>
  </tr>`).join('');
  return `<div class="bill-box">
  <div class="bh">
    <h1>${cTitle}</h1>
    ${cSub ? `<h2>${cSub}</h2>` : ''}
    <p class="addr">${addr}</p>
  </div>
  <div class="b-meta"> 
    <span>Bill No :- <span class="b-billno-blank"></span></span>
    <span>Date: <b>${todayStr()}</b></span>
  </div>
  <div class="b-watermark-wrap">
    <div class="b-watermark" style="background-image:url('${c.logo || ''}')"></div>
    <div class="b-pinfo">
      <p><b>Patient Name:</b> ${esc(bill.patientName)}</p>
      <p><b>WB / AB / Nurse:</b> ${esc(bill.staffName)} (${esc(bill.staffType)})</p>
    </div>
    <table class="b-tbl">
      <thead>
        <tr><th>S.No.</th><th>PARTICULARS</th><th>FROM</th><th>TO</th><th>DAYS</th><th>RATE</th><th>AMOUNT</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
  <div class="b-total-row">
    <div class="words"><b>Total (In Words):</b> ${esc(words)}</div>
    <div class="amt">TOTAL: &#8377;${total.toLocaleString('en-IN')}</div>
  </div>
  <div class="b-foot">
    <div class="b-eoe">E. &amp; O.E.</div>
    <div class="b-sig-i">
      <div class="b-sig-space"></div>
      <div class="b-sig-line">Authorised Signature</div>
      <div class="b-sig-co">${foot}</div>
    </div>
  </div>
</div>`;
}
// Waits until the browser has actually laid out & painted whatever was just
// written into #print-sheet before we call window.print().
//
// Why this exists: the old code (double rAF + a flat 60ms setTimeout) left a
// window where the browser hadn't committed a layout/paint pass for the
// freshly-injected content yet. On desktop that showed up as a blank print
// preview that only "woke up" after clicking something else on the page
// (because the click forced a reflow/repaint the browser had been deferring).
// On mobile "Save as PDF" — which has no such correcting user interaction
// available — that deferred paint never happened before the PDF snapshot was
// taken, so the saved file came out blank.
//
// Fix: force a *synchronous* reflow ourselves (reading offsetHeight makes the
// browser compute layout immediately, it can't defer it), wait for web fonts
// to finish loading (a print pass started mid-font-swap can also render
// blank/empty text on some mobile browsers), then still do the double-rAF +
// a longer delay as a safety margin for slower mobile devices.
async function waitForPrintReady(el) {
  void el.offsetHeight; // force synchronous layout
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (err) { /* ignore */ }
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise(resolve => setTimeout(resolve, 250));
  void el.offsetHeight; // reflow again right before printing
}

async function doPrint(bills) {
  // Ask the user how many copies of THIS page (all bills passed in) to print
  const n = await askCopies();
  if (n === null) return; // user cancelled

  // Build one box per copy, then chunk into groups of 4 (2x2 grid = one A4 page)
  const boxesArr = [];
  for (let c = 0; c < n; c++) boxesArr.push(bills.map(b => buildBillHTML(b)).join(''));

  const pages = [];
  // Two bills per A4 sheet (stacked). Change 2 -> 4 here (and the CSS grid) for 4-up.
  for (let i = 0; i < boxesArr.length; i += 2) pages.push(boxesArr.slice(i, i + 2));

  const sheet = document.getElementById('print-sheet');
  sheet.innerHTML = pages.map(p => `<div class="p-page">${p.join('')}</div>`).join('');
  // NOTE: #print-sheet must only ever become visible via the "@media print"
  // rule in style.css — never by forcing an inline style here. Inline
  // `display:block` applies on the normal screen too, not just while
  // printing, so if the cleanup below was ever late or skipped (common on
  // mobile "Save as PDF"), the printed table stayed stuck on the dashboard.
  // The @media print rule toggles this correctly and instantly at print
  // time, no JS needed.
  // IMPORTANT: do NOT clear the print sheet's *content* on a timer or on
  // 'afterprint'. On mobile, window.print() returns immediately and the
  // "Save as PDF" step happens asynchronously afterwards — clearing the
  // content then wiped the bill before it was captured, producing blank
  // pages. The sheet is display:none normally (CSS-driven) and is simply
  // overwritten on the next print, so leaving the content in place is
  // harmless and guarantees it's present while the PDF is generated.
  // Double requestAnimationFrame waits for a full paint before printing so
  // the freshly-injected content is laid out first.
  await waitForPrintReady(sheet);
  try {
    window.print();
  } catch (err) {
    toast('Print failed to open — check your browser\'s print/popup settings', 'error');
  }
  // Only NOW (the copies dialog was confirmed and the print flow has run) do
  // we count these bills as printed — cancelling the copies dialog above
  // returns early and never reaches here, so nothing is marked.
  if (window.APP && Array.isArray(bills)) {
    bills.forEach(b => APP._markBillPrinted(b));
    APP.render();
  }
}


// Print an arbitrary list of records as a clean, spreadsheet-style table
// (portrait A4). Used by the Print button on the list tabs.
async function doPrintList(title, columns, rows, metaText) {
  const ps = document.getElementById('print-sheet');
  if (!ps) { toast('Print area not found — please reload and try again', 'error'); return; }
  if (!rows || !rows.length) { toast('No records to print', 'warn'); return; }
  const esc2 = v => String(v == null ? '' : v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const thead = '<th class="pl-no">#</th>' + columns.map(c => `<th>${esc2(c[0])}</th>`).join('');
  const tbody = rows.map((r, i) => {
    const tds = columns.map(c => {
      const v = typeof c[1] === 'function' ? c[1](r) : r[c[1]];
      return `<td>${esc2(v)}</td>`;
    }).join('');
    return `<tr><td class="pl-no">${i + 1}</td>${tds}</tr>`;
  }).join('');
  // Portrait A4 gives ~190mm of usable width after margins. That's plenty
  // for a handful of columns (e.g. Patients: 5), but tables with lots of
  // columns (Staff/Worker/Online: 7-9) get cramped at the default size —
  // so the table shrinks itself a bit as columns increase, rather than
  // letting the last column's text/border get squeezed against the edge.
  const nCols = columns.length + 1; // +1 for the # column
  const compactCls = nCols >= 8 ? ' pl-compact-2' : (nCols >= 6 ? ' pl-compact-1' : '');
  ps.innerHTML = `
<div class="print-list${compactCls}">
  <h2>${esc2(title)}</h2>
  <div class="meta">${esc2(metaText)}</div>
  <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
</div>`;
  // Lists print in portrait; inject a temporary @page rule. This is scoped
  // inside "@media print" so it (and the #print-sheet visibility it used to
  // force unconditionally) only ever applies while actually printing — never
  // on the normal dashboard screen. #print-sheet's visibility itself is
  // already handled by the permanent "@media print" rule in style.css, so it
  // doesn't need to be repeated/forced here at all.
  let st = document.getElementById('print-page-style');
  if (!st) { st = document.createElement('style'); st.id = 'print-page-style'; document.head.appendChild(st); }
  st.textContent = '@media print { @page { size: A4 portrait; margin: 10mm } }';
  // Wait for a full paint before printing (same as the bill printer). Do NOT
  // clear the content on afterprint — that blanks the page on mobile. We only
  // remove the injected portrait override afterwards so bills' own @page rule applies again.
  await waitForPrintReady(ps);
  try {
    window.print();
  } catch (err) {
    toast('Print failed to open — check your browser\'s print/popup settings', 'error');
  }
  const removePage = () => {
    const e = document.getElementById('print-page-style');
    if (e && e.parentNode) e.parentNode.removeChild(e);
    window.removeEventListener('afterprint', removePage);
  };
  window.addEventListener('afterprint', removePage);
  setTimeout(removePage, 60000);
}


/* ══════════════════════════════════════════════════════════
   SVG ICONS
══════════════════════════════════════════════════════════ */
const I = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h5a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM13 5a1 1 0 011-1h5a1 1 0 011 1v3a1 1 0 01-1 1h-5a1 1 0 01-1-1V5zM13 13a1 1 0 011-1h5a1 1 0 011 1v6a1 1 0 01-1 1h-5a1 1 0 01-1-1v-6zM4 15a1 1 0 011-1h5a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4z"/></svg>`,
  patients: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
  staff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`,
  online: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path stroke-linecap="round" d="M2 10h20"/></svg>`,
  worker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V8a2 2 0 00-2-2h-4M10 6V4a2 2 0 012-2 2 2 0 012 2v2M10 6h4"/></svg>`,
  bills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  sheets: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M3 14h18M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>`,
  print: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"/></svg>`,
};
const ico = (k, cls = 'w-4 h-4') => `<span class="${cls}" style="display:inline-flex;align-items:center;justify-content:center">${I[k]}</span>`;

/* ══════════════════════════════════════════════════════════
   PULL FROM SERVER  — makes the app truly multi-device.
   The app is offline-first and normally only PUSHES local changes up to
   Google Sheets. On a brand-new device/browser the local database is
   empty, which is exactly why a freshly-opened laptop showed "0 records".
   pullFromServer() uses the backend 'list' action to read every sheet and
   MERGES anything this device is missing into local storage. It only ADDS
   records whose ID isn't already present locally, so it can never clobber
   a local edit that hasn't synced up yet.
   Note: photos/scans live in Google Drive, not in the sheet, so pulled
   staff records carry the Drive links (…Link) but not the raw image bytes
   — the text data and bills come down in full.
══════════════════════════════════════════════════════════ */
const PULL_FALLBACK_DATE_ = '2000-01-01T00:00:00.000Z';

function parseDMY_(v) {
  if (!v) return '';
  const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return '';
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return isNaN(dt.getTime()) ? '' : dt.toISOString();
}

function mapPatientRow_(r) {
  return {
    id: String(r.ID || '').trim(),
    name: r.Name || '',
    address: r.Address || '',
    mobile: r.Mobile || '',
    photo: '',
    createdAt: parseDMY_(r.Date) || PULL_FALLBACK_DATE_
  };
}

function mapOnlineRow_(r) {
  return {
    id: String(r.ID || '').trim(),
    date: toYmd(r.Date),
    company: r.Company || '',
    bank: r.Bank || '',
    amount: r.Amount || '',
    onlineApp: r.Online || '',
    paymentDetails: r.PaymentDetails || '',
    createdAt: parseDMY_(r.Date) || PULL_FALLBACK_DATE_
  };
}

function mapWorkerRow_(r) {
  const ymd = toYmd(r.DutyDate);
  let created = PULL_FALLBACK_DATE_;
  if (ymd) { const dt = new Date(ymd); if (!isNaN(dt.getTime())) created = dt.toISOString(); }
  return {
    id: String(r.ID || '').trim(),
    staffName: r.StaffName || '',
    dutyDate: ymd,
    staffMobile: r.StaffMobile || '',
    partyMobile: r.PartyMobile || '',
    partyAddress: r.PartyAddress || '',
    status: (() => {
      const s = String(r.Status || '').toLowerCase();
      if (s.includes('off')) return 'off';
      if (s.includes('on')) return 'on';
      return ''; // blank in the sheet → status left unset (optional)
    })(),
    history: (() => { try { const h = JSON.parse(r.History || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } })(),
    createdAt: created
  };
}

function mapStaffRow_(r) {
  return {
    id: String(r.ID || '').trim(),
    name: r.Name || '', nickname: r.Nickname || '', mobile: r.Mobile || '',
    type: r.Type || '', aadhar: r.AADHAR || '', pan: r.PAN || '',
    rate: r.Rate || '', startDate: r.StartDate || '',
    photo: '', saadharPhotos: [], panPhotos: [], additionalDoc: '',
    // Drive links so a pulled record can still open its files even though
    // the raw image bytes aren't stored in the sheet.
    photoLink: r.PhotoLink || '', aadharPhotoLink: r.AadharPhotoLink || '',
    panPhotoLink: r.PanPhotoLink || '', additionalDocLink: r.AdditionalDocLink || '',
    createdAt: parseDMY_(r.Date) || PULL_FALLBACK_DATE_
  };
}

// A bill spans MULTIPLE sheet rows (one per line item, same ID). Group by
// ID and rebuild the lines[] array; Total/Words only appear on the first
// line of each bill.
function mapBillRows_(rows, center) {
  const byId = new Map();
  (rows || []).forEach(r => {
    const billNo = String(r.BillNo || '').trim();
    const key = billNo || String(r.ID || '').trim();
    if (!key) return;
    if (!byId.has(key)) {
      byId.set(key, {
        id: key, serial: r.ID || '', center,
        billNo, date: r.Date || '', generatedDate: r.Date || '',
        patientId: '', patientName: r.Patient || '',
        staffId: '', staffName: r.Staff || '', staffType: r.StaffType || '',
        lines: [], totalAmount: 0, amountInWords: '',
        printCount: Number(String(r.Printed || '').replace(/[^0-9]/g, '')) || 0,
        printedAt: r.PrintedAt || '',
        createdAt: r.CreatedAt || parseDMY_(r.Date) || PULL_FALLBACK_DATE_
      });
    }
    const b = byId.get(key);
    b.lines.push({
      no: r.SNo || '', duty: r.Duty || '', shift: r.Shift || '',
      startDate: r.StartDate || '', endDate: r.EndDate || '',
      days: r.Days || '', rate: r.Rate || '', amount: r.Amount || ''
    });
    if (!b.totalAmount && r.Total !== '' && r.Total != null) {
      b.totalAmount = Number(String(r.Total).replace(/[^0-9.]/g, '')) || 0;
    }
    if (r.Words) b.amountInWords = r.Words;
  });
  return [...byId.values()];
}

async function mergeServer_(store, incoming, localList) {
  const have = new Set(localList.map(x => String(x.id)));
  let added = 0;
  for (const rec of incoming) {
    if (!rec.id || have.has(String(rec.id))) continue;
    localList.push(rec);
    have.add(String(rec.id));
    try { await dbPut(store, rec); } catch (e) { console.warn('[pull] local save failed', e); }
    added++;
  }
  return added;
}

let _pulling = false;
async function pullFromServer(app) {
  if (_pulling || !navigator.onLine) return;
  _pulling = true;
  try {
    // Fetch each sheet independently — if one list call fails, the others
    // still come through (Promise.all used to abort the ENTIRE pull on any
    // single failure, so one bad sheet meant zero records synced).
    const settled = await Promise.allSettled([
      _post({ action: 'list', sheetName: 'Patient Details', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Staff Details', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Manav Seva Kalyan Bill', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Patient Care Centre Bill', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Manav Seva Care Centre Bill', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Online Details', secret: GAS_SECRET }),
      _post({ action: 'list', sheetName: 'Worker Details', secret: GAS_SECRET })
    ]);
    const rowsOf = i => {
      const r = settled[i];
      if (r.status === 'fulfilled') return (r.value && r.value.rows) || [];
      console.warn('[pullFromServer] list failed:', r.reason && r.reason.message ? r.reason.message : r.reason);
      return [];
    };
    const patients = rowsOf(0).map(mapPatientRow_).filter(r => r.id);
    const staff = rowsOf(1).map(mapStaffRow_).filter(r => r.id);
    const bills = [
      ...mapBillRows_(rowsOf(2), 'MANAV_SEVA'),
      ...mapBillRows_(rowsOf(3), 'PATIENT_CARE'),
      ...mapBillRows_(rowsOf(4), 'MANAV_SEVA_CARE')
    ];
    const online = rowsOf(5).map(mapOnlineRow_).filter(r => r.id);
    const worker = rowsOf(6).map(mapWorkerRow_).filter(r => r.id);
    let added = 0;
    added += await mergeServer_('patients', patients, app.patients);
    added += await mergeServer_('staff', staff, app.staff);
    added += await mergeServer_('bills', bills, app.bills);
    added += await mergeServer_('online', online, app.online);
    added += await mergeServer_('worker', worker, app.worker);
    // Backfill Drive links onto staff records we already had locally (e.g.
    // pulled earlier, before the backend returned real URLs). Only fills
    // link fields — never touches locally-uploaded file bytes.
    let linkUpdates = 0;
    for (const inc of staff) {
      const loc = app.staff.find(x => String(x.id) === String(inc.id));
      if (!loc) continue;
      let changed = false;
      ['photoLink', 'aadharPhotoLink', 'panPhotoLink', 'additionalDocLink'].forEach(k => {
        if (inc[k] && loc[k] !== inc[k]) { loc[k] = inc[k]; changed = true; }
      });
      if (changed) { linkUpdates++; try { await dbPut('staff', loc); } catch (e) { } }
    }
    if (added || linkUpdates) {
      app.patients.sort(byDate); app.staff.sort(byDate); app.bills.sort(byDate); app.online.sort(byDate); app.worker.sort(byDate);
      IDX.patients.build(app.patients); IDX.staff.build(app.staff); IDX.bills.build(app.bills);
      app.render();
      toast('Loaded ' + added + ' record' + (added > 1 ? 's' : '') + ' from Google Sheets \u2713', 'success', 3000);
    }
  } catch (e) {
    // Non-fatal: the app still works fully offline with whatever is local.
    console.warn('[pullFromServer]', e && e.message ? e.message : e);
  } finally {
    _pulling = false;
  }
}

/* ══════════════════════════════════════════════════════════
   APP CLASS
══════════════════════════════════════════════════════════ */
class App {
  constructor() {
    this.tab = 'dashboard';
    this.dashModal = null;
    this.showForm = false; this.formType = null; this.formData = {};
    this.editingId = null; this.viewId = null; this.billLines = [];
    this.syncStatus = 'idle'; this.printBatch = [];
    this.patients = []; this.staff = []; this.bills = []; this.online = []; this.worker = [];
    // search state — plain object, NOT reactive, preserved across renders
    this.search = { patients: '', staff: '', bills: '', online: '', worker: '' };
    this.page = { patients: 0, staff: 0, bills: 0, online: 0, worker: 0 };
    // from/to date-range filter per tab (yyyy-mm-dd from <input type=date>)
    this.dateFrom = { patients: '', staff: '', bills: '', online: '', worker: '' };
    this.dateTo = { patients: '', staff: '', bills: '', online: '', worker: '' };
    this.loading = true;
    this._boot();
  }

  async _boot() {
    this.render();
    try {
      await openDB();
      const [p, s, b, o, w] = await Promise.all([dbAll('patients'), dbAll('staff'), dbAll('bills'), dbAll('online'), dbAll('worker')]);
      this.patients = p.sort(byDate); this.staff = s.sort(byDate); this.bills = b.sort(byDate); this.online = (o || []).sort(byDate); this.worker = (w || []).sort(byDate);
      IDX.patients.build(this.patients); IDX.staff.build(this.staff); IDX.bills.build(this.bills);
    } catch (e) {
      console.warn('[IDB fallback]', e);
      const ls = k => { try { return JSON.parse(localStorage.getItem('hbm_' + k) || '[]') } catch { return [] } };
      this.patients = ls('patients'); this.staff = ls('staff'); this.bills = ls('bills'); this.online = ls('online'); this.worker = ls('worker');
      IDX.patients.build(this.patients); IDX.staff.build(this.staff); IDX.bills.build(this.bills);
    }
    await this._migrateIds();
    await this._migrateBillIds();
    await this._migrateOnlineWorkerIds();
    await migrateLegacyQueue_();
    await refreshPendingCount_();
    this.loading = false; this.render();
    setTimeout(drainQueue, 1500);
    // Pull records added on OTHER devices down into this one so a freshly
    // opened laptop/browser shows the full history instead of "0 records".
    // Deferred so it never blocks first paint; only adds what's missing.
    setTimeout(() => pullFromServer(this), 400);
  }

  // ONE-TIME CLEANUP: older versions of this app gave new staff/patients a
  // Date.now() timestamp as their ID (e.g. "1782815138996"). This renumbers
  // any such records — oldest first — to clean sequential IDs (1, 2, 3…),
  // fixes the corresponding bill references so "Bills" history still shows
  // correctly, and pushes the rename to Google Sheets (delete old ID row,
  // append the corrected one). Already-clean IDs are left untouched, and it
  // only runs once per device.
  async _migrateIds() {
    // DISABLED: records now use globally-unique string IDs by design. The old
    // "renumber messy IDs to sequential 1,2,3" cleanup must never run again —
    // it would rewrite the unique IDs and reintroduce cross-device collisions.
    localStorage.setItem('hbm_id_migrated_v1', '1');
    return;
    if (localStorage.getItem('hbm_id_migrated_v1') === '1') return;
    const isMessy = id => !/^\d{1,6}$/.test(String(id));
    let changed = false;
    for (const store of ['staff', 'patients']) {
      const list = this[store];
      if (!list.some(r => isMessy(r.id))) continue;
      changed = true;
      const ordered = list.slice().sort(byDate).reverse(); // oldest createdAt first
      const idMap = {};
      let n = 0;
      for (const rec of ordered) {
        n++;
        const oldId = rec.id;
        const newId = String(n);
        if (oldId === newId) continue;
        idMap[oldId] = newId;
        const oldRec = { ...rec };
        rec.id = newId;
        await this._del(store, oldId);
        await this._save(store, rec);
        const sheetName = store === 'staff' ? 'Staff Details' : 'Patient Details';
        syncDel(sheetName, 'ID', oldId);
        if (store === 'staff') syncStaff(rec, 'append'); else syncPat(rec, 'append');
      }
      // keep bill history links pointing at the renumbered records
      if (Object.keys(idMap).length) {
        const field = store === 'staff' ? 'staffId' : 'patientId';
        for (const b of this.bills) {
          if (b[field] && idMap[b[field]]) { b[field] = idMap[b[field]]; await this._save('bills', b); }
        }
      }
      this[store] = list.sort(byDate);
      IDX[store].build(this[store]);
    }
    localStorage.setItem('hbm_id_migrated_v1', '1');
    if (changed) toast('Staff & patient IDs renumbered to start from 1 ✓', 'success', 4500);
  }

  // ONE-TIME CLEANUP (online / worker): these two stores never had a
  // renumbering migration before, so any records created before nextSeqId()
  // was introduced still carry old Date.now()-style IDs (e.g.
  // "1782815138996") instead of clean 1, 2, 3… This renumbers them —
  // oldest first — same approach as the (now-disabled) staff/patient
  // migration above, and pushes the rename to Google Sheets (delete old
  // ID row, re-append under the corrected ID). Already-clean IDs are left
  // untouched, and it only runs once per device.
  async _migrateOnlineWorkerIds() {
    if (localStorage.getItem('hbm_ow_id_migrated_v1') === '1') return;
    const isMessy = id => !/^\d{1,6}$/.test(String(id));
    let changed = false;
    for (const store of ['online', 'worker']) {
      const list = this[store];
      if (!list.some(r => isMessy(r.id))) continue;
      changed = true;
      const ordered = list.slice().sort(byDate).reverse(); // oldest createdAt first
      const sheetName = store === 'online' ? 'Online Details' : 'Worker Details';
      let n = 0;
      for (const rec of ordered) {
        n++;
        const oldId = rec.id;
        const newId = String(n);
        if (oldId === newId) continue;
        rec.id = newId;
        await this._del(store, oldId);
        await this._save(store, rec);
        syncDel(sheetName, 'ID', oldId);
        if (store === 'online') syncOnline(rec, 'append'); else syncWorker(rec, 'append');
      }
      this[store] = list.sort(byDate);
    }
    localStorage.setItem('hbm_ow_id_migrated_v1', '1');
    if (changed) toast('Online & Worker IDs renumbered to start from 1 ✓', 'success', 4500);
  }

  // ONE-TIME CLEANUP (bills): older bills got a 'B' + Date.now() ID
  // (e.g. "B1782898230..."). This renumbers them — oldest first — to
  // clean sequential IDs (1, 2, 3…), same as Patients/Staff. Since a
  // bill can span MULTIPLE rows in its sheet (one row per line item),
  // it deletes every one of that bill's old rows (one syncDel per
  // line) before re-appending all lines under the new ID — so no
  // duplicate or orphaned rows are left behind. Already-clean IDs are
  // left untouched, and it only runs once per device.
  async _migrateBillIds() {
    // DISABLED for the same reason as _migrateIds (unique string bill IDs).
    localStorage.setItem('hbm_bill_id_migrated_v1', '1');
    return;
    if (localStorage.getItem('hbm_bill_id_migrated_v1') === '1') return;
    const isMessy = id => !/^\d{1,6}$/.test(String(id));
    if (!this.bills.some(r => isMessy(r.id))) {
      localStorage.setItem('hbm_bill_id_migrated_v1', '1');
      return;
    }
    const ordered = this.bills.slice().sort(byDate).reverse(); // oldest createdAt first
    let n = 0;
    for (const b of ordered) {
      if (!isMessy(b.id)) { n = Math.max(n, parseInt(b.id, 10) || 0); continue }
      n++;
      const oldId = b.id;
      const newId = String(n);
      if (oldId === newId) continue;
      b.id = newId;
      await this._save('bills', b);
      const sheetName = centerOf(b.center).sheet;
      const lineCount = (b.lines || []).length || 1;
      for (let i = 0; i < lineCount; i++) syncDel(sheetName, 'ID', oldId);
      syncBill(b);
    }
    this.bills = this.bills.sort(byDate);
    IDX.bills.build(this.bills);
    localStorage.setItem('hbm_bill_id_migrated_v1', '1');
    toast('Bill IDs renumbered to start from 1 ✓', 'success', 4500);
  }

  async _save(store, obj) {
    try { await dbPut(store, obj) }
    catch { try { localStorage.setItem('hbm_' + store, JSON.stringify(this[store])) } catch { } }
  }
  async _del(store, id) {
    try { await dbDel(store, id) }
    catch { try { localStorage.setItem('hbm_' + store, JSON.stringify(this[store])) } catch { } }
  }

  // KEY FIX: search updates the state and re-renders WITHOUT resetting search value
  // PROPER FIX: a full schedRender() replaces the whole page's innerHTML, which
  // tears down and rebuilds the <input> the user is actively typing into. Even
  // with the focus/cursor restore below, destroying that DOM node on every
  // single keystroke is what made typing feel like it "needed two letters" —
  // the very first keystroke's re-render could race with the browser handing
  // the next keystroke to a freshly (re)focused input on some phones/browsers.
  // _patchList() instead updates only the results block in place and never
  // touches the search input's DOM node, so one typed character is enough.
  _search(key, q) {
    this.search[key] = q;
    this.page[key] = 0;
    this._patchList(key);
  }
  // Re-render just the search/date/page-dependent part of a list tab (the
  // record count + table/cards + empty-state + pager) without rebuilding the
  // rest of the page. Falls back to a full render if the tab isn't currently
  // the one on screen (e.g. the results wrapper isn't in the DOM).
  _patchList(key) {
    const BODY_FN = { patients: '_patientsBody', staff: '_staffBody', online: '_onlineBody', worker: '_workerBody', bills: '_billsBody' };
    const fn = BODY_FN[key];
    const wrap = fn && document.getElementById('lblk-' + key);
    if (!wrap || typeof this[fn] !== 'function') { schedRender(); return; }
    wrap.innerHTML = this[fn]();
    const total = this._page(key).total;
    const cnt = document.getElementById('cnt-' + key);
    if (cnt) cnt.textContent = `${total} record${total !== 1 ? 's' : ''}`;
  }
  _filtered(key) {
    const q = (this.search[key] || '').trim();
    let res;
    if (!q) {
      res = this[key].slice();
    } else {
      // Search across EVERY property of each record (name, mobile, address,
      // type, rate, dates, company, bank, app, payment details, party info,
      // etc.) — multi-word queries must all match somewhere in the record.
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      res = this[key].filter(r => this._recordMatches(key, r, terms));
    }
    const out = this._dateFilter(key, res).slice();
    // Show the list-style tabs in a clean, stable ascending order (by their
    // numeric per-centre id) so the ID / serial column reads 1,2,3,4,5 top to
    // bottom instead of the jumbled createdAt order. Non-numeric ids (rare
    // legacy records) fall to the end, ordered by creation time.
    if (key === 'patients' || key === 'staff' || key === 'online' || key === 'worker') {
      out.sort(byIdAsc);
    }
    return out;
  }
  // Does a record match ALL the given lowercase search terms, checking every
  // simple (string/number) property? Long blobs (photo data URLs, serialized
  // history) are skipped so they never cause phantom matches.
  _recordMatches(key, r, terms) {
    if (!terms.length) return true;
    const parts = [];
    const push = v => {
      if (v == null) return;
      if (typeof v === 'number') { parts.push(String(v)); return; }
      if (typeof v === 'string') {
        if (v.length > 300 || v.startsWith('data:')) return;
        parts.push(v);
      }
    };
    Object.values(r).forEach(push);
    // A couple of friendlier, human-readable fields to search on too.
    if (key === 'worker') {
      const st = r.status || '';
      push(st === 'off' ? 'off duty' : (st === 'on' ? 'on duty' : ''));
    }
    if (r.createdAt) push(fmtDate((r.createdAt || '').slice(0, 10)));
    const hay = parts.join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  }
  // Restrict a list to records whose date falls within the from/to range.
  // Uses createdAt (ISO) which every record has.
  _dateFilter(key, list) {
    const from = this.dateFrom[key], to = this.dateTo[key];
    if (!from && !to) return list;
    const fromT = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
    const toT = to ? new Date(to + 'T23:59:59').getTime() : Infinity;
    return list.filter(r => {
      const raw = key === 'worker' ? (r.dutyDate ? r.dutyDate + 'T12:00:00' : '') : r.createdAt;
      const t = new Date(raw || 0).getTime();
      return !isNaN(t) && t >= fromT && t <= toT;
    });
  }
  // yyyy-mm-dd strings compare correctly with plain string comparison, so no
  // need to parse into Date objects here.
  _setDate(key, which, val) {
    const from = which === 'from' ? val : this.dateFrom[key];
    const to = which === 'to' ? val : this.dateTo[key];
    if (from && to && from > to) {
      toast('From date cannot be after To date', 'error');
      // revert the input's displayed value since the change was rejected
      const inp = document.getElementById(which + '-' + key);
      if (inp) inp.value = (which === 'from' ? this.dateFrom[key] : this.dateTo[key]) || '';
      return;
    }
    (which === 'from' ? this.dateFrom : this.dateTo)[key] = val;
    this.page[key] = 0;
    this._patchList(key);
  }
  _page(key) {
    const f = this._filtered(key);
    const s = this.page[key] * PAGE_SIZE;
    return { list: f.slice(s, s + PAGE_SIZE), total: f.length, pages: Math.ceil(f.length / PAGE_SIZE) };
  }

  setTab(t) {
    this.tab = t; this.showForm = false; this.viewId = null; this.dashModal = null;
    this.formData = {}; this.editingId = null; this.render();
  }

  async testSheet() {
    toast('Testing Google Sheet connection…', 'info', 2500);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'ping', sheetName: 'Test', data: {}, secret: GAS_SECRET }),
        signal: ctrl.signal
      });
      clearTimeout(tid);
      const txt = await r.text();
      let j; try { j = JSON.parse(txt) } catch { }
      if (j && j.ok) { toast('Google Sheets connected ✓', 'success'); this.syncStatus = 'ok'; }
      else if (j && !j.ok) toast('Script error: ' + j.error, 'error', 6000);
      else toast('Non-JSON response — open the GAS URL in a browser tab to see the real error', 'error', 7000);
    } catch (e) {
      clearTimeout(tid);
      // Log the real error object — "Failed to fetch" in the toast hides the
      // actual browser-level reason. Check the Console + Network tab for the
      // real cause (CORS error text, net::ERR_*, blocked by extension, etc).
      console.error('[testSheet] raw fetch error:', e);
      const hint = e.name === 'AbortError'
        ? 'Request timed out (12s) — script may be slow or unreachable.'
        : 'Failed to fetch — check: (1) Apps Script deployed with access "Anyone", (2) latest code redeployed as a new version, (3) your internet connection. See browser Console for the real error.';
      toast(hint, 'error', 8000);
      this.syncStatus = 'err';
    }
    this.render();
  }

  /* ════ PATIENTS ════ */
  async savePatient() {
    const fd = this.formData;
    const nm = (fd.pname || '').trim();
    const mb = (fd.pmobile || '').replace(/\D/g, '');
    if (!nm) { toast('Patient name is required', 'error'); return }
    if (!/^\d{10}$/.test(mb)) { toast('Mobile must be exactly 10 digits', 'error'); return }
    const isEdit = !!this.editingId;
    const orig = isEdit ? this.patients.find(x => x.id === this.editingId) : null;
    const p = {
      id: this.editingId || String(nextSeqId(this.patients)),
      name: nm, address: (fd.paddress || '').trim(), mobile: mb,
      photo: fd.pphoto || (orig ? orig.photo || '' : ''),
      createdAt: orig ? orig.createdAt : new Date().toISOString()
    };
    if (isEdit) {
      const i = this.patients.findIndex(x => x.id === this.editingId);
      this.patients[i] = p; this.editingId = null;
      IDX.patients.remove(p.id); IDX.patients.add(p);
    } else { this.patients.unshift(p); IDX.patients.add(p) }
    await this._save('patients', p); syncPat(p, isEdit ? 'update' : 'append');
    toast(isEdit ? 'Patient updated ✓' : 'Patient added ✓', 'success');
    this.showForm = false; this.formData = {}; this.render();
  }
  async deletePatient(id) {
    const p = this.patients.find(x => x.id === id); if (!p) return;
    const ok = await confirmDelete(p.name, 'Patient');
    if (!ok) return;
    this.patients = this.patients.filter(x => x.id !== id); IDX.patients.remove(id);
    await this._del('patients', id); syncDel('Patient Details', 'ID', id);
    this.viewId = null; this.render(); toast('Patient deleted', 'info');
  }
  editPatient(id) {
    const p = this.patients.find(x => x.id === id); if (!p) return;
    this.editingId = id;
    this.formData = { pname: p.name, paddress: p.address || '', pmobile: p.mobile, pphoto: p.photo || '' };
    this.formType = 'patient'; this.showForm = true; this.viewId = null; this.render();
  }

  /* ════ WORKER DETAILS CRUD ════ */
  // Called when the user presses Enter inside any add/edit form. Fires the
  // primary action for whichever form is currently open, so keyboard users
  // don't have to reach for the mouse. For the bill form, Enter adds the
  // current line item (its most-repeated action) rather than saving.
  submitForm() {
    if (!this.showForm) return;
    switch (this.formType) {
      case 'patient': this.savePatient(); break;
      case 'staff': this.saveStaff(); break;
      case 'worker': this.saveWorker(); break;
      case 'online': this.saveOnline(); break;
      case 'bill': this.addLine(); break;
    }
  }
  async saveWorker() {
    const fd = this.formData;
    const staffName = (fd.wstaffname || '').trim();
    if (!staffName) { toast('Staff name is required', 'error'); return }
    const isEdit = !!this.editingId;
    const orig = isEdit ? this.worker.find(x => x.id === this.editingId) : null;
    const w = {
      id: this.editingId || String(nextSeqId(this.worker)),
      staffName,
      dutyDate: fd.wdutydate || '',
      staffMobile: (fd.wstaffmobile || '').replace(/[^0-9]/g, '').slice(0, 10),
      partyMobile: (fd.wpartymobile || '').replace(/[^0-9]/g, '').slice(0, 10),
      partyAddress: (fd.wpartyaddress || '').trim(),
      status: fd.wstatus === 'off' ? 'off' : (fd.wstatus === 'on' ? 'on' : ''),
      history: orig ? (orig.history || []) : [],
      createdAt: orig ? orig.createdAt : new Date().toISOString()
    };
    if (isEdit) {
      const i = this.worker.findIndex(x => x.id === this.editingId);
      this.worker[i] = w; this.editingId = null;
    } else { this.worker.unshift(w); }
    await this._save('worker', w); syncWorker(w, isEdit ? 'update' : 'append');
    toast(isEdit ? 'Worker detail updated ✓' : 'Worker detail added ✓', 'success');
    this.showForm = false; this.formData = {}; this.render();
  }
  async deleteWorker(id) {
    const w = this.worker.find(x => x.id === id); if (!w) return;
    const ok = await confirmDelete(w.staffName || 'this entry', 'Worker Detail');
    if (!ok) return;
    this.worker = this.worker.filter(x => x.id !== id);
    await this._del('worker', id); syncDel('Worker Details', 'ID', id);
    this.render(); toast('Worker detail deleted', 'info');
  }
  editWorker(id) {
    const w = this.worker.find(x => x.id === id); if (!w) return;
    this.editingId = id;
    this.formData = {
      wstaffname: w.staffName || '', wdutydate: w.dutyDate || '',
      wstaffmobile: w.staffMobile || '', wpartymobile: w.partyMobile || '',
      wpartyaddress: w.partyAddress || '', wstatus: w.status || ''
    };
    this.formType = 'worker'; this.showForm = true; this.viewId = null; this.render();
  }
  // Flip a worker between On Duty (green) and Off Duty (red).
  async toggleWorkerDuty(id) {
    const w = this.worker.find(x => x.id === id); if (!w) return;
    const today = new Date().toISOString().slice(0, 10);
    // Status not set yet → first tap simply marks the worker On Duty.
    if (!w.status) {
      w.status = 'on';
      await this._save('worker', w); syncWorker(w, 'update');
      this.render();
      toast(`${w.staffName || 'Worker'} marked On Duty`, 'success');
      return;
    }
    if ((w.status || 'on') === 'on') {
      // ON -> OFF: log the completed duty period into history.
      const end = await askDate('End Duty', `Mark ${w.staffName || 'this worker'} as Off Duty. When did this duty period end?`, today);
      if (!end) return;
      w.history = w.history || [];
      w.history.push({
        partyMobile: w.partyMobile || '',
        partyAddress: w.partyAddress || '',
        from: w.dutyDate || '',
        to: end
      });
      w.status = 'off';
      await this._save('worker', w); syncWorker(w, 'update');
      this.render();
      toast(`${w.staffName || 'Worker'} Off Duty — period ${fmtDate(w.dutyDate || '') || '?'} → ${fmtDate(end)} logged`, 'info', 4500);
      return;
    }
    // OFF -> ON: same party or a new one?
    const choice = await askChoice('Start Duty',
      `Is ${w.staffName || 'this worker'} starting a new duty with the same party as last time?`,
      [{ key: 'same', label: '✓ Same Party (reuse last details)', color: '#16a34a' },
      { key: 'new', label: '+ New Party (enter fresh details)', color: '#0ea5e9' }]);
    if (!choice) return;
    if (choice === 'same') {
      const start = await askDate('Start Duty', 'When does this duty period start?', today);
      if (!start) return;
      w.dutyDate = start; w.status = 'on';
      await this._save('worker', w); syncWorker(w, 'update');
      this.render();
      toast(`${w.staffName || 'Worker'} On Duty again with the same party`, 'success');
    } else {
      // New party: open the form with staff kept, party cleared, status On.
      this.editingId = id;
      this.formData = {
        wstaffname: w.staffName || '', wdutydate: '',
        wstaffmobile: w.staffMobile || '', wpartymobile: '',
        wpartyaddress: '', wstatus: 'on'
      };
      this.formType = 'worker'; this.showForm = true; this.viewId = id; this.render();
      toast('Enter the new party details, then Save', 'info');
    }
  }

  /* ════ ONLINE DETAILS CRUD ════ */
  async saveOnline() {
    const fd = this.formData;
    const company = fd.ocompany === 'Others' ? (fd.ocompanyOther || '').trim() : (fd.ocompany || '');
    const onlineApp = fd.oonline === 'Other App' ? (fd.oonlineOther || '').trim() : (fd.oonline || '');
    const amount = (fd.oamount || '').toString().trim();
    if (!company) { toast('Please choose or enter a company', 'error'); return }
    if (!amount) { toast('Amount is required', 'error'); return }
    const isEdit = !!this.editingId;
    const orig = isEdit ? this.online.find(x => x.id === this.editingId) : null;
    const o = {
      id: this.editingId || String(nextSeqId(this.online)),
      date: fd.odate || '',
      company, bank: (fd.obank || '').trim(), amount,
      onlineApp, paymentDetails: (fd.opaydetails || '').trim(),
      createdAt: orig ? orig.createdAt : new Date().toISOString()
    };
    if (isEdit) {
      const i = this.online.findIndex(x => x.id === this.editingId);
      this.online[i] = o; this.editingId = null;
    } else { this.online.unshift(o); }
    await this._save('online', o); syncOnline(o, isEdit ? 'update' : 'append');
    toast(isEdit ? 'Online detail updated ✓' : 'Online detail added ✓', 'success');
    this.showForm = false; this.formData = {}; this.render();
  }
  async deleteOnline(id) {
    const o = this.online.find(x => x.id === id); if (!o) return;
    const ok = await confirmDelete(o.company || 'this entry', 'Online Detail');
    if (!ok) return;
    this.online = this.online.filter(x => x.id !== id);
    await this._del('online', id); syncDel('Online Details', 'ID', id);
    this.render(); toast('Online detail deleted', 'info');
  }
  editOnline(id) {
    const o = this.online.find(x => x.id === id); if (!o) return;
    const KNOWN_C = ['Manav Seva Kalyan', 'Patient Care Center'];
    const KNOWN_A = ['GPay', 'PhonePe', 'Paytm', 'Bank App'];
    const compKnown = KNOWN_C.includes(o.company);
    const appKnown = KNOWN_A.includes(o.onlineApp);
    this.editingId = id;
    this.formData = {
      odate: o.date || '',
      ocompany: o.company ? (compKnown ? o.company : 'Others') : '',
      ocompanyOther: compKnown ? '' : (o.company || ''),
      obank: o.bank || '', oamount: o.amount || '',
      oonline: o.onlineApp ? (appKnown ? o.onlineApp : 'Other App') : '',
      oonlineOther: appKnown ? '' : (o.onlineApp || ''),
      opaydetails: o.paymentDetails || ''
    };
    this.formType = 'online'; this.showForm = true; this.viewId = null; this.render();
  }

  /* ════ STAFF ════ */
  async saveStaff() {
    const fd = this.formData;
    const nm = (fd.sname || '').trim();
    const nk = (fd.snickname || '').trim();
    const mb = (fd.smobile || '').replace(/\D/g, '');
    const aa = (fd.saadhar || '').replace(/\D/g, '');
    const pan = (fd.span || '').trim().toUpperCase();
    if (!nm) { toast('Full name is required', 'error'); return }
    if (!fd.stype) { toast('Select a staff type', 'error'); return }
    if (!/^\d{10}$/.test(mb)) { toast('Mobile must be exactly 10 digits', 'error'); return }
    if (!/^\d{12}$/.test(aa)) { toast('Aadhar must be exactly 12 digits', 'error'); return }
    if (pan && (!/^[A-Z0-9]+$/.test(pan) || pan.length > 10)) { toast('PAN must be alphanumeric, max 10 chars', 'error'); return }
    const isEdit = !!this.editingId;
    const orig = isEdit ? this.staff.find(x => x.id === this.editingId) : null;
    const s = {
      id: this.editingId || String(nextSeqId(this.staff)), name: nm, nickname: nk, mobile: mb, type: fd.stype,
      aadhar: aa, pan,
      rate: fd.srate ? Number(fd.srate) : (orig ? orig.rate || '' : ''),
      startDate: fd.sstartDate || (orig ? orig.startDate || '' : ''),
      photo: fd.sphoto || (orig ? orig.photo || '' : ''),
      saadharPhotos: fd.saadharPhotos || (orig ? orig.saadharPhotos || [] : []),
      panPhotos: fd.panPhotos || (orig ? orig.panPhotos || [] : []),
      additionalDoc: fd.sdoc || (orig ? orig.additionalDoc || '' : ''),
      createdAt: orig ? orig.createdAt : new Date().toISOString()
    };
    if (isEdit) {
      const i = this.staff.findIndex(x => x.id === this.editingId);
      this.staff[i] = s; this.editingId = null;
      IDX.staff.remove(s.id); IDX.staff.add(s);
    } else { this.staff.unshift(s); IDX.staff.add(s) }
    const changedFiles = {
      photo: !!(fd._changed && fd._changed.sphoto),
      aadhar: !!(fd._changed && fd._changed.saadharPhotos),
      pan: !!(fd._changed && fd._changed.panPhotos),
      doc: !!(fd._changed && fd._changed.sdoc)
    };
    await this._save('staff', s); syncStaff(s, isEdit ? 'update' : 'append', changedFiles);
    toast(isEdit ? 'Staff updated ✓' : 'Staff added ✓', 'success');
    this.showForm = false; this.formData = {}; this.render();
  }
  async deleteStaff(id) {
    const s = this.staff.find(x => x.id === id); if (!s) return;
    const ok = await confirmDelete(s.name, 'Staff Member');
    if (!ok) return;
    this.staff = this.staff.filter(x => x.id !== id); IDX.staff.remove(id);
    await this._del('staff', id); syncDel('Staff Details', 'ID', id);
    this.viewId = null; this.render(); toast('Staff deleted', 'info');
  }
  editStaff(id) {
    const s = this.staff.find(x => x.id === id); if (!s) return;
    this.editingId = id;
    this.formData = {
      sname: s.name, snickname: s.nickname || '', smobile: s.mobile, stype: s.type,
      saadhar: s.aadhar, span: s.pan || '',
      srate: s.rate || '', sstartDate: s.startDate || '',
      sphoto: s.photo || '',
      saadharPhotos: (s.saadharPhotos || []).slice(),
      panPhotos: (s.panPhotos || []).slice(),
      sdoc: s.additionalDoc || ''
    };
    this.formType = 'staff'; this.showForm = true; this.viewId = null; this.render();
  }
  openDoc(id, key) {
    const s = this.staff.find(x => x.id === id); if (!s) return;
    if (!key) {
      if (!s.additionalDoc) return;
      viewDoc(s.additionalDoc, s.name + ' — Additional Document');
      return;
    }
    const m = String(key).match(/^(aadhar|pan)(\d+)$/);
    if (m) {
      const list = m[1] === 'aadhar' ? (s.saadharPhotos || []) : (s.panPhotos || []);
      const f = list[Number(m[2])]; if (!f) return;
      viewDoc(f, s.name + ' — ' + (m[1] === 'aadhar' ? 'Aadhar Card' : 'PAN Card'));
    }
  }
  // Records that the user actively re-picked/removed a file for this
  // field during the CURRENT add/edit session. On an edit we only push a
  // file field up to Google Sheets/Drive if it was changed here — an
  // untouched photo is left exactly as-is in Drive (no re-upload, no
  // duplicate file, instant save).
  markChanged(key) {
    (this.formData._changed = this.formData._changed || {})[key] = true;
  }
  handleFile(e, key) {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 2097152) { toast('Image must be under 2 MB', 'error'); return }
    const r = new FileReader(); r.onload = ev => { this.formData[key] = ev.target.result; this.markChanged(key); this.render() }; r.readAsDataURL(f);
  }
  // Accepts images, PDFs, and Word docs. Stores {data, name, type} so non-image
  // files (PDF/DOC) can be identified and previewed/downloaded later.
  handleDocFile(e, key) {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5242880) { toast('File must be under 5 MB', 'error'); return }
    const r = new FileReader();
    r.onload = ev => {
      this.formData[key] = { data: ev.target.result, name: f.name, type: f.type || '' };
      this.markChanged(key);
      this.render();
    };
    r.readAsDataURL(f);
  }
  // Handle multiple file uploads (for Aadhar and PAN)
  handleMultipleFiles(e, key) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    if (!this.formData[key]) this.formData[key] = [];
    let processed = 0;
    files.forEach(f => {
      if (f.size > 5242880) { toast(`${f.name} must be under 5 MB`, 'error'); return }
      const r = new FileReader();
      r.onload = ev => {
        this.formData[key].push({ data: ev.target.result, name: f.name, type: f.type || '' });
        this.markChanged(key);
        processed++;
        if (processed === files.length) this.render();
      };
      r.readAsDataURL(f);
    });
  }

  /* ════ BILLS ════ */
  updateDays() {
    const s = this.formData.bstartDate, e = this.formData.bendDate;
    if (s && e) {
      if (e < s) { toast('End date cannot be before start date', 'error'); this.formData.bendDate = ''; this.formData.bdays = '' }
      else this.formData.bdays = String(calcDays(s, e));
    }
    this.render();
  }
  addLine() {
    const fd = this.formData;
    if (!fd.bcenter || !fd.bpatient || !fd.bstaff) { toast('Select Centre, Patient & Staff first', 'error'); return }
    if (!fd.bstartDate || !fd.bendDate) { toast('Select start and end dates', 'error'); return }
    const days = parseInt(fd.bdays || 0); const rate = parseFloat(fd.brate || 0);
    if (!days || days < 1) { toast('Days must be ≥1', 'error'); return }
    if (!rate || rate <= 0) { toast('Enter a valid rate', 'error'); return }
    if (this.billLines.length >= 9) { toast('Maximum 9 line items per bill', 'error'); return }
    // S.No must always be this line's own position in the bill (1,2,3…).
    // It used to fall back to `fd.bstaff` (the selected staff member's ID)
    // whenever that ID was truthy — which is always — so lines showed the
    // staff's ID instead of a proper running number (e.g. "5,3,2,1,4").
    this.billLines.push({ no: this.billLines.length + 1, duty: fd.bduty || 'Home', startDate: fd.bstartDate, endDate: fd.bendDate, days, shift: fd.bshift || 'Day', rate, amount: days * rate });
    Object.assign(fd, { bduty: 'Home', bstartDate: '', bendDate: '', bdays: '', bshift: 'Day', brate: '' });
    this.render();
  }
  removeLine(i) { this.billLines.splice(i, 1); this.billLines.forEach((l, idx) => l.no = idx + 1); this.render() }
  async saveBillOnly() { const b = await this._billHTML(); if (!b) return; toast(`Bill ${b.billNo} saved — ₹${Number(b.totalAmount).toLocaleString('en-IN')}`, 'success', 4000); this.billLines = []; this.formData = {}; this.showForm = false; this.render() }
  async saveBillAndPrint() { const b = await this._billHTML(); if (!b) return; toast(`Bill ${b.billNo} generated`, 'success', 4000); this.billLines = []; this.formData = {}; this.showForm = false; this.render(); setTimeout(() => doPrint([b]), 350) }
  async _billHTML() {
    const fd = this.formData;
    if (!fd.bcenter) { toast('Select a centre', 'error'); return null }
    if (!fd.bpatient) { toast('Select a patient', 'error'); return null }
    if (!fd.bstaff) { toast('Select a staff member', 'error'); return null }
    if (!this.billLines.length) { toast('Add at least one line item', 'error'); return null }
    const total = this.billLines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const pat = this.patients.find(p => p.id === fd.bpatient);
    const sta = this.staff.find(s => s.id === fd.bstaff);
    const pfx = centerOf(fd.bcenter).prefix;
    // Bill No is user-provided (pre-filled with the next suggested number on
    // the form, but editable) instead of being silently auto-generated —
    // falls back to the auto number only if the field was left blank.
    const billNo = (fd.bbillno || '').trim() || nextBillNo(pfx, this.bills);
    if (this.bills.some(b => b.billNo === billNo)) {
      toast(`Bill No "${billNo}" is already used — pick a different one`, 'error');
      return null;
    }
    // The sheet's ID column shows a per-centre serial (1,2,3…) so each centre
    // starts at 1; the record's real key stays the globally-unique BillNo.
    const serial = parseInt(billNo.slice(pfx.length + 1), 10) || 1;
    const b = {
      id: billNo, serial, center: fd.bcenter,
      billNo, date: todayStr(), generatedDate: todayStr(),
      patientId: fd.bpatient, patientName: pat ? pat.name : '', patientAddress: pat ? pat.address || '' : '',
      staffId: fd.bstaff, staffName: sta ? sta.name : '', staffType: sta ? sta.type : '',
      lines: JSON.parse(JSON.stringify(this.billLines)),
      totalAmount: total, amountInWords: n2w(total),
      printCount: 0,
      createdAt: new Date().toISOString()
    };
    this.bills.unshift(b); IDX.bills.add(b);
    await this._save('bills', b); syncBill(b);
    return b;
  }
  async deleteBill(id) {
    const b = this.bills.find(x => x.id === id);
    const ok = await confirmDelete(b ? b.billNo : 'this bill', 'Bill');
    if (!ok) return;
    this.bills = this.bills.filter(x => x.id !== id); IDX.bills.remove(id);
    await this._del('bills', id);
    if (b) syncDel(centerOf(b.center).sheet, 'BillNo', b.billNo);
    this.render(); toast('Bill deleted', 'info');
  }
  printBill(id) { const b = this.bills.find(x => x.id === id); if (!b) { toast('Bill not found', 'error'); return } doPrint([b]) }
  // Mark a bill as printed (once), persist locally, and sync the flag up so
  // the dashboard's "Bills Printed" count is correct across devices.
  _markBillPrinted(b) {
    if (!b) return;
    b.printCount = (b.printCount || 0) + 1;
    b.printedAt = new Date().toISOString();
    this._save('bills', b);
    const sheet = centerOf(b.center).sheet;
    enq({ action: 'update', sheetName: sheet, data: { ID: b.serial, Printed: b.printCount, PrintedAt: b.printedAt } });
  }
  viewBill(id) { this.viewId = id; this.render() }
  // Open a single bill's detail straight from the dashboard chip.
  openBill(id) { const b = this.bills.find(x => x.id === id); if (!b) { toast('Bill not found', 'error'); return } this.dashModal = null; this.tab = 'bills'; this.showForm = false; this.viewId = id; this.render() }
  toggleBatch(id) {
    const i = this.printBatch.indexOf(id);
    if (i > -1) this.printBatch.splice(i, 1);
    else { if (this.printBatch.length >= 4) { toast('Max 4 bills per print page', 'error'); return } this.printBatch.push(id); }
    this.render();
  }
  clearBatch() { this.printBatch = []; this.render() }
  printBatchNow() {
    if (!this.printBatch.length) { toast('Add at least one bill to the print page', 'error'); return }
    const bills = this.printBatch.map(id => this.bills.find(b => b.id === id)).filter(Boolean);
    doPrint(bills); this.printBatch = []; this.render();
  }

  /* ════ RENDER ════ */
  render() {
    const pending = _qPendingCount;
    const sdCls = { ok: 'ok', err: 'err', syncing: 'ing' }[this.syncStatus] || '';
    const sdTip = { ok: 'Synced ✓', err: 'Sync failed – saved locally', syncing: 'Syncing…' }[this.syncStatus] || '';
    const header = `<header class="app-header no-print" style="position:sticky;top:0;z-index:40">
        <div class="max-w-7xl mx-auto px-3 sm:px-5 py-3">
            <div class="flex items-center justify-between gap-2 mb-2">
                 <div class="flex items-center gap-2.5 min-w-0">
                 <span class="app-logo">🏥</span>
                 <div class="min-w-0">
                <h1 class="font-extrabold leading-tight" style="font-size:clamp(.9rem,2.5vw,1.1rem);color:#fff">Billing System</h1>
            <p class="flex items-center gap-1.5 flex-wrap" style="font-size:.68rem;color:rgba(255,255,255,.75)">
                 <span>Manav Seva Kalyan &amp; Patient Care Centre</span>
                    ${sdCls ? `<span class="sdot ${sdCls}" title="${sdTip}"></span><span>${sdTip}</span>` : ''}
                    ${pending > 0 ? `<span class="badge bg-red-100 text-red-600">${pending} pending</span>` : ''}
          </p>
        </div>
      </div>
      <div class="flex gap-1.5 flex-shrink-0 items-center">
        <button onclick="doLogout()" class="logout-btn">${ico('logout', 'w-3.5 h-3.5')} Logout</button>
      </div>
    </div>
    <div id="desktop-nav" class="flex gap-2 flex-wrap no-print">${this._navBtns()}</div>
  </div>
</header>`;
    let body = '';
    if (this.loading) { body = `<div class="grid-auto">${[1, 2, 3, 4, 5, 6].map(() => '<div class="skel rounded-2xl h-28"></div>').join('')}</div>`; }
    else if (this.tab === 'dashboard') body = this._rDashboard();
    else if (this.tab === 'patients') body = this._rPatients();
    else if (this.tab === 'staff') body = this._rStaff();
    else if (this.tab === 'online') body = this._rOnline();
    else if (this.tab === 'worker') body = this._rWorker();
    else body = this._rBills();
    const main = `<main class="max-w-7xl mx-auto px-3 sm:px-5 py-5 no-print">${body}</main>`;
    const mnav = `<nav id="mobile-nav" class="no-print" role="navigation">
  ${[['dashboard', 'Home', I.dashboard], ['patients', 'Patients', I.patients], ['staff', 'Staff', I.staff], ['online', 'Online', I.online], ['worker', 'Worker', I.worker], ['bills', 'Bills', I.bills]].map(([k, l, ic]) => `
  <button class="mnav-btn${this.tab === k ? ' active' : ''}" onclick="APP.setTab('${k}')">
    <span style="width:22px;height:22px;display:inline-flex">${ic}</span><span>${l}</span>
  </button>`).join('')}
</nav>`;
    // Preserve focus + cursor position across the full innerHTML re-render below.
    // Without this, every keystroke in a search/text input loses focus, so fast
    // typing appears to "scatter" (characters land out of order / get dropped).
    const appEl = document.getElementById('app');
    const active = document.activeElement;
    let focusId = null, selStart = null, selEnd = null;
    if (active && appEl.contains(active) && active.id) {
      focusId = active.id;
      if (typeof active.selectionStart === 'number') { selStart = active.selectionStart; selEnd = active.selectionEnd; }
    }

    appEl.innerHTML = header + main + mnav;

    if (focusId) {
      const toFocus = document.getElementById(focusId);
      if (toFocus) {
        toFocus.focus();
        if (selStart !== null && typeof toFocus.setSelectionRange === 'function') {
          try { toFocus.setSelectionRange(selStart, selEnd) } catch { }
        }
      }
    }
  }

  /* ════ WORKER DETAILS ════ */
  _rWorker() {
    const fd = this.formData;
    if (this.showForm && this.formType === 'worker') {
      return `
<button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Worker Detail ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#ffe4e6;color:#be123c">New</span>`}</h3>
  <div class="grid gap-4 mb-4">
    <div><label class="flbl">Staff Name</label><input class="finp" placeholder="Staff name" value="${esc(fd.wstaffname || '')}" oninput="APP.formData.wstaffname=this.value"></div>
    <div><label class="flbl">Duty Date</label><input class="finp" type="date" value="${esc(fd.wdutydate || '')}" oninput="APP.formData.wdutydate=this.value"></div>
    <div><label class="flbl">Duty Status <span class="text-gray-400 font-normal">(optional)</span></label>
      <div class="duty-toggle">
        <button type="button" class="duty-pill ${fd.wstatus === 'on' ? 'on-active' : ''}" onclick="APP.formData.wstatus = APP.formData.wstatus === 'on' ? '' : 'on';APP.render()"><span class="duty-dot on"></span> On Duty</button>
        <button type="button" class="duty-pill ${fd.wstatus === 'off' ? 'off-active' : ''}" onclick="APP.formData.wstatus = APP.formData.wstatus === 'off' ? '' : 'off';APP.render()"><span class="duty-dot off"></span> Off Duty</button>
      </div>
    </div>
    <div><label class="flbl">Staff Mobile No.</label><input class="finp" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit staff number" value="${esc(fd.wstaffmobile || '')}" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10);APP.formData.wstaffmobile=this.value"></div>
    <div><label class="flbl">Party Mobile No.</label><input class="finp" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit party number" value="${esc(fd.wpartymobile || '')}" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10);APP.formData.wpartymobile=this.value"></div>
    <div><label class="flbl">Party Address</label><textarea class="finp" rows="2" placeholder="Party address" oninput="APP.formData.wpartyaddress=this.value">${esc(fd.wpartyaddress || '')}</textarea></div>
  </div>
  <div class="flex gap-3">
    <button onclick="APP.saveWorker()" class="fbtn fbtn-primary flex-1 justify-center" style="background:linear-gradient(135deg,#f43f5e,#e11d48)">✓ Save</button>
    <button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel flex-1 justify-center">✕ Cancel</button>
  </div>
</div>`;
    }
    if (this.viewId && !this.showForm) {
      const w = this.worker.find(x => x.id === this.viewId);
      if (!w) { this.viewId = null; return this._rWorker() }
      const row = (label, val) => val ? `<div class="flex justify-between gap-3 py-2 border-b border-gray-50"><span class="text-xs font-bold text-gray-400">${label}</span><span class="text-sm text-gray-800 text-right break-words">${esc(val)}</span></div>` : '';
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <div class="flex items-start justify-between mb-3">
    <div class="flex items-center gap-2 flex-wrap"><h2 class="font-black text-xl">${esc(w.staffName || '—')}</h2>${!w.status ? `<button class="duty-badge duty-none" title="Click to set duty" onclick="APP.toggleWorkerDuty('${w.id}')"><span class="duty-dot none"></span>—</button>` : `<button class="duty-badge duty-${w.status}" title="Click to toggle duty" onclick="APP.toggleWorkerDuty('${w.id}')"><span class="duty-dot ${w.status}"></span>${w.status === 'off' ? 'Off Duty' : 'On Duty'}</button>`}</div>
    <div class="flex gap-2 flex-shrink-0">
      <button onclick="APP.editWorker('${w.id}')" class="fbtn text-sm" style="background:#fef3c7;color:#92400e;border:none">${ico('edit', 'w-3.5 h-3.5')} Edit</button>
      <button onclick="APP.deleteWorker('${w.id}')" class="fbtn text-sm" style="background:#fef2f2;color:#dc2626;border:none">${ico('trash', 'w-3.5 h-3.5')} Delete</button>
    </div>
  </div>
  ${row('Duty Date', fmtDate(w.dutyDate || ''))}
  ${row('Staff Mobile No.', w.staffMobile)}
  ${row('Party Mobile No.', w.partyMobile)}
  ${row('Party Address', w.partyAddress)}
  ${(w.history && w.history.length) ? `
  <div class="mt-4 pt-3 border-t border-gray-100">
    <p class="text-xs font-black text-gray-400 mb-2 tracking-wide">DUTY HISTORY (${w.history.length})</p>
    ${w.history.slice().reverse().map(h => `
    <div class="flex justify-between items-start gap-3 py-2 border-b border-gray-50">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-gray-700 truncate">${esc(h.partyAddress || 'Party')}</div>
        ${h.partyMobile ? `<div class="text-xs text-gray-400">📞 ${esc(h.partyMobile)}</div>` : ''}
      </div>
      <div class="text-xs font-semibold text-gray-500 text-right whitespace-nowrap">${esc(fmtDate(h.from || '') || '?')} → ${esc(fmtDate(h.to || '') || '?')}</div>
    </div>`).join('')}
  </div>` : ''}
</div>`;
    }
    const total0 = this._page('worker').total;
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='worker';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#f43f5e;color:#fff">${ico('plus')} Add Worker Detail</button>
  ${this._searchBar('worker', 'Search staff, mobile, party, address…', '#f43f5e')}
  <span class="text-xs text-gray-400 font-medium" id="cnt-worker">${total0} record${total0 !== 1 ? 's' : ''}</span>
</div>
<div id="lblk-worker">${this._workerBody()}</div>`;
  }
  // Results-only block for the Worker Details tab. See _patientsBody() note.
  _workerBody() {
    const { list, total, pages } = this._page('worker');
    if (!total) return `<div class="text-center py-16 text-gray-400 text-sm">${(this.search.worker || this.dateFrom.worker || this.dateTo.worker) ? 'No worker details match.' : 'No worker details yet.'}</div>`;
    return `<div style="overflow-x:auto">
<table class="tbl" style="min-width:880px">
  <thead><tr><th>ID</th><th>Staff Name</th><th>Duty Date</th><th>Status</th><th>Staff Mobile</th><th>Party Mobile</th><th>Party Address</th><th>Edit</th><th>Delete</th></tr></thead>
  <tbody>
${list.map((w, i) => `
  <tr class="cursor-pointer" onclick="APP.viewId='${w.id}';APP.render()">
    <td class="c">${this.page.worker * PAGE_SIZE + i + 1}</td>
    <td><span class="font-bold text-gray-900">${esc(w.staffName || '—')}</span></td>
    <td class="c">${w.dutyDate ? esc(fmtDate(w.dutyDate)) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c">${!w.status ? `<button class="duty-badge duty-none" title="Click to set duty" onclick="event.stopPropagation();APP.toggleWorkerDuty('${w.id}')"><span class="duty-dot none"></span>—</button>` : `<button class="duty-badge duty-${w.status}" title="Click to toggle duty" onclick="event.stopPropagation();APP.toggleWorkerDuty('${w.id}')"><span class="duty-dot ${w.status}"></span>${w.status === 'off' ? 'Off Duty' : 'On Duty'}</button>`}</td>
    <td class="c">${w.staffMobile ? '📞 ' + esc(w.staffMobile) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c">${w.partyMobile ? '📞 ' + esc(w.partyMobile) : '<span class="text-gray-300">—</span>'}</td>
    <td>${w.partyAddress ? esc(w.partyAddress) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c"><button onclick="event.stopPropagation();APP.editWorker('${w.id}')" class="fbtn text-xs" style="background:#fef3c7;color:#92400e;border:none;padding:5px 10px">${ico('edit', 'w-3.5 h-3.5')} Edit</button></td>
    <td class="c"><button onclick="event.stopPropagation();APP.deleteWorker('${w.id}')" class="fbtn text-xs" style="background:#fef2f2;color:#dc2626;border:none;padding:5px 10px">${ico('trash', 'w-3.5 h-3.5')} Delete</button></td>
  </tr>`).join('')}
  </tbody>
</table>
</div>${this._pager('worker', total, pages)}`;
  }

  /* ════ ONLINE DETAILS ════ */
  _rOnline() {
    const fd = this.formData;
    const COMPANIES = ['Manav Seva Kalyan', 'Patient Care Center', 'Others'];
    const APPS = ['GPay', 'PhonePe', 'Paytm', 'Bank App', 'Other App'];
    if (this.showForm && this.formType === 'online') {
      const comp = fd.ocompany || '', app = fd.oonline || '';
      return `
<button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Online Payment ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#e0f2fe;color:#0369a1">New</span>`}</h3>
  <div class="grid gap-4 mb-4">
    <div><label class="flbl">Date</label><input class="finp" type="date" value="${esc(fd.odate || '')}" oninput="APP.formData.odate=this.value"></div>
    <div><label class="flbl">Company</label>
      <select class="finp" onchange="APP.formData.ocompany=this.value;APP.render()">
        <option value="" ${!comp ? 'selected' : ''} disabled>Select company</option>
        ${COMPANIES.map(c => `<option value="${c}" ${comp === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </div>
    ${comp === 'Others' ? `<div><label class="flbl">Company Name</label><input class="finp" placeholder="Company name" value="${esc(fd.ocompanyOther || '')}" oninput="APP.formData.ocompanyOther=this.value"></div>` : ''}
    <div><label class="flbl">Bank</label><input class="finp" placeholder="Bank name" value="${esc(fd.obank || '')}" oninput="APP.formData.obank=this.value"></div>
    <div><label class="flbl">Amount (₹)</label><input class="finp" type="number" inputmode="numeric" placeholder="Amount" value="${esc(fd.oamount || '')}" oninput="APP.formData.oamount=this.value.replace(/[^0-9.]/g,'')"></div>
    <div><label class="flbl">Online (App)</label>
      <select class="finp" onchange="APP.formData.oonline=this.value;APP.render()">
        <option value="" ${!app ? 'selected' : ''} disabled>Select app</option>
        ${APPS.map(a => `<option value="${a}" ${app === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
    </div>
    ${app === 'Other App' ? `<div><label class="flbl">App Name</label><input class="finp" placeholder="App name" value="${esc(fd.oonlineOther || '')}" oninput="APP.formData.oonlineOther=this.value"></div>` : ''}
    <div><label class="flbl">Payment Details</label><input class="finp" placeholder="Reference / transaction details" value="${esc(fd.opaydetails || '')}" oninput="APP.formData.opaydetails=this.value"></div>
  </div>
  <div class="flex gap-3">
    <button onclick="APP.saveOnline()" class="fbtn fbtn-primary flex-1 justify-center" style="background:linear-gradient(135deg,#0ea5e9,#0284c7)">✓ Save</button>
    <button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel flex-1 justify-center">✕ Cancel</button>
  </div>
</div>`;
    }
    if (this.viewId && !this.showForm) {
      const o = this.online.find(x => x.id === this.viewId);
      if (!o) { this.viewId = null; return this._rOnline() }
      const row = (label, val) => val ? `<div class="flex justify-between gap-3 py-2 border-b border-gray-50"><span class="text-xs font-bold text-gray-400">${label}</span><span class="text-sm text-gray-800 text-right break-words">${esc(val)}</span></div>` : '';
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <div class="flex items-start justify-between mb-3">
    <div class="min-w-0">
      <div class="flex items-center gap-1.5 flex-wrap"><h2 class="font-black text-xl">${esc(o.company || '—')}</h2>${o.onlineApp ? `<span class="text-xs font-bold px-2 py-0.5 rounded" style="background:#e0f2fe;color:#0369a1">${esc(o.onlineApp)}</span>` : ''}</div>
      <p class="text-2xl font-black text-green-600 mt-1">₹${esc(Number(o.amount || 0).toLocaleString('en-IN'))}</p>
    </div>
    <div class="flex gap-2 flex-shrink-0">
      <button onclick="APP.editOnline('${o.id}')" class="fbtn text-sm" style="background:#fef3c7;color:#92400e;border:none">${ico('edit', 'w-3.5 h-3.5')} Edit</button>
      <button onclick="APP.deleteOnline('${o.id}')" class="fbtn text-sm" style="background:#fef2f2;color:#dc2626;border:none">${ico('trash', 'w-3.5 h-3.5')} Delete</button>
    </div>
  </div>
  ${row('Date', fmtDate(o.date || ''))}
  ${row('Company', o.company)}
  ${row('Bank', o.bank)}
  ${row('Amount', o.amount ? '₹' + Number(o.amount).toLocaleString('en-IN') : '')}
  ${row('Online App', o.onlineApp)}
  ${row('Payment Details', o.paymentDetails)}
</div>`;
    }
    const total0 = this._page('online').total;
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='online';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#0ea5e9;color:#fff">${ico('plus')} Add Online Detail</button>
  ${this._searchBar('online', 'Search company, bank, app, staff…', '#0ea5e9')}
  <span class="text-xs text-gray-400 font-medium" id="cnt-online">${total0} record${total0 !== 1 ? 's' : ''}</span>
</div>
<div id="lblk-online">${this._onlineBody()}</div>`;
  }
  // Results-only block for the Online Details tab. See _patientsBody() note.
  _onlineBody() {
    const { list, total, pages } = this._page('online');
    if (!total) return `<div class="text-center py-16 text-gray-400 text-sm">${(this.search.online || this.dateFrom.online || this.dateTo.online) ? 'No online details match.' : 'No online details yet.'}</div>`;
    return `<div style="overflow-x:auto">
<table class="tbl" style="min-width:780px">
  <thead><tr><th>ID</th><th>Date</th><th>Company</th><th>Bank</th><th>Amount</th><th>App</th><th>Payment Details</th><th>Edit</th><th>Delete</th></tr></thead>
  <tbody>
${list.map((o, i) => `
  <tr class="cursor-pointer" onclick="APP.viewId='${o.id}';APP.render()">
    <td class="c">${this.page.online * PAGE_SIZE + i + 1}</td>
    <td class="c">${o.date ? esc(fmtDate(o.date)) : '<span class="text-gray-300">—</span>'}</td>
    <td><span class="font-bold text-gray-900">${esc(o.company || '—')}</span></td>
    <td class="c">${o.bank ? esc(o.bank) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c"><span class="font-black text-green-600">₹${esc(Number(o.amount || 0).toLocaleString('en-IN'))}</span></td>
    <td class="c">${o.onlineApp ? `<span class="text-xs font-semibold px-1.5 py-0.5 rounded" style="background:#e0f2fe;color:#0369a1">${esc(o.onlineApp)}</span>` : '<span class="text-gray-300">—</span>'}</td>
    <td>${o.paymentDetails ? esc(o.paymentDetails) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c"><button onclick="event.stopPropagation();APP.editOnline('${o.id}')" class="fbtn text-xs" style="background:#fef3c7;color:#92400e;border:none;padding:5px 10px">${ico('edit', 'w-3.5 h-3.5')} Edit</button></td>
    <td class="c"><button onclick="event.stopPropagation();APP.deleteOnline('${o.id}')" class="fbtn text-xs" style="background:#fef2f2;color:#dc2626;border:none;padding:5px 10px">${ico('trash', 'w-3.5 h-3.5')} Delete</button></td>
  </tr>`).join('')}
  </tbody>
</table>
</div>${this._pager('online', total, pages)}`;
  }

  /* ════ DASHBOARD ════ */
  _rDashboard() {
    const totalAmount = this.bills.reduce((sum, b) => sum + (Number(b.totalAmount) || 0), 0);
    const fmtAmt = '₹' + totalAmount.toLocaleString('en-IN');
    const cards = [
      { k: 'patients', label: 'Patients', value: this.patients.length, ic: I.patients, g: 'linear-gradient(135deg,#3b82f6,#2563eb)' },
      { k: 'staff', label: 'Staff', value: this.staff.length, ic: I.staff, g: 'linear-gradient(135deg,#10b981,#0d9488)' },
      { k: 'bills', label: 'Bills Generated', value: this.bills.length, ic: I.bills, g: 'linear-gradient(135deg,#7c3aed,#6d28d9)', modal: 'generated' },
      { k: 'bills', label: 'Bills Printed', value: this.bills.filter(b => (b.printCount || 0) > 0).length, ic: I.print, g: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', modal: 'printed' },
      { k: 'online', label: 'Online Details', value: this.online.length, ic: I.online, g: 'linear-gradient(135deg,#0ea5e9,#0284c7)' },
      { k: 'worker', label: 'Worker Details', value: this.worker.length, ic: I.worker, g: 'linear-gradient(135deg,#f43f5e,#e11d48)' },
      { k: '', label: 'Total Amount', value: fmtAmt, ic: I.bills, g: 'linear-gradient(135deg,#f59e0b,#d97706)', wide: true }
    ];
    return `
<div class="mb-5">
  <h2 class="text-xl font-black text-gray-800">Dashboard</h2>
  <p class="text-sm text-gray-400">Overview of Manav Seva Kalyan &amp; Patient Care Centre</p>
</div>
<div class="dash-grid">
  ${cards.map(c => {
      const cls = `dash-card${c.wide ? ' dash-card-wide' : ''}`;
      const inner = `
    <span class="dash-ic">${c.ic}</span>
    <span class="dash-val">${c.value}</span>
    <span class="dash-label">${c.label}</span>
    ${c.detail || ''}`;
      // Bill cards open an in-dashboard popup; the amount card is display-only;
      // the rest navigate to their section.
      if (c.modal) return `<button onclick="APP.dashModal='${c.modal}';APP.render()" class="${cls}" style="background:${c.g}">${inner}</button>`;
      if (!c.k) return `<div class="${cls} dash-card-static" style="background:${c.g}">${inner}</div>`;
      return `<button onclick="APP.setTab('${c.k}')" class="${cls}" style="background:${c.g}">${inner}</button>`;
    }).join('')}
</div>
${this._dashModalHtml()}`;
  }

  // Popup listing generated / printed bills with dates, times and counts.
  _dashModalHtml() {
    if (!this.dashModal) return '';
    const isGen = this.dashModal === 'generated';
    const all = this.bills.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const list = isGen ? all : all.filter(b => (b.printCount || 0) > 0);
    const title = isGen ? `Bills Generated (${list.length})` : `Bills Printed (${list.length})`;
    const rows = list.length ? list.map(b => `
    <div class="dm-row">
      <div class="dm-main">
        <span class="dm-bno" onclick="APP.openBill('${b.id}')" title="View this bill">${esc(b.billNo)}</span>
        ${b.patientName ? `<span class="dm-pat">${esc(b.patientName)}</span>` : ''}
      </div>
      <div class="dm-side">
        <span class="dm-amt">₹${Number(b.totalAmount || 0).toLocaleString('en-IN')}</span>
        ${isGen
        ? `<span class="dm-when">🕒 Generated: ${fmtDateTime(b.createdAt)}</span>`
        : `<span class="dm-when"><b class="dm-times">×${b.printCount}</b>${b.printedAt ? ' · 🖨 Last: ' + fmtDateTime(b.printedAt) : ''}</span>`}
      </div>
    </div>`).join('') : `<div class="dm-empty">${isGen ? 'No bills generated yet.' : 'No bills printed yet.'}</div>`;
    return `
<div class="dm-overlay" onclick="APP.dashModal=null;APP.render()">
  <div class="dm-box" onclick="event.stopPropagation()">
    <div class="dm-head">
      <h3>${title}</h3>
      <button class="dm-x" onclick="APP.dashModal=null;APP.render()" title="Close">✕</button>
    </div>
    <div class="dm-body">${rows}</div>
  </div>
</div>`;
  }

  _navBtns() {
    return [['dashboard', 'Dashboard', null, '#6366f1'], ['patients', 'Patients', this.patients.length, '#3b82f6'], ['staff', 'Staff', this.staff.length, '#10b981'], ['online', 'Online Details', this.online.length, '#0ea5e9'], ['worker', 'Worker Details', this.worker.length, '#f43f5e'], ['bills', 'Bills', this.bills.length, '#7c3aed']].map(([k, l, cnt, c]) => `
<button onclick="APP.setTab('${k}')" class="nav-btn${this.tab === k ? ' active' : ''}" style="${this.tab === k ? `background:${c};color:#fff;box-shadow:0 6px 16px ${c}55` : ''}">
  <span class="nav-btn-ic" style="background:${this.tab === k ? 'rgba(255,255,255,.22)' : c + '1a'};color:${this.tab === k ? '#fff' : c}">${I[k]}</span>
  <span>${l}</span>
  ${cnt === null ? '' : `<span class="badge" style="background:${this.tab === k ? 'rgba(255,255,255,.25)' : '#fff'};color:${this.tab === k ? '#fff' : '#64748b'}">${cnt}</span>`}
</button>`).join('')
  }

  _pager(key, total, pages) {
    if (pages <= 1) return '';
    const cur = this.page[key];
    const from = cur * PAGE_SIZE + 1, to = Math.min((cur + 1) * PAGE_SIZE, total);
    return `<div class="flex items-center gap-2 mt-5 justify-center flex-wrap text-sm">
  <button onclick="APP.page['${key}']=Math.max(0,APP.page['${key}']-1);APP.render()" ${cur === 0 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 font-semibold text-gray-600">← Prev</button>
  <span class="text-gray-400 text-xs">Showing ${from}–${to} of ${total}</span>
  <button onclick="APP.page['${key}']=Math.min(${pages - 1},APP.page['${key}']+1);APP.render()" ${cur === pages - 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 font-semibold text-gray-600">Next →</button>
</div>`;
  }

  // KEY FIX: search bar uses oninput with direct value update, never re-sets value from state
  _searchBar(key, ph, accent = '#7c3aed') {
    const q = esc(this.search[key]);
    const from = esc(this.dateFrom[key] || ''), to = esc(this.dateTo[key] || '');
    return `<div class="search-wrap flex-1 min-w-[180px] max-w-sm">
  <svg class="s-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"/></svg>
  <input class="search-inp" id="srch-${key}" placeholder="${ph}" value="${q}"
    oninput="APP._search('${key}',this.value)" autocomplete="off" spellcheck="false">
  <button class="search-clear" onclick="APP._search('${key}','');document.getElementById('srch-${key}').value=''" title="Clear">✕</button>
</div>
<div class="date-range flex items-center gap-1.5 text-xs text-gray-500">
  <label class="flex items-center gap-1">From<input type="date" id="from-${key}" class="date-inp" value="${from}" ${to ? `max="${to}"` : ''} onchange="APP._setDate('${key}','from',this.value)"></label>
  <label class="flex items-center gap-1">To<input type="date" id="to-${key}" class="date-inp" value="${to}" ${from ? `min="${from}"` : ''} onchange="APP._setDate('${key}','to',this.value)"></label>
  ${(from || to) ? `<button class="text-red-500 font-bold px-1" title="Clear dates" onclick="APP.dateFrom['${key}']='';APP.dateTo['${key}']='';APP.page['${key}']=0;APP.render()">✕</button>` : ''}
  ${key !== 'bills' ? `<button class="print-list-btn" title="Print these records as a table" onclick="APP.printList('${key}')">${ico('print', 'w-3.5 h-3.5')} Print</button>` : ''}
</div>`;
  }

  // Print the currently-filtered records of a list tab as a spreadsheet-style table.
  printList(key) {
    const rows = this._filtered(key);
    if (!rows.length) { toast('No records to print', 'warn'); return; }
    const dcell = r => fmtDate((r.createdAt || '').slice(0, 10));
    const CFG = {
      patients: {
        title: 'Patients',
        cols: [['Name', 'name'], ['Address', 'address'], ['Mobile', 'mobile'], ['Date', dcell]]
      },
      staff: {
        title: 'Staff',
        cols: [['Name', 'name'], ['Nickname', 'nickname'], ['Mobile', 'mobile'], ['Type', 'type'],
        ['AADHAR', 'aadhar'], ['PAN', 'pan'], ['Rate', 'rate'], ['Start Date', r => fmtDate(r.startDate || '')]]
      },
      online: {
        title: 'Online Details',
        cols: [['Date', r => fmtDate(r.date || '')], ['Company', 'company'], ['Bank', 'bank'],
        ['Amount', r => r.amount ? '₹' + Number(r.amount).toLocaleString('en-IN') : ''],
        ['App', 'onlineApp'], ['Payment Details', 'paymentDetails']]
      },
      worker: {
        title: 'Worker Details',
        cols: [['Staff Name', 'staffName'], ['Duty Date', r => fmtDate(r.dutyDate || '')],
        ['Staff Mobile', 'staffMobile'], ['Party Mobile', 'partyMobile'],
        ['Party Address', 'partyAddress'], ['Status', r => r.status === 'off' ? 'Off Duty' : (r.status === 'on' ? 'On Duty' : '')]]
      }
    };
    const cfg = CFG[key]; if (!cfg) return;
    const cols = cfg.cols;
    const f = this.dateFrom[key], t = this.dateTo[key], qq = this.search[key];
    const bits = [`${rows.length} record${rows.length !== 1 ? 's' : ''}`];
    if (qq) bits.push(`search: "${qq}"`);
    if (f || t) bits.push(`${f ? fmtDate(f) : '…'} → ${t ? fmtDate(t) : '…'}`);
    bits.push('Printed ' + todayStr());
    doPrintList(cfg.title, cols, rows, bits.join('  ·  '));
  }

  /* ════ PATIENTS RENDER ════ */
  _rPatients() {
    const fd = this.formData;
    if (this.viewId && !this.showForm) {
      const p = this.patients.find(x => x.id === this.viewId);
      if (!p) { this.viewId = null; return this._rPatients() }
      const billsForPatient = this.bills.filter(b => b.patientId === p.id);
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <div class="flex items-start justify-between mb-4">
    <div>
      <div class="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-2xl mb-2 overflow-hidden">${p.photo ? `<img src="${p.photo}" class="w-12 h-12 rounded-full object-cover">` : '👤'}</div>
      <div class="flex items-center gap-1.5"><h2 class="font-black text-xl">${esc(p.name)}</h2><span class="text-xs font-bold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(p.id)}</span></div>
      <p class="text-sm text-gray-500">📞 ${esc(p.mobile)}</p>
      ${p.address ? `<p class="text-sm text-gray-400 mt-0.5">📍 ${esc(p.address)}</p>` : ''}
    </div>
    <div class="flex gap-2">
      <button onclick="APP.editPatient('${p.id}')" class="fbtn text-sm" style="background:#fef3c7;color:#92400e;border:none">${ico('edit', 'w-3.5 h-3.5')} Edit</button>
      <button onclick="APP.deletePatient('${p.id}')" class="fbtn text-sm" style="background:#fef2f2;color:#dc2626;border:none">${ico('trash', 'w-3.5 h-3.5')} Delete</button>
    </div>
  </div>
  ${billsForPatient.length ? `<div class="border-t pt-3 mt-2"><p class="text-xs font-bold text-gray-400 mb-2">BILLS (${billsForPatient.length})</p>
  ${billsForPatient.slice(0, 5).map(b => `<div class="flex justify-between text-sm py-1 border-b border-gray-50">
    <span class="font-semibold">${esc(b.billNo)}</span>
    <span class="text-gray-400">${esc(b.date)}</span>
    <span class="text-green-600 font-bold">₹${Number(b.totalAmount).toLocaleString('en-IN')}</span>
  </div>`).join('')}
  </div>`: ''}
</div>`;
    }
    if (this.showForm && this.formType === 'patient') {
      return `
<button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Patient / Party ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#dbeafe;color:#1d4ed8">New</span>`}</h3>
  <div class="grid gap-4 mb-4">
    <div><label class="flbl">Patient / Party Name *</label><input class="finp" placeholder="Full name" value="${esc(fd.pname || '')}" oninput="APP.formData.pname=this.value"></div>
    <div><label class="flbl">Address</label><input class="finp" placeholder="Address (optional)" value="${esc(fd.paddress || '')}" oninput="APP.formData.paddress=this.value"></div>
    <div><label class="flbl">Mobile No. * (10 digits)</label><input class="finp" type="tel" maxlength="10" placeholder="10-digit mobile" value="${esc(fd.pmobile || '')}" oninput="this.value=this.value.replace(/\D/g,'');APP.formData.pmobile=this.value"></div>
  <div class="flex gap-3">
    <button onclick="APP.savePatient()" class="fbtn fbtn-primary flex-1 justify-center">✓ Save Patient</button>
    <button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel flex-1 justify-center">✕ Cancel</button>
  </div>
</div>`;
    }
    const total0 = this._page('patients').total;
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='patient';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#3b82f6;color:#fff">${ico('plus')} Add Patient</button>
  ${this._searchBar('patients', 'Search patients by name, ID, mobile…', '#3b82f6')}
  <span class="text-xs text-gray-400 font-medium" id="cnt-patients">${total0} record${total0 !== 1 ? 's' : ''}</span>
</div>
<div id="lblk-patients">${this._patientsBody()}</div>`;
  }
  // Results-only block for the Patients tab (record table / empty-state /
  // pager). Kept separate from _rPatients() so search/date changes can patch
  // just this piece — see _patchList().
  _patientsBody() {
    const { list, total, pages } = this._page('patients');
    if (!total) return `<div class="text-center py-16 text-gray-400 text-sm">${this.search.patients ? 'No patients match.' : 'No patients yet.'}</div>`;
    return `<div style="overflow-x:auto">
<table class="tbl" style="min-width:640px">
  <thead><tr><th>ID</th><th>Name</th><th>Mobile No.</th><th>Address</th><th>Edit</th><th>Delete</th></tr></thead>
  <tbody>
${list.map((p, i) => `
  <tr class="cursor-pointer" onclick="APP.viewId='${p.id}';APP.render()">
    <td class="c">${this.page.patients * PAGE_SIZE + i + 1}</td>
    <td><span class="font-bold text-gray-900">${esc(p.name)}</span></td>
    <td class="c">📞 ${esc(p.mobile)}</td>
    <td>${p.address ? esc(p.address) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c"><button onclick="event.stopPropagation();APP.editPatient('${p.id}')" class="fbtn text-xs" style="background:#fef3c7;color:#92400e;border:none;padding:5px 10px">${ico('edit', 'w-3.5 h-3.5')} Edit</button></td>
    <td class="c"><button onclick="event.stopPropagation();APP.deletePatient('${p.id}')" class="fbtn text-xs" style="background:#fef2f2;color:#dc2626;border:none;padding:5px 10px">${ico('trash', 'w-3.5 h-3.5')} Delete</button></td>
  </tr>`).join('')}
  </tbody>
</table>
</div>${this._pager('patients', total, pages)}`;
  }

  /* ════ STAFF RENDER ════ */
  _rStaff() {
    const fd = this.formData;
    if (this.viewId && !this.showForm) {
      const s = this.staff.find(x => x.id === this.viewId);
      if (!s) { this.viewId = null; return this._rStaff() }
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-lg mx-auto">
  <div class="flex items-start justify-between mb-4">
    <div class="flex items-center gap-3">
      ${staffAvatar(s, 'w-14 h-14', 'text-2xl')}
      <div>
        <h2 class="font-black text-lg">${esc(s.name)}${s.nickname ? ` <span class="text-sm font-normal text-gray-400">"${esc(s.nickname)}"</span>` : ''}</h2>
        <div class="flex items-center gap-1.5 mt-1 flex-wrap">
          <span class="text-xs font-bold px-2 py-0.5 rounded" style="background:#dcfce7;color:#15803d">${esc(s.type)}</span>
          <span class="text-xs font-bold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#475569">ID #${esc(s.id)}</span>
        </div>
        <p class="text-sm text-gray-500 mt-1">📞 ${esc(s.mobile)}</p>
      </div>
    </div>
    <div class="flex gap-2">
      <button onclick="APP.editStaff('${s.id}')" class="fbtn text-sm" style="background:#fef3c7;color:#92400e;border:none">${ico('edit', 'w-3.5 h-3.5')} Edit</button>
      <button onclick="APP.deleteStaff('${s.id}')" class="fbtn text-sm" style="background:#fef2f2;color:#dc2626;border:none">${ico('trash', 'w-3.5 h-3.5')} Delete</button>
    </div>
  </div>
  <div class="grid grid-cols-2 gap-3 text-sm border-t pt-3">
    <div><p class="text-gray-400 text-xs font-bold mb-0.5">AADHAR NO.</p><p class="font-mono font-semibold tracking-wide">${esc(s.aadhar)}</p></div>
    <div><p class="text-gray-400 text-xs font-bold mb-0.5">PAN</p><p class="font-mono font-semibold">${esc(s.pan || 'N/A')}</p></div>
    <div><p class="text-gray-400 text-xs font-bold mb-0.5">RATE / DAY</p><p class="font-semibold ${s.rate ? 'text-green-600' : 'text-gray-300'}">${s.rate ? '₹ ' + Number(s.rate).toLocaleString('en-IN') : 'Not set'}</p></div>
    <div><p class="text-gray-400 text-xs font-bold mb-0.5">START DATE</p><p class="font-semibold ${s.startDate ? '' : 'text-gray-300'}">${s.startDate ? fmtDate(s.startDate) : 'Not set'}</p></div>
  </div>
  ${s.saadharPhotos && s.saadharPhotos.length ? `<div class="mt-3">
    <p class="text-xs font-bold text-gray-400 mb-2">AADHAR CARD (${s.saadharPhotos.length} file${s.saadharPhotos.length > 1 ? 's' : ''})</p>
    <div class="flex gap-2 flex-wrap">
      ${s.saadharPhotos.map((f, i) => fileChip(f, `APP.openDoc('${s.id}','aadhar${i}')`, f.name)).join('')}
    </div>
  </div>` : `<div class="mt-3"><p class="text-xs font-bold text-gray-400 mb-1">AADHAR CARD</p>${driveLinkBtns(s.aadharPhotoLink, 'Aadhar') || '<p class="text-xs text-gray-300">No file uploaded</p>'}</div>`}
  ${s.panPhotos && s.panPhotos.length ? `<div class="mt-3">
    <p class="text-xs font-bold text-gray-400 mb-2">PAN CARD (${s.panPhotos.length} file${s.panPhotos.length > 1 ? 's' : ''})</p>
    <div class="flex gap-2 flex-wrap">
      ${s.panPhotos.map((f, i) => fileChip(f, `APP.openDoc('${s.id}','pan${i}')`, f.name)).join('')}
    </div>
  </div>` : `<div class="mt-3"><p class="text-xs font-bold text-gray-400 mb-1">PAN CARD</p>${driveLinkBtns(s.panPhotoLink, 'PAN') || '<p class="text-xs text-gray-300">No file uploaded</p>'}</div>`}
  ${(s.additionalDoc || s.additionalDocLink) ? `<div class="mt-3">
    <p class="text-xs font-bold text-gray-400 mb-1">ADDITIONAL DOCUMENT</p>
    ${s.additionalDoc ? fileChip(s.additionalDoc, `APP.openDoc('${s.id}')`, s.additionalDoc.name) : driveLinkBtns(s.additionalDocLink, 'Document')}
  </div>` : ''}
</div>`;
    }
    if (this.showForm && this.formType === 'staff') {
      return `
<button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Staff Member ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#dcfce7;color:#15803d">New</span>`}</h3>
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
    <div><label class="flbl">Full Name *</label><input class="finp" placeholder="Full name" value="${esc(fd.sname || '')}" oninput="APP.formData.sname=this.value"></div>
    <div><label class="flbl">Nickname / Short Name</label><input class="finp" placeholder="Optional" value="${esc(fd.snickname || '')}" oninput="APP.formData.snickname=this.value"></div>
    <div><label class="flbl">Mobile No. * (10 digits)</label><input class="finp" type="tel" maxlength="10" placeholder="10-digit mobile" value="${esc(fd.smobile || '')}" oninput="this.value=this.value.replace(/\D/g,'');APP.formData.smobile=this.value"></div>
    <div><label class="flbl">Staff Type *</label>
      <select class="finp" onchange="APP.formData.stype=this.value">
        <option value="">-- Select --</option>
        <option value="WB" ${fd.stype === 'WB' ? 'selected' : ''}>WB (Ward Boy)</option>
        <option value="AB" ${fd.stype === 'AB' ? 'selected' : ''}>AB (Aaya Bai)</option>
        <option value="Nurse" ${fd.stype === 'Nurse' ? 'selected' : ''}>Nurse</option>
      </select></div>
    <div><label class="flbl">Rate (₹ per day)</label><input class="finp" type="number" placeholder="Daily rate" step="0.01" value="${esc(fd.srate || '')}" oninput="APP.formData.srate=this.value"></div>
    <div><label class="flbl">Start Date</label><input class="finp" type="date" value="${esc(fd.sstartDate || '')}" oninput="APP.formData.sstartDate=this.value"></div>
    <div><label class="flbl">Aadhar No. * (12 digits)</label><input class="finp" maxlength="12" placeholder="12-digit Aadhar" value="${esc(fd.saadhar || '')}" oninput="this.value=this.value.replace(/\D/g,'');APP.formData.saadhar=this.value" style="font-family:monospace;letter-spacing:.08em"></div>
    <div><label class="flbl">PAN Card (max 10)</label><input class="finp" maxlength="10" placeholder="PAN" value="${esc(fd.span || '')}" oninput="this.value=this.value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();APP.formData.span=this.value"></div>
    <div><label class="flbl">Staff Photo (max 2 MB)</label>
      <input type="file" accept="image/*" onchange="APP.handleFile(event,'sphoto')" class="finp text-xs cursor-pointer" style="padding:6px">
      ${fd.sphoto ? `<img src="${fd.sphoto}" class="mt-2 h-14 w-14 rounded-xl object-cover border">` : ''}</div>
    <div><label class="flbl">Aadhar Card Upload (Image / PDF / DOC - Multiple files)</label>
      <input type="file" accept="image/*,.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple onchange="APP.handleMultipleFiles(event,'saadharPhotos')" class="finp text-xs cursor-pointer" style="padding:6px">
      ${fd.saadharPhotos && fd.saadharPhotos.length ? `<div class="mt-2 flex flex-col gap-1">
        ${(fd.saadharPhotos || []).map((f, i) => {
        const m = FILE_KIND_META[fileKind(f)]; return `<div class="flex items-center gap-2 text-xs">
          <span style="background:${m.bg};color:${m.fg};padding:4px 8px;border-radius:8px;font-weight:700">${m.icon} ${m.label} · ${esc(f.name || 'File ' + (i + 1))}</span>
          <button type="button" onclick="event.stopPropagation();APP.formData.saadharPhotos.splice(${i},1);APP.markChanged('saadharPhotos');APP.render()" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700">×</button>
        </div>`;
      }).join('')}
      </div>` : ''}</div>
    <div><label class="flbl">PAN Card Upload (Image / PDF / DOC - Multiple files)</label>
      <input type="file" accept="image/*,.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple onchange="APP.handleMultipleFiles(event,'panPhotos')" class="finp text-xs cursor-pointer" style="padding:6px">
      ${fd.panPhotos && fd.panPhotos.length ? `<div class="mt-2 flex flex-col gap-1">
        ${(fd.panPhotos || []).map((f, i) => {
        const m = FILE_KIND_META[fileKind(f)]; return `<div class="flex items-center gap-2 text-xs">
          <span style="background:${m.bg};color:${m.fg};padding:4px 8px;border-radius:8px;font-weight:700">${m.icon} ${m.label} · ${esc(f.name || 'File ' + (i + 1))}</span>
          <button type="button" onclick="event.stopPropagation();APP.formData.panPhotos.splice(${i},1);APP.markChanged('panPhotos');APP.render()" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700">×</button>
        </div>`;
      }).join('')}
      </div>` : ''}</div>
    <div><label class="flbl">Additional Document (PDF / DOC / Image, max 5 MB)</label>
      <input type="file" accept="image/*,.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onchange="APP.handleDocFile(event,'sdoc')" class="finp text-xs cursor-pointer" style="padding:6px">
      ${fd.sdoc ? (() => {
          const m = FILE_KIND_META[fileKind(fd.sdoc)]; return `<div class="mt-2 flex items-center gap-2 text-xs">
        <span style="background:${m.bg};color:${m.fg};padding:4px 8px;border-radius:8px;font-weight:700">${m.icon} ${m.label} · ${esc(fd.sdoc.name || 'Uploaded')}</span>
        <button type="button" onclick="event.stopPropagation();APP.formData.sdoc='';APP.render()" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700">Remove</button>
      </div>`;
        })() : ''}</div>
  </div>
  <div class="flex gap-3">
    <button onclick="APP.saveStaff()" class="fbtn fbtn-green flex-1 justify-center">✓ Save Staff</button>
    <button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel flex-1 justify-center">✕ Cancel</button>
  </div>
</div>`;
    }
    const total0 = this._page('staff').total;
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='staff';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#10b981;color:#fff">${ico('plus')} Add Staff</button>
  ${this._searchBar('staff', 'Search staff by name, ID, mobile…', '#10b981')}
  <span class="text-xs text-gray-400 font-medium" id="cnt-staff">${total0} record${total0 !== 1 ? 's' : ''}</span>
</div>
<div id="lblk-staff">${this._staffBody()}</div>`;
  }
  // Results-only block for the Staff tab. See _patientsBody() note above —
  // kept separate so a single keystroke in the search box can patch just
  // this table instead of rebuilding the whole page (and the search input
  // along with it).
  _staffBody() {
    const { list, total, pages } = this._page('staff');
    if (!total) return `<div class="text-center py-16 text-gray-400 text-sm">${this.search.staff ? 'No staff match.' : 'No staff yet.'}</div>`;
    return `<div style="overflow-x:auto">
<table class="tbl" style="min-width:820px">
  <thead><tr><th>ID</th><th>Name</th><th>Mobile No.</th><th>Type</th><th>Rate/Day</th><th>Start Date</th><th>Docs</th><th>Edit</th><th>Delete</th></tr></thead>
  <tbody>
${list.map((s, i) => `
  <tr class="cursor-pointer" onclick="APP.viewId='${s.id}';APP.render()">
    <td class="c">${this.page.staff * PAGE_SIZE + i + 1}</td>
    <td><div class="flex items-center gap-2">${staffAvatar(s, 'w-7 h-7')
      }<span class="font-bold text-gray-900">${esc(s.name)}</span>${s.nickname ? `<span class="text-xs font-normal text-gray-400">"${esc(s.nickname)}"</span>` : ''}</div></td>
    <td class="c">📞 ${esc(s.mobile)}</td>
    <td class="c"><span class="text-xs font-bold px-1.5 py-0.5 rounded" style="background:#dcfce7;color:#15803d">${esc(s.type)}</span></td>
    <td class="c">${s.rate ? '₹' + Number(s.rate).toLocaleString('en-IN') : '<span class="text-gray-300">—</span>'}</td>
    <td class="c">${s.startDate ? fmtDate(s.startDate) : '<span class="text-gray-300">—</span>'}</td>
    <td class="c">${(s.additionalDoc || (s.saadharPhotos && s.saadharPhotos.length) || (s.panPhotos && s.panPhotos.length)) ? '📎' : '<span class="text-gray-300">—</span>'}</td>
    <td class="c"><button onclick="event.stopPropagation();APP.editStaff('${s.id}')" class="fbtn text-xs" style="background:#fef3c7;color:#92400e;border:none;padding:5px 10px">${ico('edit', 'w-3.5 h-3.5')} Edit</button></td>
    <td class="c"><button onclick="event.stopPropagation();APP.deleteStaff('${s.id}')" class="fbtn text-xs" style="background:#fef2f2;color:#dc2626;border:none;padding:5px 10px">${ico('trash', 'w-3.5 h-3.5')} Delete</button></td>
  </tr>`).join('')}
  </tbody>
</table>
</div>${this._pager('staff', total, pages)}`;
  }

  /* ════ BILLS RENDER ════ */
  _rBills() {
    const fd = this.formData;
    const centerCounts = Object.keys(CENTERS).map(k => ({ c: CENTERS[k], n: this.bills.filter(b => b.center === k).length }));
    if (this.viewId && !this.showForm) {
      const b = this.bills.find(x => x.id === this.viewId);
      if (!b) { this.viewId = null; return this._rBills() }
      const bc = centerOf(b.center); const ac = bc.color;
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back to Bills</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-2xl mx-auto">
  <div class="flex items-center justify-between mb-4">
    <div>
      <span class="text-xs font-bold px-2.5 py-1 rounded-full" style="background:${bc.bg};color:${ac}">${esc(bc.label)}</span>
      <h2 class="font-black text-xl mt-1">${esc(b.billNo)}</h2>
      <p class="text-sm text-gray-400">📅 Generated on ${esc(b.generatedDate || b.date)}</p>
    </div>
    <div class="text-right">
      <p class="text-2xl font-black text-green-600">₹${Number(b.totalAmount).toLocaleString('en-IN')}</p>
      <p class="text-xs text-gray-400">${esc(b.amountInWords)}</p>
    </div>
  </div>
  <div class="grid grid-cols-2 gap-3 mb-4 p-3 rounded-xl bg-gray-50">
    <div><p class="text-xs text-gray-400 font-bold">PATIENT</p><p class="font-semibold">${esc(b.patientName)}</p></div>
    <div><p class="text-xs text-gray-400 font-bold">STAFF</p><p class="font-semibold">${esc(b.staffName)}</p><p class="text-xs text-gray-500">${esc(b.staffType)}</p></div>
  </div>
  <div class="overflow-x-auto mb-4">
    <table class="tbl" style="min-width:420px">
      <thead><tr><th>S.No</th><th>Duty</th><th>Shift</th><th>From</th><th>To</th><th>Days</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>
        ${(b.lines || []).map(l => `<tr>
          <td class="c">${l.no}</td><td>${esc(l.duty)}</td><td>${esc(l.shift)}</td>
          <td class="c text-xs">${fmtDate(l.startDate || '')}</td><td class="c text-xs">${fmtDate(l.endDate || '')}</td>
          <td class="c font-bold">${l.days}</td>
          <td class="r">₹${Number(l.rate || 0).toLocaleString('en-IN')}</td>
          <td class="r font-bold text-green-700">₹${Number(l.amount || 0).toLocaleString('en-IN')}</td>
        </tr>`).join('')}
        <tr style="background:#f3f0ff">
          <td colspan="7" class="r font-black" style="color:#4c1d95">TOTAL</td>
          <td class="r font-black text-green-700">₹${Number(b.totalAmount).toLocaleString('en-IN')}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="flex gap-2 flex-wrap">
    <button onclick="APP.printBill('${b.id}')" class="fbtn fbtn-primary flex-1 justify-center text-sm">${ico('print')} Print Bill</button>
    <button onclick="APP.toggleBatch('${b.id}');APP.viewId=null;APP.render()" class="fbtn fbtn-outline flex-1 justify-center text-sm">＋ Add to Print Page</button>
    <button onclick="APP.deleteBill('${b.id}')" class="fbtn flex-1 justify-center text-sm" style="background:#fef2f2;color:#dc2626;border:none">${ico('trash')} Delete</button>
  </div>
</div>`;
    }
    let h = `
<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
  <div>
    <h2 class="font-bold text-lg text-gray-900">Bills</h2>
    <div class="flex gap-2 mt-1">
      ${centerCounts.map(({ c, n }) => `<span class="text-xs font-bold px-2.5 py-1 rounded-full" style="background:${c.bg};color:${c.color}">${esc(c.badge)}: ${n}</span>`).join('')}
    </div>
  </div>
  <button onclick="APP.formType='bill';APP.showForm=true;APP.billLines=[];APP.formData={};APP.viewId=null;APP.render()" class="fbtn fbtn-primary">${ico('plus')} New Bill</button>
</div>`;
    if (this.printBatch.length) {
      const sel = this.printBatch.map(id => this.bills.find(x => x.id === id)).filter(Boolean);
      h += `<div class="no-print sticky z-30 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2" style="top:70px">
  <span class="font-bold text-amber-800 text-sm">📄 Print Page (${sel.length}/4):</span>
  ${sel.map(b => `<span class="text-xs bg-white border border-amber-300 rounded-full px-2.5 py-1 font-semibold">
    ${esc(b.billNo)} <button onclick="APP.toggleBatch('${b.id}')" class="text-red-500 font-bold ml-1">✕</button>
  </span>`).join('')}
  <div class="ml-auto flex gap-2">
    <button onclick="APP.printBatchNow()" class="fbtn text-sm" style="background:#d97706;color:#fff">${ico('print')} Print Page</button>
    <button onclick="APP.clearBatch()" class="fbtn fbtn-cancel text-sm">Clear</button>
  </div>
</div>`;
    }
    if (this.showForm && this.formType === 'bill') {
      const tot = this.billLines.reduce((s, l) => s + Number(l.amount || 0), 0);
      const prev = (parseInt(fd.bdays || 0) || 0) * (parseFloat(fd.brate || 0) || 0);
      h += `<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-5">
  <h3 class="font-bold text-base mb-4 text-gray-800">Generate New Bill</h3>
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
    <div><label class="flbl">Centre *</label>
      <select class="finp" onchange="APP.formData.bcenter=this.value;APP.render()">
        <option value="">-- Select centre --</option>
        ${Object.values(CENTERS).map(c => `<option value="${c.key}" ${fd.bcenter === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select></div>
    <div><label class="flbl">Patient *</label>
      <select class="finp" onchange="APP.formData.bpatient=this.value">
        <option value="">-- Select patient --</option>
        ${this.patients.map(p => `<option value="${p.id}" ${fd.bpatient === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></div>
    <div><label class="flbl">Staff *</label>
      <select class="finp" onchange="APP.formData.bstaff=this.value">
        <option value="">-- Select staff --</option>
        ${this.staff.map(s => `<option value="${s.id}" ${fd.bstaff === s.id ? 'selected' : ''}>${esc(s.name)}${s.nickname ? ' (' + esc(s.nickname) + ')' : ''} — ${esc(s.type)}</option>`).join('')}
      </select></div>
    <div><label class="flbl">Bill No ${fd.bcenter ? '' : '(pick a centre first)'}</label>
      <input class="finp" type="text" placeholder="${fd.bcenter ? esc(nextBillNo(centerOf(fd.bcenter).prefix, this.bills)) : 'e.g. MSK-0001'}"
        value="${safe(fd.bbillno)}" oninput="APP.formData.bbillno=this.value">
      <p class="text-[11px] text-gray-400 mt-0.5">Leave blank to auto-use the suggested number above.</p></div>
  </div>
  ${fd.bcenter ? `<div class="rounded-xl p-3 mb-4 text-center" style="background:#faf5ff;border:1.5px dashed #a78bfa">
    <div class="font-black text-red-800 text-sm">${esc(centerOf(fd.bcenter).title)}</div>
    ${centerOf(fd.bcenter).sub ? `<div class="font-bold text-xs">${esc(centerOf(fd.bcenter).sub)}</div>` : ''}
    <div class="text-xs font-semibold text-gray-600 mt-0.5">${esc(centerOf(fd.bcenter).addr)}</div>
  </div>`: ''}
  <div class="rounded-xl p-4 mb-4" style="background:#f8fafc;border:1px solid #e2e8f0">
    <h4 class="font-bold text-sm mb-3 text-gray-700">Add Line Item</h4>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
      <div><label class="flbl">Duty</label>
        <select class="finp text-sm" onchange="APP.formData.bduty=this.value">
          <option value="Home" ${!fd.bduty || fd.bduty === 'Home' ? 'selected' : ''}>Home</option>
          <option value="Hospital" ${fd.bduty === 'Hospital' ? 'selected' : ''}>Hospital</option>
        </select></div>
      <div><label class="flbl">Shift</label>
        <select class="finp text-sm" onchange="APP.formData.bshift=this.value">
          <option value="Day" ${!fd.bshift || fd.bshift === 'Day' ? 'selected' : ''}>Day</option>
          <option value="Night" ${fd.bshift === 'Night' ? 'selected' : ''}>Night</option>
          <option value="24 Hours" ${fd.bshift === '24 Hours' ? 'selected' : ''}>24 Hours</option>
        </select></div>
      <div><label class="flbl">Start Date *</label><input type="date" class="finp text-sm" value="${safe(fd.bstartDate)}" onchange="APP.formData.bstartDate=this.value;APP.updateDays()"></div>
      <div><label class="flbl">End Date * (≥ start)</label><input type="date" class="finp text-sm" value="${safe(fd.bendDate)}" min="${safe(fd.bstartDate)}" onchange="APP.formData.bendDate=this.value;APP.updateDays()"></div>
      <div><label class="flbl">Days (auto)</label><input type="number" class="finp text-sm font-bold text-blue-700" style="background:#eff6ff;border-color:#bfdbfe" value="${safe(fd.bdays)}" readonly></div>
      <div><label class="flbl">Rate ₹ *</label><input type="number" class="finp text-sm" min="0" placeholder="Per day rate" value="${safe(fd.brate)}" onchange="APP.formData.brate=this.value;APP.render()"></div>
      <div><label class="flbl">Amount</label><div class="finp text-sm font-bold text-green-700" style="background:#f0fdf4;border-color:#bbf7d0">₹${prev ? prev.toLocaleString('en-IN') : '—'}</div></div>
    </div>
    <button onclick="APP.addLine()" class="fbtn fbtn-primary w-full justify-center text-sm">${ico('plus')} Add Line Item</button>
  </div>
  ${this.billLines.length ? `
  <div class="overflow-x-auto mb-4">
    <table class="tbl" style="min-width:540px">
      <thead><tr>${['S.No', 'Duty', 'Shift', 'From', 'To', 'Days', 'Rate', 'Amount', ''].map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${this.billLines.map((l, i) => `<tr>
          <td class="c">${l.no}</td><td>${esc(l.duty)}</td><td>${esc(l.shift)}</td>
          <td class="c text-xs">${fmtDate(l.startDate || '')}</td><td class="c text-xs">${fmtDate(l.endDate || '')}</td>
          <td class="c font-bold">${l.days}</td>
          <td class="r">₹${Number(l.rate || 0).toLocaleString('en-IN')}</td>
          <td class="r font-bold text-green-700">₹${Number(l.amount || 0).toLocaleString('en-IN')}</td>
          <td class="c"><button onclick="APP.removeLine(${i})" class="text-red-500 hover:text-red-700 font-bold">✕</button></td>
        </tr>`).join('')}
        <tr style="background:#f3f0ff">
          <td colspan="7" class="r font-black" style="color:#4c1d95">TOTAL</td>
          <td class="r font-black text-green-700">₹${tot.toLocaleString('en-IN')}</td><td></td>
        </tr>
      </tbody>
    </table>
    <div class="mt-2 flex justify-between items-center p-3 rounded-xl text-sm" style="background:#fefce8;border:1px solid #fde68a">
      <span><b>In Words:</b> ${esc(n2w(tot))}</span>
      <span class="font-black text-green-700 ml-4">₹${tot.toLocaleString('en-IN')}</span>
    </div>
  </div>`: ''}
  <div class="flex gap-3 flex-wrap">
    <button onclick="APP.saveBillOnly()" class="fbtn fbtn-outline flex-1 justify-center text-sm" style="min-width:140px">💾 Save Bill</button>
    <button onclick="APP.saveBillAndPrint()" class="fbtn fbtn-primary flex-1 justify-center text-sm" style="min-width:180px">${ico('print')} Save &amp; Print Bill</button>
    <button onclick="APP.showForm=false;APP.billLines=[];APP.formData={};APP.render()" class="fbtn fbtn-cancel text-sm">✕ Cancel</button>
  </div>
</div>`;
    }
    h += `<div class="flex flex-wrap items-center gap-3 mb-4">${this._searchBar('bills', 'Search bills by patient, bill no, date…', '#7c3aed')}</div>`;
    return h + `<div id="lblk-bills">${this._billsBody()}</div>`;
  }
  // Results-only block for the Bills tab (card grid / empty-state / pager).
  // See _patientsBody() note — kept separate so search patches just this
  // piece instead of rebuilding the whole page and the search input with it.
  _billsBody() {
    const { list, total, pages } = this._page('bills');
    if (!this.bills.length) return `<div class="text-center py-12 text-gray-400 text-sm">No bills yet. Click + New Bill to start.</div>`;
    if (!total) return `<div class="text-center py-12 text-gray-400 text-sm">No bills match your search.</div>`;
    let g = `<div class="grid-auto">`;
    list.forEach(b => {
      const bc = centerOf(b.center); const ac = bc.color; const amt = Number(b.totalAmount) || 0;
      const inBatch = this.printBatch.includes(b.id);
      g += `<div class="card p-4 cursor-pointer" style="border-left:4px solid ${ac}" onclick="APP.viewBill('${b.id}')">
  <div class="flex justify-between items-start mb-2">
    <div class="min-w-0">
      <span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:${bc.bg};color:${ac}">${esc(bc.badge)}</span>
      <p class="font-bold text-gray-900 mt-1">${esc(b.billNo)}</p>
      <p class="text-xs text-gray-400">📅 ${esc(b.date)}</p>
    </div>
    <p class="font-black text-lg text-green-600 flex-shrink-0">₹${amt.toLocaleString('en-IN')}</p>
  </div>
  <p class="text-sm text-gray-700 truncate"><b>Patient:</b> ${esc(b.patientName)}</p>
  <p class="text-sm text-gray-600 truncate"><b>Staff:</b> ${esc(b.staffName)} <span class="text-gray-400">(${esc(b.staffType)})</span></p>
  <p class="text-xs text-gray-400 mt-1">${(b.lines || []).length} item(s)</p>
  <div class="flex flex-wrap gap-1.5 mt-3" onclick="event.stopPropagation()">
    <button onclick="APP.printBill('${b.id}')" class="fbtn text-xs py-1.5 px-2.5 flex-1 justify-center" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe">${ico('print', 'w-3.5 h-3.5')} Print</button>
    <button onclick="APP.toggleBatch('${b.id}')" class="fbtn text-xs py-1.5 px-2.5 flex-1 justify-center" style="${inBatch ? 'background:#f59e0b;color:#fff' : 'background:#f1f5f9;color:#374151;border:1px solid #e2e8f0'}">${inBatch ? '✓ In Page' : '＋ Page'}</button>
    <button onclick="APP.viewBill('${b.id}')" class="fbtn text-xs py-1.5 px-2.5 flex-1 justify-center" style="background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe">${ico('eye', 'w-3.5 h-3.5')} View</button>
    <button onclick="APP.deleteBill('${b.id}')" class="fbtn text-xs py-1.5 px-2.5 flex-1 justify-center" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca">${ico('trash', 'w-3.5 h-3.5')} Delete</button>
  </div>
</div>`;
    });
    return g + `</div>` + this._pager('bills', total, pages);
  }

  _rSheets() {
    // Google Sheets URL - Updated with your spreadsheet ID
    const spreadsheetId = '1QHZUui_pMTwZXwPgqkKkyY87e6fsEAx35Q7IBIAs4z4';
    const sheetsUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    let html = `
                <div class="sheets-container" style="padding: 20px;">
                    <div style="background: linear-gradient(135deg, #7c3aed 0%, #0d9488 100%); border-radius: 12px; padding: 30px; color: white; margin-bottom: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.1)">
                        <h2 style="margin: 0 0 10px 0; font-size: 1.8rem; font-weight: 900">📊 Google Sheets Integration</h2>
                        <p style="margin: 0; font-size: 1rem; opacity: 0.95">All your data is synced with Google Sheets. Click on any sheet below to open and edit directly.</p>
                    </div>

                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px">
                        <!-- Patient Details Sheet -->
                        <div style="background: white; border-radius: 12px; border-left: 5px solid #3b82f6; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: all 0.3s ease" onmouseover="this.style.boxShadow='0 8px 20px rgba(59, 130, 246, 0.2)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px">
                                <span style="font-size: 28px">👥</span>
                                <h3 style="margin: 0; color: #1e293b; font-size: 1.2rem; font-weight: 700">Patient Details</h3>
                            </div>
                            <p style="margin: 0 0 15px 0; color: #64748b; font-size: 0.9rem">View and manage all patient information including ID, name, contact details, address, and dates.</p>
                            <p style="margin: 0 0 15px 0; color: #94a3b8; font-size: 0.85rem"><strong>Columns:</strong> ID, Name, Address, Mobile, Date</p>
                            <a href="${sheetsUrl}#gid=0" target="_blank" style="display: inline-block; background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s" onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
                                Open Sheet ↗
                            </a>
                        </div>

                        <!-- Staff Details Sheet -->
                        <div style="background: white; border-radius: 12px; border-left: 5px solid #10b981; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: all 0.3s ease" onmouseover="this.style.boxShadow='0 8px 20px rgba(16, 185, 129, 0.2)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px">
                                <span style="font-size: 28px">👔</span>
                                <h3 style="margin: 0; color: #1e293b; font-size: 1.2rem; font-weight: 700">Staff Details</h3>
                            </div>
                            <p style="margin: 0 0 15px 0; color: #64748b; font-size: 0.9rem">Manage staff members with their nicknames, roles, contact info, AADHAR, PAN, rates, dates, and photo uploads.</p>
                            <p style="margin: 0 0 15px 0; color: #94a3b8; font-size: 0.85rem"><strong>Columns:</strong> ID, Name, Nickname, Mobile, Type, Rate, Start Date, AADHAR, PAN, Aadhar Photo 1, Aadhar Photo 2, PAN Photo 1, PAN Photo 2</p>
                            <a href="${sheetsUrl}#gid=474513622" target="_blank" style="display: inline-block; background: #10b981; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s" onmouseover="this.style.background='#059669'" onmouseout="this.style.background='#10b981'">
                                Open Sheet ↗
                            </a>
                        </div>

                        <!-- Manav Seva Kalyan Bill -->
                        <div style="background: white; border-radius: 12px; border-left: 5px solid #7c3aed; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: all 0.3s ease" onmouseover="this.style.boxShadow='0 8px 20px rgba(124, 58, 237, 0.2)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px">
                                <span style="font-size: 28px">📋</span>
                                <h3 style="margin: 0; color: #1e293b; font-size: 1.2rem; font-weight: 700">MSK Bills</h3>
                            </div>
                            <p style="margin: 0 0 15px 0; color: #64748b; font-size: 0.9rem">Billing records for Manav Seva Kalyan Centre with patient, staff, and payment details.</p>
                            <p style="margin: 0 0 15px 0; color: #94a3b8; font-size: 0.85rem"><strong>Columns:</strong> Bill No, Date, Patient, Staff, SNo, Rate, Amount, Total</p>
                            <a href="${sheetsUrl}#gid=1102806989" target="_blank" style="display: inline-block; background: #7c3aed; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s" onmouseover="this.style.background='#6d28d9'" onmouseout="this.style.background='#7c3aed'">
                                Open Sheet ↗
                            </a>
                        </div>

                        <!-- Patient Care Center Bill -->
                        <div style="background: white; border-radius: 12px; border-left: 5px solid #0d9488; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: all 0.3s ease" onmouseover="this.style.boxShadow='0 8px 20px rgba(13, 148, 136, 0.2)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px">
                                <span style="font-size: 28px">🏥</span>
                                <h3 style="margin: 0; color: #1e293b; font-size: 1.2rem; font-weight: 700">PCC Bills</h3>
                            </div>
                            <p style="margin: 0 0 15px 0; color: #64748b; font-size: 0.9rem">Billing records for Patient Care Centre with complete service and payment information.</p>
                            <p style="margin: 0 0 15px 0; color: #94a3b8; font-size: 0.85rem"><strong>Columns:</strong> Bill No, Date, Patient, Staff, SNo, Rate, Amount, Total</p>
                            <a href="${sheetsUrl}#gid=1268298933" target="_blank" style="display: inline-block; background: #0d9488; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s" onmouseover="this.style.background='#0f766e'" onmouseout="this.style.background='#0d9488'">
                                Open Sheet ↗
                            </a>
                        </div>

                        <!-- Manav Seva Care Centre Bill (NEW) -->
                        <div style="background: white; border-radius: 12px; border-left: 5px solid #dc2626; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: all 0.3s ease" onmouseover="this.style.boxShadow='0 8px 20px rgba(220, 38, 38, 0.2)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px">
                                <span style="font-size: 28px">🩺</span>
                                <h3 style="margin: 0; color: #1e293b; font-size: 1.2rem; font-weight: 700">MSC Bills</h3>
                            </div>
                            <p style="margin: 0 0 15px 0; color: #64748b; font-size: 0.9rem">Billing records for Manav Seva Care Centre with patient, staff, and payment details.</p>
                            <p style="margin: 0 0 15px 0; color: #94a3b8; font-size: 0.85rem"><strong>Columns:</strong> Bill No, Date, Patient, Staff, SNo, Rate, Amount, Total</p>
                            <a href="${sheetsUrl}" target="_blank" style="display: inline-block; background: #dc2626; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s" onmouseover="this.style.background='#b91c1c'" onmouseout="this.style.background='#dc2626'">
                                Open Sheet ↗
                            </a>
                        </div>
                    </div>

                    <!-- Quick Actions -->
                    <div style="background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 20px">
                        <h3 style="margin: 0 0 15px 0; color: #1e293b; font-size: 1.1rem; font-weight: 700">⚡ Quick Actions</h3>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap">
                            <a href="${sheetsUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 8px; background: white; border: 1.5px solid #3b82f6; color: #3b82f6; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; transition: all 0.2s" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background='white'">
                                📄 Open Full Spreadsheet
                            </a>
                            <a href="${sheetsUrl}" target="_blank" onclick="navigator.clipboard.writeText('${sheetsUrl}'); return false;" style="display: inline-flex; align-items: center; gap: 8px; background: white; border: 1.5px solid #10b981; color: #10b981; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: pointer; transition: all 0.2s" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='white'">
                                🔗 Copy Link
                            </a>
                        </div>
                    </div>

                    <!-- Info Box -->
                    <div style="background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 8px; padding: 16px; color: #1e7c4e">
                        <p style="margin: 0; font-weight: 600">✅ Data Sync Status: Active</p>
                        <p style="margin: 8px 0 0 0; font-size: 0.9rem; opacity: 0.8">Your local data and Google Sheets are synchronized. Changes in this app and the spreadsheet are kept in sync.</p>
                    </div>
                </div>`;

    return html;
  }
}/* end App */
/* end App */

/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
let APP;
function initApp() { APP = window.APP = new App(); }

// Press Enter anywhere in an add/edit form to trigger its primary action
// (Save / Add) — no need to click the button. Textareas keep their normal
// newline behaviour, and dialogs/search boxes handle Enter on their own, so
// they're skipped here.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (!t || !t.tagName) return;
  const tag = t.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
  if (tag !== 'INPUT' && tag !== 'SELECT') return;
  // Let dialog overlays, the login screen and the search boxes manage Enter.
  if (t.closest && (t.closest('#dlg-overlay') || t.closest('#login-screen'))) return;
  // Skip the search box and the date-range filter bar — those aren't forms.
  if (t.closest && (t.closest('.search-wrap') || t.closest('.date-range'))) return;
  if (!window.APP || !APP.showForm) return;
  e.preventDefault();
  APP.submitForm();
});

// Pull other devices' new records down promptly — not only on a full page
// reload. autoPull skips while a form is open so it can't disrupt data entry,
// and pullFromServer is a no-op when nothing changed.
const autoPull = () => { if (APP && !APP.showForm && navigator.onLine) pullFromServer(APP); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) { drainQueue(); autoPull(); } });
window.addEventListener('focus', () => { if (navigator.onLine) autoPull(); });
// Light background poll (~20s) so records added on another device appear
// without a manual refresh.
setInterval(() => { if (!document.hidden) autoPull(); }, 20000);
// Check auth on load
if (checkAuth()) initApp();
if (navigator.onLine) drainQueue();