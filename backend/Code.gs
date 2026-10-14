/**
 * =====================================================================
 *  RENT MANAGER — property & tenant management · Google Apps Script backend (Code.gs)
 *  API_VERSION 1.0-rent
 * =====================================================================
 *  SETUP (one time)
 *  1. New Google Sheet → Extensions → Apps Script → paste this whole file.
 *  2. Run  setupSheets  (creates Admin, Properties, Tenants, Rules, Transactions).
 *  3. Edit the 3 constants in  createAdmin  (bottom) → run it → your Owner login exists.
 *     (A read-only admin: add a row in the Admin tab by hand with Role = Viewer, or run
 *      createAdmin again with ADMIN_ROLE = 'Viewer' and another mobile.)
 *  4. Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → Deploy.
 *  5. Copy the Web app URL → paste into API_URL in site/common.js.
 *  UPDATING: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 *  Roles:  Owner  = full access        Viewer = sees everything, cannot change anything
 *          Tenant = sees only own tenancy (own rent / deposit entries, own property rules)
 *  Every data action needs a valid mobile + token. Writes are refused server-side for Viewer / Tenant.
 *  Passwords are salted hashes. Mobile number must be unique across Admin + Tenants.
 * =====================================================================
 */

var SHEET_ADMIN = 'Admin';
var SHEET_PROP  = 'Properties';
var SHEET_TEN   = 'Tenants';
var SHEET_RULES = 'Rules';
var SHEET_TXN   = 'Transactions';

var HEADERS = {
  Admin:        ['Mobile', 'Name', 'Password', 'Role', 'Status'],
  Properties:   ['Property_ID', 'Name', 'Address', 'Status', 'Note'],
  Tenants:      ['Tenant_ID', 'Name', 'Mobile', 'Password', 'Property_ID', 'Unit', 'Monthly_Rent', 'Due_Day',
                 'Deposit', 'Lease_Start', 'Lease_End', 'Status', 'Note'],
  Rules:        ['Rule_ID', 'Property_ID', 'Rule_Text'],
  Transactions: ['Txn_ID', 'Date', 'Type', 'Property_ID', 'Tenant_ID', 'Rent_Month', 'Rent_Due', 'Amount', 'Notes']
};

var TXN_TYPES = ['Rent', 'Expense', 'Payout', 'Deposit Received', 'Deposit Refund'];
var TENANT_TXN_TYPES = ['Rent', 'Deposit Received', 'Deposit Refund'];   // the only ones a tenant ever receives

var TZ               = 'Asia/Kolkata';
var SESSION_DAYS     = 30;
var MAX_ATTEMPTS     = 5;
var LOCKOUT_SECONDS  = 900;
var MIN_PASSWORD_LEN = 6;
var MAX_PASSWORD_LEN = 64;
var API_VERSION      = '1.0-rent';

// --------------------------- HTTP ENTRY -----------------------------

