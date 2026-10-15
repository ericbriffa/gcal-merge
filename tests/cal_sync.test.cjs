const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const script = fs.readFileSync(path.join(__dirname, '..', 'cal_sync.js'), 'utf8');

function setup() {
  const writes = [];
  const reads = [];
  const logs = [];
  const calendars = new Map();
  const start = new Date('2026-11-01T12:00:00Z');
  function event(title, description = '', allDay = false, instant = start) {
    return {
      getTitle: () => title,
      getStartTime: () => instant,
      getEndTime: () => new Date('2026-11-01T13:00:00Z'),
      isAllDayEvent: () => allDay,
      getAllDayStartDate: () => new Date('2026-11-01T00:00:00Z'),
      getAllDayEndDate: () => new Date('2026-11-02T00:00:00Z'),
      getLocation: () => '',
      getDescription: () => description,
      color: '',
      getColor() { return this.color; },
      setColor(color) { this.color = String(color); writes.push('color'); },
      deleteEvent: () => writes.push('delete')
    };
  }
  function calendar(id, primary = false) {
    const result = {
      events: [],
      getId: () => id,
      isMyPrimaryCalendar: () => primary,
      getEvents() { reads.push(id); return [...this.events]; },
      createEvent(title, start, end, options) {
        writes.push(title);
        const result = event(title, options.description);
        this.events.push(result);
        return result;
      }
    };
    calendars.set(id, result);
    return result;
  }
  calendar('source-1');
  calendar('source-2');
  calendar('destination');
  calendar('default', true);
  const config = {
    sourceCalIds: ['source-1', 'source-2'],
    sourceColors: ['10', '11'],
    teamCalId: 'destination',
    personalCalendar: {enabled: false, color: '10', titleKeywords: ['OOO', 'VACATION']}
  };
  const context = vm.createContext({
    Logger: {log(message) { logs.push(message); }},
    CalendarApp: {
      EventColor: {GREEN: '10', RED: '11', BLUE: '9'},
      getCalendarById: id => calendars.get(id) || null,
      getDefaultCalendar: () => calendars.get('default')
    }
  });
  vm.runInContext(script, context);
  context.getConfiguration = () => config;
  return {config, context, calendars, reads, writes, logs, event};
}

test('validation is read-only and leaves the disabled default calendar unread', () => {
  const s = setup();
  s.context.validateConfiguration();
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.reads, ['destination', 'source-1', 'source-2']);
});

const invalidSettings = [
  ['source placeholder', s => s.config.sourceCalIds[0] = 'source_cal_1@import.calendar.google.com', /placeholder/],
  ['destination placeholder', s => s.config.teamCalId = 'destination_cal@group.calendar.google.com', /placeholder/],
  ['missing sources', s => s.config.sourceCalIds = [], /at least one/],
  ['blank ID', s => s.config.sourceCalIds[0] = ' ', /non-empty/],
  ['URL instead of ID', s => s.config.sourceCalIds[0] = 'webcal://example.com/feed', /not a URL/],
  ['duplicate sources', s => s.config.sourceCalIds[1] = 'source-1', /duplicated/],
  ['source is destination', s => s.config.teamCalId = 'source-1', /must not also/],
  ['missing source color', s => s.config.sourceColors.pop(), /exactly one color/],
  ['invalid color', s => s.config.sourceColors[0] = 'chartreuse', /EventColor/],
  ['nonboolean enable flag', s => s.config.personalCalendar.enabled = 'false', /true or false/],
  ['invalid keyword', s => s.config.personalCalendar.titleKeywords = [123], /array of strings/]
];
for (const [name, change, message] of invalidSettings) {
  test('rejects ' + name + ' before any calendar access or writes', () => {
    const s = setup();
    change(s);
    assert.throws(() => s.context.syncTeamCalendar(), message);
    assert.deepEqual(s.reads, []);
    assert.deepEqual(s.writes, []);
  });
}

test('rejects the default calendar as destination', () => {
  const s = setup();
  s.config.teamCalId = 'default';
  assert.throws(() => s.context.syncTeamCalendar(), /not your default/);
  assert.deepEqual(s.writes, []);
});

