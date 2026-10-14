/* =====================================================================
 *  RENT MANAGER — common.js : config · pure calculations · API · session · header/nav · sheets
 *  The only thing to configure: API_URL
 * ===================================================================== */
(function () {
  'use strict';

  /* ============ CONFIG: paste your Apps Script Web App URL ============ */
  const API_URL = 'https://script.google.com/macros/s/AKfycbxcOTkBRuRPQw-Dud-OAgU7uiN37AXWZY2d2_x4TFzTdB9l8-0WSiWD6HaETSx7p5k5/exec';   // https://script.google.com/macros/s/XXXX/exec
  const APP_NAME = 'Rent Manager';
  /* =================================================================== */

  const SESSION_KEY = 'rent_session_v1';
  const FLASH_KEY = 'rent_flash_v1';

  /* ============================ pure helpers ============================ */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayKey = () => ymd(new Date());
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  function addMonths(key, n) {
    const p = key.split('-').map(Number), d = new Date(p[0], p[1] - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function monthsBetween(a, b) {
    const out = []; let k = a, guard = 0;
    while (k <= b && guard++ < 1200) { out.push(k); k = addMonths(k, 1); }
    return out;
  }
  const daysInMonth = (key) => { const p = key.split('-').map(Number); return new Date(p[0], p[1], 0).getDate(); };
  const dueDateFor = (key, dueDay) => key + '-' + pad(Math.min(Math.max(1, Number(dueDay) || 1), daysInMonth(key)));
  function monthLabel(key, style) {          // 'm' → Oct · 'my' → Oct 2026 · 'long' → October 2026
    const p = key.split('-').map(Number), d = new Date(p[0], p[1] - 1, 1);
    if (style === 'm') return d.toLocaleDateString('en-IN', { month: 'short' });
    return d.toLocaleDateString('en-IN', { month: style === 'long' ? 'long' : 'short', year: 'numeric' });
  }
  function dateLabel(s) {
    if (!s) return '';
    const p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const sortBy = (arr, f) => arr.slice().sort((a, b) => { const x = f(a), y = f(b); return x < y ? -1 : x > y ? 1 : 0; });

  /* -------- rent status (computed here, from the transactions) --------
   * Month rent = Rent_Due of that month's last Rent entry (so old months keep the old rent),
   * or the tenant's current Monthly_Rent when the month has no entry.
   * Paid = sum of that month's Rent entries. Statuses: Paid · Partial · Due · Overdue · Upcoming · NA            */
  function rentEntriesByMonth(txns, tenantId) {
    const by = {};
    txns.forEach((x) => { if (x.type === 'Rent' && x.tenant_id === tenantId && x.rent_month) (by[x.rent_month] = by[x.rent_month] || []).push(x); });
    Object.keys(by).forEach((k) => { by[k] = sortBy(by[k], (x) => x.date); });
    return by;
  }
  function monthStatus(t, key, list, today) {
    list = list || [];
    const startKey = (t.lease_start || '').slice(0, 7), endKey = (t.lease_end || '').slice(0, 7);
    const inLease = (!startKey || key >= startKey) && (!endKey || key <= endKey);
    const dueDate = dueDateFor(key, t.due_day);
    const paid = round2(list.reduce((s, x) => s + (Number(x.amount) || 0), 0));
    let rentDue = Number(t.monthly_rent) || 0;
    for (let i = list.length - 1; i >= 0; i--) { if (list[i].rent_due > 0) { rentDue = list[i].rent_due; break; } }
    const base = { key, due_date: dueDate, rent_due: rentDue, paid, balance: Math.max(0, round2(rentDue - paid)), entries: list };
    if (!list.length && !inLease) return Object.assign(base, { status: 'NA', rent_due: 0, balance: 0 });
    let status;
    if (list.length && paid >= rentDue) status = 'Paid';
    else if (paid > 0) status = 'Partial';
    else if (today > dueDate) status = 'Overdue';
    else status = key <= today.slice(0, 7) ? 'Due' : 'Upcoming';
    return Object.assign(base, { status });
  }
  function yearTable(t, year, txns, today) {
    const by = rentEntriesByMonth(txns, t.id);
    return monthsBetween(year + '-01', year + '-12').map((k) => monthStatus(t, k, by[k], today));
  }
  /** First month (from lease start up to next month) that is not Paid; null when everything is settled. */
  function nextDue(t, txns, today) {
    const by = rentEntriesByMonth(txns, t.id), cur = today.slice(0, 7), nextKey = addMonths(cur, 1);
    const startKey = (t.lease_start || today).slice(0, 7), endKey = (t.lease_end || '').slice(0, 7);
    if (startKey > nextKey) return monthStatus(t, startKey, by[startKey], today);
    const last = endKey && endKey < nextKey ? endKey : nextKey;
    for (const k of monthsBetween(startKey, last)) {
      const s = monthStatus(t, k, by[k], today);
      if (s.status !== 'Paid' && s.status !== 'NA') return s;
    }
    return null;
  }
  /** Money already past its due date: Overdue months + Partial months whose due date has passed. */
  function outstanding(t, txns, today) {
    const by = rentEntriesByMonth(txns, t.id), cur = today.slice(0, 7);
    const startKey = (t.lease_start || cur).slice(0, 7), endKey = (t.lease_end || '').slice(0, 7);
    const last = endKey && endKey < cur ? endKey : cur;
    let amount = 0; const months = [];
    monthsBetween(startKey, last).forEach((k) => {
      const s = monthStatus(t, k, by[k], today);
      if ((s.status === 'Overdue' || s.status === 'Partial') && today > s.due_date && s.balance > 0) { amount += s.balance; months.push(k); }
    });
    return { amount: round2(amount), months };
  }
  function depositInfo(t, txns) {
    let received = 0, refunded = 0;
    txns.forEach((x) => {
      if (x.tenant_id !== t.id) return;
      if (x.type === 'Deposit Received') received += x.amount; else if (x.type === 'Deposit Refund') refunded += x.amount;
    });
    received = round2(received); refunded = round2(refunded);
    return { agreed: Number(t.deposit) || 0, received, refunded, held: round2(received - refunded), pending: Math.max(0, round2((Number(t.deposit) || 0) - received)) };
  }
  /** Cash view for a date range. pid = null → all properties. Net = Rent − Expense − Payout (deposits are separate). */
  function propertyReport(txns, pid, from, to) {
    const r = { rent: 0, expense: 0, payout: 0, deposit_in: 0, deposit_out: 0 };
    txns.forEach((x) => {
      if ((pid && x.property_id !== pid) || x.date < from || x.date > to) return;
      if (x.type === 'Rent') r.rent += x.amount; else if (x.type === 'Expense') r.expense += x.amount; else if (x.type === 'Payout') r.payout += x.amount;
      else if (x.type === 'Deposit Received') r.deposit_in += x.amount; else if (x.type === 'Deposit Refund') r.deposit_out += x.amount;
    });
    Object.keys(r).forEach((k) => { r[k] = round2(r[k]); });
    r.net = round2(r.rent - r.expense - r.payout);
    return r;
  }
  function analyze(data, from, to) {
    const props = sortBy(data.properties, (p) => (p.status === 'Active' ? '0' : '1') + p.name.toLowerCase())
      .map((p) => Object.assign({}, p, propertyReport(data.txns, p.id, from, to)));
    const tenants = data.tenants.map((t) => {
      const rent = round2(data.txns.reduce((s, x) => s + (x.type === 'Rent' && x.tenant_id === t.id && x.date >= from && x.date <= to ? x.amount : 0), 0));
      return Object.assign({}, t, { rent_received: rent });
    }).filter((t) => t.rent_received > 0 || t.status === 'Active');
    return { props, total: propertyReport(data.txns, null, from, to), tenants };
  }
  /** Range picker state → {from, to}. mode 'year' (default) or 'custom'. */
  function rangeOf(s) { return s.mode === 'custom' ? { from: s.from, to: s.to } : { from: s.year + '-01-01', to: s.year + '-12-31' }; }
  const tenantLabel = (t) => t.name + (t.unit && t.name.toLowerCase().indexOf(t.unit.toLowerCase()) < 0 ? ' · ' + t.unit : '');

  const pure = { pad, ymd, todayKey, round2, money, addMonths, monthsBetween, daysInMonth, dueDateFor, monthLabel, dateLabel, sortBy,
    rentEntriesByMonth, monthStatus, yearTable, nextDue, outstanding, depositInfo, propertyReport, analyze, rangeOf, tenantLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* =============================== DOM utils =============================== */
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'value') n.value = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    });
    kids.flat(Infinity).forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  function toast(message, type = 'ok') {
    let box = $('toasts');
    if (!box) { box = el('div', { id: 'toasts', class: 'toasts' }); document.body.appendChild(box); }
    const t = el('div', { class: 'toast ' + (type === 'error' ? 'toast-err' : 'toast-ok'), text: message });
    box.appendChild(t); setTimeout(() => t.remove(), type === 'error' ? 4500 : 2500);
  }
  function flash(message, type = 'ok') { try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type })); } catch (_) {} }
  function showFlash() {
    try { const raw = sessionStorage.getItem(FLASH_KEY); if (!raw) return; sessionStorage.removeItem(FLASH_KEY); const f = JSON.parse(raw); if (f && f.message) toast(f.message, f.type); } catch (_) {}
  }
  const setBusy = (btn, busy) => { btn.disabled = busy; btn.classList.toggle('busy', busy); };
  const chip = (status) => el('span', { class: 'chip chip-' + status, text: status === 'NA' ? '–' : status });

  /* ================================ Session ================================ */
  let session = null;
  function loadSession() {
    try { const s = JSON.parse(localStorage.getItem(SESSION_KEY)); if (s && s.mobile && s.token && s.exp > Date.now()) return s; } catch (_) {}
    return null;
  }
  function saveSession(s) { session = s; try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) {} }
  function clearSession() {
    session = null;
    try { Object.keys(localStorage).filter((k) => k.indexOf('rent_') === 0 && k !== FLASH_KEY).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  }
  const homePage = (role) => (role === 'Tenant' ? 'tenant.html' : 'home.html');
  /** opts.admin → tenants are bounced to their own page. Returns the session, or null (and redirects). */
  function requireLogin(opts) {
    const s = loadSession();
    if (!s) { location.replace('index.html'); return null; }
    if (opts && opts.admin && s.role === 'Tenant') { location.replace('tenant.html'); return null; }
    session = s; showFlash(); return s;
  }
  function logout() { clearSession(); flash('Logged out.'); location.replace('index.html'); }
  const canEdit = () => !!session && session.role === 'Owner';

  /* ================================== API ================================== */
  class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
  async function api(action, payload = {}) {
    if (API_URL.indexOf('PASTE_') === 0) throw new ApiError('config', 'API_URL is not set in common.js yet.');
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      // text/plain = "simple" request → no CORS preflight (Apps Script cannot answer OPTIONS)
      res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, payload)), signal: ctrl.signal });
    } catch (_) { throw new ApiError('network', 'Network problem. Check internet and try again.'); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch (_) { throw new ApiError('bad_response', 'Unexpected server response.'); }
    if (!data.success) {
      if (data.error === 'session_expired') { clearSession(); flash('Session expired. Please login again.', 'error'); location.replace('index.html'); }
      throw new ApiError(data.error || 'error', data.message || 'Something went wrong.');
    }
    return data;
  }
  function call(action, payload = {}) {
    if (!session) throw new ApiError('session_expired', 'Please login again.');
    // `mobile` + `token` identify the logged-in user. Never put another "mobile" in a payload (tenants use tenant_mobile).
    return api(action, Object.assign({}, payload, { mobile: session.mobile, token: session.token }));
  }

  /* ============================ Header + navigation ============================ */
  /** opts: back (href) · onRefresh (async) · sub (small text after title) */
  function mountHeader(title, opts) {
    opts = opts || {};
    const menu = el('div', { class: 'menu', hidden: true },
      el('div', { class: 'menu-note' }, (session && session.name) || '', session && session.role === 'Viewer' ? el('span', { class: 'viewer-tag', text: 'View only' }) : null),
      el('button', { class: 'menu-item', type: 'button', text: '⟳  Refresh', onclick: () => { menu.hidden = true; refresh(); } }),
      el('button', { class: 'menu-item', type: 'button', text: '🔑  Change password', onclick: () => { menu.hidden = true; openChangePassword(); } }),
      el('button', { class: 'menu-item danger', type: 'button', text: '⎋  Logout', onclick: logout }));
    const avatar = el('button', { class: 'avatar', type: 'button', 'aria-label': 'Profile', text: (Array.from(String((session && session.name) || '?').trim())[0] || '?').toUpperCase() });
    const rbtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', text: '⟳', onclick: () => refresh() });
    async function refresh() {
      if (!opts.onRefresh || rbtn.classList.contains('spin')) return;
      rbtn.classList.add('spin');
      try { await opts.onRefresh(); } catch (err) { toast(err.message, 'error'); } finally { rbtn.classList.remove('spin'); }
    }
    avatar.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { menu.hidden = true; });
    $('hdr').replaceChildren(el('div', { class: 'hdr-bar' },
      el('div', { class: 'hdr-left' }, opts.back ? el('a', { href: opts.back, 'aria-label': 'Back', text: '‹' }) : null, el('h1', { class: 'hdr-title', id: 'hdrTitle', text: title })),
      el('div', { class: 'hdr-right' }, rbtn, el('div', { class: 'menu-wrap' }, avatar, menu))));
  }
  const setTitle = (t) => { const n = $('hdrTitle'); if (n) n.textContent = t; };

  function mountNav(active) {
    const items = [['home', 'home.html', '🏠', 'Home'], ['analysis', 'analysis.html', '📊', 'Analysis'], ['manage', 'manage.html', '⚙️', 'Manage']];
    $('nav').replaceChildren(el('div', { class: 'nav-inner' }, ...items.map((i) => el('a', { class: 'nav-item' + (i[0] === active ? ' active' : ''), href: i[1] }, el('span', { class: 'nav-ico', text: i[2] }), el('span', { text: i[3] })))));
  }

  /* ------------------------------ Bottom sheet ------------------------------ */
  function openSheet(title, content) {
    const close = () => { overlay.remove(); document.body.classList.remove('no-scroll'); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { class: 'sheet-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: close })), content);
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, sheet);
    document.body.appendChild(overlay); document.body.classList.add('no-scroll'); document.addEventListener('keydown', onKey);
    return close;
  }

  function openChangePassword() {
    const o = el('input', { class: 'field', type: 'password', autocomplete: 'current-password', id: 'pwOld' });
    const n = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', id: 'pwNew' });
    const c = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', id: 'pwNew2' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Change password' });
    let close;
    const form = el('form', { novalidate: true },
      el('label', { class: 'lbl', for: 'pwOld', text: 'Current password' }), o,
      el('label', { class: 'lbl', for: 'pwNew', text: 'New password (6+ characters)' }), n,
      el('label', { class: 'lbl', for: 'pwNew2', text: 'Repeat new password' }), c, save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (n.value.length < 6) { toast('New password must be at least 6 characters.', 'error'); return; }
      if (n.value !== c.value) { toast('The two new passwords do not match.', 'error'); return; }
      setBusy(save, true);
      try {
        const d = await call('change_password', { old_password: o.value, new_password: n.value });
        saveSession(Object.assign({}, session, { token: d.token, exp: d.expires }));
        close(); toast('Password changed');
      } catch (err) { toast(err.message, 'error'); setBusy(save, false); }
    });
    close = openSheet('Change password', form); o.focus();
  }

  /* -------------------- Range picker (Year / Custom) -------------------- */
  /** host: element · st: {mode, year, from, to} (mutated) · onChange(): called after every change */
  function mountRange(host, st, onChange) {
    function draw() {
      const seg = el('div', { class: 'seg' }, ...[['year', 'Year'], ['custom', 'Custom range']].map((m) =>
        el('button', { type: 'button', class: st.mode === m[0] ? 'active' : '', text: m[1], onclick: () => { st.mode = m[0]; draw(); onChange(); } })));
      let body;
      if (st.mode === 'year') {
        body = el('div', { class: 'monthbar' },
          el('button', { class: 'mb-btn', type: 'button', 'aria-label': 'Previous year', text: '‹', onclick: () => { st.year--; draw(); onChange(); } }),
          el('div', { class: 'month-pick', style: 'cursor:default', text: String(st.year) }),
          el('button', { class: 'mb-btn', type: 'button', 'aria-label': 'Next year', text: '›', onclick: () => { st.year++; draw(); onChange(); } }));
      } else {
        const f = el('input', { type: 'date', class: 'field', value: st.from, 'aria-label': 'From date' });
        const t = el('input', { type: 'date', class: 'field', value: st.to, 'aria-label': 'To date' });
        const apply = () => {
          if (!f.value || !t.value) return;
          if (f.value > t.value) { toast('"From" must be before "To".', 'error'); return; }
          st.from = f.value; st.to = t.value; onChange();
        };
        f.addEventListener('change', apply); t.addEventListener('change', apply);
        body = el('div', { class: 'two' }, el('div', {}, el('label', { class: 'lbl', text: 'From' }), f), el('div', {}, el('label', { class: 'lbl', text: 'To' }), t));
      }
      host.replaceChildren(seg, body);
    }
    draw();
  }
  const newRangeState = () => { const n = new Date(); return { mode: 'year', year: n.getFullYear(), from: n.getFullYear() + '-01-01', to: ymd(n) }; };

  window.App = Object.assign({ $, el, toast, flash, showFlash, setBusy, chip, api, call, ApiError, APP_NAME,
    session: () => session, loadSession, saveSession, requireLogin, logout, canEdit, homePage,
    mountHeader, setTitle, mountNav, openSheet, openChangePassword, mountRange, newRangeState }, pure);
})();
