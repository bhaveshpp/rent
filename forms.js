/* =====================================================================
 *  RENT MANAGER — forms.js : every add/edit popup (owner only). Load after common.js + store.js.
 *  App.forms.openTxn({edit, property_id, tenant_id, type}) · openProperty(p) · openTenant(t) · openRule(r) · openClose(t)
 * ===================================================================== */
(function () {
  'use strict';
  const A = window.App, S = A.store, { el, toast } = A;
  const num = (v) => Number(String(v).replace(/,/g, ''));
  const field = (id, label, input) => [el('label', { class: 'lbl', for: id, text: label }), input];

  function fillSelect(sel, opts, keep) {
    sel.replaceChildren(...opts.map((o) => el('option', { value: o.v, text: o.t })));
    if (keep != null && opts.some((o) => o.v === keep)) sel.value = keep;
  }

  /* ============================ Rent / Expense / Payout / Deposit ============================ */
  function openTxn(opts) {
    opts = opts || {};
    const v = S.view(); if (!v) { toast('Still loading — try again in a moment.', 'error'); return; }
    const edit = opts.edit || null, today = A.todayKey();
    let tab = edit ? (edit.type.indexOf('Deposit') === 0 ? 'Deposit' : edit.type) : (opts.type || 'Rent');

    const tabs = el('div', { class: 'seg' });
    const date = el('input', { id: 'xDate', class: 'field', type: 'date', value: edit ? edit.date : today });
    const prop = el('select', { id: 'xProp', class: 'field' });
    const tenant = el('select', { id: 'xTen', class: 'field' });
    const month = el('input', { id: 'xMonth', class: 'field', type: 'month' });
    const due = el('input', { id: 'xDue', class: 'field', type: 'text', inputmode: 'decimal', placeholder: '0' });
    const kind = el('select', { id: 'xKind', class: 'field' }, el('option', { value: 'Deposit Received', text: 'Deposit received' }), el('option', { value: 'Deposit Refund', text: 'Deposit refunded' }));
    const amount = el('input', { id: 'xAmt', class: 'field amount', type: 'text', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
    const note = el('textarea', { id: 'xNote', class: 'field', maxlength: '300', placeholder: 'Note (optional)' });
    const helper = el('div', { class: 'hint', hidden: true });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: edit ? 'Update' : 'Save' });
    const gTen = el('div', {}, ...field('xTen', 'Tenant', tenant));
    const gMonth = el('div', { class: 'two' }, el('div', {}, ...field('xMonth', 'Rent for month', month)), el('div', {}, ...field('xDue', 'Rent due', due)));
    const gKind = el('div', {}, ...field('xKind', 'Deposit', kind));
    let touchedAmt = !!edit, touchedDue = !!edit;

    amount.value = edit ? String(edit.amount) : '';
    note.value = edit ? edit.note : '';
    if (edit && edit.type.indexOf('Deposit') === 0) kind.value = edit.type;
    if (edit && edit.type === 'Rent') { month.value = edit.rent_month; due.value = edit.rent_due ? String(edit.rent_due) : ''; }

    const activeProps = v.properties.filter((p) => p.status === 'Active' || (edit && p.id === edit.property_id));
    fillSelect(prop, activeProps.map((p) => ({ v: p.id, t: p.name })), edit ? edit.property_id : opts.property_id);
    if (!prop.value && activeProps.length) prop.value = activeProps[0].id;

    const tenantsOf = (pid) => v.tenants.filter((t) => t.property_id === pid && (t.status === 'Active' || (edit && t.id === edit.tenant_id)));
    function fillTenants(keep) {
      const list = tenantsOf(prop.value);
      fillSelect(tenant, list.map((t) => ({ v: t.id, t: A.tenantLabel(t) })), keep);
    }
    const curTenant = () => v.tenants.find((t) => t.id === tenant.value) || null;
    const others = (t) => v.txns.filter((x) => !(edit && x.id === edit.id) && x.tenant_id === t.id);   // everything except the entry being edited

    function refreshHelper() {
      const t = curTenant(); helper.hidden = true;
      if (!t || tab === 'Expense' || tab === 'Payout') return;
      if (tab === 'Rent') {
        if (!month.value) return;
        const st = A.monthStatus(t, month.value, A.rentEntriesByMonth(others(t), t.id)[month.value], today);
        helper.textContent = A.monthLabel(month.value, 'my') + ' — rent ₹' + A.money(st.rent_due) + ' · already paid ₹' + A.money(st.paid) + ' · balance ₹' + A.money(st.balance);
        helper.hidden = false;
        if (!touchedDue) due.value = st.paid > 0 || st.entries.length ? String(st.rent_due) : String(t.monthly_rent);
        if (!touchedAmt) amount.value = st.balance > 0 ? String(st.balance) : '';
      } else {
        const d = A.depositInfo(t, others(t));
        helper.textContent = 'Deposit agreed ₹' + A.money(d.agreed) + ' · received ₹' + A.money(d.received) + ' · refunded ₹' + A.money(d.refunded) + ' · held ₹' + A.money(d.held);
        helper.hidden = false;
      }
    }
    function defaultMonth() {
      const t = curTenant(); if (!t) return today.slice(0, 7);
      const nd = A.nextDue(t, others(t), today);
      return nd ? nd.key : today.slice(0, 7);
    }
    function applyTab() {
      [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.t === tab));
      gTen.hidden = tab === 'Expense' || tab === 'Payout';
      gMonth.hidden = tab !== 'Rent';
      gKind.hidden = tab !== 'Deposit';
      if (tab === 'Rent' && !month.value) month.value = defaultMonth();
      refreshHelper();
    }
    ['Rent', 'Expense', 'Payout', 'Deposit'].forEach((tp) => tabs.append(el('button', { type: 'button', 'data-t': tp, text: tp, onclick: () => { tab = tp; applyTab(); } })));
    fillTenants(edit ? edit.tenant_id : opts.tenant_id);
    prop.addEventListener('change', () => { fillTenants(); if (!edit) { touchedAmt = false; touchedDue = false; month.value = tab === 'Rent' ? defaultMonth() : month.value; } refreshHelper(); });
    tenant.addEventListener('change', () => { if (!edit) { touchedAmt = false; touchedDue = false; if (tab === 'Rent') month.value = defaultMonth(); } refreshHelper(); });
    month.addEventListener('change', () => { if (!edit) { touchedAmt = false; touchedDue = false; } refreshHelper(); });
    amount.addEventListener('input', () => { touchedAmt = true; }); due.addEventListener('input', () => { touchedDue = true; refreshHelper(); });
    kind.addEventListener('change', refreshHelper);

    let close;
    const form = el('form', { novalidate: true });
    if (edit && S.statusOf(edit.id) === 'failed') {
      form.append(el('div', { class: 'errbar' }, 'Not saved: ' + S.errorOf(edit.id) + ' ', el('button', { class: 'btn btn-sm', type: 'button', text: 'Retry', onclick: () => { S.retry(edit.id); close(); } })));
    }
    form.append(tabs, ...field('xDate', 'Date', date), ...field('xProp', 'Property', prop), gTen, gMonth, gKind,
      ...field('xAmt', 'Amount received / paid', amount), helper, ...field('xNote', 'Note', note), save);
    if (edit) form.append(el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete', onclick: () => { if (!confirm('Delete this entry?')) return; S.deleteTxn(edit); close(); toast('Deleted'); } }));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const amt = num(amount.value);
      if (!isFinite(amt) || amt <= 0) { toast('Enter a valid amount.', 'error'); amount.focus(); return; }
      if (!date.value) { toast('Choose the date.', 'error'); return; }
      if (!prop.value) { toast('Choose a property (add one in Manage).', 'error'); return; }
      const f = { date: date.value, property_id: prop.value, amount: amt, note: note.value.trim(), tenant_id: '', rent_month: '', rent_due: '', type: tab };
      if (tab === 'Rent' || tab === 'Deposit') {
        if (!tenant.value) { toast('Choose a tenant (add one in Manage).', 'error'); return; }
        f.tenant_id = tenant.value;
      }
      if (tab === 'Rent') {
        if (!month.value) { toast('Choose the rent month.', 'error'); return; }
        const d = due.value.trim() === '' ? (curTenant() ? curTenant().monthly_rent : 0) : num(due.value);
        if (!isFinite(d) || d < 0) { toast('Rent due must be a number.', 'error'); return; }
        f.rent_month = month.value; f.rent_due = d;
      }
      if (tab === 'Deposit') f.type = kind.value;
      if (edit) S.editTxn(edit, f); else S.addTxn(f);
      close(); toast(edit ? 'Updated' : 'Saved');
    });
    close = A.openSheet(edit ? 'Edit entry' : 'New entry', form);
    applyTab();
    if (!edit) amount.focus();
  }

  /* ================================ server-first forms ================================ */
  async function submit(btn, fn, close, okMsg) {
    A.setBusy(btn, true);
    try { await fn(); close(); toast(okMsg); } catch (err) { toast(err.message, 'error'); A.setBusy(btn, false); }
  }
  const statusSelect = (id, value) => { const s = el('select', { id, class: 'field' }, el('option', { value: 'Active', text: 'Active' }), el('option', { value: 'Inactive', text: 'Inactive' })); s.value = value || 'Active'; return s; };

  function openProperty(p) {
    const name = el('input', { id: 'pName', class: 'field', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Ghar Adajan' });
    const addr = el('input', { id: 'pAddr', class: 'field', maxlength: '200', placeholder: 'Address' });
    const status = statusSelect('pStatus', p && p.status);
    const note = el('textarea', { id: 'pNote', class: 'field', maxlength: '500', placeholder: 'Private note (not shown to tenants)' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: p ? 'Update' : 'Add property' });
    if (p) { name.value = p.name; addr.value = p.address; note.value = p.note; }
    let close;
    const form = el('form', { novalidate: true }, ...field('pName', 'Name', name), ...field('pAddr', 'Address', addr), ...field('pStatus', 'Status', status), ...field('pNote', 'Note', note), save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) { toast('Enter the property name.', 'error'); return; }
      submit(save, () => S.write('save_property', { id: p ? p.id : '', name: name.value.trim(), address: addr.value.trim(), status: status.value, note: note.value.trim() }), close, 'Saved');
    });
    close = A.openSheet(p ? 'Edit property' : 'New property', form); name.focus();
  }

  function openTenant(t) {
    const v = S.view();
    const props = v.properties.filter((p) => p.status === 'Active' || (t && p.id === t.property_id));
    if (!props.length) { toast('Add a property first (Manage → Properties).', 'error'); return; }
    const name = el('input', { id: 'tName', class: 'field', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. 1st Floor – Ramesh Patel' });
    const mobile = el('input', { id: 'tMobile', class: 'field', type: 'tel', inputmode: 'numeric', maxlength: '14', placeholder: '10-digit mobile (= login)' });
    const prop = el('select', { id: 'tProp', class: 'field' }); fillSelect(prop, props.map((p) => ({ v: p.id, t: p.name })), t ? t.property_id : undefined);
    const unit = el('input', { id: 'tUnit', class: 'field', maxlength: '40', placeholder: 'e.g. 1st Floor / Shop 5 (optional)' });
    const rent = el('input', { id: 'tRent', class: 'field', type: 'text', inputmode: 'decimal', placeholder: '0' });
    const dueDay = el('input', { id: 'tDue', class: 'field', type: 'number', min: '1', max: '31', placeholder: '5' });
    const deposit = el('input', { id: 'tDep', class: 'field', type: 'text', inputmode: 'decimal', placeholder: '0' });
    const start = el('input', { id: 'tStart', class: 'field', type: 'date', value: A.todayKey() });
    const end = el('input', { id: 'tEnd', class: 'field', type: 'date' });
    const status = statusSelect('tStatus', t && t.status);
    const note = el('textarea', { id: 'tNote', class: 'field', maxlength: '500', placeholder: 'Private note (not shown to the tenant)' });
    const pw = el('input', { id: 'tPw', class: 'field', type: 'text', autocomplete: 'off', placeholder: t ? 'Leave empty to keep the current password' : 'Login password (6+ characters)' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: t ? 'Update' : 'Add tenant' });
    if (t) { name.value = t.name; mobile.value = t.mobile; unit.value = t.unit; rent.value = String(t.monthly_rent); dueDay.value = String(t.due_day);
      deposit.value = t.deposit ? String(t.deposit) : ''; start.value = t.lease_start || ''; end.value = t.lease_end || ''; note.value = t.note; }
    let close;
    const form = el('form', { novalidate: true }, ...field('tName', 'Name', name), ...field('tMobile', 'Mobile (login ID)', mobile), ...field('tProp', 'Property', prop), ...field('tUnit', 'Unit', unit),
      el('div', { class: 'two' }, el('div', {}, ...field('tRent', 'Monthly rent', rent)), el('div', {}, ...field('tDue', 'Due day (1–31)', dueDay))),
      ...field('tDep', 'Deposit (total agreed)', deposit),
      el('div', { class: 'two' }, el('div', {}, ...field('tStart', 'Lease start', start)), el('div', {}, ...field('tEnd', 'Lease end (optional)', end))),
      ...field('tStatus', 'Status', status), ...field('tNote', 'Note', note), ...field('tPw', t ? 'Reset password' : 'Password', pw), save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = num(rent.value), dd = parseInt(dueDay.value, 10), dep = deposit.value.trim() === '' ? 0 : num(deposit.value);
      if (!name.value.trim()) { toast('Enter the tenant name.', 'error'); return; }
      if (mobile.value.replace(/\D/g, '').length < 10) { toast('Enter a 10-digit mobile number.', 'error'); return; }
      if (!isFinite(r) || r < 0 || rent.value.trim() === '') { toast('Enter the monthly rent.', 'error'); return; }
      if (!(dd >= 1 && dd <= 31)) { toast('Due day must be 1 to 31.', 'error'); return; }
      if (!isFinite(dep) || dep < 0) { toast('Deposit must be a number.', 'error'); return; }
      if (!start.value) { toast('Choose the lease start date.', 'error'); return; }
      if (!t && pw.value.length < 6) { toast('Set a password of 6+ characters.', 'error'); return; }
      submit(save, () => S.write('save_tenant', { id: t ? t.id : '', name: name.value.trim(), tenant_mobile: mobile.value, property_id: prop.value, unit: unit.value.trim(),
        monthly_rent: r, due_day: dd, deposit: dep, lease_start: start.value, lease_end: end.value, status: status.value, note: note.value.trim(), password: pw.value }), close, 'Saved');
    });
    close = A.openSheet(t ? 'Edit tenant' : 'New tenant', form); name.focus();
  }

  function openRule(r) {
    const v = S.view();
    const prop = el('select', { id: 'rProp', class: 'field' }); fillSelect(prop, [{ v: 'ALL', t: 'All properties' }].concat(v.properties.map((p) => ({ v: p.id, t: p.name }))), r ? r.property_id : 'ALL');
    const text = el('textarea', { id: 'rText', class: 'field', maxlength: '500', placeholder: 'e.g. Rent must be paid by the 5th of every month.' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: r ? 'Update' : 'Add rule' });
    if (r) text.value = r.text;
    let close;
    const form = el('form', { novalidate: true }, ...field('rProp', 'Applies to', prop), ...field('rText', 'Rule', text), save);
    if (r) form.append(el('button', { class: 'btn btn-danger', type: 'button', text: 'Delete rule', onclick: async (ev) => {
      if (!confirm('Delete this rule?')) return;
      submit(ev.target, () => S.write('delete_rule', { id: r.id }), close, 'Deleted');
    } }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!text.value.trim()) { toast('Write the rule.', 'error'); return; }
      submit(save, () => S.write('save_rule', { id: r ? r.id : '', property_id: prop.value, text: text.value.trim() }), close, 'Saved');
    });
    close = A.openSheet(r ? 'Edit rule' : 'New rule', form); text.focus();
  }

  /** Tenant leaves: Inactive + lease end (+ the deposit refund entry) in one step. */
  function openClose(t) {
    const v = S.view(), d = A.depositInfo(t, v.txns);
    const end = el('input', { id: 'cEnd', class: 'field', type: 'date', value: A.todayKey() });
    const refund = el('input', { id: 'cRef', class: 'field amount', type: 'text', inputmode: 'decimal', placeholder: '0' });
    const note = el('textarea', { id: 'cNote', class: 'field', maxlength: '300', placeholder: 'Deposit settlement, e.g. "₹2,000 deducted for repairs"' });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Close tenancy' });
    refund.value = d.held > 0 ? String(d.held) : '';
    let close;
    const form = el('form', { novalidate: true },
      el('div', { class: 'hint' }, A.tenantLabel(t) + ' will be marked Inactive and can no longer log in. Their history stays. Deposit held: ₹' + A.money(d.held) + '.'),
      ...field('cEnd', 'Last day (lease end)', end), ...field('cRef', 'Deposit refunded now (leave empty if none)', refund), ...field('cNote', 'Note', note), save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const rf = refund.value.trim() === '' ? 0 : num(refund.value);
      if (!end.value) { toast('Choose the last day.', 'error'); return; }
      if (!isFinite(rf) || rf < 0) { toast('Refund must be a number.', 'error'); return; }
      if (!confirm('Close this tenancy?')) return;
      submit(save, () => S.write('close_tenancy', { tenant_id: t.id, end_date: end.value, refund_amount: rf, note: note.value.trim() }), close, 'Tenancy closed');
    });
    close = A.openSheet('Close tenancy', form);
  }

  A.forms = { openTxn, openProperty, openTenant, openRule, openClose };
})();
