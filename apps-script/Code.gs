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
 * Item "Check every (days)": how often someone should look at the item and report on it. Empty means no routine
 * check. The page lists items whose last report is older than this under "Due to check".
 * Item "Show": Main (listed by default), Price list (behind the price-list switch),
 * More (rows that were hidden in the overseas price list).
 * Vendor option "Size": the grade / size category the row belongs to (rows with the same size are grouped). An item whose
 * rows have sizes keeps its stock per size on the "Sizes" tab (status, count); its own status columns then hold a summary
 * (the worst status of the sizes on show). The item's min level applies to each size. A size is on show when one of its
 * rows is starred, or when it has no vendor row yet.
 *
 * The passcodes live in this script's properties, never in the web page.
 */

var TABS = { items: 'Items', opts: 'Vendor options', events: 'Stock events', reminders: 'Reminders', sizes: 'Sizes' };

var ITEM_COLS = ['Item ID', 'Name', 'Also called', 'CAS', 'Category', 'Location', 'Min level', 'Unit', 'Stocked',
  'Lead >2 wk', 'Has expiry', 'Required spec', 'Source', 'Notes', 'Status', 'Status date', 'Status by', 'Status note', 'Type', 'Show', 'Current level', 'Check every (days)'];
var ITEM_KEYS = ['id', 'name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'stocked',
  'lead', 'exp', 'spec', 'source', 'notes', 'status', 'statusAt', 'statusBy', 'statusNote', 'type', 'show', 'level', 'check'];
var ITEM_TYPES = ['t', 't', 't', 't', 't', 't', 'n', 't', 't', 'b', 'b', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'n', 'n'];
var ITEM_EDITABLE = ['name', 'aka', 'cas', 'cat', 'loc', 'min', 'unit', 'type', 'lead', 'exp', 'spec', 'notes', 'level', 'check'];
var ITEM_KINDS = ['Stocked', 'On hand', 'Asset', 'Price only'];

var OPT_COLS = ['Option ID', 'Item ID', 'Vendor', 'Catalog #', 'Grade', 'Pack size', 'Pack unit', 'Price ($)',
  'Preferred', 'Price note', 'Alternative catalog #', 'Price checked on', 'Comment', 'Link', 'Hidden in price list', 'Times bought', 'Last bought', 'Size'];
var OPT_KEYS = ['oid', 'item', 'vendor', 'catalog', 'grade', 'pack', 'unit', 'price', 'pref', 'pnote', 'alt', 'checked', 'comment', 'link', 'hidden', 'bought', 'last', 'size'];
var OPT_TYPES = ['t', 't', 't', 't', 't', 'n', 't', 'p', 'b', 't', 't', 't', 't', 't', 'b', 'n', 't', 't'];
var OPT_KEPT = ['hidden', 'bought', 'last'];   // set by the purchase records, not edited in the page

// Stock per size: one row per item and size that has been reported on, or that was made without a vendor row.
var SIZE_COLS = ['Item ID', 'Size', 'Status', 'Status date', 'Status by', 'Status note', 'Current level'];
var SIZE_KEYS = ['item', 'size', 'status', 'statusAt', 'statusBy', 'statusNote', 'level'];
var SIZE_TYPES = ['t', 't', 't', 't', 't', 't', 'n'];
var STATUS_RANK = { 'Out': 6, 'Low': 5, 'Ordered': 4, 'OK': 3, 'No need': 2 };

var EVENT_COLS = ['Date', 'Item ID', 'Item', 'Event', 'Reported by', 'Note'];
var EVENT_TYPES = ['t', 't', 't', 't', 't', 't'];

// Reminders: a shared to-do list for the inventory (links to find, prices to compare). The tab is made on first use.
var REM_COLS = ['ID', 'Reminder', 'Added', 'Added by', 'Done', 'Done date', 'Done by'];
var REM_KEYS = ['rid', 'text', 'at', 'by', 'done', 'doneAt', 'doneBy'];
var REM_TYPES = ['t', 't', 't', 't', 'b', 't', 't'];