function doGet(e) {
  return json_({ success: true, version: API_VERSION, message: 'Rent Manager API is running. Send POST requests.' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new ApiError('bad_request', 'Empty request.');
    var body;
    try { body = JSON.parse(e.postData.contents); } catch (x) { throw new ApiError('bad_request', 'Invalid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('bad_request', 'Invalid request.');

    if (body.action === 'login') return ok_(login_(body));

    var user = authenticate_(body);
    switch (body.action) {
      case 'change_password':    return ok_(withLock_(function () { return changePassword_(body, user); }));
      case 'admin_data':         requireAdmin_(user); return ok_(adminData_(user));
      case 'tenant_data':        requireTenant_(user); return ok_(tenantData_(user));
      case 'save_property':      return ok_(withLock_(function () { return saveProperty_(body, requireOwner_(user)); }));
      case 'save_tenant':        return ok_(withLock_(function () { return saveTenant_(body, requireOwner_(user)); }));
      case 'close_tenancy':      return ok_(withLock_(function () { return closeTenancy_(body, requireOwner_(user)); }));
      case 'save_rule':          return ok_(withLock_(function () { return saveRule_(body, requireOwner_(user)); }));
      case 'delete_rule':        return ok_(withLock_(function () { return deleteRule_(body, requireOwner_(user)); }));
      case 'save_transaction':   return ok_(withLock_(function () { return saveTransaction_(body, requireOwner_(user)); }));
      case 'delete_transaction': return ok_(withLock_(function () { return deleteTransaction_(body, requireOwner_(user)); }));
      default: throw new ApiError('bad_request', 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof ApiError) return fail_(err.code, err.message);
    console.error(err && err.stack ? err.stack : err);
    return fail_('server_error', 'Server error. Please try again.');
  }
}

// ------------------------------ ROLES -------------------------------

function requireAdmin_(u)  { if (u.role !== 'Owner' && u.role !== 'Viewer') throw new ApiError('forbidden', 'Not allowed.'); return u; }
function requireOwner_(u)  {
  if (u.role === 'Viewer') throw new ApiError('forbidden', 'View-only access — you cannot change data.');
  if (u.role !== 'Owner') throw new ApiError('forbidden', 'Not allowed.');
  return u;
}
function requireTenant_(u) { if (u.role !== 'Tenant') throw new ApiError('forbidden', 'Not allowed.'); return u; }

// ------------------------------ LOGIN -------------------------------

/** Looks the mobile up in Admin first, then Tenants. Mobile is unique across both. */
function findLogin_(mobile) {
  var a = table_(SHEET_ADMIN), i, r;
  for (i = 0; i < a.rows.length; i++) {
    r = a.rows[i];
    if (normMobile_(r[a.idx.Mobile]) === mobile) {
      return { t: a, row: i + 2, mobile: mobile, name: String(r[a.idx.Name] || '').trim(), id: '',
               role: String(r[a.idx.Role]).trim() === 'Owner' ? 'Owner' : 'Viewer',   // anything but "Owner" = read-only
               password: String(r[a.idx.Password] || ''), status: String(r[a.idx.Status] || '').trim().toLowerCase() };
    }
  }
  var t = table_(SHEET_TEN);
  for (i = 0; i < t.rows.length; i++) {
    r = t.rows[i];
    if (normMobile_(r[t.idx.Mobile]) === mobile) {
      return { t: t, row: i + 2, mobile: mobile, name: String(r[t.idx.Name] || '').trim(), id: String(r[t.idx.Tenant_ID] || ''),
               role: 'Tenant', password: String(r[t.idx.Password] || ''), status: String(r[t.idx.Status] || '').trim().toLowerCase() };
    }
  }
  return null;
}

function login_(body) {
  var mobile = normMobile_(body.mobile);
  var password = String(body.password == null ? '' : body.password);
  var invalid = new ApiError('invalid_credentials', 'Invalid Credentials');
  if (mobile.length !== 10 || !password) throw invalid;
  assertNotLocked_(mobile);
  var u = findLogin_(mobile);
  if (!u || u.status !== 'active' || !verifyPassword_(u.password, password)) { recordFailure_(mobile); throw invalid; }
  clearFailures_(mobile);

  if (u.password.indexOf('sha256$') !== 0) {          // upgrade plain-text password typed in the sheet
    withLock_(function () {
      u.password = hashPassword_(password);
      u.t.sh.getRange(u.row, u.t.idx.Password + 1).setNumberFormat('@').setValue(u.password);
    });
  }
  var tk = makeToken_(u);
  return { token: tk.token, expires: tk.expires, user: { mobile: u.mobile, name: u.name, role: u.role } };
}

function changePassword_(body, u) {
  var oldPw = String(body.old_password == null ? '' : body.old_password);
  var newPw = String(body.new_password == null ? '' : body.new_password);
  if (!verifyPassword_(u.password, oldPw)) throw new ApiError('wrong_password', 'Current password is wrong.');
  if (newPw.length < MIN_PASSWORD_LEN || newPw.length > MAX_PASSWORD_LEN) {
    throw new ApiError('bad_request', 'New password must be ' + MIN_PASSWORD_LEN + '–' + MAX_PASSWORD_LEN + ' characters.');
  }
  u.password = hashPassword_(newPw);
  u.t.sh.getRange(u.row, u.t.idx.Password + 1).setNumberFormat('@').setValue(u.password);
  var tk = makeToken_(u);                              // old tokens die with the old password hash
  return { token: tk.token, expires: tk.expires };
}

// ------------------------------- DATA -------------------------------

/** Everything the owner / viewer needs. The app computes statuses and reports itself. */
function adminData_(u) {
  return { role: u.role, properties: readProperties_(), tenants: readTenants_(), rules: readRules_(), txns: readTxns_() };
}

/** Tenant isolation: own tenancy only. Private owner notes on the tenant / property are never sent. */
function tenantData_(u) {
  var me = readTenants_().filter(function (t) { return t.id === u.id; })[0];
  if (!me) throw new ApiError('session_expired', 'Session expired. Please login again.');
  me.note = '';
  var props = readProperties_().filter(function (p) { return p.id === me.property_id; });
  props.forEach(function (p) { p.note = ''; });
  var rules = readRules_().filter(function (r) { return r.property_id === 'ALL' || r.property_id === me.property_id; });
  var txns = readTxns_().filter(function (x) { return x.tenant_id === me.id && TENANT_TXN_TYPES.indexOf(x.type) >= 0; });
  return { role: 'Tenant', tenant_id: me.id, properties: props, tenants: [me], rules: rules, txns: txns };
}

function readProperties_() {
  var t = table_(SHEET_PROP), out = [];
  t.rows.forEach(function (r) {
    var id = String(r[t.idx.Property_ID] || '').trim(), name = String(r[t.idx.Name] || '').trim();
    if (!id || !name) return;
    out.push({ id: id, name: name, address: String(r[t.idx.Address] || ''), status: statusOf_(r[t.idx.Status]),
               note: unsafeText_(String(r[t.idx.Note] || '')) });
  });
  return out;
}

function readTenants_() {
  var t = table_(SHEET_TEN), out = [];
  t.rows.forEach(function (r) {
    var id = String(r[t.idx.Tenant_ID] || '').trim(), name = String(r[t.idx.Name] || '').trim();
    if (!id || !name) return;
    out.push({
      id: id, name: name, mobile: normMobile_(r[t.idx.Mobile]), property_id: String(r[t.idx.Property_ID] || '').trim(),
      unit: String(r[t.idx.Unit] || ''), monthly_rent: Number(r[t.idx.Monthly_Rent]) || 0,
      due_day: Math.min(31, Math.max(1, parseInt(r[t.idx.Due_Day], 10) || 1)), deposit: Number(r[t.idx.Deposit]) || 0,
      lease_start: readDateCell_(r[t.idx.Lease_Start]), lease_end: readDateCell_(r[t.idx.Lease_End]),
      status: statusOf_(r[t.idx.Status]), note: unsafeText_(String(r[t.idx.Note] || ''))
    });
  });
  return out;                                          // Password column is never read into this list
}

function readRules_() {
  var t = table_(SHEET_RULES), out = [];
  t.rows.forEach(function (r) {
    var id = String(r[t.idx.Rule_ID] || '').trim(), text = unsafeText_(String(r[t.idx.Rule_Text] || ''));
    if (!id || !text) return;
    out.push({ id: id, property_id: String(r[t.idx.Property_ID] || 'ALL').trim() || 'ALL', text: text });
  });
  return out;
}

function readTxns_() {
  var t = table_(SHEET_TXN), out = [];
  t.rows.forEach(function (r) { var x = txnFromRow_(t, r); if (x) out.push(x); });
  return out;
}

function txnFromRow_(t, r) {
  var id = String(r[t.idx.Txn_ID] || '').trim(), type = String(r[t.idx.Type] || '').trim(), date = readDateCell_(r[t.idx.Date]);
  if (!id || TXN_TYPES.indexOf(type) < 0 || !date) return null;
  return { id: id, date: date, type: type, property_id: String(r[t.idx.Property_ID] || '').trim(),
           tenant_id: String(r[t.idx.Tenant_ID] || '').trim(), rent_month: readMonthCell_(r[t.idx.Rent_Month]),
           rent_due: Number(r[t.idx.Rent_Due]) || 0, amount: Number(r[t.idx.Amount]) || 0,
           note: unsafeText_(String(r[t.idx.Notes] || '')) };
}

// ------------------------------ WRITES ------------------------------

function saveProperty_(body) {
  var t = table_(SHEET_PROP);
  var name = cleanName_(body.name, 60);
  var status = body.status === 'Inactive' ? 'Inactive' : 'Active';
  var id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Property_ID', id);
  t.rows.forEach(function (r, i) {
    if (i !== rowIdx && String(r[t.idx.Name]).trim().toLowerCase() === name.toLowerCase()) throw new ApiError('bad_request', 'A property with this name already exists.');
  });
  if (status === 'Inactive' && rowIdx >= 0) {
    var busy = readTenants_().some(function (x) { return x.property_id === id && x.status === 'Active'; });
    if (busy) throw new ApiError('bad_request', 'This property still has active tenants. Close their tenancy first.');
  }
  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  row[t.idx.Property_ID] = rowIdx < 0 ? newId_('PR') : id;
  row[t.idx.Name] = name;
  row[t.idx.Address] = str_(body.address, 200);
  row[t.idx.Status] = status;
  row[t.idx.Note] = safeText_(strMulti_(body.note, 500));
  writeRow_(t, rowIdx < 0 ? nextRow_(t) : rowIdx + 2, row, []);
  return { property: { id: row[t.idx.Property_ID], name: name, address: row[t.idx.Address], status: status, note: unsafeText_(row[t.idx.Note]) } };
}

function saveTenant_(body) {
  var t = table_(SHEET_TEN);
  var name = cleanName_(body.name, 60);
  var mobile = normMobile_(body.tenant_mobile);   // NOT body.mobile — that field carries the logged-in user's session
  if (mobile.length !== 10) throw new ApiError('bad_request', 'Enter a 10-digit mobile number.');
  var id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Tenant_ID', id);
  if (mobileTaken_(mobile, id)) throw new ApiError('bad_request', 'This mobile number is already used by another login.');

  var propertyId = str_(body.property_id, 40);
  var prop = readProperties_().filter(function (p) { return p.id === propertyId; })[0];
  if (!prop) throw new ApiError('bad_request', 'Choose a valid property.');
  var status = body.status === 'Inactive' ? 'Inactive' : 'Active';
  if (status === 'Active' && prop.status !== 'Active') throw new ApiError('bad_request', 'This property is inactive.');

  var rent = Number(body.monthly_rent);
  if (!isFinite(rent) || rent < 0 || rent > 1e8) throw new ApiError('bad_request', 'Enter a valid monthly rent.');
  var dueDay = parseInt(body.due_day, 10);
  if (!(dueDay >= 1 && dueDay <= 31)) throw new ApiError('bad_request', 'Due day must be 1 to 31.');
  var deposit = body.deposit === '' || body.deposit == null ? 0 : Number(body.deposit);
  if (!isFinite(deposit) || deposit < 0 || deposit > 1e9) throw new ApiError('bad_request', 'Invalid deposit.');
  var start = dateKey_(body.lease_start);
  var end = body.lease_end ? dateKey_(body.lease_end) : '';
  if (end && end < start) throw new ApiError('bad_request', 'Lease end is before lease start.');

  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  var pw = String(body.password == null ? '' : body.password);
  if (rowIdx < 0 && !pw) throw new ApiError('bad_request', 'Set a password for the new tenant.');
  if (pw) {
    if (pw.length < MIN_PASSWORD_LEN || pw.length > MAX_PASSWORD_LEN) throw new ApiError('bad_request', 'Password must be ' + MIN_PASSWORD_LEN + '–' + MAX_PASSWORD_LEN + ' characters.');
    row[t.idx.Password] = hashPassword_(pw);
  }
  row[t.idx.Tenant_ID]    = rowIdx < 0 ? newId_('TN') : id;
  row[t.idx.Name]         = name;
  row[t.idx.Mobile]       = mobile;
  row[t.idx.Property_ID]  = propertyId;
  row[t.idx.Unit]         = str_(body.unit, 40);
  row[t.idx.Monthly_Rent] = Math.round(rent * 100) / 100;
  row[t.idx.Due_Day]      = dueDay;
  row[t.idx.Deposit]      = Math.round(deposit * 100) / 100;
  row[t.idx.Lease_Start]  = start;
  row[t.idx.Lease_End]    = end;
  row[t.idx.Status]       = status;
  row[t.idx.Note]         = safeText_(strMulti_(body.note, 500));
  writeRow_(t, rowIdx < 0 ? nextRow_(t) : rowIdx + 2, row, ['Mobile', 'Password', 'Lease_Start', 'Lease_End']);
  return { tenant: tenantOut_(t, row) };
}

function tenantOut_(t, row) {
  return { id: row[t.idx.Tenant_ID], name: row[t.idx.Name], mobile: row[t.idx.Mobile], property_id: row[t.idx.Property_ID],
           unit: row[t.idx.Unit], monthly_rent: row[t.idx.Monthly_Rent], due_day: row[t.idx.Due_Day], deposit: row[t.idx.Deposit],
           lease_start: row[t.idx.Lease_Start], lease_end: row[t.idx.Lease_End], status: row[t.idx.Status], note: unsafeText_(String(row[t.idx.Note] || '')) };
}

/** Tenant leaves: Inactive + Lease_End, and (optionally) the Deposit Refund entry — one atomic step. */
function closeTenancy_(body) {
  var t = table_(SHEET_TEN);
  var id = str_(body.tenant_id, 40);
  var rowIdx = findRow_(t, 'Tenant_ID', id);
  if (rowIdx < 0) throw new ApiError('bad_request', 'Choose a tenant.');
  var end = dateKey_(body.end_date);
  var row = t.rows[rowIdx].slice();
  var start = readDateCell_(row[t.idx.Lease_Start]);
  if (start && end < start) throw new ApiError('bad_request', 'End date is before the lease start.');
  var refund = body.refund_amount === '' || body.refund_amount == null ? 0 : Number(body.refund_amount);
  if (!isFinite(refund) || refund < 0 || refund > 1e9) throw new ApiError('bad_request', 'Invalid refund amount.');

  var out = {};
  if (refund > 0) {
    var tt = table_(SHEET_TXN), trow = blankRow_(tt);
    trow[tt.idx.Txn_ID] = newId_('TX'); trow[tt.idx.Date] = end; trow[tt.idx.Type] = 'Deposit Refund';
    trow[tt.idx.Property_ID] = String(row[t.idx.Property_ID]); trow[tt.idx.Tenant_ID] = id;
    trow[tt.idx.Amount] = Math.round(refund * 100) / 100; trow[tt.idx.Notes] = safeText_(strMulti_(body.note, 300));
    writeRow_(tt, nextRow_(tt), trow, ['Date', 'Rent_Month']);
    out.txn = txnFromRow_(tt, trow);
  }
  row[t.idx.Status] = 'Inactive';
  row[t.idx.Lease_End] = end;
  writeRow_(t, rowIdx + 2, row, ['Mobile', 'Password', 'Lease_Start', 'Lease_End']);
  out.tenant = tenantOut_(t, row);
  return out;
}

function saveRule_(body) {
  var t = table_(SHEET_RULES);
  var text = strMulti_(body.text, 500);
  if (!text) throw new ApiError('bad_request', 'Write the rule text.');
  var propertyId = str_(body.property_id, 40) || 'ALL';
  if (propertyId !== 'ALL' && !readProperties_().some(function (p) { return p.id === propertyId; })) throw new ApiError('bad_request', 'Choose a valid property.');
  var id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Rule_ID', id);
  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  row[t.idx.Rule_ID] = rowIdx < 0 ? newId_('RL') : id;
  row[t.idx.Property_ID] = propertyId;
  row[t.idx.Rule_Text] = safeText_(text);
  writeRow_(t, rowIdx < 0 ? nextRow_(t) : rowIdx + 2, row, []);
  return { rule: { id: row[t.idx.Rule_ID], property_id: propertyId, text: text } };
}

function deleteRule_(body) {
  var t = table_(SHEET_RULES), id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Rule_ID', id);
  if (rowIdx < 0) throw new ApiError('bad_request', 'Missing id.');
  t.sh.deleteRow(rowIdx + 2);
  return { id: id };
}

function saveTransaction_(body) {
  var type = String(body.type || '');
  if (TXN_TYPES.indexOf(type) < 0) throw new ApiError('bad_request', 'Invalid type.');
  var amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 1e9) throw new ApiError('bad_request', 'Enter a valid amount.');
  amount = Math.round(amount * 100) / 100;
  var date = dateKey_(body.date);

  var propertyId = str_(body.property_id, 40);
  if (!readProperties_().some(function (p) { return p.id === propertyId; })) throw new ApiError('bad_request', 'Choose a valid property.');

  var tenantId = '', rentMonth = '', rentDue = '';
  if (type === 'Rent' || type === 'Deposit Received' || type === 'Deposit Refund') {
    tenantId = str_(body.tenant_id, 40);
    var ten = readTenants_().filter(function (x) { return x.id === tenantId; })[0];
    if (!ten) throw new ApiError('bad_request', 'Choose a tenant.');
    if (ten.property_id !== propertyId) throw new ApiError('bad_request', 'This tenant does not belong to the selected property.');
    if (type === 'Rent') {
      rentMonth = String(body.rent_month || '');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rentMonth)) throw new ApiError('bad_request', 'Choose the rent month.');
      rentDue = body.rent_due === '' || body.rent_due == null ? ten.monthly_rent : Number(body.rent_due);
      if (!isFinite(rentDue) || rentDue < 0 || rentDue > 1e9) throw new ApiError('bad_request', 'Invalid rent due.');
      rentDue = Math.round(rentDue * 100) / 100;
    }
  }

  var t = table_(SHEET_TXN), id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Txn_ID', id);
  var row = rowIdx < 0 ? blankRow_(t) : t.rows[rowIdx].slice();
  row[t.idx.Txn_ID] = rowIdx < 0 ? newId_('TX') : id;
  row[t.idx.Date] = date; row[t.idx.Type] = type; row[t.idx.Property_ID] = propertyId; row[t.idx.Tenant_ID] = tenantId;
  row[t.idx.Rent_Month] = rentMonth; row[t.idx.Rent_Due] = rentDue; row[t.idx.Amount] = amount;
  row[t.idx.Notes] = safeText_(strMulti_(body.note, 300));
  writeRow_(t, rowIdx < 0 ? nextRow_(t) : rowIdx + 2, row, ['Date', 'Rent_Month']);
  return { saved_id: row[t.idx.Txn_ID], txn: txnFromRow_(t, row) };
}

function deleteTransaction_(body) {
  var t = table_(SHEET_TXN), id = str_(body.id, 40);
  var rowIdx = findRow_(t, 'Txn_ID', id);
  if (rowIdx < 0) throw new ApiError('bad_request', 'Missing id.');
  t.sh.deleteRow(rowIdx + 2);
  return { id: id };
}

// ------------------------------ SHEET I/O ---------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new ApiError('server_error', 'Tab "' + name + '" is missing. Run setupSheets.');
  return sh;
}

