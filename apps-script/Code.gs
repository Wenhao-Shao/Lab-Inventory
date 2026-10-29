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
 * Item "Type": Stocked (kept in the lab; with a minimum level a count makes it OK or Low, without one it shows as Stocked),
 * Asset (equipment), Price only (a price on file, nothing bought). "On hand" was merged into Stocked on 29 Oct 2026.
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
var ITEM_KINDS = ['Stocked', 'Asset', 'Price only'];   // "On hand" (until 29 Oct 2026) reads as Stocked

var OPT_COLS = ['Option ID', 'Item ID', 'Vendor', 'Catalog #', 'Grade', 'Pack size', 'Pack unit', 'Price ($)',
  'Preferred', 'Price note', 'Alternative catalog #', 'Price checked on', 'Comment', 'Link', 'Hidden in price list', 'Times bought', 'Last bought', 'Size'];
var OPT_KEYS = ['oid', 'item', 'vendor', 'catalog', 'grade', 'pack', 'unit', 'price', 'pref', 'pnote', 'alt', 'checked', 'comment', 'link', 'hidden', 'bought', 'last', 'size'];
var OPT_TYPES = ['t', 't', 't', 't', 't', 'n', 't', 'p', 'b', 't', 't', 't', 't', 't', 'b', 'n', 't', 't'];
var OPT_KEPT = ['hidden', 'bought', 'last'];   // set by the purchase records, not edited in the page

// Stock per size: one row per item and size that has been reported on, or that was made without a vendor row.
// "Recheck by/date": someone asked for this size to be counted again; it is on Due to check until the next report on it.
var SIZE_COLS = ['Item ID', 'Size', 'Status', 'Status date', 'Status by', 'Status note', 'Current level', 'Recheck by', 'Recheck date'];
var SIZE_KEYS = ['item', 'size', 'status', 'statusAt', 'statusBy', 'statusNote', 'level', 'flagBy', 'flagAt'];
var SIZE_TYPES = ['t', 't', 't', 't', 't', 't', 'n', 't', 't'];
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
    .addItem('Set admin passcode', 'setAdminPasscode')
    .addItem('Check status', 'status')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Notifications')
      .addItem('Set up Slack and email', 'setNotifications')
      .addItem('Send a test', 'testNotifications')
      .addItem('Due to check: count now', 'dueCheckNow')
      .addItem('Due to check: daily alert on', 'dueAlertOn')
      .addItem('Due to check: daily alert off', 'dueAlertOff'));
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
  if (typeof applyChanges1028c === 'function') menu.addItem('13. Reorganise sizes (28 Oct)', 'applyChanges1028c');
  if (typeof applyChanges1028d === 'function') menu.addItem('14. Heating block sizes (28 Oct)', 'applyChanges1028d');
  if (typeof applyChanges1029 === 'function') menu.addItem('15. Merge On hand into Stocked (29 Oct)', 'applyChanges1029');
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

/** Third passcode (29 Oct 2026): it can do everything the edit passcode can, and it is the one that ticks off and removes reminders.
 *  Edit passcodes can add reminders but not tick them off. Until an admin passcode is set, the edit passcode ticks them off too. */
function setAdminPasscode() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var a = ui.prompt('Admin passcode', 'For the PI and the Ordering Manager. It can do everything the edit passcode can, and it ticks off and removes reminders. At least 8 characters, different from the other two.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var v = a.getResponseText().trim();
  if (v.length < 8 || v === props.getProperty('EDIT_PASSCODE') || v === props.getProperty('READ_PASSCODE')) {
    ui.alert('Not saved. The admin passcode needs at least 8 characters and must differ from the edit and read passcodes.');
    return;
  }
  props.setProperty('ADMIN_PASSCODE', v);
  ui.alert('Saved. Sign in on the inventory page with this passcode to tick off reminders. The edit passcode can now add reminders but not tick them off.');
}

function status() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), props = PropertiesService.getScriptProperties();
  var items = ss.getSheetByName(TABS.items);
  alert_('Tabs: ' + (items ? 'ready, ' + Math.max(0, items.getLastRow() - 1) + ' items' : 'not set up') +
    '\nPasscodes: ' + (props.getProperty('EDIT_PASSCODE') && props.getProperty('READ_PASSCODE') ? 'set' : 'not set') +
    '\nAdmin passcode: ' + (props.getProperty('ADMIN_PASSCODE') ? 'set' : 'not set') + '\n\n' + notifyStatus_());
}

function alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }

/* --------------------------------------------------------- notifications */
// 29 Oct 2026. Two messages, both sent from this script (it runs as the Sheet's owner):
//   1. Each new reminder is posted to the Slack channel of the webhook (#ordering-receiving), @-mentioning NOTIFY_SLACK.
//   2. Once a day (trigger: Notifications > Due to check: daily alert on), if more than DUE_ALERT_OVER items are due to check,
//      a Slack post @-mentioning NOTIFY_SLACK and an email to NOTIFY_EMAIL. Sent again only after a week, or after the number
//      has dropped to the limit or below and gone over again.
// Script properties (set from Notifications > Set up Slack and email; never written in this file, which is public on GitHub):
//   SLACK_WEBHOOK  a Slack Incoming Webhook URL; NOTIFY_SLACK  Slack member IDs, e.g. "U01ABC, U02DEF";
//   NOTIFY_EMAIL   email addresses, comma separated; DUE_ALERT_OVER  the limit (default 20).
var PAGE_URL = 'https://wenhao-shao.github.io/Lab-Inventory/';
var NOTIFY_ = [];
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function list_(v) { return String(v || '').split(/[\s,;]+/).filter(Boolean); }
function mentions_() { return list_(prop_('NOTIFY_SLACK')).map(function (id) { return '<@' + id + '>'; }).join(' '); }
function dueOver_() { var n = Number(prop_('DUE_ALERT_OVER')); return n > 0 ? Math.floor(n) : 20; }
/** Text from the page, made safe for Slack: no links, mentions or @channel can be slipped in. */
function slackText_(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** Posts to the webhook's channel. True when Slack took it; false (and logged) when it did not or no webhook is set. */
function slack_(text) {
  var url = prop_('SLACK_WEBHOOK');
  if (!url) return false;
  try {
    var r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
    if (r.getResponseCode() === 200) return true;
    Logger.log('Slack answered ' + r.getResponseCode() + ': ' + r.getContentText());
  } catch (e) { Logger.log('Slack: ' + e); }
  return false;
}
function sendQueued_() {
  var q = NOTIFY_; NOTIFY_ = [];
  q.forEach(function (x) {
    if (!x.reminder) return;
    var r = x.reminder, who = mentions_();
    slack_(':memo: New inventory reminder from *' + slackText_(r.by) + '*: ' + slackText_(r.text) + (who ? '\n' + who : '') +
      '\n<' + PAGE_URL + '#reminders|Open Reminders>');
  });
}

/** The items on Due to check, as the page counts them: a size on show that someone asked to recheck, or whose last report is
 *  older than the item's "Check every (days)" (or that was never reported, when the item has a check interval). */
function dueItems_(ss) {
  var items = rows_(ss.getSheetByName(TABS.items), ITEM_KEYS, ITEM_TYPES).filter(function (r) { return r.id; });
  var optsOf = {}, sizesOf = {}, sh = ss.getSheetByName(TABS.sizes), now = Date.now(), out = [];
  rows_(ss.getSheetByName(TABS.opts), OPT_KEYS, OPT_TYPES).forEach(function (o) { if (o.item) (optsOf[o.item] = optsOf[o.item] || []).push(o); });
  if (sh) sizeRows_(sh).forEach(function (r) { (sizesOf[r.item] = sizesOf[r.item] || {})[r.size] = r; });
  function days(at) { if (!at) return Infinity; var d = new Date(String(at).replace(' ', 'T')); return isNaN(d) ? Infinity : (now - d) / 864e5; }
  items.forEach(function (it) {
    var opts = optsOf[it.id] || [], idx = sizesOf[it.id] || {}, anyStar = opts.some(function (o) { return o.pref; }), keys = [], rows = {};
    function add(k) { if (!rows[k]) { rows[k] = []; keys.push(k); } }
    opts.forEach(function (o) { var k = String(o.size || '').trim(); add(k); rows[k].push(o); });
    Object.keys(idx).forEach(function (k) { if (k !== '' || rows['']) add(k); });
    if (!keys.length) add('');
    var hit = [];
    keys.forEach(function (k) {
      var st = idx[k] || (k === '' && !Object.keys(idx).some(function (x) { return idx[x].statusAt; }) ? it : {});
      var starred = rows[k].some(function (o) { return o.pref; });
      var shown = !anyStar || !rows[k].length || starred || ['Low', 'Out', 'Ordered'].indexOf(st.status) >= 0 || !!st.flagAt;
      if (shown && (st.flagAt || (typeof it.check === 'number' && it.check > 0 && days(st.statusAt) >= it.check))) hit.push(k);
    });
    if (hit.length) out.push({ id: it.id, name: it.name, sizes: hit, nSizes: keys.length });
  });
  return out;
}
function dueLine_(d) { return d.name + (d.nSizes > 1 ? ' (' + d.sizes.map(function (k) { return k || 'unnamed size'; }).join(', ') + ')' : ''); }

/** Daily, from the trigger. Sends the Due to check alert when more than the limit are due (see the top of this section). */
function dueAlert() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return dueAlertFor_(ss, false);
}
function dueAlertFor_(ss, force) {
  var props = PropertiesService.getScriptProperties(), due = dueItems_(ss), n = due.length, over = dueOver_();
  if (n <= over && !force) { props.deleteProperty('DUE_ALERT_SENT'); return { sent: false, n: n, why: n + ' due; the alert is for more than ' + over + '.' }; }
  var last = Number(props.getProperty('DUE_ALERT_SENT')) || 0;
  if (!force && last && Date.now() - last < 7 * 864e5)
    return { sent: false, n: n, why: n + ' due; the alert was already sent on ' + Utilities.formatDate(new Date(last), ss.getSpreadsheetTimeZone(), 'MMM d') + ' and goes again a week after that.' };
  var names = due.map(dueLine_), head = names.slice(0, 15), rest = names.length - head.length, who = mentions_();
  var slackOk = slack_(':clipboard: *' + n + ' inventory items are due to check.*' + (who ? ' ' + who : '') +
    ' When you have a moment, please open <' + PAGE_URL + '|the inventory>, choose *Due to check*, and report on each one; any report (a count, Low, Out, Ordered or No need) counts as its check.\n' +
    slackText_(head.join(' · ')) + (rest > 0 ? ' · and ' + rest + ' more' : ''));
  var to = list_(prop_('NOTIFY_EMAIL')), mailOk = false;
  if (to.length) {
    try {
      MailApp.sendEmail({ to: to.join(','), subject: 'Lab inventory: ' + n + ' items are due to check',
        body: 'Hello,\n\n' + n + ' items in the lab inventory are due to check: their routine check interval has passed, or someone asked for a recheck.\n\n' +
          'When you have a moment, please open the inventory, choose "Due to check", and report on each one. Any report (a count, Low, Out, Ordered or No need) counts as its check.\n\n' +
          PAGE_URL + '\n\nDue now:\n' + names.map(function (x) { return '  - ' + x; }).join('\n') +
          '\n\nThis message is sent automatically by the lab inventory when more than ' + over + ' items are due to check.' });
      mailOk = true;
    } catch (e) { Logger.log('Email: ' + e); }
  }
  if (slackOk || mailOk) props.setProperty('DUE_ALERT_SENT', String(Date.now()));
  return { sent: slackOk || mailOk, n: n, why: n + ' due. Slack: ' + (slackOk ? 'sent' : prop_('SLACK_WEBHOOK') ? 'failed (see Executions)' : 'no webhook set') +
    '. Email: ' + (mailOk ? 'sent to ' + to.join(', ') : to.length ? 'failed (see Executions)' : 'no address set') + '.' };
}

