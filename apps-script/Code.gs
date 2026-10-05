/**
 * Shao Lab Inventory: Google Sheet back end.
 *
 * The web page on GitHub talks to this script; the script reads and writes three
 * tabs in this spreadsheet (Items, Vendor options, Stock events).
 *
 * One-time setup, from the spreadsheet's "Lab inventory" menu:
 *   1. Set up tabs      (creates the tabs and loads the reagents from Seed.gs)
 *   2. Set passcodes    (one passcode that can edit, one that can only read)
 * Then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 *
 * The passcodes live in this script's properties, never in the web page.
 */

var TABS = { items: 'Items', opts: 'Vendor options', events: 'Stock events' };

var ITEM_COLS = ['Item ID', 'Name', 'Also called', 'CAS', 'Category', 'Location', 'Min level', 'Unit', 'Stocked',
  'Lead >2 wk', 'Has expiry', 'Required spec', 'Source', 'Notes', 'Status', 'Status date', 'Status by', 'Status note'];
var ITEM_KEYS = ['id', 'name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'stocked',
  'lead', 'exp', 'spec', 'source', 'notes', 'status', 'statusAt', 'statusBy', 'statusNote'];
var ITEM_TYPES = ['t', 't', 't', 't', 't', 't', 'n', 't', 't', 'b', 'b', 't', 't', 't', 't', 't', 't', 't'];
var ITEM_EDITABLE = ['name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'stocked', 'lead', 'exp', 'spec', 'notes'];

var OPT_COLS = ['Option ID', 'Item ID', 'Vendor', 'Catalog #', 'Grade', 'Pack size', 'Pack unit', 'Price ($)',
  'Preferred', 'Price note', 'Alternative catalog #', 'Price checked on', 'Comment'];
var OPT_KEYS = ['oid', 'item', 'vendor', 'catalog', 'grade', 'pack', 'unit', 'price', 'pref', 'pnote', 'alt', 'checked', 'comment'];
var OPT_TYPES = ['t', 't', 't', 't', 't', 'n', 't', 'p', 'b', 't', 't', 't', 't'];

var EVENT_COLS = ['Date', 'Item ID', 'Item', 'Event', 'Reported by', 'Note'];
var EVENT_TYPES = ['t', 't', 't', 't', 't', 't'];

var STATUS_OF = { Low: 'Low', Out: 'Out', Ordered: 'Ordered', Received: 'OK', OK: 'OK' };
var PREFIX = { 'General organic solvents': 'SOL', 'Spec/HPLC solvents': 'SPC', 'Anhydrous solvents': 'ANH',
  'General solids': 'SLD', 'General acids & bases': 'ACB', 'NMR solvents': 'NMR', 'PVSK reagents': 'PVK',
  'Consumables': 'CON', 'Glassware': 'GLS' };
var EVENTS_SENT = 150;

/* ------------------------------------------------------------------ menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Lab inventory')
    .addItem('1. Set up tabs', 'setup')
    .addItem('2. Set passcodes', 'setPasscodes')
    .addItem('Check status', 'status')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  var items = tab_(ss, TABS.items, ITEM_COLS, ITEM_TYPES);
  var opts = tab_(ss, TABS.opts, OPT_COLS, OPT_TYPES);
  tab_(ss, TABS.events, EVENT_COLS, EVENT_TYPES);
  var msg = 'The three tabs are ready.';
  if (items.getLastRow() < 2 && typeof SEED !== 'undefined') {
    var itemRows = [], optRows = [], n = 0;
    SEED.forEach(function (it) {
      itemRows.push(itemRow_(it));
      (it.opts || []).forEach(function (o) {
        n++;
        var c = Object.assign({}, o, { oid: 'V-' + ('00' + n).slice(-3), item: it.id });
        optRows.push(optRow_(c));
      });
    });
    write_(items, 2, itemRows, ITEM_TYPES);
    if (optRows.length) write_(opts, 2, optRows, OPT_TYPES);
    msg += ' Loaded ' + itemRows.length + ' items and ' + optRows.length + ' vendor options.';
  } else if (items.getLastRow() >= 2) {
    msg += ' The Items tab already has rows, so nothing was loaded.';
  }
  alert_(msg + ' Next: Lab inventory > Set passcodes.');
}

function setPasscodes() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var a = ui.prompt('Passcode that can EDIT', 'For lab members who report stock and add items. At least 8 characters.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var b = ui.prompt('Passcode that can only READ', 'For people who should look things up but not change anything. At least 8 characters, different from the first.', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var edit = a.getResponseText().trim(), read = b.getResponseText().trim();
  if (edit.length < 8 || read.length < 8 || edit === read) {
    ui.alert('Not saved. Each passcode needs at least 8 characters and the two must differ.');
    return;
  }
  props.setProperty('EDIT_PASSCODE', edit);
  props.setProperty('READ_PASSCODE', read);
  ui.alert('Saved. Anyone already signed in with an old passcode will be asked to sign in again.');
}

function status() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), props = PropertiesService.getScriptProperties();
  var items = ss.getSheetByName(TABS.items);
  alert_('Tabs: ' + (items ? 'ready, ' + Math.max(0, items.getLastRow() - 1) + ' items' : 'not set up') +
    '\nPasscodes: ' + (props.getProperty('EDIT_PASSCODE') && props.getProperty('READ_PASSCODE') ? 'set' : 'not set'));
}

function alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }

/* --------------------------------------------------------------- web app */

function doGet() {
  return ContentService.createTextOutput('The lab inventory script is running. Open the inventory page to use it.');
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    out = handle_(body);
  } catch (err) {
    out = err && err.error ? { ok: false, error: err.error, message: err.message || '' }
                           : { ok: false, error: 'server', message: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) { return { error: code, message: message || '' }; }

function handle_(body) {
  var props = PropertiesService.getScriptProperties();
  var edit = props.getProperty('EDIT_PASSCODE'), read = props.getProperty('READ_PASSCODE');
  if (!edit || !read) throw fail_('not_set_up', 'Passcodes have not been set in the spreadsheet.');
  var pass = String(body.pass || ''), role = pass === edit ? 'edit' : pass === read ? 'read' : null;
  if (!role) { Utilities.sleep(1000); throw fail_('bad_passcode'); }

  var id = props.getProperty('SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || !ss.getSheetByName(TABS.items)) throw fail_('not_set_up', 'Run Lab inventory > Set up tabs in the spreadsheet.');

  var action = String(body.action || 'load'), extra = {};
  if (action !== 'load') {
    if (role !== 'edit') throw fail_('read_only');
    var user = text_(body.user, 40);
    if (!user) throw fail_('invalid', 'A name is required to make changes.');
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { throw fail_('busy'); }
    try {
      if (action === 'report') report_(ss, body, user);
      else if (action === 'addItem') extra.newId = addItem_(ss, body);
      else if (action === 'updateItem') updateItem_(ss, body);
      else if (action === 'saveOption') saveOption_(ss, body);
      else if (action === 'deleteOption') deleteOption_(ss, body);
      else throw fail_('invalid', 'Unknown action.');
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
  }
  var data = readAll_(ss);
  return Object.assign({ ok: true, role: role, items: data.items, events: data.events }, extra);
}

/* --------------------------------------------------------------- actions */

function report_(ss, body, user) {
  var ev = String(body.event || '');
  if (!STATUS_OF[ev]) throw fail_('invalid', 'Unknown report type.');
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.itemId);
  if (!row) throw fail_('not_found');
  var name = String(items.getRange(row, 2).getValue()), when = now_(ss), note = text_(body.note, 300);
  append_(ss.getSheetByName(TABS.events), [when, String(body.itemId), name, ev, user, note], EVENT_TYPES);
  var c = ITEM_KEYS.indexOf('status') + 1;
  write_(items, row, [[STATUS_OF[ev], when, user, note]], ['t', 't', 't', 't'], c);
}

function addItem_(ss, body) {
  var it = cleanItem_(body.item || {});
  if (!it.name || !it.cat) throw fail_('invalid', 'Name and category are required.');
  var items = ss.getSheetByName(TABS.items), pre = PREFIX[it.cat] || 'GEN';
  it.id = pre + '-' + ('00' + (maxNumber_(items, 1, pre + '-') + 1)).slice(-3);
  it.source = ''; it.status = ''; it.statusAt = ''; it.statusBy = ''; it.statusNote = '';
  append_(items, itemRow_(it), ITEM_TYPES);
  if (body.opt && (body.opt.vendor || body.opt.catalog)) {
    var o = cleanOpt_(body.opt), opts = ss.getSheetByName(TABS.opts);
    o.oid = nextOid_(opts); o.item = it.id; o.pref = true; o.alt = '';
    o.checked = o.price == null ? '' : today_(ss);
    append_(opts, optRow_(o), OPT_TYPES);
  }
  return it.id;
}

function updateItem_(ss, body) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.id);
  if (!row) throw fail_('not_found');
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  var next = cleanItem_(body.fields || {});
  if (!next.name || !next.cat) throw fail_('invalid', 'Name and category are required.');
  ITEM_EDITABLE.forEach(function (k) { cur[k] = next[k]; });
  write_(items, row, [itemRow_(cur)], ITEM_TYPES);
}

function saveOption_(ss, body) {
  var items = ss.getSheetByName(TABS.items), opts = ss.getSheetByName(TABS.opts);
  if (!findRow_(items, 1, body.itemId)) throw fail_('not_found');
  var o = cleanOpt_(body.opt || {});
  if (!o.vendor) throw fail_('invalid', 'Vendor is required.');
  o.item = String(body.itemId);
  var row = body.oid ? findRow_(opts, 1, body.oid) : 0;
  if (body.oid && !row) throw fail_('not_found');
  if (row) {
    var old = fromRow_(opts.getRange(row, 1, 1, OPT_KEYS.length).getValues()[0], OPT_KEYS, OPT_TYPES);
    o.oid = old.oid; o.alt = old.alt;
    o.checked = o.price != null && o.price !== old.price ? today_(ss) : old.checked;
  } else {
    o.oid = nextOid_(opts); o.alt = '';
    o.checked = o.price == null ? '' : today_(ss);
  }
  if (o.pref) {
    var last = opts.getLastRow();
    if (last >= 2) {
      var ids = opts.getRange(2, 2, last - 1, 1).getValues(), pc = OPT_KEYS.indexOf('pref') + 1;
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === o.item && i + 2 !== row) opts.getRange(i + 2, pc).setValue(false);
      }
    }
  }
  if (row) write_(opts, row, [optRow_(o)], OPT_TYPES); else append_(opts, optRow_(o), OPT_TYPES);
}

