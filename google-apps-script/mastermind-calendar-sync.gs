/**
 * Mastermind -> Michelle's own calendar sync (Google Apps Script)
 * -------------------------------------------------------------------------
 * Runs INSIDE Michelle's Google account (m@michellesandershair.com).
 *
 * Every hour it:
 *   - Reads Hunter's "Mastermind" Google Calendar (shared to Michelle, read-only).
 *   - Mirrors each upcoming event into a calendar Michelle OWNS ("Mastermind (Hunter)"),
 *     which she then syncs to Square and can mark Busy/Free per event.
 *   - Keeps the mirror current: adds new calls, updates moved ones, removes cancelled ones.
 *   - NEVER overwrites Michelle's own Busy/Free choice on a mirrored event.
 *   - Fails SAFE: if the source calendar can't be read, it changes nothing and emails Hunter.
 *
 * One-time setup (signed in as Michelle at script.google.com):
 *   1. Paste this whole file in, Save.
 *   2. Run "syncMastermind" once -> approve the Google permission prompt.
 *   3. Run "installHourlyTrigger" once -> it now runs itself every hour.
 *   4. In Square Appointments, sync Google Calendar and pick "Mastermind (Hunter)".
 */

var CONFIG = {
  // Hunter's "Mastermind" calendar (verified live 2026-07-21).
  SOURCE_CAL_ID: 'c_515e3e155a61cf0257ebf73e30ecbf1f2e68967d371f1067de9f2fb4fa4277ee@group.calendar.google.com',

  // Where the copies are written. Square syncs only ONE calendar and only blocks
  // events she OWNS -- so we write copies onto her PRIMARY calendar (the one Square
  // already syncs). These copies are created by her, so Square blocks them, unlike
  // the invites she's only a guest on.
  // Set WRITE_TO_PRIMARY=false ONLY if you deliberately point Square at DEST_CAL_NAME.
  WRITE_TO_PRIMARY: true,
  DEST_CAL_NAME: 'Mastermind (Hunter)',

  // How far ahead to keep in sync (days). Covers the retreat + months of calls.
  DAYS_AHEAD: 210,

  // Where to email if anything breaks (so it never fails silently).
  ALERT_EMAIL: 'hunter@hairbyhunty.com'
};

// Tag stamped on each mirrored event so we can match it back to its source.
var SRC_KEY = 'mastermindSrcKey';

/**
 * Main sync. Safe to run as often as you like (idempotent).
 */
function syncMastermind() {
  try {
    var source = CalendarApp.getCalendarById(CONFIG.SOURCE_CAL_ID);
    if (!source) {
      notify_('Sync SKIPPED - could not open the Mastermind source calendar. ' +
              'The sharing may have been removed, or the calendar ID changed. ' +
              'Nothing was added or deleted.');
      return;
    }

    var dest = getDestCalendar_();

    var now = new Date();
    var end = new Date(now.getTime() + CONFIG.DAYS_AHEAD * 24 * 60 * 60 * 1000);

    var srcEvents = source.getEvents(now, end);
    var destEvents = dest.getEvents(now, end);

    // Index existing mirrored events by the source key we stamped on them.
    // (Events without our tag were made by Michelle - we never touch those.)
    var mirrorByKey = {};
    for (var i = 0; i < destEvents.length; i++) {
      var tag = destEvents[i].getTag(SRC_KEY);
      if (tag) mirrorByKey[tag] = destEvents[i];
    }

    // Add new / update changed.
    var liveKeys = {};
    var added = 0, updated = 0;
    for (var j = 0; j < srcEvents.length; j++) {
      var se = srcEvents[j];
      var key = eventKey_(se);
      liveKeys[key] = true;

      var mirror = mirrorByKey[key];
      if (mirror) {
        if (reconcileMirror_(dest, mirror, se, key)) updated++;
      } else {
        createMirror_(dest, se, key);
        added++;
      }
    }

    // Find mirrored events whose source no longer exists in the window (cancelled/removed).
    var stale = [];
    for (var k in mirrorByKey) {
      if (!liveKeys[k]) stale.push(mirrorByKey[k]);
    }

    var removed = 0;
    if (srcEvents.length === 0 && stale.length > 0) {
      // Suspicious: source returned nothing but mirrors exist. Don't mass-delete on a fluke.
      notify_('Sync CAUTION - the Mastermind calendar returned 0 events but ' + stale.length +
              ' mirrored blocks exist. Skipped deletion as a safety check. If the Mastermind ' +
              'calls were genuinely cleared this is fine; otherwise confirm the calendar is ' +
              'still shared to Michelle.');
    } else {
      for (var s = 0; s < stale.length; s++) {
        stale[s].deleteEvent();
        removed++;
      }
    }

    Logger.log('Mastermind sync OK - added ' + added + ', updated ' + updated + ', removed ' + removed);

  } catch (err) {
    notify_('Sync ERROR - ' + (err && err.message ? err.message : err) +
            '\n\n' + (err && err.stack ? err.stack : ''));
  }
}

