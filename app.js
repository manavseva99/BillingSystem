'use strict';
/* ══════════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════════ */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyOUmx4CMaEE6JiGYtdmk84Ek96Uw0zsWQCTitdEf1JQ7ZBIt0OvhaTaon_2EOQqhn2/exec';
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
const DB_NAME = 'HospitalBMS3', DB_VER = 2;
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
      { name: 'bills', indexes: ['createdAt', 'center', 'patientName', 'billNo'] }
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
const calcDays = (s, e) => { if (!s || !e) return 0; const ms = new Date(e) - new Date(s); return ms < 0 ? 0 : Math.round(ms / 864e5) + 1 };
const byDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
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
  (records || []).forEach(r => { const n = parseInt(String(r.id).replace(/\D/g, ''), 10); if (Number.isFinite(n) && n > max) max = n; });
  return max + 1;
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
  <p>How many copies do you want to print on this page? (1 to 4)</p>
  <input id="dlg-input" type="number" min="1" max="4" value="1" inputmode="numeric">
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
      if (n > 4) n = 4;
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
      catch (e) { if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt)); else { console.warn('[GAS]', e.message); anyFailed = true } }
    }
    // Remove this item the instant it succeeds — we no longer rewrite
    // the whole queue as one blob, so a single huge item can't block or
    // corrupt the rest of the queue, and storage shrinks immediately.
    if (ok) { try { await qDelete(item.qid) } catch (e) { console.warn('Queue cleanup failed', e) } }
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

const syncStaff = (s, act) => enq({
  action: act, sheetName: 'Staff Details', data: {
    ID: s.id,
    Name: s.name,
    Nickname: s.nickname || '',
    Mobile: s.mobile,
    Type: s.type,
    AADHAR: s.aadhar || '',
    PAN: s.pan || '',
    Rate: s.rate || '',
    StartDate: fmtDate(s.startDate || ''),
    Date: todayStr(),
    // Base64 data URLs — the Apps Script backend decodes these and
    // embeds them directly into the sheet (e.g. via insertImage),
    // no Google Drive connection needed.
    Photo: s.photo || '',
    // Send EVERY uploaded file as an array (not just the first one) so
    // the backend saves each Aadhar/PAN file to Drive individually and
    // links every single one in the AadharPhotoLink/PanPhotoLink columns.
    AadharPhoto: (s.saadharPhotos || []).map(f => f.data),
    AadharPhotoNames: (s.saadharPhotos || []).map(f => f.name).join(', '),
    PanPhoto: (s.panPhotos || []).map(f => f.data),
    PanPhotoNames: (s.panPhotos || []).map(f => f.name).join(', '),
    AdditionalDocName: (s.additionalDoc && s.additionalDoc.name) || '',
    AdditionalDoc: (s.additionalDoc && s.additionalDoc.data) || (typeof s.additionalDoc === 'string' ? s.additionalDoc : '')
  }
});

const syncDel = (sheet, key, val) => enq({ action: 'delete', sheetName: sheet, data: { [key]: val } });

function syncBill(b) {
  const sheet = b.center === 'MANAV_SEVA' ? 'Manav Seva Kalyan Bill' : 'Patient Care Centre Bill';
  (b.lines || []).forEach((l, i) => enq({
    action: 'append', sheetName: sheet, data: {
      ID: b.id,
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
      Words: i === 0 ? b.amountInWords : ''
    }
  }));
}