/** Reads a tab: {sh, idx (header→col), rows (2D), width}. Columns are found by NAME. */
function table_(name) {
  var sh = sheet_(name), need = HEADERS[name];
  var width = Math.max(sh.getLastColumn(), need.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h] = i; });
  need.forEach(function (h) {
    if (idx[h] === undefined) throw new ApiError('server_error', 'Column "' + h + '" missing in ' + name + '. Run setupSheets.');
  });
  var last = sh.getLastRow();
  return { sh: sh, idx: idx, rows: last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [], width: width };
}

function blankRow_(t) { var r = []; for (var i = 0; i < t.width; i++) r.push(''); return r; }
function nextRow_(t) { return Math.max(t.sh.getLastRow(), 1) + 1; }

/** Writes one row; text-type columns are forced to plain text first so "2026-10" / dates are never auto-converted. */
function writeRow_(t, target, row, textCols) {
  textCols.forEach(function (c) { t.sh.getRange(target, t.idx[c] + 1).setNumberFormat('@'); });
  t.sh.getRange(target, 1, 1, t.width).setValues([row]);
}

/** Row index for an id; -1 when no id was given (= new row); throws if an id is given but not found. */
function findRow_(t, idCol, id) {
  if (!id) return -1;
  var found = -1;
  t.rows.forEach(function (r, i) { if (String(r[t.idx[idCol]]).trim() === id) found = i; });
  if (found < 0) throw new ApiError('not_found', 'Record not found.');
  return found;
}