// Reports the page can send. "Stock" is a count of what is on the shelf; its status follows from the count and the min level.
// "Received" and "OK" are kept so that events written before 8 Oct 2026, and an older copy of the page, still work.
// "No need" says the lab does not need to restock this for now; any later report replaces it.
var STATUS_OF = { Low: 'Low', Out: 'Out', Ordered: 'Ordered', Stock: 'OK', 'No need': 'No need', Received: 'OK', OK: 'OK' };
var PREFIX = { 'General organic solvents': 'SOL', 'Spec/HPLC solvents': 'SPC', 'Anhydrous solvents': 'ANH',
  'General solids': 'SLD', 'General acids & bases': 'ACB', 'NMR solvents': 'NMR', 'PVSK reagents': 'PVK',
  'Research chemicals': 'RCH', 'Gloves & PPE': 'PPE', 'Pipettes & tips': 'PIP', 'Filtration, syringes & needles': 'FIL',
  'Vials, tubes & plates': 'VIA', 'Bottles & containers': 'BOT', 'Glassware': 'GLS', 'Stoppers, septa & joints': 'STP',
  'Stir bars': 'STR', 'Substrates & microscopy': 'SUB', 'Chromatography & TLC': 'TLC', 'Hand tools & weighing': 'TOL',
  'Cleaning & wipes': 'CLN', 'Tapes, films & general supplies': 'SUP', 'General supply': 'SUP', 'Desiccants': 'DES', 'Tubing & fluid transfer': 'TUB',
  'Pumps & vacuum': 'PMP', 'Heating & baths': 'HEA', 'Clamps, stands & supports': 'CLP', 'Benchtop equipment': 'EQP', 'Asset': 'EQP',
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
  if (typeof applyChanges1008 === 'function') menu.addItem('5. Apply changes (8 Oct)', 'applyChanges1008');
  if (typeof applyChanges1021 === 'function') menu.addItem('6. Apply changes (21 Oct)', 'applyChanges1021');
  if (typeof applyChanges1021b === 'function') menu.addItem('7. Apply changes (21 Oct, part 2)', 'applyChanges1021b');
  if (typeof applyChanges1021c === 'function') menu.addItem('8. Apply changes (21 Oct, part 3)', 'applyChanges1021c');
  if (typeof applyChanges1021d === 'function') menu.addItem('9. Remove merge notes (21 Oct)', 'applyChanges1021d');
  if (typeof applyChanges1022 === 'function') menu.addItem('10. Group centrifuge tubes (22 Oct)', 'applyChanges1022');
  if (typeof applyChanges1028 === 'function') menu.addItem('11. Sizes for gloves, dropper bulb, PTFE filter paper (28 Oct)', 'applyChanges1028');
  if (typeof applyChanges1028b === 'function') menu.addItem('12. A size for every item (28 Oct)', 'applyChanges1028b');
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

/** Optional third passcode. It works exactly like the edit passcode (Due to check comes with edit); kept so a passcode already set this way still signs in. Not on the menu. */
function setAdminPasscode() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var a = ui.prompt('Admin passcode', 'For the PI and the Ordering Manager. It can edit, sees Due to check, and sets how often items are checked. At least 8 characters, different from the other two.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var v = a.getResponseText().trim();
  if (v.length < 8 || v === props.getProperty('EDIT_PASSCODE') || v === props.getProperty('READ_PASSCODE')) {
    ui.alert('Not saved. The admin passcode needs at least 8 characters and must differ from the edit and read passcodes.');
    return;
  }
  props.setProperty('ADMIN_PASSCODE', v);
  ui.alert('Saved. Sign in on the inventory page with this passcode to see Due to check.');
}

function status() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), props = PropertiesService.getScriptProperties();
  var items = ss.getSheetByName(TABS.items);
  alert_('Tabs: ' + (items ? 'ready, ' + Math.max(0, items.getLastRow() - 1) + ' items' : 'not set up') +
    '\nPasscodes: ' + (props.getProperty('EDIT_PASSCODE') && props.getProperty('READ_PASSCODE') ? 'set' : 'not set') +
    '\nAdmin passcode: ' + (props.getProperty('ADMIN_PASSCODE') ? 'set' : 'not set'));
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
  var admin = props.getProperty('ADMIN_PASSCODE');
  var pass = String(body.pass || ''), role = admin && pass === admin ? 'admin' : pass === edit ? 'edit' : pass === read ? 'read' : null;
  if (!role) { Utilities.sleep(1000); throw fail_('bad_passcode'); }

  var id = props.getProperty('SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || !ss.getSheetByName(TABS.items)) throw fail_('not_set_up', 'Run Lab inventory > Set up tabs in the spreadsheet.');

  // A page that sends v >= 2 gets a short answer: only what changed after a save, and a compact table on load.
  var action = String(body.action || 'load'), extra = {}, lean = Number(body.v) >= 2, patch = null;
  if (action !== 'load') {
    if (role !== 'edit' && role !== 'admin') throw fail_('read_only');
    var user = text_(body.user, 40);
    if (!user) throw fail_('invalid', 'A name is required to make changes.');
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { throw fail_('busy'); }
    try {
      if (action === 'report') patch = report_(ss, body, user);
      else if (action === 'addItem') { patch = addItem_(ss, body, role); extra.newId = patch.add.id; }
      else if (action === 'updateItem') patch = updateItem_(ss, body, role);
      else if (action === 'saveOption') patch = saveOption_(ss, body);
      else if (action === 'deleteOption') patch = deleteOption_(ss, body);
      else if (action === 'deleteItem') patch = deleteItem_(ss, body, user);
      else if (action === 'addReminder') patch = addReminder_(ss, body, user);
      else if (action === 'checkReminder') patch = checkReminder_(ss, body, user);
      else if (action === 'deleteReminder') patch = deleteReminder_(ss, body);
      else if (action === 'addSize') patch = addSize_(ss, body);
      else if (action === 'deleteSize') patch = deleteSize_(ss, body);
      else if (action === 'renameSize') patch = renameSize_(ss, body);
      else throw fail_('invalid', 'Unknown action.');
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    if (lean) return Object.assign({ ok: true, role: role, patch: patch }, extra);
  }
  if (lean) return Object.assign({ ok: true, role: role }, compact_(ss));
  var data = readAll_(ss);
  return Object.assign({ ok: true, role: role, items: data.items, events: data.events, reminders: reminders_(ss), sizes: sizes_(ss) }, extra);
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
  var size = text_(body.size, 80);   // the size's name, written at the start of the note
  if (size) note = size + (note ? ' · ' + note : '');
  if (body.sized && body.sizeKey != null) return sizeReport_(ss, body, user, items, row, cur, ev, when, status, given, unit, note);
  append_(ss.getSheetByName(TABS.events), [when, String(body.itemId), cur.name, ev, user, note], EVENT_TYPES);
  write_(items, row, [[status, when, user, note]], ['t', 't', 't', 't'], ITEM_KEYS.indexOf('status') + 1);
  if (level !== cur.level) write_(items, row, [[level == null ? '' : level]], ['n'], ITEM_KEYS.indexOf('level') + 1);
  if (unit !== cur.unit) write_(items, row, [[unit]], ['t'], ITEM_KEYS.indexOf('unit') + 1);
  return { item: { id: String(body.itemId), status: status, statusAt: when, statusBy: user, statusNote: note, level: level, unit: unit },
           event: { at: when, item: String(body.itemId), name: cur.name, event: ev, by: user, note: note } };
}

/** A report on one size of an item that has sizes: the size's own stock row changes, and the item's status columns get the
 *  worst status of the sizes on show (Out, Low, Ordered, OK, No need). The note in the stock event names the size. */
function sizeReport_(ss, body, user, items, row, cur, ev, when, status, given, unit, note) {
  var id = String(body.itemId), key = text_(body.sizeKey, 80), sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES);
  var all = sizeRows_(sh), mine = all.filter(function (r) { return r.item === id; });
  var srow = mine.filter(function (r) { return r.size === key; })[0];
  var opts = rows_(ss.getSheetByName(TABS.opts), OPT_KEYS, OPT_TYPES).filter(function (o) { return o.item === id; });
  // Rows without a size held the item's own stock until now: keep that stock under their (unnamed) size.
  if (key !== '' && !mine.some(function (r) { return r.size === ''; }) && opts.some(function (o) { return !o.size; }) && cur.status) {
    var keepRow = { item: id, size: '', status: cur.status, statusAt: cur.statusAt, statusBy: cur.statusBy, statusNote: cur.statusNote, level: cur.level };
    append_(sh, toRow_(keepRow, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES); keepRow._row = sh.getLastRow(); mine.push(keepRow);
  }
  var level = srow ? srow.level : null;
  if (ev === 'Out') level = 0;
  else if (ev === 'Low' || ev === 'Stock') { if (given != null) level = given; }
  if (ev === 'Stock') status = given === 0 ? 'Out' : (cur.min != null && given < cur.min ? 'Low' : 'OK');
  var bare = note.indexOf(' · ') >= 0 && text_(body.size, 80) ? note.slice(note.indexOf(' · ') + 3) : (text_(body.size, 80) ? '' : note);
  var next = { item: id, size: key, status: status, statusAt: when, statusBy: user, statusNote: bare, level: level };
  if (srow) write_(sh, srow._row, [toRow_(next, SIZE_KEYS, SIZE_TYPES)], SIZE_TYPES);
  else { append_(sh, toRow_(next, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES); mine.push(next); }
  mine = mine.map(function (r) { return r.size === key ? next : r; });
  append_(ss.getSheetByName(TABS.events), [when, id, cur.name, ev, user, note], EVENT_TYPES);
  // The item's own status: the worst of the sizes on show (a size is on show when a row of it is starred or it has no rows).
  var anyStar = opts.some(function (o) { return o.pref; }), shown = {};
  opts.forEach(function (o) { if (o.pref || !anyStar) shown[o.size || ''] = true; });
  mine.forEach(function (r) { if (!opts.some(function (o) { return (o.size || '') === r.size; })) shown[r.size] = true; });
  var worst = '', parts = [];
  mine.forEach(function (r) {
    if (!shown[r.size] || !r.status) return;
    if (!worst || (STATUS_RANK[r.status] || 0) > (STATUS_RANK[worst] || 0)) worst = r.status;
    parts.push((r.size || 'other') + ': ' + r.status + (typeof r.level === 'number' ? ' ' + r.level + (cur.unit ? ' ' + cur.unit : '') : ''));
  });
  var sumNote = parts.join('; ').slice(0, 300);
  write_(items, row, [[worst || status, when, user, sumNote]], ['t', 't', 't', 't'], ITEM_KEYS.indexOf('status') + 1);
  if (unit !== cur.unit) write_(items, row, [[unit]], ['t'], ITEM_KEYS.indexOf('unit') + 1);
  var sent = {}; SIZE_KEYS.forEach(function (k) { sent[k] = next[k]; });
  return { item: { id: id, status: worst || status, statusAt: when, statusBy: user, statusNote: sumNote, unit: unit }, sizeRow: sent,
           event: { at: when, item: id, name: cur.name, event: ev, by: user, note: note } };
}

/** Makes a size that has no vendor row yet (for example gloves size L), so it shows and can be reported on. */
function addSize_(ss, body) {
  var id = String(body.itemId || ''), key = text_(body.size, 80);
  if (!key) throw fail_('invalid', 'Name the size first.');
  if (!findRow_(ss.getSheetByName(TABS.items), 1, id)) throw fail_('not_found');
  var sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES);
  var have = sizeRows_(sh).filter(function (r) { return r.item === id && r.size === key; })[0];
  var r = have || { item: id, size: key, status: '', statusAt: '', statusBy: '', statusNote: '', level: null };
  if (!have) append_(sh, toRow_(r, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES);
  var sent = {}; SIZE_KEYS.forEach(function (k) { sent[k] = r[k]; });
  return { sizeRow: sent };
}
/** Renames a size: its vendor rows and its stock row move to the new name. Renaming an item's unnamed size (from "")
 *  names it, and the item's own stock goes with it. */
function renameSize_(ss, body) {
  var id = String(body.itemId || ''), from = text_(body.from, 80), to = text_(body.to, 80);
  if (!to) throw fail_('invalid', 'Name the size first.');
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, id);
  if (!row) throw fail_('not_found');
  var opts = ss.getSheetByName(TABS.opts), sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES);
  cols_(opts, OPT_COLS);
  var all = sizeRows_(sh), mine = all.filter(function (r) { return r.item === id; });
  var optRows = rows_(opts, OPT_KEYS, OPT_TYPES);
  if (to !== from && (mine.some(function (r) { return r.size === to; }) || optRows.some(function (o) { return o.item === id && (o.size || '') === to; })))
    throw fail_('invalid', 'This item already has a size called ' + to + '.');
  var col = OPT_KEYS.indexOf('size') + 1;
  optRows.forEach(function (o, i) {
    if (o.item === id && String(o.size || '').trim() === from) write_(opts, i + 2, [[to]], ['t'], col);
  });
  var srow = mine.filter(function (r) { return r.size === from; })[0], out;
  if (srow) { srow.size = to; write_(sh, srow._row, [toRow_(srow, SIZE_KEYS, SIZE_TYPES)], SIZE_TYPES); out = srow; }
  else {
    var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
    out = { item: id, size: to, status: from === '' ? cur.status : '', statusAt: from === '' ? cur.statusAt : '', statusBy: from === '' ? cur.statusBy : '',
            statusNote: from === '' ? cur.statusNote : '', level: from === '' ? cur.level : null };
    if (from === '' || !optRows.some(function (o) { return o.item === id && String(o.size || '').trim() === from; })) append_(sh, toRow_(out, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES);
    else out = null;
  }
  var sent = null; if (out) { sent = {}; SIZE_KEYS.forEach(function (k) { sent[k] = out[k]; }); }
  return { renamed: { item: id, from: from, to: to, row: sent } };
}

/** Removes a size's stock row. Its vendor rows, if any, keep their size name. */
function deleteSize_(ss, body) {
  var id = String(body.itemId || ''), key = text_(body.size, 80), sh = ss.getSheetByName(TABS.sizes);
  if (sh) sizeRows_(sh).filter(function (r) { return r.item === id && r.size === key; }).reverse().forEach(function (r) { sh.deleteRow(r._row); });
  return { delSize: { item: id, size: key } };
}

function addItem_(ss, body, role) {
  var it = cleanItem_(body.item || {});
  if (!it.name || !it.cat) throw fail_('invalid', 'Name and category are required.');
  var items = ss.getSheetByName(TABS.items), pre = PREFIX[it.cat] || 'GEN';
  var used = maxNumber_(items, 1, pre + '-');
  ['Merged items', 'Deleted items'].forEach(function (t) { var sh = ss.getSheetByName(t); if (sh) used = Math.max(used, maxNumber_(sh, 1, pre + '-')); });
  it.id = pre + '-' + ('00' + (used + 1)).slice(-3);
  it.source = ''; it.status = ''; it.statusAt = ''; it.statusBy = ''; it.statusNote = '';
  kind_(it);
  cols_(items, ITEM_COLS);
  append_(items, itemRow_(it), ITEM_TYPES);
  var added = Object.assign({}, it, { opts: [] });
  if (body.opt && (body.opt.vendor || body.opt.catalog)) {
    var o = cleanOpt_(body.opt), opts = ss.getSheetByName(TABS.opts);
    o.oid = nextOid_(opts); o.item = it.id; o.pref = true; o.alt = '';
    o.link = o.link || ''; o.size = o.size || ''; o.hidden = false; o.bought = null; o.last = '';
    o.checked = o.price == null ? '' : today_(ss);
    cols_(opts, OPT_COLS);
    append_(opts, optRow_(o), OPT_TYPES);
    added.opts.push(sent_(o));
  }
  return { add: added };
}

function updateItem_(ss, body, role) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.id);
  if (!row) throw fail_('not_found');
  cols_(items, ITEM_COLS);
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  if (ITEM_KINDS.indexOf(cur.type) < 0) cur.type = cur.stocked === 'Yes' ? 'Stocked' : 'On hand';
  var next = cleanItem_(body.fields || {});
  if (!next.name || !next.cat) throw fail_('invalid', 'Name and category are required.');
  var sent = body.fields || {};
  ITEM_EDITABLE.forEach(function (k) {
    if ((k === 'level' || k === 'check') && sent[k] === undefined) return;   // an older page does not send these
    cur[k] = next[k];
  });
  // An edit never touches the report fields (status, statusAt, statusBy, statusNote), so it does not count as a check.
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
    if (o.link === undefined) o.link = old.link;   // a page from before 21 Oct does not send the link
    if (o.size === undefined) o.size = old.size;   // nor, before 28 Oct, the size
    o.checked = o.price != null && o.price !== old.price ? today_(ss) : old.checked;
  } else {
    o.oid = nextOid_(opts); o.alt = ''; o.link = o.link || ''; o.size = o.size || ''; o.hidden = false; o.bought = null; o.last = '';
    o.checked = o.price == null ? '' : today_(ss);
    cols_(opts, OPT_COLS);
  }
  // Several vendor rows of one item can be starred (21 Oct 2026), so a star here leaves the other rows alone.
  if (row) write_(opts, row, [optRow_(o)], OPT_TYPES); else append_(opts, optRow_(o), OPT_TYPES);
  return { itemId: o.item, opt: sent_(o) };
}

