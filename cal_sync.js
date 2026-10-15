/**
 * gcal-merge
 * Merge source Google Calendars into a separate destination calendar.
 */

function getConfiguration() {
  // SETTINGS: keep this function when updating the sync logic below.
  // Source Calendars to merge from
  var sourceCalIds = [
    'source_cal_1@import.calendar.google.com',
    'source_cal_2@import.calendar.google.com',
    'source_cal_N@import.calendar.google.com'
  ];
  // Optionally source events from this account's default calendar (i.e. to select events from your own calendar)
  var personalCalendar = {
    enabled: false,
    color: CalendarApp.EventColor.GREEN,
    titleKeywords: ['OOO', 'VACATION']
  };

  // Destination calendar
  var teamCalId = 'destination_cal@group.calendar.google.com';

  // Event colors set per source calendar, applied to the destination calendar (for differentiation)
  var sourceColors = [
    CalendarApp.EventColor.GREEN,
    CalendarApp.EventColor.RED,
    CalendarApp.EventColor.BLUE
  ];

  return {
    sourceCalIds: sourceCalIds,
    sourceColors: sourceColors,
    personalCalendar: personalCalendar,
    teamCalId: teamCalId
  };
}

/**
 * Read-only preflight. Run this from the editor before the first sync.
 * All calendar reads complete before syncTeamCalendar changes any events.
 * Write access is not tested here: that would require a write or the advanced API.
 */
function validateConfiguration() {
  var config = getConfiguration();
  var errors = [];
  function checkId(id, label) {
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(label + ' must be a non-empty Calendar ID.');
    } else if (/^(source_cal_(1|2|N)|destination_cal)@/i.test(id)) {
      errors.push(label + ' still contains a placeholder. Copy the real Calendar ID from its settings.');
    } else if (/^(https?:|webcal:)/i.test(id) || id !== id.trim()) {
      errors.push(label + ' must be a Calendar ID, not a URL, and must have no surrounding spaces.');
    }
  }
  function checkColor(color, label) {
    var valid = Object.keys(CalendarApp.EventColor).some(function(key) {
      return String(CalendarApp.EventColor[key]) === String(color);
    });
    if (!valid) errors.push(label + ' must be a CalendarApp.EventColor value.');
  }

  checkId(config.teamCalId, 'Destination calendar');
  if (!Array.isArray(config.sourceCalIds) || config.sourceCalIds.length === 0) {
    errors.push('sourceCalIds must contain at least one source Calendar ID.');
  } else {
    config.sourceCalIds.forEach(function(id, index) {
      checkId(id, 'Source calendar ' + (index + 1));
      if (config.sourceCalIds.indexOf(id) !== index) {
        errors.push('Source calendar ' + (index + 1) + ' is duplicated.');
      }
      if (id === config.teamCalId) {
        errors.push('The destination calendar must not also be a source.');
      }
    });
  }
  if (!Array.isArray(config.sourceColors) || !Array.isArray(config.sourceCalIds) ||
      config.sourceColors.length !== config.sourceCalIds.length) {
    errors.push('sourceColors must have exactly one color for each source calendar.');
  } else {
    config.sourceColors.forEach(function(color, index) {
      checkColor(color, 'Source color ' + (index + 1));
    });
  }
  var personal = config.personalCalendar;
  if (!personal || typeof personal.enabled !== 'boolean') {
    errors.push('personalCalendar.enabled must be true or false.');
  } else {
    checkColor(personal.color, 'personalCalendar.color');
    if (!Array.isArray(personal.titleKeywords) || personal.titleKeywords.some(function(keyword) {
      return typeof keyword !== 'string';
    })) {
      errors.push('personalCalendar.titleKeywords must be an array of strings.');
    }
  }
  if (errors.length) {
    throw new Error('Invalid configuration:\n- ' + errors.join('\n- '));
  }

  var start = new Date();
  var end = new Date();
  end.setDate(start.getDate() + 90);
  function readCalendar(id, label) {
    try {
      var calendar = CalendarApp.getCalendarById(id);
      if (!calendar) throw new Error('Calendar not found or not accessible.');
      return { calendar: calendar, events: calendar.getEvents(start, end) };
    } catch (error) {
      throw new Error(label + ' could not be read. Check its Calendar ID and access. ' + error.message);
    }
  }

  var destination = readCalendar(config.teamCalId, 'Destination calendar');
  if (destination.calendar.isMyPrimaryCalendar()) {
    throw new Error('Use a separate destination calendar, not your default calendar.');
  }
  var sourceIds = [];
  var sources = config.sourceCalIds.map(function(id, index) {
    var source = readCalendar(id, 'Source calendar ' + (index + 1));
    var resolvedId = source.calendar.getId();
    if (resolvedId === destination.calendar.getId()) {
      throw new Error('The destination calendar must not also be a source.');
    }
    if (sourceIds.indexOf(resolvedId) !== -1) {
      throw new Error('Multiple source settings resolve to the same calendar.');
    }
    sourceIds.push(resolvedId);
    Logger.log('Source ' + (index + 1) + ': ' + source.events.length + ' events in the next 90 days.');
    return source;
  });
  var defaultEvents = [];
  if (personal.enabled) {
    var defaultCalendar = CalendarApp.getDefaultCalendar();
    if (!defaultCalendar) throw new Error('Default calendar is not accessible.');
    defaultEvents = defaultCalendar.getEvents(start, end);
  }
  Logger.log('Validation passed. Calendar checks complete.');
  return { config: config, destination: destination, sources: sources, defaultEvents: defaultEvents };
}

