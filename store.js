/* =====================================================================
 *  RENT MANAGER — store.js : local-first data layer (load after common.js)
 *   • ONE dataset (properties, tenants, rules, all transactions) is fetched once and cached on the device
 *     (5-minute freshness). Every screen — reports, rent status, analysis, filters — is computed from it,
 *     so switching year / property / tenant / filters never calls the API.
 *   • Rent / Expense / Payout / Deposit entries: optimistic — shown instantly, saved in the background,
 *     unsynced ones survive a reload, network errors retry, other errors are flagged (⚠ Not saved).
 *   • Properties / tenants / rules: saved on the server first (waits for confirmation), then the cache is updated.
 * ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.App) return;
  const A = window.App;

  const D_KEY = 'rent_data_v1', Q_KEY = 'rent_queue_v1';
  const TTL = 5 * 60 * 1000, RETRY_MS = 30000;

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota / private mode */ } };

  let data = read(D_KEY, null);      // {ts, role, properties, tenants, rules, txns}  — server snapshot
  let queue = read(Q_KEY, []);       // [{id, kind:'save'|'delete', payload, item, state:'queued'|'failed', error}]
  let running = false, inflight = null, retryTimer = null;

  const isTmp = (id) => String(id).indexOf('tmp_') === 0;
  const newTmp = () => 'tmp_' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  const emit = () => window.dispatchEvent(new Event('rent:change'));
  const saveD = () => write(D_KEY, data);
  const saveQ = () => write(Q_KEY, queue);
  const idle = () => !queue.some((o) => o.state === 'queued') && !inflight;
  const fresh = () => !!data && Date.now() - data.ts < TTL;
  const upsert = (arr, item) => { const i = arr.findIndex((x) => x.id === item.id); if (i >= 0) arr[i] = item; else arr.push(item); };

  /* ------------------------------- the view ------------------------------- */
  /** server snapshot + every unsynced local change. null until the first load. */
  function view() {
    if (!data) return null;
    let txns = data.txns.slice();
    queue.forEach((op) => {
      if (op.kind === 'delete') txns = txns.filter((x) => x.id !== op.id);
      else { txns = txns.filter((x) => x.id !== op.item.id); txns.push(op.item); }
    });
    return { role: data.role, ts: data.ts, properties: data.properties, tenants: data.tenants, rules: data.rules, txns };
  }

  /** Fetch the whole dataset (skipped while fresh, unless forced). Waits for unsynced changes first. */
  async function load(force) {
    if (!force && fresh()) return view();
    await whenIdle(6000);
    const s = A.session();
    const d = await A.call(s && s.role === 'Tenant' ? 'tenant_data' : 'admin_data');
    data = { ts: Date.now(), role: d.role, properties: d.properties, tenants: d.tenants, rules: d.rules, txns: d.txns };
    saveD(); emit();
    return view();
  }

  /* --------------- properties / tenants / rules (server first) --------------- */
  async function write_(action, payload) {
    const d = await A.call(action, payload);
    if (data) {
      if (d.property) upsert(data.properties, d.property);
      if (d.tenant) upsert(data.tenants, d.tenant);
      if (d.rule) upsert(data.rules, d.rule);
      if (action === 'delete_rule') data.rules = data.rules.filter((r) => r.id !== d.id);
      if (d.txn) upsert(data.txns, d.txn);
      saveD(); emit();
    }
    return d;
  }

  /* ------------------- transactions (optimistic + queue) ------------------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const toPayload = (f, id) => ({ id: id || '', date: f.date, type: f.type, property_id: f.property_id, tenant_id: f.tenant_id || '',
    rent_month: f.rent_month || '', rent_due: f.rent_due === '' || f.rent_due == null ? '' : f.rent_due, amount: f.amount, note: f.note || '' });
  const opFor = (id) => queue.find((o) => o.id === id && o !== inflight);
  function enqueue(op) { queue.push(op); afterChange(); }
  function afterChange() { saveQ(); emit(); run(); }

  function addTxn(f) {
    const item = Object.assign({ rent_due: 0 }, f, { id: newTmp() });
    enqueue({ id: item.id, kind: 'save', payload: toPayload(f, ''), item, state: 'queued', error: '' });
    return item;
  }
  function editTxn(old, f) {
    const item = Object.assign({ rent_due: 0 }, f, { id: old.id });
    const payload = toPayload(f, isTmp(old.id) ? '' : old.id);
    const op = opFor(old.id);
    if (op && op.kind === 'save') { op.item = item; op.payload = payload; op.state = 'queued'; op.error = ''; afterChange(); return item; }
    enqueue({ id: old.id, kind: 'save', payload, item, state: 'queued', error: '' });
    return item;
  }
  function deleteTxn(item) {
    const op = opFor(item.id);
    if (op && op.kind === 'save') {
      queue = queue.filter((o) => o !== op);
      if (isTmp(item.id)) { afterChange(); return; }           // never reached the sheet
    }
    enqueue({ id: item.id, kind: 'delete', state: 'queued', error: '' });
  }
  function retry(id) { const op = queue.find((o) => o.id === id && o.state === 'failed'); if (op) { op.state = 'queued'; op.error = ''; afterChange(); } }
  const statusOf = (id) => { const o = queue.find((x) => x.id === id && x.kind === 'save'); return o ? (o.state === 'failed' ? 'failed' : 'queued') : null; };
  const errorOf = (id) => { const o = queue.find((x) => x.id === id && x.state === 'failed'); return o ? o.error : ''; };
  const pendingCount = () => queue.filter((o) => o.state === 'queued').length;

  function onSaved(op, txn) {
    queue = queue.filter((o) => o !== op);
    if (data) data.txns = data.txns.filter((x) => x.id !== txn.id && x.id !== op.id).concat([txn]);
    if (isTmp(op.id)) {
      queue.forEach((o) => {            // later edits / deletes of the same new entry now point to the real row
        if (o.id !== op.id) return;
        o.id = txn.id;
        if (o.item) o.item.id = txn.id;
        if (o.payload) o.payload.id = txn.id;
      });
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let stopped = false;
    try {
      for (;;) {
        const op = queue.find((o) => o.state === 'queued');
        if (!op) break;
        inflight = op; emit();
        try {
          if (op.kind === 'save') onSaved(op, (await A.call('save_transaction', op.payload)).txn);
          else if (isTmp(op.id)) queue = queue.filter((o) => o !== op);
          else {
            try { await A.call('delete_transaction', { id: op.id }); } catch (e) { if (e.code !== 'bad_request') throw e; }   // already gone
            queue = queue.filter((o) => o !== op);
            if (data) data.txns = data.txns.filter((x) => x.id !== op.id);
          }
        } catch (err) {
          if (err.code === 'network' || err.code === 'session_expired' || err.code === 'config') {
            stopped = true;
            if (err.code === 'network') A.toast('Offline — changes will sync when you are back online.', 'error');
            break;
          }
          op.state = 'failed'; op.error = err.message || 'Could not save.';
          A.toast('Not saved: ' + op.error, 'error');
        }
        inflight = null; saveQ(); saveD(); emit();
      }
    } finally {
      inflight = null; running = false; saveQ(); saveD(); emit();
    }
    if (stopped) { clearTimeout(retryTimer); retryTimer = setTimeout(run, RETRY_MS); }
  }
  const resume = () => (queue.some((o) => o.state === 'queued') ? run() : Promise.resolve());
  window.addEventListener('online', resume);

  function whenIdle(maxMs) {
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { window.removeEventListener('rent:change', check); clearTimeout(t); resolve(); };
      const check = () => { if (idle()) done(); };
      const t = setTimeout(done, maxMs || 6000);
      window.addEventListener('rent:change', check);
    });
  }

  A.store = { TTL, view, load, fresh, write: write_, addTxn, editTxn, deleteTxn, retry, statusOf, errorOf, pendingCount, resume, whenIdle };
})();