function setNotifications() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  function ask(title, text, key, check) {
    var cur = props.getProperty(key) || '';
    var a = ui.prompt(title, text + '\n\nNow: ' + (key === 'SLACK_WEBHOOK' ? (cur ? 'set' : 'not set') : (cur || 'not set')) + '. Leave empty to keep it; type "none" to clear it.', ui.ButtonSet.OK_CANCEL);
    if (a.getSelectedButton() !== ui.Button.OK) return false;
    var v = a.getResponseText().trim();
    if (!v) return true;
    if (v.toLowerCase() === 'none') { props.deleteProperty(key); return true; }
    if (check && !check(v)) { ui.alert('Not saved: that does not look right. Nothing else was changed after this step.'); return false; }
    props.setProperty(key, v); return true;
  }
  if (!ask('Slack webhook', 'The Incoming Webhook URL for #ordering-receiving (it starts with https://hooks.slack.com/). Each new reminder is posted there.', 'SLACK_WEBHOOK',
      function (v) { return /^https:\/\/hooks\.slack\.com\/\S+$/.test(v); })) return;
  if (!ask('Who to @-mention in Slack', 'Slack member IDs, separated by commas (a member ID starts with U; find it in their Slack profile, More, Copy member ID).', 'NOTIFY_SLACK',
      function (v) { return list_(v).every(function (x) { return /^[UW][A-Z0-9]{6,}$/.test(x); }); })) return;
  if (!ask('Who gets the Due to check email', 'Email addresses, separated by commas.', 'NOTIFY_EMAIL',
      function (v) { return list_(v).every(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); }); })) return;
  if (!ask('When to send the Due to check alert', 'Send it when MORE than this many items are due to check (default 20).', 'DUE_ALERT_OVER',
      function (v) { return /^\d+$/.test(v) && Number(v) > 0; })) return;
  ui.alert('Saved.\n\n' + notifyStatus_() + '\n\nNext: Notifications > Send a test.');
}
function notifyStatus_() {
  var on = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dueAlert'; });
  return 'Slack webhook: ' + (prop_('SLACK_WEBHOOK') ? 'set' : 'not set') + '\nSlack @-mentions: ' + (list_(prop_('NOTIFY_SLACK')).length || 'none') +
    '\nDue to check email to: ' + (list_(prop_('NOTIFY_EMAIL')).join(', ') || 'nobody') + '\nDue to check alert: more than ' + dueOver_() + ' items, daily check ' + (on ? 'on' : 'off');
}
/** A Slack post that mentions nobody, and an email to you only. */
function testNotifications() {
  var ui = SpreadsheetApp.getUi(), me = Session.getEffectiveUser().getEmail();
  var ok = slack_(':white_check_mark: Test from the lab inventory. New reminders will be posted here' + (list_(prop_('NOTIFY_SLACK')).length ? ', mentioning ' + list_(prop_('NOTIFY_SLACK')).length + ' people' : '') + '.');
  var mail = false;
  try { MailApp.sendEmail(me, 'Lab inventory: test', 'This is how the Due to check email will arrive. It goes to: ' + (list_(prop_('NOTIFY_EMAIL')).join(', ') || 'nobody yet') + '.'); mail = true; } catch (e) { Logger.log(e); }
  ui.alert('Slack: ' + (ok ? 'posted (look in the channel)' : prop_('SLACK_WEBHOOK') ? 'did not go through; check the webhook URL' : 'no webhook set') + '\nEmail: ' + (mail ? 'sent to you (' + me + ')' : 'did not go through'));
}
function dueCheckNow() {
  var ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActiveSpreadsheet(), due = dueItems_(ss), over = dueOver_();
  var a = ui.alert('Due to check: ' + due.length, due.length + ' items are due to check now (the alert is for more than ' + over + ').\n\n' + due.slice(0, 25).map(dueLine_).join('\n') +
    (due.length > 25 ? '\n... and ' + (due.length - 25) + ' more' : '') + '\n\nSend the alert now (Slack and email), whatever the number?', ui.ButtonSet.YES_NO);
  if (a !== ui.Button.YES) return;
  ui.alert(dueAlertFor_(ss, true).why);
}
function dueAlertOn() {
  dueAlertOff(true);
  ScriptApp.newTrigger('dueAlert').timeBased().everyDays(1).atHour(8).create();
  SpreadsheetApp.getUi().alert('On. Every morning between 8 and 9 the inventory counts the items due to check, and sends the alert when there are more than ' + dueOver_() + '.');
}
function dueAlertOff(quiet) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dueAlert') ScriptApp.deleteTrigger(t); });
  if (quiet !== true) SpreadsheetApp.getUi().alert('Off. No daily Due to check alert.');
}

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
  // Ticking off and removing reminders: the admin passcode, or the edit passcode while no admin passcode is set.
  extra.canTick = role === 'admin' || (role === 'edit' && !admin);
  // The read-only passcode can do two things (29 Oct 2026): say a size looks low (suspectLow: the stock is not changed; the
  // size goes on Due to check and a "Please check" reminder is added), and add a reminder about one item.
  extra.suspectLow = role === 'read'; extra.readReminder = role === 'read';
  LOG_ = []; NOTIFY_ = [];
  // Older activity, or a search of all of it: any passcode (29 Oct 2026).
  if (action === 'events') return Object.assign({ ok: true, role: role }, extra, eventsPage_(ss, body));
  if (action !== 'load') {
    var readOk = action === 'suspectLow' || (action === 'addReminder' && !!body.itemId);
    if (role === 'read' ? !readOk : role !== 'edit' && role !== 'admin') throw fail_('read_only');
    var user = text_(body.user, 40);
    if (!user) throw fail_('invalid', 'A name is required to make changes.');
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { throw fail_('busy'); }
    try {
      if (action === 'report') patch = report_(ss, body, user);
      else if (action === 'suspectLow') patch = suspectLow_(ss, body, user);
      else if (action === 'addItem') { patch = addItem_(ss, body, role, user); extra.newId = patch.add.id; }
      else if (action === 'updateItem') patch = updateItem_(ss, body, role, user);
      else if (action === 'saveOption') patch = saveOption_(ss, body, user);
      else if (action === 'deleteOption') patch = deleteOption_(ss, body, user);
      else if (action === 'deleteItem') patch = deleteItem_(ss, body, user);
      else if (action === 'addReminder') patch = addReminder_(ss, body, user, role === 'read');
      else if (action === 'checkReminder' || action === 'deleteReminder') {
        if (!extra.canTick) throw fail_('admin_only', 'Only the admin passcode ticks off or removes reminders.');
        patch = action === 'checkReminder' ? checkReminder_(ss, body, user) : deleteReminder_(ss, body, user);
      }
      else if (action === 'addSize') patch = addSize_(ss, body, user);
      else if (action === 'deleteSize') patch = deleteSize_(ss, body, user);
      else if (action === 'renameSize') patch = renameSize_(ss, body, user);
      else if (action === 'recheck') patch = recheck_(ss, body, user);
      else throw fail_('invalid', 'Unknown action.');
      if (patch && LOG_.length) patch.log = LOG_;   // what this change wrote to the activity log
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    sendQueued_();   // Slack, after the lock, and never a reason for the save to fail
    if (lean) return Object.assign({ ok: true, role: role, patch: patch }, extra);
  }
  if (lean) return Object.assign({ ok: true, role: role }, extra, compact_(ss));
  var data = readAll_(ss);
  return Object.assign({ ok: true, role: role, items: data.items, events: data.events, reminders: reminders_(ss), sizes: sizes_(ss) }, extra);   // extra carries canTick
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
  return plainReport_(ss, body, user, items, row, cur, ev, when, status, level, unit, note);
}

