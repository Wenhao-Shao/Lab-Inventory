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
 * Item "Type": Stocked (reordered when low), On hand (in the lab, never flagged),
 * Asset (equipment), Price only (a price on file, nothing bought).
 * Item "Current level": the amount last reported on the shelf, in the item's unit. It is the last count
 * someone typed in, not a live number: nothing lowers it when people use the item.
 * Item "Show": Main (listed by default), Price list (behind the price-list switch),
 * More (rows that were hidden in the overseas price list).
 *
 * The passcodes live in this script's properties, never in the web page.
 */

var TABS = { items: 'Items', opts: 'Vendor options', events: 'Stock events' };

var ITEM_COLS = ['Item ID', 'Name', 'Also called', 'CAS', 'Category', 'Location', 'Min level', 'Unit', 'Stocked',
  'Lead >2 wk', 'Has expiry', 'Required spec', 'Source', 'Notes', 'Status', 'Status date', 'Status by', 'Status note', 'Type', 'Show', 'Current level'];
var ITEM_KEYS = ['id', 'name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'stocked',
  'lead', 'exp', 'spec', 'source', 'notes', 'status', 'statusAt', 'statusBy', 'statusNote', 'type', 'show', 'level'];
var ITEM_TYPES = ['t', 't', 't', 't', 't', 't', 'n', 't', 't', 'b', 'b', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'n'];
var ITEM_EDITABLE = ['name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'type', 'lead', 'exp', 'spec', 'notes', 'level'];
var ITEM_KINDS = ['Stocked', 'On hand', 'Asset', 'Price only'];

var OPT_COLS = ['Option ID', 'Item ID', 'Vendor', 'Catalog #', 'Grade', 'Pack size', 'Pack unit', 'Price ($)',
  'Preferred', 'Price note', 'Alternative catalog #', 'Price checked on', 'Comment', 'Link', 'Hidden in price list', 'Times bought', 'Last bought'];
var OPT_KEYS = ['oid', 'item', 'vendor', 'catalog', 'grade', 'pack', 'unit', 'price', 'pref', 'pnote', 'alt', 'checked', 'comment', 'link', 'hidden', 'bought', 'last'];
var OPT_TYPES = ['t', 't', 't', 't', 't', 'n', 't', 'p', 'b', 't', 't', 't', 't', 't', 'b', 'n', 't'];
var OPT_KEPT = ['link', 'hidden', 'bought', 'last'];   // set by the purchase records, not edited in the page

var EVENT_COLS = ['Date', 'Item ID', 'Item', 'Event', 'Reported by', 'Note'];
var EVENT_TYPES = ['t', 't', 't', 't', 't', 't'];

// Reports the page can send. "Stock" is a count of what is on the shelf; its status follows from the count and the min level.
// "Received" and "OK" are kept so that events written before 8 Oct 2026, and an older copy of the page, still work.
var STATUS_OF = { Low: 'Low', Out: 'Out', Ordered: 'Ordered', Stock: 'OK', Received: 'OK', OK: 'OK' };
var PREFIX = { 'General organic solvents': 'SOL', 'Spec/HPLC solvents': 'SPC', 'Anhydrous solvents': 'ANH',
  'General solids': 'SLD', 'General acids & bases': 'ACB', 'NMR solvents': 'NMR', 'PVSK reagents': 'PVK',
  'Research chemicals': 'RCH', 'Gloves & PPE': 'PPE', 'Pipettes & tips': 'PIP', 'Filtration, syringes & needles': 'FIL',
  'Vials, tubes & plates': 'VIA', 'Bottles & containers': 'BOT', 'Glassware': 'GLS', 'Stoppers, septa & joints': 'STP',
  'Stir bars': 'STR', 'Substrates & microscopy': 'SUB', 'Chromatography & TLC': 'TLC', 'Hand tools & weighing': 'TOL',
  'Cleaning & wipes': 'CLN', 'Tapes, films & general supplies': 'SUP', 'Desiccants': 'DES', 'Tubing & fluid transfer': 'TUB',
  'Pumps & vacuum': 'PMP', 'Heating & baths': 'HEA', 'Clamps, stands & supports': 'CLP', 'Benchtop equipment': 'EQP',
  'Consumables': 'CON' };
var EVENTS_SENT = 150;

/* ------------------------------------------------------------------ menu */

function onOpen() {
  var menu = SpreadsheetApp.getUi().createMenu('Lab inventory')
    .addItem('1. Set up tabs', 'setup')
    .addItem('2. Set passcodes', 'setPasscodes')
    .addItem('Check status', 'status');
  if (typeof loadMergedInventory === 'function') menu.addItem('3. Load merged inventory', 'loadMergedInventory');
  if (typeof applyFixes1007 === 'function') menu.addItem('4. Apply fixes (7 Oct)', 'applyFixes1007');
  menu.addToUi();
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

  // A page that sends v >= 2 gets a short answer: only what changed after a save, and a compact table on load.
  var action = String(body.action || 'load'), extra = {}, lean = Number(body.v) >= 2, patch = null;
  if (action !== 'load') {
    if (role !== 'edit') throw fail_('read_only');
    var user = text_(body.user, 40);
    if (!user) throw fail_('invalid', 'A name is required to make changes.');
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { throw fail_('busy'); }
    try {
      if (action === 'report') patch = report_(ss, body, user);
      else if (action === 'addItem') { patch = addItem_(ss, body); extra.newId = patch.add.id; }
      else if (action === 'updateItem') patch = updateItem_(ss, body);
      else if (action === 'saveOption') patch = saveOption_(ss, body);
      else if (action === 'deleteOption') patch = deleteOption_(ss, body);
      else throw fail_('invalid', 'Unknown action.');
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    if (lean) return Object.assign({ ok: true, role: role, patch: patch }, extra);
  }
  if (lean) return Object.assign({ ok: true, role: role }, compact_(ss));
  var data = readAll_(ss);
  return Object.assign({ ok: true, role: role, items: data.items, events: data.events }, extra);
}

/* --------------------------------------------------------------- actions */

function report_(ss, body, user) {
  var ev = String(body.event || '');
  if (!STATUS_OF[ev]) throw fail_('invalid', 'Unknown report type.');
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.itemId);
  if (!row) throw fail_('not_found');
  cols_(items, ITEM_COLS);
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  var when = now_(ss), status = STATUS_OF[ev], level = cur.level, unit = cur.unit || text_(body.unit, 16);
  var given = num_(body.level), note = text_(body.note, 300);
  function amount(n, u) { return String(n) + (u ? ' ' + u : ''); }
  if (ev === 'Out') { level = 0; }
  else if (ev === 'Low') { if (given != null) { level = given; note = amount(given, unit) + ' left'; } }
  else if (ev === 'Stock') {
    if (given == null) throw fail_('invalid', 'Enter how much is on the shelf.');
    level = given; note = amount(given, unit);
    status = given === 0 ? 'Out' : (cur.min != null && given < cur.min ? 'Low' : 'OK');
  } else if (ev === 'Ordered') {
    var qty = num_(body.qty), qunit = text_(body.qunit, 16);
    if (qty != null) note = 'Ordered ' + amount(qty, qunit);
  }
  append_(ss.getSheetByName(TABS.events), [when, String(body.itemId), cur.name, ev, user, note], EVENT_TYPES);
  write_(items, row, [[status, when, user, note]], ['t', 't', 't', 't'], ITEM_KEYS.indexOf('status') + 1);
  if (level !== cur.level) write_(items, row, [[level == null ? '' : level]], ['n'], ITEM_KEYS.indexOf('level') + 1);
  if (unit !== cur.unit) write_(items, row, [[unit]], ['t'], ITEM_KEYS.indexOf('unit') + 1);
  return { item: { id: String(body.itemId), status: status, statusAt: when, statusBy: user, statusNote: note, level: level, unit: unit },
           event: { at: when, item: String(body.itemId), name: cur.name, event: ev, by: user, note: note } };
}

function addItem_(ss, body) {
  var it = cleanItem_(body.item || {});
  if (!it.name || !it.cat) throw fail_('invalid', 'Name and category are required.');
  var items = ss.getSheetByName(TABS.items), pre = PREFIX[it.cat] || 'GEN';
  it.id = pre + '-' + ('00' + (maxNumber_(items, 1, pre + '-') + 1)).slice(-3);
  it.source = ''; it.status = ''; it.statusAt = ''; it.statusBy = ''; it.statusNote = '';
  kind_(it);
  cols_(items, ITEM_COLS);
  append_(items, itemRow_(it), ITEM_TYPES);
  var added = Object.assign({}, it, { opts: [] });
  if (body.opt && (body.opt.vendor || body.opt.catalog)) {
    var o = cleanOpt_(body.opt), opts = ss.getSheetByName(TABS.opts);
    o.oid = nextOid_(opts); o.item = it.id; o.pref = true; o.alt = '';
    o.link = ''; o.hidden = false; o.bought = null; o.last = '';
    o.checked = o.price == null ? '' : today_(ss);
    cols_(opts, OPT_COLS);
    append_(opts, optRow_(o), OPT_TYPES);
    added.opts.push(sent_(o));
  }
  return { add: added };
}

function updateItem_(ss, body) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.id);
  if (!row) throw fail_('not_found');
  cols_(items, ITEM_COLS);
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  if (ITEM_KINDS.indexOf(cur.type) < 0) cur.type = cur.stocked === 'Yes' ? 'Stocked' : 'On hand';
  var next = cleanItem_(body.fields || {});
  if (!next.name || !next.cat) throw fail_('invalid', 'Name and category are required.');
  var sent = body.fields || {};
  ITEM_EDITABLE.forEach(function (k) { if (k === 'level' && sent.level === undefined) return; cur[k] = next[k]; });   // an older page does not send the level
  kind_(cur);
  write_(items, row, [itemRow_(cur)], ITEM_TYPES);
  return { item: cur };
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
    cols_(opts, OPT_COLS);
    var old = fromRow_(opts.getRange(row, 1, 1, OPT_KEYS.length).getValues()[0], OPT_KEYS, OPT_TYPES);
    o.oid = old.oid; o.alt = old.alt;
    OPT_KEPT.forEach(function (k) { o[k] = old[k]; });
    o.checked = o.price != null && o.price !== old.price ? today_(ss) : old.checked;
  } else {
    o.oid = nextOid_(opts); o.alt = ''; o.link = ''; o.hidden = false; o.bought = null; o.last = '';
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
  return { itemId: o.item, opt: sent_(o) };
}