function deleteOption_(ss, body) {
  var opts = ss.getSheetByName(TABS.opts), row = findRow_(opts, 1, body.oid);
  if (!row) throw fail_('not_found');
  opts.deleteRow(row);
}

/* --------------------------------------------------------------- helpers */

function readAll_(ss) {
  var byId = {}, items = [];
  rows_(ss.getSheetByName(TABS.items), ITEM_KEYS, ITEM_TYPES).forEach(function (it) {
    if (!it.id) return;
    it.opts = []; byId[it.id] = it; items.push(it);
  });
  var optSheet = ss.getSheetByName(TABS.opts);
  if (optSheet) rows_(optSheet, OPT_KEYS, OPT_TYPES).forEach(function (o) {
    var owner = byId[o.item]; if (!owner) return;
    delete o.item; owner.opts.push(o);
  });
  var events = [], es = ss.getSheetByName(TABS.events);
  if (es && es.getLastRow() >= 2) {
    var last = es.getLastRow(), first = Math.max(2, last - EVENTS_SENT + 1);
    es.getRange(first, 1, last - first + 1, EVENT_COLS.length).getValues().forEach(function (r) {
      if (!r[1]) return;
      events.push({ at: stamp_(r[0], ss), item: String(r[1]), name: String(r[2]), event: String(r[3]), by: String(r[4]), note: String(r[5]) });
    });
    events.reverse();
  }
  return { items: items, events: events };
}