function mobileTaken_(mobile, exceptTenantId) {
  var a = table_(SHEET_ADMIN), t = table_(SHEET_TEN), taken = false;
  a.rows.forEach(function (r) { if (normMobile_(r[a.idx.Mobile]) === mobile) taken = true; });
  t.rows.forEach(function (r) {
    if (normMobile_(r[t.idx.Mobile]) === mobile && String(r[t.idx.Tenant_ID]).trim() !== exceptTenantId) taken = true;
  });
  return taken;
}

// ---------------------------- VALIDATION ----------------------------

function statusOf_(v) { return String(v == null ? '' : v).trim().toLowerCase() === 'inactive' ? 'Inactive' : 'Active'; }

function dateKey_(v) {
  var s = String(v == null ? '' : v);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ApiError('bad_request', 'Invalid date.');
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new ApiError('bad_request', 'Invalid date.');
  return s;
}

/** Date cell (real Date or text) → 'yyyy-MM-dd', else ''. */
function readDateCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v).trim());
  return m ? m[1] : '';
}
/** Month cell (real Date or text 'yyyy-MM') → 'yyyy-MM', else ''. */
function readMonthCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, TZ, 'yyyy-MM');
  var m = /^(\d{4}-\d{2})/.exec(String(v == null ? '' : v).trim());
  return m ? m[1] : '';
}