function deleteOption_(ss, body) {
  var opts = ss.getSheetByName(TABS.opts), row = findRow_(opts, 1, body.oid);
  if (!row) throw fail_('not_found');
  opts.deleteRow(row);
  return { delOpt: String(body.oid) };
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
  return { items: items, events: events_(ss) };
}

function events_(ss) {
  var events = [], es = ss.getSheetByName(TABS.events);
  if (es && es.getLastRow() >= 2) {
    var last = es.getLastRow(), first = Math.max(2, last - EVENTS_SENT + 1);
    es.getRange(first, 1, last - first + 1, EVENT_COLS.length).getValues().forEach(function (r) {
      if (!r[1]) return;
      events.push({ at: stamp_(r[0], ss), item: String(r[1]), name: String(r[2]), event: String(r[3]), by: String(r[4]), note: String(r[5]) });
    });
    events.reverse();
  }
  return events;
}

/** The whole inventory as two tables without repeated field names: about half the size of the full form. */
function compact_(ss) {
  function table(sheet, keys, types) {
    var out = [];
    if (sheet) rows_(sheet, keys, types).forEach(function (o) { if (o[keys[0]]) out.push(keys.map(function (k) { return o[k]; })); });
    return out;
  }
  return { compact: true, ikeys: ITEM_KEYS, okeys: OPT_KEYS, items: table(ss.getSheetByName(TABS.items), ITEM_KEYS, ITEM_TYPES),
           opts: table(ss.getSheetByName(TABS.opts), OPT_KEYS, OPT_TYPES), events: events_(ss) };
}