test('rejects aliases that resolve to the destination or a duplicate source', () => {
  const s = setup();
  s.calendars.set('source-1', s.calendars.get('destination'));
  assert.throws(() => s.context.validateConfiguration(), /must not also/);
  s.calendars.set('source-1', s.calendars.get('source-2'));
  assert.throws(() => s.context.validateConfiguration(), /same calendar/);
});

test('an unreadable final source aborts before creating or deleting any events', () => {
  const s = setup();
  s.calendars.get('source-1').events = [s.event('Shift')];
  s.calendars.get('destination').events = [s.event('Old shift', 'Source: Webcal Sync')];
  s.calendars.get('source-2').getEvents = () => { throw new Error('permission denied'); };
  assert.throws(() => s.context.syncTeamCalendar(), /Source calendar 2 could not be read/);
  assert.deepEqual(s.writes, []);
});

test('an unreadable enabled default calendar also aborts before any writes', () => {
  const s = setup();
  s.config.personalCalendar.enabled = true;
  s.calendars.get('source-1').events = [s.event('Shift')];
  s.calendars.get('default').getEvents = () => { throw new Error('permission denied'); };
  assert.throws(() => s.context.syncTeamCalendar(), /permission denied/);
  assert.deepEqual(s.writes, []);
});

test('sync reuses preflight reads and honors custom case-insensitive keywords', () => {
  const s = setup();
  s.config.personalCalendar = {enabled: true, color: '10', titleKeywords: [' travel ', '']};
  s.calendars.get('default').events = [s.event('Travel to conference'), s.event('Team meeting')];
  s.context.syncTeamCalendar();
  assert.deepEqual(s.writes, ['Travel to conference', 'color']);
  assert.deepEqual(s.reads, ['destination', 'source-1', 'source-2', 'default']);
});

test('all-day matching ignores differing midnight timestamps', () => {
  const s = setup();
  const a = s.event('Time off', '', true, new Date('2026-11-01T00:00:00Z'));
  const b = s.event('Time off', '', true, new Date('2026-11-01T07:00:00Z'));
  assert.equal(s.context.eventsMatch(a, b), true);
});


test('sync logs actual changes after validation and reports a no-op on repeat', () => {
  const s = setup();
  s.calendars.get('source-1').events = [s.event('New shift'), s.event('Existing shift')];
  s.calendars.get('destination').events = [
    s.event('Existing shift', 'Source: Webcal Sync'),
    s.event('Stale shift', 'Source: Webcal Sync'),
    s.event('Manual event')
  ];
  // Reflect a successful deletion in the mock calendar on subsequent runs.
  const stale = s.calendars.get('destination').events[1];
  stale.deleteEvent = () => {
    s.writes.push('delete');
    s.calendars.get('destination').events = s.calendars.get('destination').events.filter(e => e !== stale);
  };
  const first = s.context.syncTeamCalendar();
  assert.equal(first.created, 1);
  assert.equal(first.recolored, 1, 'newly created event color is included under created');
  assert.equal(first.deleted, 1);
  assert.ok(s.logs.includes('Validation passed. Calendar checks complete.'));
  assert.equal(s.logs.at(-1), 'Sync complete: 1 created, 1 recolored, 1 deleted.');
  assert.equal(s.logs.some(line => line.includes('No events changed')), false);
  s.writes.length = 0;
  s.context.syncTeamCalendar();
  assert.equal(s.logs.at(-1), 'Sync complete: 0 created, 0 recolored, 0 deleted.');
  assert.deepEqual(s.writes, []);
});

test('standalone validation never logs a sync summary', () => {
  const s = setup();
  s.context.validateConfiguration();
  assert.equal(s.logs.at(-1), 'Validation passed. Calendar checks complete.');
  assert.equal(s.logs.some(line => line.startsWith('Sync complete:')), false);
});


test('single-file script includes its configuration template', () => {
  const context = vm.createContext({CalendarApp: {EventColor: {GREEN: '10', RED: '11', BLUE: '9'}}});
  vm.runInContext(script, context);
  assert.equal(typeof context.syncTeamCalendar, 'function');
  assert.equal(context.getConfiguration().sourceCalIds.length, 3);
  assert.throws(() => context.validateConfiguration(), /placeholder/);
});