function cleanName_(v, max) {
  var n = str_(v, max);
  if (!n) throw new ApiError('bad_request', 'Name is required.');
  if (/^[=+\-@]/.test(n)) throw new ApiError('bad_request', 'Name cannot start with = + - @');
  return n;
}
function str_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function strMulti_(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
/** setValues() evaluates strings starting with = + - @ → prefix an apostrophe; stripped on read. */
function safeText_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unsafeText_(s) { return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }
function normMobile_(v) { var d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function newId_(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

// ------------------------- PASSWORDS & TOKENS -----------------------

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
function hashPassword_(plain) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 'sha256$' + salt + '$' + sha256Hex_(salt + plain);
}
function verifyPassword_(stored, plain) {
  stored = String(stored);
  if (stored.indexOf('sha256$') === 0) {
    var p = stored.split('$');
    return p.length === 3 && safeEqual_(sha256Hex_(p[1] + plain), p[2]);
  }
  return stored !== '' && safeEqual_(stored, plain);
}
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(m) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(m, secret_())); }

/** Token is bound to mobile + role + id + current password hash (changing password / role kills old tokens). */
function makeToken_(u) {
  var expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return { token: expires + '.' + sign_(u.mobile + '.' + u.role + '.' + u.id + '.' + expires + '.' + u.password), expires: expires };
}
function authenticate_(body) {
  var expired = new ApiError('session_expired', 'Session expired. Please login again.');
  var mobile = normMobile_(body.mobile), token = String(body.token || ''), dot = token.indexOf('.');
  if (mobile.length !== 10 || dot < 1) throw expired;
  var expires = Number(token.slice(0, dot));
  if (!isFinite(expires) || expires < Date.now()) throw expired;
  var u = findLogin_(mobile);
  if (!u || u.status !== 'active') throw expired;
  if (!safeEqual_(sign_(u.mobile + '.' + u.role + '.' + u.id + '.' + expires + '.' + u.password), token.slice(dot + 1))) throw expired;
  return u;
}

