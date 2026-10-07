import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const runtime = await readFile(new URL('../App/Resources/runtime.js', import.meta.url), 'utf8');
const legacy = await readFile(new URL('../App/Resources/legacy.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../docs/legacy-manifest.json', import.meta.url)));
const plain = value => JSON.parse(JSON.stringify(value));
async function engine(options = {}) {
  const calls = [], persisted = {}, timers = new Set();
  let context;
  const timeout = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  context = vm.createContext({ console, setTimeout: timeout, clearTimeout: id => { timers.delete(id); clearTimeout(id); }, setInterval, clearInterval,
    __native(raw) {
      const message = JSON.parse(raw); calls.push(message);
      Promise.resolve().then(async () => {
        if (options.handler) { const override = await options.handler(message); if (override !== undefined) return override; }
        if (message.method === 'storage.apply') { for (const op of message.payload.operations) if (op.op === 'writeText') persisted[op.path] = { kind: 'text', value: op.value }; return {}; }
        if (message.method === 'request') return { text: 'ok', status: 200 };
        if (message.method === 'alert') return { index: -1, values: [] };
        if (message.method === 'calendar.between' || /^notifications\.(pending|delivered)$/.test(message.method)) return [];
        if (message.method === 'location.current') throw Error('No GPS in test');
        if (['widget.result', 'widget.error', 'widget.publish', 'widget.preview', 'notifications.remove'].includes(message.method)) return {};
        throw Error('Unhandled native method: ' + message.method);
      }).then(value => context.UniDayNative.resolve(message.id, value, null), error => context.UniDayNative.resolve(message.id, null, error.message));
    }
  });
  vm.runInContext(runtime, context, { filename: 'runtime.js' });
  vm.runInContext(legacy, context, { filename: 'legacy.js' });
  const evaluate = expression => vm.runInContext(expression, context);
  await context.UniDayNative.bootstrap({ files: options.files || {}, directories: ['/documents/UniDay-Personal'], device: { screenSize: { width: 390, height: 844 } }, widget: options.widget ?? true });
  evaluate(`applyProfile({...currentProfile(),calendarURL:'https://example.test/calendar.ics',universityLabel:'Test',city:'Tartu',stops:[{key:'home',id:'test:home',code:'H',name:'Home test',label:'Home',direction:'University',latitude:58.38,longitude:26.72},{key:'uni',id:'test:uni',code:'U',name:'Uni test',label:'Uni',direction:'Home',latitude:58.40,longitude:26.74}],widgetStopKeys:['home','uni'],courseItems:{},courseHints:{}})`);
  return { context, evaluate, calls, persisted, close() { for (const id of timers) clearTimeout(id); } };
}
const ics = events => 'BEGIN:VCALENDAR\r\n' + events.join('\r\n') + '\r\nEND:VCALENDAR';
const event = (uid, start, end, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:Math AB.1234\r\n${extra}\r\nEND:VEVENT`;

test('all 271 original top-level functions and contiguous segments are preserved', () => {
  assert.equal(createHash('sha256').update(legacy).digest('hex'), manifest.generatedSHA256);
  const declarations = [...legacy.matchAll(/^(?:async )?function (\w+)\s*\(/gm)];
  assert.equal(declarations.length, 271);
  assert.deepEqual(declarations.map(x => x[1]), manifest.functions.map(x => x.name));
  for (let i = 0; i < declarations.length; i++) assert.equal(createHash('sha256').update(legacy.slice(declarations[i].index, declarations[i + 1]?.index ?? legacy.length)).digest('hex'), manifest.functions[i].sha256);
  assert.doesNotMatch(legacy, /await main\(\);\s*Script\.complete\(\);\s*$/);
});

test('blank defaults contain no calendar, addresses, stops or personal profile', async () => {
  const e = await engine();
  try {
    const prefix = legacy.slice(0, legacy.indexOf('const PREFIX'));
    const settings = JSON.parse(prefix.slice(prefix.indexOf('const SETTINGS = {') + 17, prefix.lastIndexOf('};') + 1));
    assert.equal(settings.calendarURL, ''); assert.equal(settings.city, ''); assert.equal(settings.universityLabel, '');
    assert.deepEqual(settings.stops, []); assert.deepEqual(settings.extraStops, []); assert.deepEqual(settings.locationAnchors, { home: null, uni: null });
  } finally { e.close(); }
});

test('ICS folding, escaping, daily recurrence and explicit cancellation survive native runtime', async () => {
  const e = await engine();
  try {
    const text = ics([event('a', '20261005T090000Z', '20261005T100000Z', 'RRULE:FREQ=DAILY;COUNT=3\r\nDESCRIPTION:One\\nTwo\r\nLOCATION:Room\r\n 123'), 'BEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261006T090000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT']);
    e.context.calendarText = text;
    const values = plain(e.evaluate(`expandCalendar(parseCalendar(calendarText),new Date('2026-10-05'),new Date('2026-10-09'))`));
    assert.equal(values.length, 2); assert.equal(values[0].notes, 'One\nTwo'); assert.equal(values[0].location, 'Room123');
    assert.equal(values[1].start, '2026-10-07T09:00:00.000Z');
  } finally { e.close(); }
});

test('unknown recurrence, invalid date and nonexistent DST wall time reject rather than silently shift', async () => {
  const e = await engine();
  try {
    for (const text of [ics([event('a', '20261005T090000Z', '20261005T100000Z', 'RRULE:FREQ=MONTHLY')]), ics([event('a', '20260230T090000Z', '20260302T100000Z')])]) {
      e.context.calendarText = text; assert.throws(() => e.evaluate('parseCalendar(calendarText)'));
    }
    assert.throws(() => e.evaluate(`fromWall([2026,3,29,3,30],'Europe/Tallinn')`), /Некорректное/);
    assert.equal(e.evaluate(`dayKey(fromWall([2026,10,25,4,30]))`), '2026-10-25');
  } finally { e.close(); }
});

test('native network status and in-flight deduplication use the existing NetworkClient', async () => {
  let requests = 0;
  const e = await engine({ handler: async message => { if (message.method === 'request') { requests++; await new Promise(resolve => setTimeout(resolve, 5)); return { text: 'denied', status: 404 }; } } });
  try {
    const values = await e.evaluate(`Promise.allSettled([loadRequest('https://example.test/fail'),loadRequest('https://example.test/fail')])`);
    assert.equal(requests, 1); assert.equal(values[0].status, 'rejected'); assert.match(values[0].reason.message, /HTTP 404/);
  } finally { e.close(); }
});

test('native Alert fields, cancellation and secure-field flags retain their meaning', async () => {
  const e = await engine({ handler: message => message.method === 'alert' ? { index: 0, values: ['changed', 'secret'] } : undefined });
  try {
    const value = await e.evaluate(`(async()=>{const a=new Alert();a.addAction('Save');a.addCancelAction('Cancel');a.addTextField('Name','old');a.addSecureTextField('Password');const choice=await a.presentAlert();return {choice,text:a.textFieldValue(0)}})()`);
    assert.deepEqual(plain(value), { choice: 0, text: 'changed' });
    assert.equal(e.calls.find(x => x.method === 'alert').payload.fields[1].secure, true);
  } finally { e.close(); }
});

test('virtual files cannot escape the documents sandbox; native writes flush explicitly', async () => {
  const e = await engine();
  try {
    assert.throws(() => e.context.UniDay.debug.virtualPath('/documents-other/private'), /Недопустимый/);
    assert.throws(() => e.context.UniDay.debug.virtualPath('/documents/../secret'), /Недопустимый/);
    e.evaluate(`FileManager.local().writeString('/documents/UniDay-Personal/test.json','{"ok":true}')`);
    assert.equal(Object.keys(e.persisted).length, 0);
    await e.context.UniDayNative.flush();
    assert.equal(e.persisted['/documents/UniDay-Personal/test.json'].value, '{"ok":true}');
  } finally { e.close(); }
});

test('disk failure is surfaced and pending writes remain recoverable', async () => {
  let fail = true;
  const e = await engine({ handler: message => { if (message.method === 'storage.apply' && fail) throw Error('Disk full'); } });
  try {
    e.evaluate(`FileManager.local().writeString('/documents/UniDay-Personal/packing.json','{}')`);
    await assert.rejects(e.context.UniDay.flush(), /Disk full/);
    assert.equal(e.context.UniDay.debug.pendingOperations().length, 1);
    assert.throws(() => e.evaluate(`FileManager.local().writeString('/documents/UniDay-Personal/notes.json','{}')`), /Запись остановлена/);
    fail = false; await e.context.UniDay.retrySaving();
    assert.equal(e.persisted['/documents/UniDay-Personal/packing.json'].value, '{}');
  } finally { e.close(); }
});

test('native calendar timestamps rehydrate to Dates and cache queried ranges', async () => {
  const e = await engine({ handler: message => message.method === 'calendar.between' ? [{ identifier: 'private-test-event', title: 'Mine', startDate: 1791363600000, endDate: 1791367200000, isAllDay: false }] : undefined });
  try {
    const value = await e.evaluate(`CalendarEvent.between(new Date('2026-10-07'),new Date('2026-10-08'))`);
    assert.equal(typeof value[0].startDate.getTime, 'function');
    assert.equal(e.context.UniDay.debug.state().calendarEvents[0].identifier, 'private-test-event');
  } finally { e.close(); }
});

test('scheduled stale departures never claim realtime and cancelled trips disappear', async () => {
  const e = await engine();
  try {
    e.context.raw = { stoptimesForPatterns: [{ pattern: { route: { shortName: '3' } }, stoptimes: [
      { serviceDay: 1000000000, scheduledDeparture: 100, realtimeDeparture: 160, realtime: true, trip: { gtfsId: 'trip' }, stopSequence: 4 },
      { serviceDay: 1000000000, scheduledDeparture: 110, realtimeDeparture: 200, realtime: true, realtimeState: 'CANCELED' }
    ] }] };
    const live = e.evaluate('departures(raw,new Date(1000000000000))');
    const cached = e.evaluate('departures(raw,new Date(1000000000000),null,true)');
    assert.equal(live.length, 1); assert.equal(+live[0].date, 1000000160000); assert.equal(live[0].live, true);
    assert.equal(cached[0].live, false); assert.equal(+cached[0].date, 1000000100000);
  } finally { e.close(); }
});

test('route visibility, balanced priorities and origin stop order remain unchanged', async () => {
  const e = await engine();
  try {
    e.evaluate(`SETTINGS.stopPriorities.home=['3'];SETTINGS.hiddenRoutes.home=['5'];SETTINGS.allowedRoutes.home=['3','4'];`);
    assert.equal(e.evaluate(`routeVisible(SETTINGS.stops[0],'3')`), true);
    assert.equal(e.evaluate(`routeVisible(SETTINGS.stops[0],'5')`), false);
    assert.deepEqual(plain(e.evaluate(`effectiveStopKeys({side:'home'})`)), ['home']);
    const routes = plain(e.evaluate(`mixedPriorityDepartures([{route:'3',date:new Date(100)},{route:'3',date:new Date(300)},{route:'3',date:new Date(500)}],[{route:'4',date:new Date(200)},{route:'4',date:new Date(400)}],1,4).map(x=>x.route)`));
    assert.deepEqual(routes, ['3', '3', '4', '4']);
  } finally { e.close(); }
});

test('exact notes, checkboxes, lists, edits, personal index and profile survive simulated app update', async () => {
  const e = await engine();
  try {
    e.evaluate(`saveProfile({...currentProfile(),alwaysBring:['Laptop'],courseItems:{'AB.1234':['Ruler']},courseHints:{'AB.1234':'Hint'},widgetCustomText:['My own text'],travelChains:[{key:'chain_1',name:'My commute',legs:[{from:'home',to:'uni',stopKeys:['home'],routes:['3']}]}],activeTravelChain:'chain_1'})`);
    const records = { 'lesson-notes.json': '{"keep":"Private note"}', 'packing.json': '{"2026-10-07":["Umbrella"]}', 'packing-checks.json': '{"2026-10-07":{"[\\"Umbrella\\"]":false}}', 'lesson-edits.json': '{"edit":{"label":"Mine","scope":"one","title":"My class"}}', 'personal-event-ids.json': '["local-event"]' };
    for (const [name, value] of Object.entries(records)) { e.context.payload = value; e.evaluate(`FileManager.local().writeString('/documents/UniDay-Personal/${name}',payload)`); }
    await e.context.UniDay.flush();
    const upgraded = await engine({ files: plain(e.persisted) });
    try {
      assert.equal(await upgraded.evaluate('bootstrapProfile()'), true);
      const profile = plain(upgraded.evaluate('currentProfile()'));
      assert.equal(profile.calendarURL, 'https://example.test/calendar.ics'); assert.equal(profile.activeTravelChain, 'chain_1');
      assert.deepEqual(profile.alwaysBring, ['Laptop']); assert.deepEqual(profile.courseItems['AB.1234'], ['Ruler']); assert.deepEqual(profile.widgetCustomText, ['My own text']);
      for (const [name, value] of Object.entries(records)) assert.equal(upgraded.evaluate(`FileManager.local().readString('/documents/UniDay-Personal/${name}')`), value);
      assert.equal(upgraded.evaluate(`readPackingChecks(FileManager.local(),'/documents/UniDay-Personal/packing-checks.json')['2026-10-07']['["Umbrella"]']`), false);
    } finally { upgraded.close(); }
  } finally { e.close(); }
});

test('legacy v1/v2 profile migration preserves explicit empty choices and custom appearance', async () => {
  const e = await engine();
  try {
    const profile = plain(e.evaluate('currentProfile()'));
    profile.widgetStopKeys = []; profile.appearance.mediumLayout = 'columns'; profile.appearance.mediumColumnSplit = 65; delete profile.appearance.mediumLayoutVersion;
    profile.appearance.categoryCustomFont = 'Georgia'; profile.courseHints['AB.1234'] = 'Keep';
    e.context.envelope = { version: 2, dataFolder: 'UniDay-EMU', profile };
    const migrated = plain(e.evaluate('profileEnvelope(envelope)'));
    assert.deepEqual(migrated.profile.widgetStopKeys, []); assert.equal(migrated.profile.appearance.mediumLayout, 'columns'); assert.equal(migrated.profile.courseHints['AB.1234'], 'Keep');
    assert.equal(migrated.dataFolder, 'UniDay-EMU');
    e.context.envelope.version = 4; assert.throws(() => e.evaluate('profileEnvelope(envelope)'), /Неизвестная версия/);
  } finally { e.close(); }
});

test('calendar-link migration retains original and copied note/edit keys', async () => {
  const e = await engine();
  try {
    e.context.data = { '["https://old.test/cal","uid",123]': 'note', '["course-edit","https://old.test/cal","AB.1234"]': { title: 'Edited' }, other: 'other' };
    const values = plain(e.evaluate(`copyCalendarKeys(data,'https://old.test/cal','https://new.test/cal')`));
    assert.equal(values['["https://new.test/cal","uid",123]'], 'note'); assert.equal(values['["https://old.test/cal","uid",123]'], 'note');
    assert.equal(values['["course-edit","https://new.test/cal","AB.1234"]'].title, 'Edited'); assert.equal(values.other, 'other');
  } finally { e.close(); }
});

test('damaged user records and primary profile recover without silently replacing data', async () => {
  const e = await engine();
  try {
    e.evaluate(`saveProfile(currentProfile());FileManager.local().writeString('/documents/UniDay-Personal/packing.json','broken');FileManager.local().writeString('/documents/UniDay-Personal/profile.json','broken')`);
    assert.throws(() => e.evaluate(`readPacking(FileManager.local(),'/documents/UniDay-Personal/packing.json')`));
    assert.equal(await e.evaluate('bootstrapProfile()'), true);
    assert.match(e.evaluate('SETTINGS.profileRecoveryWarning'), /резервная копия/);
    assert.equal(e.evaluate(`FileManager.local().readString('/documents/UniDay-Personal/packing.json')`), 'broken');
  } finally { e.close(); }
});

test('native exported widget plans preserve all sizes, typography, blocks, native timer dates and deep links', async () => {
  const e = await engine();
  try {
    const model = e.evaluate(`(()=>{const now=new Date();const current={uid:'x',title:'Math AB.1234',code:'AB.1234',start:new Date(+now-600000),end:new Date(+now+1200000),location:'Room 1'};return {now,lessons:[current],upcoming:[current],calendarOK:true,calendarWarning:'',buses:[],weather:missingWeather(),position:{side:null},busSaved:null}})()`);
    const plans = plain(e.context.UniDay.exportWidgetPlans(model));
    assert.deepEqual(Object.keys(plans), ['small', 'medium', 'large']);
    assert.equal(plans.medium.dashboard, true); assert.equal(plans.small.family, 'small');
    const cells = plans.large.groups.flatMap(x => x.rows.flat()); assert.ok(cells.some(x => x.date && x.timer));
    assert.ok(cells.every(x => x.font && Number.isFinite(x.points))); assert.ok(plans.large.url.startsWith('uniday://overview'));
    assert.ok(plans.large.groups.every(x => Number.isFinite(x.lane) && Number.isFinite(x.sectionHeight)));
  } finally { e.close(); }
});

test('fresh and offline complete models reuse original calendar/bus/weather loaders in WidgetKit host', async () => {
  const now = new Date(), start = new Date(+now + 1800000), end = new Date(+now + 5400000);
  const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const calendarText = ics([event('fresh-test', stamp(start), stamp(end))]);
  let offline = false;
  const e = await engine({ handler: message => {
    if (message.method !== 'request') return;
    if (offline) throw Error('Offline');
    const url = message.payload.url;
    if (url.includes('/calendar.ics')) return { text: calendarText, status: 200 };
    if (url.includes('open-meteo')) return { text: JSON.stringify({ current: { time: Math.floor(Date.now() / 1000), temperature_2m: 10, apparent_temperature: 9, weather_code: 2, is_day: 1 }, current_units: { temperature_2m: '°C' } }), status: 200 };
    const raw = stop => ({ gtfsId: 'test:' + stop, code: stop === 'home' ? 'H' : 'U', stoptimesForPatterns: [{ pattern: { route: { shortName: '3' } }, stoptimes: [{ serviceDay: Math.floor(Date.now() / 1000) - 3600, scheduledDeparture: 4200, realtimeDeparture: 4260, realtime: true, trip: { gtfsId: 'test-trip' }, stopSequence: 2 }] }] });
    return { text: JSON.stringify({ data: { home: raw('home'), uni: raw('uni') } }), status: 200 };
  } });
  try {
    const online = await e.evaluate('main({skipSetup:true,returnModel:true})');
    assert.equal(online.model.calendarOK, true); assert.equal(online.model.upcoming[0].uid, 'fresh-test'); assert.equal(online.model.weather.temperature, '+10°');
    assert.equal(online.model.buses[0].all[0].live, true);
    await e.context.UniDay.flush();
    offline = true;
    e.evaluate('SETTINGS.calendarCacheMinutes=0;SETTINGS.busCacheSeconds=0;SETTINGS.weatherCacheMinutes=0');
    e.evaluate(`(()=>{const fm=FileManager.local(),path='/documents/UniDay-Personal/weather-open-meteo.json',v=JSON.parse(fm.readString(path));v.saved-=120000;fm.writeString(path,JSON.stringify(v))})()`);
    const cached = await e.evaluate('main({skipSetup:true,returnModel:true})');
    assert.equal(cached.model.calendarOK, true); assert.match(cached.model.calendarWarning, /копия/);
    assert.equal(cached.model.buses[0].all[0].live, false); assert.equal(cached.model.busStale, true); assert.equal(cached.model.weatherStale, true);
  } finally { e.close(); }
});

test('full backup forwards every virtual file; no personal defaults enter source', async () => {
  let exported;
  const e = await engine({ handler: message => { if (message.method === 'data.export') { exported = message.payload; return {}; } } });
  try {
    e.evaluate(`saveProfile(currentProfile());FileManager.local().writeString('/documents/UniDay-Personal/lesson-notes.json','{"keep":"Private"}')`);
    await e.context.UniDay.exportBackup();
    assert.equal(exported.schemaVersion, 1); assert.equal(exported.files['/documents/UniDay-Personal/lesson-notes.json'].value, '{"keep":"Private"}');
    assert.ok(exported.files['/documents/UniDay-Personal/profile.json']);
  } finally { e.close(); }
});

test('user notes containing Scriptable and JavaScript-looking text are never rewritten', async () => {
  const e = await engine({ widget: false });
  try {
    const result = await e.evaluate('main({skipSetup:true,returnModel:true,cacheOnly:true})');
    e.context.model = result.model;
    e.evaluate(`(()=>{const lesson={uid:'note-test',title:'Study Scriptable AB.1234',code:'AB.1234',start:new Date(),end:new Date(Date.now()+600000),notes:'Scriptable: window.location.assign(test)'};model.lessons=[lesson];model.upcoming=[lesson];model.weekEvents=[lesson];model.annotations={[lessonNoteKey(lesson)]:'Keep Scriptable and window.location.assign(test) unchanged'};})()`);
    const html = e.evaluate('renderHTML(model)');
    assert.ok(html.includes('Keep Scriptable and window.location.assign(test) unchanged'));
    assert.ok(html.includes('Study Scriptable'));
    assert.ok(html.includes('parent.UniDayRuntime.navigate('));
    const raw = e.context.UniDay.shortcutHTML();
    assert.ok(raw.includes('Keep Scriptable and window.location.assign(test) unchanged'));
    assert.ok(raw.includes('window.location.assign(url)'));
    assert.equal(e.context.UniDay.snapshot().html, raw);
    assert.ok(e.evaluate('presentInteractiveOverview.toString()').includes('UniDayRuntime.bindOverview(view,model,applyRefresh)'));
  } finally { e.close(); }
});

test('cold widget stop links and all legacy UI actions dispatch canonically exactly once', async () => {
  const e = await engine();
  try {
    const model = e.evaluate('({buses:SETTINGS.stops,lessons:[],weekEvents:[]})');
    assert.equal(e.context.UniDay.debug.coldStartURL({ action: 'stop-board', stop: 'uni' }, model), 'uniday://overview?action=stop-board&stop=uni');
    assert.equal(e.context.UniDay.debug.coldStartURL({ action: 'add-event' }, model), null);
    assert.equal(e.context.UniDay.debug.coldStartURL({ action: 'edit-note' }, model), null);
    assert.equal(e.context.UniDay.debug.coldStartURL({ action: 'settings-page', page: 'colors' }, model), 'uniday://overview?action=settings-page&page=colors');
    assert.equal(e.context.UniDay.debug.coldStartURL({ action: 'pack-check', date: '2026-10-07', item: 'Umbrella', checked: '0' }, model), 'uniday://overview?action=pack-check&date=2026-10-07&item=Umbrella&checked=0');
    const now = e.evaluate('new Date()');
    const plans = e.context.UniDay.exportWidgetPlans({ now, lessons: [], upcoming: [], calendarOK: true, calendarWarning: '', weather: e.evaluate('missingWeather()'), buses: model.buses, position: { side: null } });
    assert.ok(plans.large.groups.filter(group => group.section === 'buses').every(group => group.url.includes('action=stop-board')));
  } finally { e.close(); }
});

test('backup can rescue unsaved in-memory notes even when native storage fails', async () => {
  let exported;
  const e = await engine({ handler: message => {
    if (message.method === 'storage.apply') throw Error('Disk full');
    if (message.method === 'data.export') { exported = message.payload; return {}; }
  } });
  try {
    e.evaluate(`FileManager.local().writeString('/documents/UniDay-Personal/lesson-notes.json','{"new":"Rescue me"}')`);
    await e.context.UniDay.exportBackup();
    assert.equal(exported.containsUnsavedChanges, true);
    assert.equal(exported.files['/documents/UniDay-Personal/lesson-notes.json'].value, '{"new":"Rescue me"}');
  } finally { e.close(); }
});