function syncTeamCalendar() {
  var validated = validateConfiguration();
  var config = validated.config;
  var personalCalendar = config.personalCalendar;
  var sourceColors = config.sourceColors;
  var IDENTIFIER = "Source: Webcal Sync"; // The string the script looks for to manage events
  var teamCal = validated.destination.calendar;
  var teamEvents = validated.destination.events;
  var allSourceEvents = [];
  var stats = { created: 0, recolored: 0, deleted: 0 };

  // 2. PROCESS WEBCALS
  validated.sources.forEach(function(source, index) {
    var events = source.events;
    allSourceEvents = allSourceEvents.concat(events);
    processEvents(events, teamCal, teamEvents, IDENTIFIER, sourceColors[index], stats);
  });

  // 3. OPTIONAL PERSONAL CALENDAR EVENTS (from the account running this script)
  var personalCalendarEvents = [];
  if (personalCalendar.enabled) {
    // Ignore blank keywords so an empty setting never matches every event.
    var keywords = personalCalendar.titleKeywords.map(function(keyword) {
      return keyword.trim().toUpperCase();
    }).filter(function(keyword) {
      return keyword.length > 0;
    });
    personalCalendarEvents = validated.defaultEvents.filter(function(event) {
      var title = event.getTitle().toUpperCase();
      return keywords.some(function(keyword) {
        return title.includes(keyword);
      });
    });
  }
  allSourceEvents = allSourceEvents.concat(personalCalendarEvents);
  processEvents(personalCalendarEvents, teamCal, teamEvents, IDENTIFIER, personalCalendar.color, stats);

  // 4. CLEANUP (With Empty Description Guard)
  teamEvents.forEach(function(targetEvent) {
    // GUARD: If description is null, treat as empty string.
    // This prevents the script from crashing or misidentifying manual events.
    var desc = targetEvent.getDescription() || "";

    // ONLY check for deletion if the identifier is present
    if (desc.includes(IDENTIFIER)) {
      var stillExists = allSourceEvents.some(function(sEvent) {
        return eventsMatch(sEvent, targetEvent);
      });

      if (!stillExists) {
        Logger.log('Deleting stale synced event: ' + targetEvent.getTitle());
        targetEvent.deleteEvent();
        stats.deleted++;
      }
    } else {
      // If the identifier isn't there (even if description is empty), it skips it
      Logger.log('Skipping manual event: ' + targetEvent.getTitle());
    }
  });
  Logger.log('Sync complete: ' + stats.created + ' created, ' +
    stats.recolored + ' recolored, ' + stats.deleted + ' deleted.');
  return stats;
}

/**
 * Logic for adding events correctly (All-day vs Timed)
 */
function processEvents(sourceEvents, teamCal, teamEvents, tag, color, stats) {
  sourceEvents.forEach(function(sourceEvent) {
    var title = sourceEvent.getTitle();
    var startTime = sourceEvent.getStartTime();

    var match = teamEvents.find(function(t) {
      return eventsMatch(sourceEvent, t);
    });

    var isNew = !match;
    if (isNew) {
      var sourceDesc = sourceEvent.getDescription() || "";
      var options = {
        location: sourceEvent.getLocation(),
        description: tag + "\n\n" + sourceDesc
      };

      if (sourceEvent.isAllDayEvent()) {
        match = teamCal.createAllDayEvent(title, sourceEvent.getAllDayStartDate(), sourceEvent.getAllDayEndDate(), options);
      } else {
        match = teamCal.createEvent(title, startTime, sourceEvent.getEndTime(), options);
      }
      teamEvents.push(match);
      stats.created++;
    }

    // Apply source colors to new and existing synced events only.
    if (color && (match.getDescription() || "").includes(tag)) {
      if (match.getColor() !== String(color)) {
        match.setColor(color);
        if (!isNew) stats.recolored++;
      }
    }
  });
}

/**
 * All-day dates are independent of each calendar's midnight time zone.
 * Use the same comparison when finding copies and deciding what is stale.
 */
function eventsMatch(sourceEvent, targetEvent) {
  if (sourceEvent.getTitle() !== targetEvent.getTitle() ||
      sourceEvent.isAllDayEvent() !== targetEvent.isAllDayEvent()) {
    return false;
  }

  if (sourceEvent.isAllDayEvent()) {
    return sourceEvent.getAllDayStartDate().getTime() ===
      targetEvent.getAllDayStartDate().getTime();
  }

  return sourceEvent.getStartTime().getTime() ===
    targetEvent.getStartTime().getTime();
}