/**
 * Unique key per event instance. Includes the start time so each occurrence of a
 * recurring call (which all share one series id) is tracked separately.
 */
function eventKey_(e) {
  var start = e.isAllDayEvent() ? e.getAllDayStartDate().getTime() : e.getStartTime().getTime();
  return e.getId() + '|' + start;
}

/**
 * Create a mirrored copy on the destination calendar. New copies default to Busy
 * (the calendar's default) so Square blocks the time; Michelle can flip any to Free.
 */
function createMirror_(dest, se, key) {
  var opts = { description: se.getDescription() || '', location: se.getLocation() || '' };
  var mirror;
  if (se.isAllDayEvent()) {
    mirror = dest.createAllDayEvent(se.getTitle(), se.getAllDayStartDate(), se.getAllDayEndDate(), opts);
  } else {
    mirror = dest.createEvent(se.getTitle(), se.getStartTime(), se.getEndTime(), opts);
  }
  mirror.setTag(SRC_KEY, key);
  return mirror;
}

/**
 * Bring an existing mirror in line with its source (title/time only).
 * NEVER changes Busy/Free - that belongs to Michelle. Returns true if anything changed.
 */
function reconcileMirror_(dest, mirror, se, key) {
  // If the event flipped between timed and all-day (rare), rebuild it cleanly.
  if (se.isAllDayEvent() !== mirror.isAllDayEvent()) {
    mirror.deleteEvent();
    createMirror_(dest, se, key);
    return true;
  }

  var changed = false;

  if (mirror.getTitle() !== se.getTitle()) {
    mirror.setTitle(se.getTitle());
    changed = true;
  }

  if (se.isAllDayEvent()) {
    if (mirror.getAllDayStartDate().getTime() !== se.getAllDayStartDate().getTime() ||
        mirror.getAllDayEndDate().getTime() !== se.getAllDayEndDate().getTime()) {
      mirror.setAllDayDates(se.getAllDayStartDate(), se.getAllDayEndDate());
      changed = true;
    }
  } else {
    if (mirror.getStartTime().getTime() !== se.getStartTime().getTime() ||
        mirror.getEndTime().getTime() !== se.getEndTime().getTime()) {
      mirror.setTime(se.getStartTime(), se.getEndTime());
      changed = true;
    }
  }

  return changed;
}

/**
 * Resolve the destination calendar. Defaults to Michelle's PRIMARY calendar --
 * the one Square syncs -- so the copies actually block her Square availability.
 * If WRITE_TO_PRIMARY is false, find-or-create a separate owned calendar named
 * DEST_CAL_NAME instead (only useful if you point Square at that calendar).
 */
function getDestCalendar_() {
  if (CONFIG.WRITE_TO_PRIMARY) return CalendarApp.getDefaultCalendar();
  var name = CONFIG.DEST_CAL_NAME;
  var cals = CalendarApp.getCalendarsByName(name);
  for (var i = 0; i < cals.length; i++) {
    if (cals[i].isOwnedByMe()) return cals[i];
  }
  return CalendarApp.createCalendar(name);
}

/**
 * Email Hunter when something needs a look. Wrapped so an email failure never
 * crashes the sync.
 */
function notify_(msg) {
  try {
    MailApp.sendEmail(CONFIG.ALERT_EMAIL, 'Mastermind calendar sync - needs a look', msg);
  } catch (e) {
    Logger.log('notify_ failed: ' + e + ' | original message: ' + msg);
  }
}

/**
 * Run ONCE to schedule the hourly sync. Removes any existing schedule for this
 * function first, so running it again won't create duplicates.
 */
function installHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncMastermind') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncMastermind').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed for syncMastermind.');
}