function rows_(sheet, keys, types) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, keys.length).getValues().map(function (r) { return fromRow_(r, keys, types); });
}

function fromRow_(r, keys, types) {
  var o = {};
  keys.forEach(function (k, i) {
    var v = r[i], t = types[i];
    if (t === 'b') o[k] = v === true || String(v).toUpperCase() === 'TRUE';
    else if (t === 'n' || t === 'p') o[k] = v === '' || v == null || isNaN(Number(v)) ? null : Number(v);
    else o[k] = v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(v == null ? '' : v);
  });
  return o;
}

function itemRow_(it) { return toRow_(it, ITEM_KEYS, ITEM_TYPES); }
function optRow_(o) { return toRow_(o, OPT_KEYS, OPT_TYPES); }
function toRow_(o, keys, types) {
  return keys.map(function (k, i) {
    var v = o[k], t = types[i];
    if (t === 'b') return !!v;
    if (t === 'n' || t === 'p') return v == null || v === '' || isNaN(Number(v)) ? '' : Number(v);
    return v == null ? '' : String(v);
  });
}

function cleanItem_(f) {
  return { name: text_(f.name, 120), aka: text_(f.aka, 200), cas: text_(f.cas, 40), cat: text_(f.cat, 60), loc: text_(f.loc, 120),
    min: num_(f.min), unit: text_(f.unit, 12), stocked: text_(f.stocked, 12) || 'Not set', lead: !!f.lead, exp: !!f.exp,
    spec: text_(f.spec, 120), notes: text_(f.notes, 500) };
}
function cleanOpt_(f) {
  return { vendor: text_(f.vendor, 60), catalog: text_(f.catalog, 60), grade: text_(f.grade, 60), pack: num_(f.pack),
    unit: text_(f.unit, 12), price: num_(f.price), pref: !!f.pref, pnote: text_(f.pnote, 120), comment: text_(f.comment, 500) };
}
/** Trimmed text with a length cap; a leading "=" is dropped so nothing typed in the page can become a formula. */
function text_(v, max) { return String(v == null ? '' : v).trim().replace(/^[=\s]+/, '').slice(0, max); }
function num_(v) { var n = Number(v); return v == null || v === '' || isNaN(n) || n < 0 ? null : n; }