/** A report on an item without sizes: the item's own status columns change. */
function plainReport_(ss, body, user, items, row, cur, ev, when, status, level, unit, note) {
  append_(ss.getSheetByName(TABS.events), [when, String(body.itemId), cur.name, ev, user, note], EVENT_TYPES);
  write_(items, row, [[status, when, user, note]], ['t', 't', 't', 't'], ITEM_KEYS.indexOf('status') + 1);
  if (level !== cur.level) write_(items, row, [[level == null ? '' : level]], ['n'], ITEM_KEYS.indexOf('level') + 1);
  if (unit !== cur.unit) write_(items, row, [[unit]], ['t'], ITEM_KEYS.indexOf('unit') + 1);
  return { item: { id: String(body.itemId), status: status, statusAt: when, statusBy: user, statusNote: note, level: level, unit: unit },
           event: { at: when, item: String(body.itemId), name: cur.name, event: ev, by: user, note: note } };
}

/** The size (or the item, without sizes) is marked Ordered: { at: date } of that report; otherwise null. */
function heldOrdered_(ss, body, cur) {
  if (!(body.sized && body.sizeKey != null)) return cur.status === 'Ordered' ? { at: cur.statusAt || '' } : null;
  var sh = ss.getSheetByName(TABS.sizes); if (!sh) return null;
  var id = String(body.itemId), key = text_(body.sizeKey, 80);
  var r = sizeRows_(sh).filter(function (x) { return x.item === id && x.size === key; })[0];
  return r && r.status === 'Ordered' ? { at: r.statusAt || '' } : null;
}
/** "2026-10-29 14:05" -> "Oct 29", as the page shows dates. */
function shortDay_(at) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(at || ''));
  return m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] + ' ' + Number(m[3]) : String(at || '');
}
/** From the read-only passcode: someone thinks a size is low and says about how much is left. The stock is not changed.
 *  The size goes on Due to check (as with Recheck, until someone reports on it) and a reminder is added, e.g.
 *  "Please check: Sam suspects Acetone (4 L) has only about 1 L left." The unit typed in goes in the text only. */