function assertNotLocked_(m) {
  if (Number(CacheService.getScriptCache().get('fail_' + m) || 0) >= MAX_ATTEMPTS) {
    throw new ApiError('too_many_attempts', 'Too many wrong attempts. Try again after 15 minutes.');
  }
}
function recordFailure_(m) { var c = CacheService.getScriptCache(); c.put('fail_' + m, String(Number(c.get('fail_' + m) || 0) + 1), LOCKOUT_SECONDS); }
function clearFailures_(m) { CacheService.getScriptCache().remove('fail_' + m); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ok_(d) { d = d || {}; d.success = true; return json_(d); }
function fail_(code, message) { return json_({ success: false, error: code, message: message }); }

// ------------------------- ADMIN (run from editor) -------------------

/** Creates / completes all tabs, formats and dropdowns. Safe to re-run (never touches data). */
function setupSheets() {
  var ss = ss_();
  if (ss.getName().indexOf('Untitled') === 0) ss.rename('Rent Manager');
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var need = HEADERS[name];
    var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    need.forEach(function (h) { if (have.indexOf(h) < 0) { sh.getRange(1, have.length + 1).setValue(h); have.push(h); } });
    sh.getRange(1, 1, 1, have.length).setFontWeight('bold').setBackground('#E8EAF6');
    sh.setFrozenRows(1);
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  function fmt(tab, col, f, n) { var t = table_(tab); t.sh.getRange(2, t.idx[col] + 1, n, 1).setNumberFormat(f); }
  function list(tab, col, values, n) {
    var t = table_(tab);
    t.sh.getRange(2, t.idx[col] + 1, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  }
  fmt(SHEET_ADMIN, 'Mobile', '@', 50); fmt(SHEET_ADMIN, 'Password', '@', 50);
  fmt(SHEET_TEN, 'Mobile', '@', 500); fmt(SHEET_TEN, 'Password', '@', 500);
  fmt(SHEET_TEN, 'Lease_Start', '@', 500); fmt(SHEET_TEN, 'Lease_End', '@', 500);
  fmt(SHEET_TXN, 'Date', '@', 5000); fmt(SHEET_TXN, 'Rent_Month', '@', 5000); fmt(SHEET_TXN, 'Notes', '@', 5000);
  fmt(SHEET_TXN, 'Amount', '#,##0.00', 5000); fmt(SHEET_TXN, 'Rent_Due', '#,##0.00', 5000);
  list(SHEET_ADMIN, 'Role', ['Owner', 'Viewer'], 50); list(SHEET_ADMIN, 'Status', ['Active', 'Inactive'], 50);
  list(SHEET_PROP, 'Status', ['Active', 'Inactive'], 200); list(SHEET_TEN, 'Status', ['Active', 'Inactive'], 500);
  list(SHEET_TXN, 'Type', TXN_TYPES, 5000);
  fillMissingIds_();
  SpreadsheetApp.flush();
}

/** Gives an ID to rows typed / pasted by hand without one (needed for edit & delete in the app). */
function fillMissingIds() { fillMissingIds_(); }
function fillMissingIds_() {
  [[SHEET_PROP, 'Property_ID', 'PR'], [SHEET_TEN, 'Tenant_ID', 'TN'], [SHEET_RULES, 'Rule_ID', 'RL'], [SHEET_TXN, 'Txn_ID', 'TX']].forEach(function (p) {
    var t = table_(p[0]);
    if (!t.rows.length) return;
    var changed = false, k = 0;
    var vals = t.rows.map(function (r) {
      var hasData = r.some(function (x, i) { return i !== t.idx[p[1]] && String(x) !== ''; });
      if (hasData && !String(r[t.idx[p[1]]]).trim()) { changed = true; return [newId_(p[2]) + (k++).toString(36)]; }
      return [r[t.idx[p[1]]]];
    });
    if (changed) t.sh.getRange(2, t.idx[p[1]] + 1, vals.length, 1).setValues(vals);
  });
}

/** Edit the constants, then run once: adds an admin login (or resets that admin's password). */
function createAdmin() {
  var ADMIN_MOBILE   = '9999999999';
  var ADMIN_NAME     = 'Owner';
  var ADMIN_PASSWORD = 'ChangeMe123';
  var ADMIN_ROLE     = 'Owner';          // 'Owner' = full access · 'Viewer' = read-only

  var mobile = normMobile_(ADMIN_MOBILE);
  if (mobile.length !== 10) throw new Error('Mobile must be 10 digits.');
  if (ADMIN_PASSWORD.length < MIN_PASSWORD_LEN) throw new Error('Password must be at least 6 characters.');
  if (ADMIN_ROLE !== 'Owner' && ADMIN_ROLE !== 'Viewer') throw new Error('Role must be Owner or Viewer.');
  var a = table_(SHEET_ADMIN), hash = hashPassword_(ADMIN_PASSWORD), found = -1;
  a.rows.forEach(function (r, i) { if (normMobile_(r[a.idx.Mobile]) === mobile) found = i; });
  if (found < 0 && mobileTaken_(mobile, '')) throw new Error('This mobile is already used by a tenant.');
  var row = found < 0 ? blankRow_(a) : a.rows[found].slice();
  row[a.idx.Mobile] = mobile; row[a.idx.Name] = ADMIN_NAME; row[a.idx.Password] = hash; row[a.idx.Role] = ADMIN_ROLE; row[a.idx.Status] = 'Active';
  writeRow_(a, found < 0 ? nextRow_(a) : found + 2, row, ['Mobile', 'Password']);
  Logger.log((found < 0 ? 'Admin created: ' : 'Admin updated: ') + mobile + ' (' + ADMIN_ROLE + ')');
}