function formats_(types) {
  return types.map(function (t) { return t === 't' ? '@' : t === 'p' ? '0.00' : '0.###############'; });
}
/** Writes rows starting at (row, col). Text columns are set to plain text first so "7773-1-5" or "0123" stay as typed. */
function write_(sheet, row, rows, types, col) {
  if (!rows.length) return;
  var need = row + rows.length - 1;
  if (need > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows() + 50);
  var range = sheet.getRange(row, col || 1, rows.length, rows[0].length), f = formats_(types);
  range.setNumberFormats(rows.map(function () { return f; }));
  range.setValues(rows);
}
function append_(sheet, row, types) { write_(sheet, sheet.getLastRow() + 1, [row], types); }

function tab_(ss, name, cols, types) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRow_(sheet, col, value) {
  var last = sheet.getLastRow(), want = String(value == null ? '' : value);
  if (last < 2 || !want) return 0;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === want) return i + 2;
  return 0;
}
function maxNumber_(sheet, col, prefix) {
  var last = sheet.getLastRow(), max = 0;
  if (last < 2) return 0;
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (r) {
    var s = String(r[0]);
    if (s.indexOf(prefix) === 0) { var n = parseInt(s.slice(prefix.length), 10); if (n > max) max = n; }
  });
  return max;
}
function nextOid_(opts) { return 'V-' + ('00' + (maxNumber_(opts, 1, 'V-') + 1)).slice(-3); }

function now_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'); }
function today_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd'); }
function stamp_(v, ss) { return v instanceof Date ? Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm') : String(v); }