function suspectLow_(ss, body, user) {
  var given = num_(body.level);
  if (given == null) throw fail_('invalid', 'Enter about how much is left.');
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, String(body.itemId || ''));
  if (!row) throw fail_('not_found');
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  var size = text_(body.size, 80), unit = cur.unit || text_(body.unit, 16), left = String(given) + (unit ? ' ' + unit : '');
  var held = heldOrdered_(ss, { itemId: body.itemId, sized: true, sizeKey: body.sizeKey }, cur);
  var p = recheck_(ss, body, user, (size ? size + ' · ' : '') + 'thinks it is low, about ' + left + ' left');
  var text = 'Please check: ' + user + ' suspects ' + cur.name + (size ? ' (' + size + ')' : '') + ' has only about ' + left + ' left.' +
    (held ? ' It is marked Ordered' + (held.at ? ' (' + shortDay_(held.at) + ')' : '') + '.' : '');
  p.reminder = addReminder_(ss, { text: text }, user).reminder;
  return p;
}

/** A report on one size of an item that has sizes: the size's own stock row changes, and the item's status columns get the
 *  worst status of the sizes on show (Out, Low, Ordered, OK, No need). The note in the stock event names the size. */
function sizeReport_(ss, body, user, items, row, cur, ev, when, status, given, unit, note) {
  var id = String(body.itemId), key = text_(body.sizeKey, 80), sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES);
  cols_(sh, SIZE_COLS);
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
  var next = { item: id, size: key, status: status, statusAt: when, statusBy: user, statusNote: bare, level: level, flagBy: '', flagAt: '' };   // any report clears a recheck
  if (srow) write_(sh, srow._row, [toRow_(next, SIZE_KEYS, SIZE_TYPES)], SIZE_TYPES);
  else { append_(sh, toRow_(next, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES); mine.push(next); }
  mine = mine.map(function (r) { return r.size === key ? next : r; });
  append_(ss.getSheetByName(TABS.events), [when, id, cur.name, ev, user, note], EVENT_TYPES);
  // The item's own status: the worst of the sizes on show (a size is on show when a row of it is starred or it has no rows).
  var anyStar = opts.some(function (o) { return o.pref; }), shown = {};
  opts.forEach(function (o) { if (o.pref || !anyStar) shown[o.size || ''] = true; });
  mine.forEach(function (r) { if (r.size === key ? (status === 'Low' || status === 'Out' || status === 'Ordered') : (r.status === 'Low' || r.status === 'Out' || r.status === 'Ordered' || r.flagAt)) shown[r.size] = true; });   // an open report or a recheck never hides
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

/** Asks for a size to be counted again: it goes on Due to check until the next report on it. Logged in Stock events as "Recheck". */
function recheck_(ss, body, user, eventNote) {
  var id = String(body.itemId || ''), key = text_(body.sizeKey, 80);
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, id);
  if (!row) throw fail_('not_found');
  var sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES); cols_(sh, SIZE_COLS);
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES), when = now_(ss);
  var r = sizeRows_(sh).filter(function (x) { return x.item === id && x.size === key; })[0];
  if (r) { r.flagBy = user; r.flagAt = when; write_(sh, r._row, [toRow_(r, SIZE_KEYS, SIZE_TYPES)], SIZE_TYPES); delete r._row; }
  else {   // an item without size rows yet: its own stock goes with the new row
    r = { item: id, size: key, status: key === '' ? cur.status : '', statusAt: key === '' ? cur.statusAt : '', statusBy: key === '' ? cur.statusBy : '',
          statusNote: key === '' ? cur.statusNote : '', level: key === '' ? cur.level : null, flagBy: user, flagAt: when };
    append_(sh, toRow_(r, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES);
  }
  var note = eventNote != null ? text_(eventNote, 300) : text_(body.size, 80);
  append_(ss.getSheetByName(TABS.events), [when, id, cur.name, 'Recheck', user, note], EVENT_TYPES);
  var sent = {}; SIZE_KEYS.forEach(function (k) { sent[k] = r[k]; });
  return { sizeRow: sent, event: { at: when, item: id, name: cur.name, event: 'Recheck', by: user, note: note } };
}