/** A vendor option as the page expects it: every field except the item it belongs to. */
function sent_(o) {
  var out = {};
  OPT_KEYS.forEach(function (k) { if (k !== 'item') out[k] = o[k] === undefined ? '' : o[k]; });
  return out;
}

function rows_(sheet, keys, types) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var width = Math.min(keys.length, sheet.getMaxColumns());
  return sheet.getRange(2, 1, last - 1, width).getValues().map(function (r) { return fromRow_(r, keys, types); });
}

function fromRow_(r, keys, types) {
  var o = {};
  keys.forEach(function (k, i) {
    var v = i < r.length ? r[i] : '', t = types[i];
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
  var type = text_(f.type, 12);
  if (ITEM_KINDS.indexOf(type) < 0) type = f.stocked === 'Yes' || f.stocked == null || f.stocked === '' ? 'Stocked' : 'On hand';
  return { name: text_(f.name, 160), aka: text_(f.aka, 200), cas: text_(f.cas, 40), cat: text_(f.cat, 60), loc: text_(f.loc, 120),
    min: num_(f.min), unit: text_(f.unit, 16), type: type, lead: !!f.lead, exp: !!f.exp,
    spec: text_(f.spec, 120), notes: text_(f.notes, 1000), level: num_(f.level) };
}
/** Keeps the older "Stocked" column and the "Show" column in step with Type. */
function kind_(it) {
  it.stocked = it.type === 'Stocked' ? 'Yes' : (it.stocked === 'Personal' ? 'Personal' : 'No');
  it.show = it.type === 'Price only' ? (it.show === 'More' ? 'More' : 'Price list') : 'Main';
}
function cleanOpt_(f) {
  return { vendor: text_(f.vendor, 80), catalog: text_(f.catalog, 60), grade: text_(f.grade, 160), pack: num_(f.pack),
    unit: text_(f.unit, 16), price: num_(f.price), pref: !!f.pref, pnote: text_(f.pnote, 160), comment: text_(f.comment, 800) };
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
function append_(sheet, row, types) {
  if (sheet.getMaxColumns() < row.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
  write_(sheet, sheet.getLastRow() + 1, [row], types);
}

function tab_(ss, name, cols, types) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Makes sure the sheet is wide enough and has every header this script knows. */
function cols_(sheet, cols) {
  if (sheet.getMaxColumns() < cols.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols.length - sheet.getMaxColumns());
  var head = sheet.getRange(1, 1, 1, cols.length).getValues()[0], changed = false;
  cols.forEach(function (c, i) { if (String(head[i]) !== c) { head[i] = c; changed = true; } });
  if (changed) sheet.getRange(1, 1, 1, cols.length).setValues([head]).setFontWeight('bold');
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
function nextOid_(opts) { return 'V-' + ('000' + (maxNumber_(opts, 1, 'V-') + 1)).slice(-4); }

function now_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'); }
function today_(ss) { return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd'); }
function stamp_(v, ss) { return v instanceof Date ? Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm') : String(v); }