/* ══════════════════════════════════════════════════════════
   PRINT  — Single bill, exact size.
   User is asked via prompt() how many copies (1-4) to print on the page.
══════════════════════════════════════════════════════════ */
function buildBillHTML(bill) {
  const isM = bill.center === 'MANAV_SEVA';
  const cTitle = isM ? 'MANAV SEVA KALYAN' : 'PATIENT CARE CENTRE';
  const cSub = isM ? 'CARE CENTRE' : '';
  const addr = isM
    ? 'BMC MARKET OFFICE NO. 21, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056'
    : 'BMC MARKET OFFICE NO. 22, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056';
  const total = Number(bill.totalAmount) || 0;
  const words = bill.amountInWords || n2w(total);
  const foot = isM ? 'MANAV SEVA KALYAN' : 'PATIENT CARE CENTRE';
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
    <span>Bill No: <b>${esc(bill.billNo)}</b></span>
    <span>Date: <b>${todayStr()}</b></span>
  </div>
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
  <div class="b-total-row">
    <div class="words"><b>Total (In Words):</b> ${esc(words)}</div>
    <div class="amt">TOTAL: &#8377;${total.toLocaleString('en-IN')}</div>
  </div>
  <div class="b-sig">
    <div class="b-sig-i">
      <div class="b-sig-space"></div>
      <div style="font-weight:700">Authorised Signature</div>
      <div style="font-weight:900">${foot}</div>
    </div>
  </div>
  <div class="b-eoe">E. &amp; O.E.</div>
</div>`;
}
async function doPrint(bills) {
  // Ask the user how many copies of THIS page (all bills passed in) to print
  const n = await askCopies();
  if (n === null) return; // user cancelled

  // Build one box per copy, then chunk into groups of 4 (2x2 grid = one A4 page)
  const boxesArr = [];
  for (let c = 0; c < n; c++) boxesArr.push(bills.map(b => buildBillHTML(b)).join(''));

  const pages = [];
  for (let i = 0; i < boxesArr.length; i += 4) pages.push(boxesArr.slice(i, i + 4));

  const sheet = document.getElementById('print-sheet');
  sheet.innerHTML = pages.map(p => `<div class="p-page">${p.join('')}</div>`).join('');
  // Wait for the browser to actually paint the newly-injected content
  // before printing. Without this, mobile browsers' "Save as PDF" can
  // snapshot the page before layout/paint has caught up with the
  // innerHTML change above, producing a blank page. Double
  // requestAnimationFrame guarantees at least one full paint has
  // happened (the first rAF fires before the next paint, the second
  // fires after it).
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
  setTimeout(() => { sheet.innerHTML = '' }, 1500);
}

/* ══════════════════════════════════════════════════════════
   SVG ICONS
══════════════════════════════════════════════════════════ */
const I = {
  patients: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
  staff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`,
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
   APP CLASS
══════════════════════════════════════════════════════════ */
class App {
  constructor() {
    this.tab = 'patients';
    this.showForm = false; this.formType = null; this.formData = {};
    this.editingId = null; this.viewId = null; this.billLines = [];
    this.syncStatus = 'idle'; this.printBatch = [];
    this.patients = []; this.staff = []; this.bills = [];
    // search state — plain object, NOT reactive, preserved across renders
    this.search = { patients: '', staff: '', bills: '' };
    this.page = { patients: 0, staff: 0, bills: 0 };
    this.loading = true;
    this._boot();
  }

  async _boot() {
    this.render();
    try {
      await openDB();
      const [p, s, b] = await Promise.all([dbAll('patients'), dbAll('staff'), dbAll('bills')]);
      this.patients = p.sort(byDate); this.staff = s.sort(byDate); this.bills = b.sort(byDate);
      IDX.patients.build(this.patients); IDX.staff.build(this.staff); IDX.bills.build(this.bills);
    } catch (e) {
      console.warn('[IDB fallback]', e);
      const ls = k => { try { return JSON.parse(localStorage.getItem('hbm_' + k) || '[]') } catch { return [] } };
      this.patients = ls('patients'); this.staff = ls('staff'); this.bills = ls('bills');
      IDX.patients.build(this.patients); IDX.staff.build(this.staff); IDX.bills.build(this.bills);
    }
    await this._migrateIds();
    await this._migrateBillIds();
    await migrateLegacyQueue_();
    await refreshPendingCount_();
    this.loading = false; this.render();
    setTimeout(drainQueue, 1500);
  }

  // ONE-TIME CLEANUP: older versions of this app gave new staff/patients a
  // Date.now() timestamp as their ID (e.g. "1782815138996"). This renumbers
  // any such records — oldest first — to clean sequential IDs (1, 2, 3…),
  // fixes the corresponding bill references so "Bills" history still shows
  // correctly, and pushes the rename to Google Sheets (delete old ID row,
  // append the corrected one). Already-clean IDs are left untouched, and it
  // only runs once per device.
  async _migrateIds() {
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

  // ONE-TIME CLEANUP (bills): older bills got a 'B' + Date.now() ID
  // (e.g. "B1782898230..."). This renumbers them — oldest first — to
  // clean sequential IDs (1, 2, 3…), same as Patients/Staff. Since a
  // bill can span MULTIPLE rows in its sheet (one row per line item),
  // it deletes every one of that bill's old rows (one syncDel per
  // line) before re-appending all lines under the new ID — so no
  // duplicate or orphaned rows are left behind. Already-clean IDs are
  // left untouched, and it only runs once per device.
  async _migrateBillIds() {
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
      const sheetName = b.center === 'MANAV_SEVA' ? 'Manav Seva Kalyan Bill' : 'Patient Care Centre Bill';
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
  _search(key, q) {
    this.search[key] = q;
    this.page[key] = 0;
    schedRender();
  }
  _filtered(key) {
    const q = (this.search[key] || '').trim();
    // A pure-number query is treated as an ID lookup first — e.g. typing
    // "5" finds staff/patient #5 (and #50, #51…) without being diluted by
    // unrelated numeric matches like rate or mobile number digits.
    if (q && /^\d+$/.test(q) && (key === 'staff' || key === 'patients')) {
      const byId = this[key].filter(r => String(r.id) === q || String(r.id).startsWith(q));
      if (byId.length) return byId;
    }
    return IDX[key].search(this.search[key], this[key]);
  }
  _page(key) {
    const f = this._filtered(key);
    const s = this.page[key] * PAGE_SIZE;
    return { list: f.slice(s, s + PAGE_SIZE), total: f.length, pages: Math.ceil(f.length / PAGE_SIZE) };
  }

  setTab(t) {
    this.tab = t; this.showForm = false; this.viewId = null;
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
    await this._save('staff', s); syncStaff(s, isEdit ? 'update' : 'append');
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
  handleFile(e, key) {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 2097152) { toast('Image must be under 2 MB', 'error'); return }
    const r = new FileReader(); r.onload = ev => { this.formData[key] = ev.target.result; this.render() }; r.readAsDataURL(f);
  }
  // Accepts images, PDFs, and Word docs. Stores {data, name, type} so non-image
  // files (PDF/DOC) can be identified and previewed/downloaded later.
  handleDocFile(e, key) {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5242880) { toast('File must be under 5 MB', 'error'); return }
    const r = new FileReader();
    r.onload = ev => {
      this.formData[key] = { data: ev.target.result, name: f.name, type: f.type || '' };
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
    this.billLines.push({ no: this.billLines.length + 1, duty: fd.bduty || 'Home', startDate: fd.bstartDate, endDate: fd.bendDate, days, shift: fd.bshift || 'Day', rate, amount: days * rate });
    Object.assign(fd, { bduty: 'Home', bstartDate: '', bendDate: '', bdays: '', bshift: 'Day', brate: '' });
    this.render();
  }
  removeLine(i) { this.billLines.splice(i, 1); this.billLines.forEach((l, x) => l.no = x + 1); this.render() }
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
    const pfx = fd.bcenter === 'MANAV_SEVA' ? 'MSK' : 'PCC';
    const b = {
      id: String(nextSeqId(this.bills)), center: fd.bcenter,
      billNo: nextBillNo(pfx, this.bills), date: todayStr(), generatedDate: todayStr(),
      patientId: fd.bpatient, patientName: pat ? pat.name : '', patientAddress: pat ? pat.address || '' : '',
      staffId: fd.bstaff, staffName: sta ? sta.name : '', staffType: sta ? sta.type : '',
      lines: JSON.parse(JSON.stringify(this.billLines)),
      totalAmount: total, amountInWords: n2w(total),
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
    if (b) syncDel(b.center === 'MANAV_SEVA' ? 'Manav Seva Kalyan Bill' : 'Patient Care Centre Bill', 'BillNo', b.billNo);
    this.render(); toast('Bill deleted', 'info');
  }
  printBill(id) { const b = this.bills.find(x => x.id === id); if (!b) { toast('Bill not found', 'error'); return } doPrint([b]) }
  viewBill(id) { this.viewId = id; this.render() }
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
    else if (this.tab === 'patients') body = this._rPatients();
    else if (this.tab === 'staff') body = this._rStaff();
    else body = this._rBills();
    const main = `<main class="max-w-7xl mx-auto px-3 sm:px-5 py-5 no-print">${body}</main>`;
    const mnav = `<nav id="mobile-nav" class="no-print" role="navigation">
  ${[['patients', 'Patients', I.patients], ['staff', 'Staff', I.staff], ['bills', 'Bills', I.bills]].map(([k, l, ic]) => `
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

  _navBtns() {
    return [['patients', 'Patients', this.patients.length, '#3b82f6'], ['staff', 'Staff', this.staff.length, '#10b981'], ['bills', 'Bills', this.bills.length, '#7c3aed']].map(([k, l, cnt, c]) => `
<button onclick="APP.setTab('${k}')" class="nav-btn${this.tab === k ? ' active' : ''}" style="${this.tab === k ? `background:${c};color:#fff;box-shadow:0 6px 16px ${c}55` : ''}">
  <span class="nav-btn-ic" style="background:${this.tab === k ? 'rgba(255,255,255,.22)' : c + '1a'};color:${this.tab === k ? '#fff' : c}">${I[k]}</span>
  <span>${l}</span>
  <span class="badge" style="background:${this.tab === k ? 'rgba(255,255,255,.25)' : '#fff'};color:${this.tab === k ? '#fff' : '#64748b'}">${typeof cnt === 'number' ? cnt : cnt}</span>
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
    return `<div class="search-wrap flex-1 min-w-[180px] max-w-sm">
  <svg class="s-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"/></svg>
  <input class="search-inp" id="srch-${key}" placeholder="${ph}" value="${q}"
    oninput="APP._search('${key}',this.value)" autocomplete="off" spellcheck="false">
  <button class="search-clear" onclick="APP._search('${key}','');document.getElementById('srch-${key}').value=''" title="Clear">✕</button>
</div>`;
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
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Patient / Party ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#dbeafe;color:#1d4ed8">Will be ID #${nextSeqId(this.patients)}</span>`}</h3>
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
    const { list, total, pages } = this._page('patients');
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='patient';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#3b82f6;color:#fff">${ico('plus')} Add Patient</button>
  ${this._searchBar('patients', 'Search patients by name, ID, mobile…', '#3b82f6')}
  <span class="text-xs text-gray-400 font-medium">${total} record${total !== 1 ? 's' : ''}</span>
</div>
${!total ? `<div class="text-center py-16 text-gray-400 text-sm">${this.search.patients ? 'No patients match.' : 'No patients yet.'}</div>` :
        `<div class="grid-auto">
${list.map(p => `
<div class="card p-4 cursor-pointer" style="border-left:4px solid #3b82f6" onclick="APP.viewId='${p.id}';APP.render()">
  <div class="flex items-center gap-3">
    <div class="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0 text-blue-500 overflow-hidden">${p.photo ? `<img src="${p.photo}" class="w-10 h-10 rounded-full object-cover">` : '👤'}</div>
    <div class="min-w-0">
      <div class="flex items-center gap-1.5"><p class="font-bold text-gray-900 truncate">${esc(p.name)}</p><span class="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0" style="background:#eff6ff;color:#93c5fd">#${esc(p.id)}</span></div>
      <p class="text-xs text-gray-500">📞 ${esc(p.mobile)}</p>
    </div>
  </div>
</div>`).join('')}
</div>${this._pager('patients', total, pages)}`}`;
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
      ${s.photo ? `<img src="${s.photo}" class="w-14 h-14 rounded-full object-cover flex-shrink-0 border-2 border-green-200">` : `<div class="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0 text-2xl">👤</div>`}
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
  </div>` : `<div class="mt-3"><p class="text-xs font-bold text-gray-400 mb-1">AADHAR CARD</p><p class="text-xs text-gray-300">No file uploaded</p></div>`}
  ${s.panPhotos && s.panPhotos.length ? `<div class="mt-3">
    <p class="text-xs font-bold text-gray-400 mb-2">PAN CARD (${s.panPhotos.length} file${s.panPhotos.length > 1 ? 's' : ''})</p>
    <div class="flex gap-2 flex-wrap">
      ${s.panPhotos.map((f, i) => fileChip(f, `APP.openDoc('${s.id}','pan${i}')`, f.name)).join('')}
    </div>
  </div>` : `<div class="mt-3"><p class="text-xs font-bold text-gray-400 mb-1">PAN CARD</p><p class="text-xs text-gray-300">No file uploaded</p></div>`}
  ${s.additionalDoc ? `<div class="mt-3">
    <p class="text-xs font-bold text-gray-400 mb-1">ADDITIONAL DOCUMENT</p>
    ${fileChip(s.additionalDoc, `APP.openDoc('${s.id}')`, s.additionalDoc.name)}
  </div>` : ''}
</div>`;
    }
    if (this.showForm && this.formType === 'staff') {
      return `
<button onclick="APP.showForm=false;APP.editingId=null;APP.formData={};APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
  <h3 class="font-bold text-base mb-4 flex items-center gap-2">${this.editingId ? 'Edit' : 'Add'} Staff Member ${this.editingId ? `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#f1f5f9;color:#94a3b8">ID #${esc(this.editingId)}</span>` : `<span class="text-xs font-semibold px-2 py-0.5 rounded" style="background:#dcfce7;color:#15803d">Will be ID #${nextSeqId(this.staff)}</span>`}</h3>
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
          <button type="button" onclick="event.stopPropagation();APP.formData.saadharPhotos.splice(${i},1);APP.render()" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700">×</button>
        </div>`;
      }).join('')}
      </div>` : ''}</div>
    <div><label class="flbl">PAN Card Upload (Image / PDF / DOC - Multiple files)</label>
      <input type="file" accept="image/*,.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple onchange="APP.handleMultipleFiles(event,'panPhotos')" class="finp text-xs cursor-pointer" style="padding:6px">
      ${fd.panPhotos && fd.panPhotos.length ? `<div class="mt-2 flex flex-col gap-1">
        ${(fd.panPhotos || []).map((f, i) => {
        const m = FILE_KIND_META[fileKind(f)]; return `<div class="flex items-center gap-2 text-xs">
          <span style="background:${m.bg};color:${m.fg};padding:4px 8px;border-radius:8px;font-weight:700">${m.icon} ${m.label} · ${esc(f.name || 'File ' + (i + 1))}</span>
          <button type="button" onclick="event.stopPropagation();APP.formData.panPhotos.splice(${i},1);APP.render()" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:700">×</button>
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
    const { list, total, pages } = this._page('staff');
    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <button onclick="APP.formType='staff';APP.showForm=true;APP.editingId=null;APP.formData={};APP.render()" class="fbtn" style="background:#10b981;color:#fff">${ico('plus')} Add Staff</button>
  ${this._searchBar('staff', 'Search staff by name, ID, mobile…', '#10b981')}
  <span class="text-xs text-gray-400 font-medium">${total} record${total !== 1 ? 's' : ''}</span>
</div>
${!total ? `<div class="text-center py-16 text-gray-400 text-sm">${this.search.staff ? 'No staff match.' : 'No staff yet.'}</div>` :
        `<div class="grid-auto">
${list.map(s => `
<div class="card p-4 cursor-pointer" style="border-left:4px solid #10b981" onclick="APP.viewId='${s.id}';APP.render()">
  <div class="flex items-center gap-3">
    ${s.photo ? `<img src="${s.photo}" class="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-green-200">` : `<div class="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0 text-green-600">👤</div>`}
    <div class="min-w-0">
      <p class="font-bold text-gray-900 truncate">${esc(s.name)}${s.nickname ? ` <span class="text-xs font-normal text-gray-400">"${esc(s.nickname)}"</span>` : ''}</p>
      <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
        <span class="text-xs font-bold px-1.5 py-0.5 rounded" style="background:#dcfce7;color:#15803d">${esc(s.type)}</span>
        ${s.rate ? `<span class="text-xs font-semibold px-1.5 py-0.5 rounded" style="background:#fef3c7;color:#92400e">₹${Number(s.rate).toLocaleString('en-IN')}</span>` : ''}
        ${s.startDate ? `<span class="text-xs text-gray-500">📅 ${fmtDate(s.startDate)}</span>` : ''}
        <span class="text-xs text-gray-500">📞 ${esc(s.mobile)}</span>
        ${(s.additionalDoc || (s.saadharPhotos && s.saadharPhotos.length) || (s.panPhotos && s.panPhotos.length)) ? `<span class="text-xs" title="Documents on file">📎</span>` : ''}
      </div>
    </div>
  </div>
</div>`).join('')}
</div>${this._pager('staff', total, pages)}`}`;
  }

  /* ════ BILLS RENDER ════ */
  _rBills() {
    const fd = this.formData;
    const msk = this.bills.filter(b => b.center === 'MANAV_SEVA').length;
    const pcc = this.bills.filter(b => b.center === 'PATIENT_CARE').length;
    if (this.viewId && !this.showForm) {
      const b = this.bills.find(x => x.id === this.viewId);
      if (!b) { this.viewId = null; return this._rBills() }
      const isM = b.center === 'MANAV_SEVA'; const ac = isM ? '#7c3aed' : '#0d9488';
      return `
<button onclick="APP.viewId=null;APP.render()" class="fbtn fbtn-cancel mb-4 text-sm">${ico('back')} Back to Bills</button>
<div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 w-full max-w-2xl mx-auto">
  <div class="flex items-center justify-between mb-4">
    <div>
      <span class="text-xs font-bold px-2.5 py-1 rounded-full" style="background:${isM ? '#ede9fe' : '#ccfbf1'};color:${ac}">${isM ? 'Manav Seva Kalyan' : 'Patient Care Centre'}</span>
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
      <span class="text-xs font-bold px-2.5 py-1 rounded-full" style="background:#ede9fe;color:#6d28d9">MSK: ${msk}</span>
      <span class="text-xs font-bold px-2.5 py-1 rounded-full" style="background:#ccfbf1;color:#0f766e">PCC: ${pcc}</span>
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
        <option value="MANAV_SEVA" ${fd.bcenter === 'MANAV_SEVA' ? 'selected' : ''}>Manav Seva Kalyan</option>
        <option value="PATIENT_CARE" ${fd.bcenter === 'PATIENT_CARE' ? 'selected' : ''}>Patient Care Centre</option>
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
  </div>
  ${fd.bcenter ? `<div class="rounded-xl p-3 mb-4 text-center" style="background:#faf5ff;border:1.5px dashed #a78bfa">
    <div class="font-black text-red-800 text-sm">${fd.bcenter === 'MANAV_SEVA' ? 'MANAV SEVA KALYAN' : 'PATIENT CARE CENTRE'}</div>
    ${fd.bcenter === 'MANAV_SEVA' ? '<div class="font-bold text-xs">CARE CENTRE</div>' : ''}
    <div class="text-xs font-semibold text-gray-600 mt-0.5">${fd.bcenter === 'MANAV_SEVA' ? 'BMC MARKET OFFICE NO. 21' : 'BMC MARKET OFFICE NO. 22'}, BAPISTA ROAD, VILE PARLE(W), MUMBAI - 400056</div>
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
    const { list, total, pages } = this._page('bills');
    h += `<div class="mb-4">${this._searchBar('bills', 'Search bills by patient, bill no, date…', '#7c3aed')}</div>`;
    if (!this.bills.length) return h + `<div class="text-center py-12 text-gray-400 text-sm">No bills yet. Click + New Bill to start.</div>`;
    if (!total) return h + `<div class="text-center py-12 text-gray-400 text-sm">No bills match your search.</div>`;
    h += `<div class="grid-auto">`;
    list.forEach(b => {
      const isM = b.center === 'MANAV_SEVA'; const ac = isM ? '#7c3aed' : '#0d9488'; const amt = Number(b.totalAmount) || 0;
      const inBatch = this.printBatch.includes(b.id);
      h += `<div class="card p-4 cursor-pointer" style="border-left:4px solid ${ac}" onclick="APP.viewBill('${b.id}')">
  <div class="flex justify-between items-start mb-2">
    <div class="min-w-0">
      <span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:${isM ? '#ede9fe' : '#ccfbf1'};color:${ac}">${isM ? 'MSK' : 'PCC'}</span>
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
    return h + `</div>` + this._pager('bills', total, pages);
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) drainQueue() });
// Check auth on load
if (checkAuth()) initApp();
if (navigator.onLine) drainQueue();