/** Makes a size that has no vendor row yet (for example gloves size L), so it shows and can be reported on. */
function addSize_(ss, body, user) {
  var id = String(body.itemId || ''), key = text_(body.size, 80);
  if (!key) throw fail_('invalid', 'Name the size first.');
  if (!findRow_(ss.getSheetByName(TABS.items), 1, id)) throw fail_('not_found');
  var sh = tab_(ss, TABS.sizes, SIZE_COLS, SIZE_TYPES);
  var have = sizeRows_(sh).filter(function (r) { return r.item === id && r.size === key; })[0];
  var r = have || { item: id, size: key, status: '', statusAt: '', statusBy: '', statusNote: '', level: null };
  if (!have) { append_(sh, toRow_(r, SIZE_KEYS, SIZE_TYPES), SIZE_TYPES); log_(ss, id, itemName_(ss, id), 'Size added', user, key); }
  var sent = {}; SIZE_KEYS.forEach(function (k) { sent[k] = r[k]; });
  return { sizeRow: sent };
}
/** Renames a size: its vendor rows and its stock row move to the new name. Renaming an item's unnamed size (from "")
 *  names it, and the item's own stock goes with it. */
function renameSize_(ss, body, user) {
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
  if (to !== from) log_(ss, id, itemName_(ss, id), 'Size renamed', user, (from || '(unnamed)') + ' → ' + to);
  return { renamed: { item: id, from: from, to: to, row: sent } };
}

/** Removes a size's stock row. Its vendor rows, if any, keep their size name. */
function deleteSize_(ss, body, user) {
  var id = String(body.itemId || ''), key = text_(body.size, 80), sh = ss.getSheetByName(TABS.sizes);
  if (sh) sizeRows_(sh).filter(function (r) { return r.item === id && r.size === key; }).reverse().forEach(function (r) { sh.deleteRow(r._row); });
  log_(ss, id, itemName_(ss, id), 'Size removed', user, key || '(unnamed)');
  return { delSize: { item: id, size: key } };
}

function addItem_(ss, body, role, user) {
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
  log_(ss, it.id, it.name, 'Item added', user, [it.cat, it.type, added.opts.length ? 'vendor ' + optLabel_(added.opts[0]) : ''].filter(Boolean).join(' · '));
  return { add: added };
}

function updateItem_(ss, body, role, user) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.id);
  if (!row) throw fail_('not_found');
  cols_(items, ITEM_COLS);
  var cur = fromRow_(items.getRange(row, 1, 1, ITEM_KEYS.length).getValues()[0], ITEM_KEYS, ITEM_TYPES);
  if (ITEM_KINDS.indexOf(cur.type) < 0) cur.type = 'Stocked';
  var next = cleanItem_(body.fields || {});
  if (!next.name || !next.cat) throw fail_('invalid', 'Name and category are required.');
  var sent = body.fields || {}, was = Object.assign({}, cur);
  ITEM_EDITABLE.forEach(function (k) {
    if ((k === 'level' || k === 'check') && sent[k] === undefined) return;   // an older page does not send these
    cur[k] = next[k];
  });
  // An edit never touches the report fields (status, statusAt, statusBy, statusNote), so it does not count as a check.
  kind_(cur);
  write_(items, row, [itemRow_(cur)], ITEM_TYPES);
  var what = changes_(was, cur, ITEM_EDITABLE, ITEM_LABELS);
  if (what) log_(ss, cur.id, cur.name, 'Edit', user, what);
  return { item: cur };
}