/** Moves an item and its vendor options to the "Deleted items" and "Deleted vendor options" tabs, so a wrong delete can be undone by moving the rows back. */
function deleteItem_(ss, body, user) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.id);
  if (!row) throw fail_('not_found');
  cols_(items, ITEM_COLS);
  var when = now_(ss), id = String(body.id);
  var it = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  var di = tab_(ss, 'Deleted items', ITEM_COLS.concat(['Deleted on', 'Deleted by']), ITEM_TYPES.concat(['t', 't']));
  append_(di, itemRow_(it).concat([when, user]), ITEM_TYPES.concat(['t', 't']));
  var opts = ss.getSheetByName(TABS.opts), last = opts.getLastRow();
  if (last >= 2) {
    cols_(opts, OPT_COLS);
    var vals = opts.getRange(2, 1, last - 1, OPT_KEYS.length).getValues(), keep = [];
    var dop = tab_(ss, 'Deleted vendor options', OPT_COLS.concat(['Deleted on', 'Deleted by']), OPT_TYPES.concat(['t', 't']));
    for (var i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][1]) !== id) continue;
      var drow = optRow_(fromRow_(vals[i], OPT_KEYS, OPT_TYPES));   // the deleted tab keeps its old columns; the size goes after "Deleted by"
      append_(dop, drow.slice(0, 17).concat([when, user, drow[17]]), OPT_TYPES.slice(0, 17).concat(['t', 't', 't']));
      opts.deleteRow(i + 2);
    }
  }
  items.deleteRow(row);
  var szs = ss.getSheetByName(TABS.sizes);
  if (szs) sizeRows_(szs).filter(function (r) { return r.item === id; }).reverse().forEach(function (r) { szs.deleteRow(r._row); });
  return { delItem: id };
}