function saveOption_(ss, body, user) {
  var items = ss.getSheetByName(TABS.items), opts = ss.getSheetByName(TABS.opts);
  if (!findRow_(items, 1, body.itemId)) throw fail_('not_found');
  var old = null;
  var o = cleanOpt_(body.opt || {});
  if (!o.vendor) throw fail_('invalid', 'Vendor is required.');
  o.item = String(body.itemId);
  var row = body.oid ? findRow_(opts, 1, body.oid) : 0;
  if (body.oid && !row) throw fail_('not_found');
  if (row) {
    cols_(opts, OPT_COLS);
    old = fromRow_(opts.getRange(row, 1, 1, OPT_KEYS.length).getValues()[0], OPT_KEYS, OPT_TYPES);
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
  var name = itemName_(ss, o.item);
  if (!old) log_(ss, o.item, name, 'Vendor added', user, optLabel_(o) + (o.price != null ? ' · $' + o.price : '') + (o.pref ? ' · starred' : ''));
  else {
    var what = changes_(old, o, OPT_LOGGED, OPT_LABELS), star = !!old.pref !== !!o.pref;
    if (what) log_(ss, o.item, name, 'Vendor edited', user, optLabel_(o) + ' · ' + what + (star ? '; ' + (o.pref ? 'starred' : 'unstarred') : ''));
    else if (star) log_(ss, o.item, name, o.pref ? 'Starred' : 'Unstarred', user, optLabel_(o));
  }
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
  log_(ss, id, it.name, 'Item deleted', user, 'moved to the Deleted items tab');
  var szs = ss.getSheetByName(TABS.sizes);
  if (szs) sizeRows_(szs).filter(function (r) { return r.item === id; }).reverse().forEach(function (r) { szs.deleteRow(r._row); });
  return { delItem: id };
}

function deleteOption_(ss, body, user) {
  var opts = ss.getSheetByName(TABS.opts), row = findRow_(opts, 1, body.oid);
  if (!row) throw fail_('not_found');
  var o = fromRow_(opts.getRange(row, 1, 1, OPT_KEYS.length).getValues()[0], OPT_KEYS, OPT_TYPES);
  opts.deleteRow(row);
  log_(ss, o.item, itemName_(ss, o.item), 'Vendor deleted', user, optLabel_(o) + (o.price != null && o.price !== '' ? ' · $' + o.price : ''));
  return { delOpt: String(body.oid) };
}

/* --------------------------------------------------------------- reminders */

function reminders_(ss) {
  var sh = ss.getSheetByName(TABS.reminders);
  return sh ? rows_(sh, REM_KEYS, REM_TYPES).filter(function (r) { return r.rid; }) : [];
}
/** forItem: from the read-only passcode, which can only add a reminder about one item. The item's name is put at the start
 *  ("Acetone: ...") when the text does not already start with it. */
function addReminder_(ss, body, user, forItem) {
  var text = text_(body.text, 300);
  if (forItem) {
    var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, body.itemId);
    if (!row) throw fail_('not_found');
    var name = String(items.getRange(row, ITEM_KEYS.indexOf('name') + 1).getValue() || '').trim();
    if (name && text.toLowerCase().indexOf(name.toLowerCase()) !== 0) text = text ? text_(name + ': ' + text, 300) : '';
    if (text.replace(/[\s:]+$/, '') === name) text = '';   // only the name: nothing written
  }
  if (!text) throw fail_('invalid', 'Write the reminder first.');
  var sh = tab_(ss, TABS.reminders, REM_COLS, REM_TYPES);
  var r = { rid: 'R-' + ('000' + (maxNumber_(sh, 1, 'R-') + 1)).slice(-4), text: text, at: now_(ss), by: user, done: false, doneAt: '', doneBy: '' };
  append_(sh, toRow_(r, REM_KEYS, REM_TYPES), REM_TYPES);
  log_(ss, r.rid, 'Reminder', 'Reminder added', user, text);
  NOTIFY_.push({ reminder: r });
  return { reminder: r };
}
function checkReminder_(ss, body, user) {
  var sh = ss.getSheetByName(TABS.reminders), row = sh ? findRow_(sh, 1, body.rid) : 0;
  if (!row) throw fail_('not_found');
  var r = fromRow_(sh.getRange(row, 1, 1, REM_KEYS.length).getValues()[0], REM_KEYS, REM_TYPES);
  r.done = !!body.done; r.doneAt = r.done ? now_(ss) : ''; r.doneBy = r.done ? user : '';
  write_(sh, row, [[r.done, r.doneAt, r.doneBy]], ['b', 't', 't'], REM_KEYS.indexOf('done') + 1);
  log_(ss, r.rid, 'Reminder', r.done ? 'Reminder closed' : 'Reminder reopened', user, r.text);
  return { reminder: r };
}
function deleteReminder_(ss, body, user) {
  var sh = ss.getSheetByName(TABS.reminders), row = sh ? findRow_(sh, 1, body.rid) : 0;
  if (!row) throw fail_('not_found');
  var r = fromRow_(sh.getRange(row, 1, 1, REM_KEYS.length).getValues()[0], REM_KEYS, REM_TYPES);
  sh.deleteRow(row);
  log_(ss, r.rid, 'Reminder', 'Reminder deleted', user, r.text);
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
  var width = Math.min(SIZE_KEYS.length, sh.getMaxColumns());
  return sh.getRange(2, 1, last - 1, width).getValues().map(function (r, i) {
    var o = fromRow_(r, SIZE_KEYS, SIZE_TYPES); o._row = i + 2; return o;
  }).filter(function (r) { return r.item; });
}

/** The row of the oldest of the EVENTS_SENT events a load sends; "Show older" asks for the rows above it. */
function eventsFrom_(ss) {
  var es = ss.getSheetByName(TABS.events), last = es ? es.getLastRow() : 1;
  return Math.max(2, last - EVENTS_SENT + 1);
}
/** A page of the activity log, newest first, from the rows above row `before`: the next n rows, or, with a search (body.q),
 *  the next n rows that hold every word of it (in the date, item, event, name or note). `before` in the answer is where
 *  the next page starts; `more` says whether rows are left above it. */