function deleteOption_(ss, body) {
  var opts = ss.getSheetByName(TABS.opts), row = findRow_(opts, 1, body.oid);
  if (!row) throw fail_('not_found');
  opts.deleteRow(row);
  return { delOpt: String(body.oid) };
}

/* --------------------------------------------------------------- reminders */

function reminders_(ss) {
  var sh = ss.getSheetByName(TABS.reminders);
  return sh ? rows_(sh, REM_KEYS, REM_TYPES).filter(function (r) { return r.rid; }) : [];
}
function addReminder_(ss, body, user) {
  var text = text_(body.text, 300);
  if (!text) throw fail_('invalid', 'Write the reminder first.');
  var sh = tab_(ss, TABS.reminders, REM_COLS, REM_TYPES);
  var r = { rid: 'R-' + ('000' + (maxNumber_(sh, 1, 'R-') + 1)).slice(-4), text: text, at: now_(ss), by: user, done: false, doneAt: '', doneBy: '' };
  append_(sh, toRow_(r, REM_KEYS, REM_TYPES), REM_TYPES);
  return { reminder: r };
}
function checkReminder_(ss, body, user) {
  var sh = ss.getSheetByName(TABS.reminders), row = sh ? findRow_(sh, 1, body.rid) : 0;
  if (!row) throw fail_('not_found');
  var r = fromRow_(sh.getRange(row, 1, 1, REM_KEYS.length).getValues()[0], REM_KEYS, REM_TYPES);
  r.done = !!body.done; r.doneAt = r.done ? now_(ss) : ''; r.doneBy = r.done ? user : '';
  write_(sh, row, [[r.done, r.doneAt, r.doneBy]], ['b', 't', 't'], REM_KEYS.indexOf('done') + 1);
  return { reminder: r };
}
function deleteReminder_(ss, body) {
  var sh = ss.getSheetByName(TABS.reminders), row = sh ? findRow_(sh, 1, body.rid) : 0;
  if (!row) throw fail_('not_found');
  sh.deleteRow(row);
  return { delReminder: String(body.rid) };
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

function sizes_(ss) {
  var sh = ss.getSheetByName(TABS.sizes);
  return sh ? sizeRows_(sh).map(function (r) { delete r._row; return r; }) : [];
}
/** The Sizes tab's rows, each with its sheet row number in _row. */
function sizeRows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SIZE_KEYS.length).getValues().map(function (r, i) {
    var o = fromRow_(r, SIZE_KEYS, SIZE_TYPES); o._row = i + 2; return o;
  }).filter(function (r) { return r.item; });
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
           opts: table(ss.getSheetByName(TABS.opts), OPT_KEYS, OPT_TYPES), events: events_(ss), reminders: reminders_(ss),
           skeys: SIZE_KEYS, sizes: sizes_(ss).map(function (r) { return SIZE_KEYS.map(function (k) { return r[k]; }); }) };
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
    spec: text_(f.spec, 120), notes: text_(f.notes, 1000), level: num_(f.level), check: num_(f.check) };
}
/** Keeps the older "Stocked" column and the "Show" column in step with Type. */
function kind_(it) {
  it.stocked = it.type === 'Stocked' ? 'Yes' : (it.stocked === 'Personal' ? 'Personal' : 'No');
  it.show = it.type === 'Price only' ? (it.show === 'More' ? 'More' : 'Price list') : 'Main';
}
function cleanOpt_(f) {
  return { vendor: text_(f.vendor, 80), catalog: text_(f.catalog, 60), grade: text_(f.grade, 160), pack: num_(f.pack),
    unit: text_(f.unit, 16), price: num_(f.price), pref: !!f.pref, pnote: text_(f.pnote, 160), comment: text_(f.comment, 800),
    link: f.link === undefined ? undefined : links_(f.link), size: f.size === undefined ? undefined : text_(f.size, 80) };
}
/** One or more web addresses, kept as "url ; url". Anything that is not an http(s) address is dropped. */
function links_(v) {
  return (String(v == null ? '' : v).match(/https?:\/\/[^\s;"'<>]+/gi) || []).filter(function (u, i, a) { return a.indexOf(u) === i; }).join(' ; ').slice(0, 2000);
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