function eventsPage_(ss, body) {
  var es = ss.getSheetByName(TABS.events), last = es ? es.getLastRow() : 1;
  var row = Math.min(Math.floor(Number(body.before)) || last + 1, last + 1), n = Math.min(Math.max(Math.floor(Number(body.n)) || EVENTS_SENT, 1), 500);
  var m = searchTerms_(body.q), words = m.words, out = [];
  var chunk = words.length || m.days.length ? 2000 : n;
  while (row > 2 && out.length < n) {
    var hi = row - 1, lo = Math.max(2, hi - chunk + 1), vals = es.getRange(lo, 1, hi - lo + 1, EVENT_COLS.length).getValues();
    row = lo;
    for (var i = hi; i >= lo; i--) {
      var r = vals[i - lo];
      if (!r[1] && !r[3]) continue;
      var e = { at: stamp_(r[0], ss), item: String(r[1]), name: String(r[2]), event: String(r[3]), by: String(r[4]), note: String(r[5]) };
      if ((words.length || m.days.length) && !termsMatch_(m, e)) continue;
      out.push(e);
      if (out.length >= n) { row = i; break; }
    }
  }
  return { events: out, before: row, more: row > 2 };
}
/** A search, split into dates ("Oct 9", "2026-10-09") that must be the entry's day, and words that must each appear in it.
 *  A word of one or two digits must be a whole number in it (so "9" does not find "29"); longer words can be part of a word. */
function searchTerms_(q) {
  var t = String(q || '').toLowerCase().slice(0, 100), days = [];
  t = t.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/g, function (x, mo, d) { days.push(mo + ' ' + Number(d)); return ' '; });
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, function (x) { days.push(shortDay_(x).toLowerCase() + '|' + x); return ' '; });
  return { days: days, words: t.split(/\s+/).filter(Boolean).slice(0, 8) };
}
function termsMatch_(m, e) {
  var dayOf = shortDay_(e.at).toLowerCase(), ymd = String(e.at).slice(0, 10);
  if (!m.days.every(function (d) { var p = d.split('|'); return p[1] ? p[1] === ymd : p[0] === dayOf; })) return false;
  var hay = [e.at, dayOf, e.item, e.name, e.event, e.by, e.note].join(' ').toLowerCase(), toks = hay.split(/[^a-z0-9.%µ]+/);
  return m.words.every(function (w) { return /^\d{1,2}$/.test(w) ? toks.indexOf(w) >= 0 : hay.indexOf(w) >= 0; });
}

/* ---------------------------------------------------------- activity log */
// Every change made from the page is written to the Stock events tab (29 Oct 2026): stock reports and rechecks as before,
// and now item, vendor, size and reminder changes too. LOG_ holds this request's new rows; they go back to the page as patch.log.
var LOG_ = [];
var ITEM_LABELS = ['Name', 'Also called', 'CAS', 'Category', 'Location', 'Min level', 'Unit', 'Type', 'Long lead time', 'Has expiry',
  'Required spec', 'Notes', 'On the shelf', 'Check every (days)'];   // in the order of ITEM_EDITABLE
var OPT_LOGGED = ['vendor', 'catalog', 'grade', 'size', 'pack', 'unit', 'price', 'pnote', 'comment', 'link'];
var OPT_LABELS = ['Vendor', 'Catalog #', 'Grade', 'Size', 'Pack', 'Pack unit', 'Price', 'Price note', 'Comment', 'Link'];
function log_(ss, itemId, name, event, user, note) {
  var e = { at: now_(ss), item: String(itemId || ''), name: String(name || ''), event: event, by: user || '', note: text_(note, 300) };
  append_(tab_(ss, TABS.events, EVENT_COLS, EVENT_TYPES), [e.at, e.item, e.name, e.event, e.by, e.note], EVENT_TYPES);
  LOG_.push(e);
  return e;
}
/** "Min level: 10 → 5; Notes: (empty) → keep in hood": the fields that changed. */
function changes_(a, b, keys, labels) {
  function v(x) { if (x == null || x === '') return '(empty)'; if (x === true) return 'yes'; if (x === false) return 'no'; var t = String(x); return t.length > 40 ? t.slice(0, 38) + '…' : t; }
  var out = [];
  keys.forEach(function (k, i) {
    var x = a[k] == null ? '' : String(a[k]), y = b[k] == null ? '' : String(b[k]);
    if (x !== y) out.push(labels[i] + ': ' + v(a[k]) + ' → ' + v(b[k]));
  });
  return out.join('; ');
}
function itemName_(ss, id) {
  var items = ss.getSheetByName(TABS.items), row = findRow_(items, 1, id);
  return row ? String(items.getRange(row, ITEM_KEYS.indexOf('name') + 1).getValue()) : '';
}
function optLabel_(o) { return [o.vendor, o.catalog, o.size ? '(' + o.size + ')' : ''].filter(Boolean).join(' '); }

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
           skeys: SIZE_KEYS, sizes: sizes_(ss).map(function (r) { return SIZE_KEYS.map(function (k) { return r[k]; }); }), evFrom: eventsFrom_(ss) };
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
  if (ITEM_KINDS.indexOf(type) < 0) type = 'Stocked';
  return { name: text_(f.name, 160), aka: text_(f.aka, 200), cas: text_(f.cas, 40), cat: text_(f.cat, 60), loc: text_(f.loc, 120),
    min: num_(f.min), unit: text_(f.unit, 16), type: type, lead: !!f.lead, exp: !!f.exp,
    spec: text_(f.spec, 120), notes: text_(f.notes, 1000), level: num_(f.level), check: num_(f.check) };
}
/** Keeps the older "Stocked" column and the "Show" column in step with Type. */
function kind_(it) {
  it.stocked = it.stocked === 'Personal' ? 'Personal' : it.type === 'Stocked' ? 'Yes' : 'No';
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
