/* UniDay native adapters. legacy.js retains every 7.9.0 function unchanged. */
(function (g) {
  'use strict';
  const pending = new Map();
  let nextID = 0, state = {}, storageError = null, drainTask = null, drainTimer = null;
  let operations = [], activeView = null, capturedModel = null, publishTimer = null, hookInstalled = false;
  let launchTask = null, resumeTask = null, originalHTMLRenderer = null, overviewRefresh = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  // Translate only original system messages; never rewrite user note/course text.
  const nativeMessages = new Map([
    ['Один скрипт для всех. Пройди настройку или выбери готовый файл настроек.', 'Пройди настройку UniDay или выбери готовый файл настроек.'],
    ['Свои события не удалось прочитать. Проверь доступ Scriptable к Календарю.', 'Свои события не удалось прочитать. Проверь доступ UniDay к Календарю.'],
    ['Свои события не удалось прочитать. Разреши Scriptable полный доступ к Календарю в Settings → Apps → Scriptable → Calendars.', 'Свои события не удалось прочитать. Разреши UniDay полный доступ к Календарю в Настройки → Приложения → UniDay → Календари.'],
    ['WebView не подтвердил загрузку. Попробуй запустить этот скрипт кнопкой ▶ внутри Scriptable. Настройки сохранены. Этапы запуска доступны в настройках → Диагностика запуска.', 'Экран не подтвердил загрузку. Открой UniDay заново. Этапы запуска доступны в настройках → Диагностика запуска.'],
    ['Настройки не прочитаны. Нажми и настрой UniDay внутри Scriptable.', 'Настройки не прочитаны. Нажми и настрой UniDay.'],
    ['Нажми и пройди первую настройку внутри Scriptable.', 'Нажми и пройди первую настройку UniDay.'],
    ['Не удалось завершить добавление. Проверь доступ Scriptable к календарям. Если уже нажал Add, сначала проверь Календарь iPhone, чтобы не создать дубль.', 'Не удалось завершить добавление. Проверь доступ UniDay к календарям. Если уже сохранил событие, сначала проверь Календарь iPhone, чтобы не создать дубль.'],
    ['Старые уведомления не удалось очистить. Если они продолжают приходить, отключи уведомления Scriptable в настройках iPhone.', 'Старые уведомления UniDay не удалось очистить. Проверь разрешение уведомлений UniDay в настройках iPhone.']
  ]);
  const uiText = value => nativeMessages.get(String(value ?? '')) || String(value ?? '');
  function call(method, payload = {}) {
    const id = String(++nextID);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try {
        const message = { id, method, payload };
        if (typeof g.__native === 'function') g.__native(JSON.stringify(message));
        else if (g.webkit?.messageHandlers?.uniday) g.webkit.messageHandlers.uniday.postMessage(message);
        else throw Error('Нативный адаптер UniDay недоступен: ' + method);
      } catch (error) { pending.delete(id); reject(error); }
    });
  }
  function reportStorage(error) {
    storageError = error;
    if (typeof document !== 'undefined') {
      let banner = document.getElementById('storage-error');
      if (banner) { banner.hidden = false; banner.textContent = 'Изменения не сохранены на iPhone. ' + error.message + ' Экспортируй резервную копию перед закрытием.'; }
    }
  }
  function virtualPath(input) {
    const raw = String(input).replace(/\\/g, '/');
    if (!raw.startsWith('/documents')) throw Error('Путь вне локальных данных UniDay.');
    const segments = raw.split('/').filter(Boolean);
    if (segments[0] !== 'documents' || segments.some(x => x === '.' || x === '..' || /[\u0000-\u001f]/.test(x))) throw Error('Недопустимый путь данных.');
    return '/' + segments.join('/');
  }
  function queue(operation) {
    if (storageError) throw Error('Запись остановлена после ошибки сохранения: ' + storageError.message);
    operations.push(operation);
    if (typeof g.setTimeout === 'function' && !drainTimer) drainTimer = g.setTimeout(() => {
      drainTimer = null; flush().catch(reportStorage);
    }, 25);
  }
  async function flush() {
    if (drainTask) { await drainTask; if (operations.length) return flush(); return; }
    if (storageError) throw storageError;
    if (!operations.length) return;
    const batch = operations.splice(0);
    drainTask = call('storage.apply', { operations: batch }).catch(error => {
      operations.unshift(...batch); reportStorage(error); throw error;
    }).finally(() => { drainTask = null; });
    await drainTask;
    if (operations.length) await flush();
  }
  function prepareHTML(html) {
    return String(html)
      .replace('<small>Проверить в Scriptable, включая фон под обои</small>', '<small>Проверить в UniDay, включая фон под обои</small>')
      .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, start, script, end) => start + script.replace(/window\.location\.assign\(/g, 'parent.UniDayRuntime.navigate(') + end);
  }
  function nativeImage(value) {
    if (!value || typeof value.dataURL !== 'string' || !Number.isFinite(value.width) || !Number.isFinite(value.height)) throw Error('Некорректное изображение.');
    return new NativeImage(value);
  }
  async function decodeImage(value) {
    const image = nativeImage(value);
    if (typeof document !== 'undefined') {
      const element = new g.Image();
      await new Promise((resolve, reject) => { element.onload = resolve; element.onerror = () => reject(Error('Фото не прочитано.')); element.src = image.dataURL; });
      image.element = element;
    }
    return image;
  }
  class NativeImage {
    constructor(value) { this.dataURL = value.dataURL; this.size = new Size(value.width, value.height); this.element = value.element || null; }
    toJSON() { return { kind: 'image', dataURL: this.dataURL, width: this.size.width, height: this.size.height }; }
  }
  class FileManager {
    static local() { return manager; }
    documentsDirectory() { return '/documents'; }
    joinPath(base, leaf) { return virtualPath(base + '/' + leaf); }
    fileExists(path) { path = virtualPath(path); return Object.prototype.hasOwnProperty.call(state.files, path) || state.directories.includes(path); }
    createDirectory(path, recursive = false) {
      path = virtualPath(path);
      const parts = path.split('/').filter(Boolean);
      const parent = '/' + parts.slice(0, -1).join('/');
      if (!recursive && !state.directories.includes(parent)) throw Error('Папка не существует.');
      for (let i = recursive ? 1 : parts.length; i <= parts.length; i++) {
        const directory = '/' + parts.slice(0, i).join('/');
        if (!state.directories.includes(directory)) { queue({ op: 'mkdir', path: directory }); state.directories.push(directory); }
      }
    }
    readString(path) {
      const entry = state.files[virtualPath(path)];
      if (!entry || entry.kind !== 'text') throw Error('Файл не существует или не является текстом.');
      return entry.value;
    }
    writeString(path, value) {
      path = virtualPath(path); value = String(value);
      if (!state.directories.includes(path.slice(0, path.lastIndexOf('/')))) throw Error('Папка данных не существует.');
      queue({ op: 'writeText', path, value }); state.files[path] = { kind: 'text', value };
    }
    readImage(path) {
      path = virtualPath(path);
      const image = state.imageCache?.[path];
      if (image) return image;
      const entry = state.files[path];
      if (!entry || entry.kind !== 'image') throw Error('Изображение не найдено.');
      const result = nativeImage(entry);
      if (typeof document !== 'undefined') throw Error('Изображение ещё загружается. Повтори после открытия приложения.');
      return result;
    }
    writeImage(path, image) {
      path = virtualPath(path); const entry = image.toJSON();
      queue({ op: 'writeImage', path, dataURL: entry.dataURL, width: entry.width, height: entry.height });
      state.files[path] = entry; (state.imageCache ||= {})[path] = image;
    }
    remove(path) {
      path = virtualPath(path); queue({ op: 'remove', path });
      for (const key of Object.keys(state.files)) if (key === path || key.startsWith(path + '/')) delete state.files[key];
      state.directories = state.directories.filter(x => x !== path && !x.startsWith(path + '/'));
    }
    listContents(path) {
      const prefix = virtualPath(path) + '/';
      return [...new Set([...Object.keys(state.files), ...state.directories].filter(x => x.startsWith(prefix)).map(x => x.slice(prefix.length).split('/')[0]))];
    }
  }
  const manager = new FileManager();
  class Alert {
    constructor() { this.title = ''; this.message = ''; this.actions = []; this.fields = []; this.cancel = null; }
    addAction(title) { this.actions.push({ title: uiText(title), destructive: false }); }
    addDestructiveAction(title) { this.actions.push({ title: uiText(title), destructive: true }); }
    addCancelAction(title) { this.cancel = uiText(title); }
    addTextField(placeholder, value = '') { this.fields.push({ placeholder: uiText(placeholder), value: String(value), secure: false }); }
    addSecureTextField(placeholder, value = '') { this.fields.push({ placeholder: uiText(placeholder), value: String(value), secure: true }); }
    textFieldValue(index) { if (!this.fields[index]) throw Error('Поле не найдено.'); return this.fields[index].value; }
    async presentAlert() { return this.present('alert'); }
    async presentSheet() { return this.present('sheet'); }
    async present(style) {
      const value = await call('alert', { title: uiText(this.title), message: uiText(this.message), actions: this.actions, cancel: this.cancel, fields: this.fields, style });
      if (!Number.isInteger(value?.index) || value.index < -1 || value.index >= this.actions.length) throw Error('Диалог вернул неверный ответ.');
      this.fields.forEach((field, index) => { field.value = String(value.values?.[index] ?? field.value); });
      return value.index;
    }
  }
  class Request {
    constructor(url) { this.url = url; this.method = 'GET'; this.headers = {}; this.body = null; this.timeoutInterval = 6; this.response = null; }
    async loadString() {
      const value = await call('request', { url: this.url, method: this.method, headers: this.headers, body: this.body, timeoutSeconds: this.timeoutInterval });
      this.response = { statusCode: value.status, headers: value.headers || {} };
      if (typeof value.text !== 'string' || !Number.isInteger(value.status)) throw Error('Сеть вернула неверный ответ.');
      return value.text;
    }
    async loadJSON() { return JSON.parse(await this.loadString()); }
  }
  class WebView {
    constructor() { this.shouldAllowRequest = null; this.frame = null; this.closed = false; this.closeResolve = null; }
    async loadHTML(html) {
      await flush();
      if (typeof document === 'undefined') throw Error('HTML-интерфейс недоступен в процессе виджета.');
      this.closed = false;
      if (!this.frame) {
        this.frame = document.createElement('iframe'); this.frame.title = 'UniDay'; this.frame.id = 'uniday-screen';
        this.frame.setAttribute('allow', ''); document.getElementById('content').replaceChildren(this.frame);
      }
      const frame = this.frame;
      await new Promise((resolve, reject) => {
        const timer = g.setTimeout(() => reject(Error('Экран UniDay не загрузился.')), 6500);
        frame.onload = () => {
          g.clearTimeout(timer);
          frame.contentDocument.addEventListener('click', event => {
            const anchor = event.target.closest?.('a[href]');
            if (!anchor) return;
            event.preventDefault(); this.navigate(anchor.getAttribute('href'));
          }, true);
          resolve();
        };
        frame.srcdoc = prepareHTML(html);
      });
    }
    async evaluateJavaScript(script, useCallback = false) {
      await flush();
      if (!this.frame?.contentWindow) throw Error('Экран UniDay не открыт.');
      const child = this.frame.contentWindow;
      if (!useCallback) return child.eval(script);
      return new Promise((resolve, reject) => {
        child.completion = value => { delete child.completion; resolve(value); };
        try { child.eval(script); } catch (error) { delete child.completion; reject(error); }
      });
    }
    async present() {
      activeView = this;
      const desired = args.queryParameters;
      const url = coldStartURL(desired, capturedModel);
      if (url) g.setTimeout(() => { if (!this.closed) this.navigate(url); }, 0);
      return new Promise(resolve => { this.closeResolve = resolve; });
    }
    navigate(url) {
      const allowed = this.shouldAllowRequest ? this.shouldAllowRequest({ url: String(url) }) : true;
      if (allowed && /^(https?:|mailto:|tel:)/i.test(url)) call('safari.open', { url: String(url) }).catch(error => new AlertError(error));
      else if (allowed && /^uniday:/i.test(url)) UniDay.relaunch(queryFromURL(url));
      return allowed;
    }
    close() { this.closed = true; this.closeResolve?.(); this.closeResolve = null; if (activeView === this) activeView = null; if (overviewRefresh?.view === this) overviewRefresh = null; }
  }
  function AlertError(error) { const a = new Alert(); a.title = 'UniDay'; a.message = error.message || String(error); a.addAction('Понятно'); a.presentAlert().catch(() => {}); }
  class Size { constructor(width, height) { this.width = width; this.height = height; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Color {
    constructor(hex, alpha = 1) { this.hex = '#' + String(hex).replace(/^#/, ''); this.alpha = alpha; if (!/^#[0-9a-f]{6}$/i.test(this.hex)) throw Error('Неверный цвет.'); }
    static clear() { return new Color('#000000', 0); }
  }
  class Font {
    constructor(name, size, weight = 'regular', design = 'default') {
      if (!name || !Number.isFinite(size) || size <= 0) throw Error('Неверный шрифт.');
      if (state.device?.fontNames && !name.startsWith('system') && !state.device.fontNames.includes(name)) throw Error('Шрифт не установлен: ' + name);
      Object.assign(this, { name, size, weight, design });
    }
  }
  for (const [method, weight] of Object.entries({ systemFont: 'regular', boldSystemFont: 'bold', semiboldSystemFont: 'semibold', mediumSystemFont: 'medium', regularSystemFont: 'regular', heavySystemFont: 'heavy' })) Font[method] = size => new Font('system', size, weight);
  for (const design of ['Rounded', 'Monospaced']) for (const weight of ['regular', 'semibold', 'bold', 'heavy']) Font[weight + design + 'SystemFont'] = size => new Font('system', size, weight, design.toLowerCase());
  class DrawContext {
    constructor() { this.size = new Size(1, 1); this.opaque = false; this.respectScreenScale = false; this.canvas = null; this.fillColor = new Color('#000000'); }
    context() {
      if (typeof document === 'undefined') throw Error('Обрезка фото доступна в приложении UniDay.');
      if (!this.canvas) { this.canvas = document.createElement('canvas'); this.canvas.width = this.size.width; this.canvas.height = this.size.height; }
      return this.canvas.getContext('2d');
    }
    setFillColor(color) { this.fillColor = color; }
    fillRect(rect) { const c = this.context(); c.globalAlpha = this.fillColor.alpha; c.fillStyle = this.fillColor.hex; c.fillRect(rect.x, rect.y, rect.width, rect.height); c.globalAlpha = 1; }
    drawImageInRect(image, rect) { if (!image.element) throw Error('Фото не загружено для обрезки.'); this.context().drawImage(image.element, rect.x, rect.y, rect.width, rect.height); }
    drawImageAtPoint(image, point) { this.drawImageInRect(image, new Rect(point.x, point.y, image.size.width, image.size.height)); }
    getImage() { const c = this.context(); return new NativeImage({ dataURL: c.canvas.toDataURL('image/png'), width: c.canvas.width, height: c.canvas.height, element: c.canvas }); }
  }
  class WidgetNode {
    constructor(type, value = null) { this.type = type; this.value = value; this.children = []; }
    addStack() { const node = new WidgetNode('stack'); this.children.push(node); return node; }
    addText(value) { const node = new WidgetNode('text', value); this.children.push(node); return node; }
    addDate(value) { const node = new WidgetNode('date', new Date(value).toISOString()); this.children.push(node); return node; }
    addSpacer(value = null) { this.children.push(new WidgetNode('spacer', value)); }
    setPadding(top, left, bottom, right) { this.padding = { top, left, bottom, right }; }
    layoutVertically() { this.axis = 'vertical'; }
    layoutHorizontally() { this.axis = 'horizontal'; }
    centerAlignContent() { this.alignment = 'center'; }
    topAlignContent() { this.alignment = 'top'; }
    bottomAlignContent() { this.alignment = 'bottom'; }
    applyTimerStyle() { this.dateStyle = 'timer'; }
    applyOffsetStyle() { this.dateStyle = 'offset'; }
  }
  class ListWidget extends WidgetNode {
    constructor() { super('widget'); this.axis = 'vertical'; }
    async presentSmall() { return this.preview('small'); }
    async presentMedium() { return this.preview('medium'); }
    async presentLarge() { return this.preview('large'); }
    async preview(family) {
      await flush();
      const plan = this._nativePlans?.[family] || (capturedModel ? exportWidgetPlans(capturedModel)[family] : null);
      if (!plan) throw Error('Данные предпросмотра ещё не загружены.');
      return call('widget.preview', { family, plan, tree: clone(this) });
    }
  }
  const Timer = { schedule(ms, repeat, callback) { const id = repeat ? g.setInterval(callback, ms) : g.setTimeout(callback, ms); return { invalidate() { repeat ? g.clearInterval(id) : g.clearTimeout(id); } }; } };
  const CalendarEvent = {
    async between(from, to) {
      const events = await call('calendar.between', { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
      if (!Array.isArray(events)) throw Error('Календарь вернул неверный ответ.');
      const previous = (state.calendarEvents || []).filter(event => !(new Date(event.startDate) < to && new Date(event.endDate) > from));
      state.calendarEvents = clone([...previous, ...events]);
      return events.map(calendarDates);
    },
    async presentCreate() {
      const event = await call('calendar.create');
      if (!event) return null;
      state.calendarEvents = clone([...(state.calendarEvents || []).filter(item => item.identifier !== event.identifier), event]);
      return calendarDates(event);
    }
  };
  function calendarDates(event) { return { ...event, startDate: new Date(event.startDate), endDate: new Date(event.endDate) }; }
  const Location = { setAccuracyToHundredMeters() { state.locationAccuracy = 100; }, current() { return call('location.current', { accuracy: state.locationAccuracy || 100 }); } };
  const Photos = { latestScreenshot: async () => decodeImage(await call('photos.pick', { latestScreenshot: true })), fromLibrary: async () => decodeImage(await call('photos.pick', { latestScreenshot: false })) };
  const DocumentPicker = { async open(types) { const entries = await call('document.pick', { types }); const paths = []; for (const entry of entries) { const path = virtualPath(entry.path); state.files[path] = { kind: 'text', value: String(entry.text) }; paths.push(path); } return paths; } };
  const QuickLook = { present(value, fullscreen = false) { return call('quickLook', typeof value === 'string' ? { text: value, fullscreen } : { image: value.toJSON(), fullscreen }); } };
  const Safari = { open(url) { return call('safari.open', { url }); } };
  const Notification = {
    allPending: () => call('notifications.pending'), allDelivered: () => call('notifications.delivered'),
    removePending: identifiers => call('notifications.remove', { identifiers, delivered: false }),
    removeDelivered: identifiers => call('notifications.remove', { identifiers, delivered: true })
  };
  const Device = { screenSize: () => new Size(state.device?.screenSize?.width || 390, state.device?.screenSize?.height || 844), screenResolution: () => new Size(state.device?.screenResolution?.width || 1170, state.device?.screenResolution?.height || 2532), model: () => state.device?.model || 'iPhone', systemVersion: () => state.device?.systemVersion || '', screenScale: () => state.device?.scale || 3 };
  const URLScheme = { forRunningScript: () => 'uniday://overview' };
  const Script = { setWidget(widget) { state.widgetTree = clone(widget); }, setShortcutOutput(html) { state.shortcutOutput = html; }, complete() {} };
  Object.assign(g, { FileManager, Alert, Request, WebView, Size, Point, Rect, Color, Font, DrawContext, ListWidget, Timer, CalendarEvent, Location, Photos, DocumentPicker, QuickLook, Safari, Notification, Device, URLScheme, Script, config: { runsInApp: true, runsInWidget: false, runsFromHomeScreen: false, runsWithSiri: false, widgetFamily: 'large' }, args: { queryParameters: {}, shortcutParameter: null, widgetParameter: null } });
  g.UniDayNative = {
    call, flush,
    resolve(id, result, error) { const item = pending.get(String(id)); if (!item) return; pending.delete(String(id)); error ? item.reject(Error(typeof error === 'string' ? error : error.message || JSON.stringify(error))) : item.resolve(result); },
    async bootstrap(value) {
      state = { ...value, files: clone(value.files || {}), directories: [...new Set(['/documents', ...(value.directories || [])])], imageCache: {} };
      for (const [path, entry] of Object.entries(state.files)) { virtualPath(path); if (entry.kind === 'image') state.imageCache[path] = await decodeImage(entry); }
      storageError = null; operations = [];
      g.config.runsInWidget = !!value.widget; g.config.runsInApp = !value.widget;
      installHooks();
      return true;
    }
  };
  function queryFromURL(url) {
    const value = String(url), query = {};
    for (const item of (value.split('?')[1] || '').split('&')) { if (!item) continue; const index = item.indexOf('='); try { query[decodeURIComponent(index < 0 ? item : item.slice(0, index))] = decodeURIComponent(index < 0 ? '' : item.slice(index + 1)); } catch {} }
    const host = /^uniday:\/\/([^/?]+)/i.exec(value)?.[1];
    if (!query.action && host) query.action = host;
    return query;
  }
  function coldStartURL(query, model) {
    if (!query?.action || !model) return null;
    const action = query.action;
    // main already performs these actions; never execute them a second time.
    if (['overview', 'settings', 'week', 'pick-week', 'edit-note', 'edit-pack', 'add-event'].includes(action)) return null;
    if (['stop-board', 'stop-routes'].includes(action)) {
      const stop = model.buses?.find(item => item.key === query.stop);
      return stop ? action === 'stop-board' ? stopBoardURL(stop) : stopRoutesURL(stop) : null;
    }
    if (action === 'bus-trip') { try { return busTripURL(parseBusTripSelection(query)); } catch { return null; } }
    if (action === 'edit-lesson') {
      const lessons = [...(model.weekEvents || []), ...(model.lessons || [])].filter(item => lessonNoteRef(item) === query.ref);
      return lessons.length ? lessonEditURL(lessons[0]) : null;
    }
    if (action === 'pack-check') return actionURL(action, { date: query.date, item: query.item }) + '&checked=' + (query.checked === '1' ? '1' : '0');
    if (['journey', 'place-setup', 'new-courses', 'calendar-repair'].includes(action)) return actionURL(action);
    if (['settings-page', 'setting-op'].includes(action)) {
      const params = { ...query }; delete params.action;
      return actionURL(action, params);
    }
    return null;
  }
  function installHooks() {
    if (hookInstalled || typeof renderHTML !== 'function') return;
    hookInstalled = true;
    const originalRender = renderHTML;
    originalHTMLRenderer = originalRender;
    renderHTML = function (model) {
      capturedModel = model;
      const translated = { ...model };
      for (const key of ['personalWarning', 'cleanupWarning', 'eventNotice']) if (translated[key]) translated[key] = uiText(translated[key]);
      const html = originalRender(translated); schedulePublish(); return prepareHTML(html);
    };
    const originalDOMUpdate = overviewDOMUpdate;
    overviewDOMUpdate = function (html, scroll = 0) { return originalDOMUpdate(prepareHTML(html), scroll); };
    const originalBuild = buildLargeWidget;
    buildLargeWidget = function (model) { const widget = originalBuild(model); widget._nativePlans = exportWidgetPlans(model); return widget; };
    // Register the original refresh closure, so it also updates its private ICS
    // series and busy queue. No UI/domain behavior is reimplemented here.
    const originalOverview = presentInteractiveOverview.toString();
    const marker = 'const update=async()=>{';
    if (originalOverview.split(marker).length !== 2) throw Error('Неизвестный интерфейс UniDay: адаптер обновления требует проверки.');
    presentInteractiveOverview = g.eval('(' + originalOverview.replace(marker, 'globalThis.UniDayRuntime.bindOverview(view,model,applyRefresh);' + marker) + ')');
  }
  function schedulePublish() {
    if (!capturedModel || g.config.runsInWidget || typeof g.setTimeout !== 'function') return;
    if (publishTimer) g.clearTimeout(publishTimer);
    publishTimer = g.setTimeout(() => { publishTimer = null; publish().catch(error => reportStorage(error)); }, 75);
  }
  function exportWidgetPlans(model) {
    const storedWeather = model.weather && !model.weather.missing ? { weather: model.weather, saved: model.weatherSaved, observedAt: model.weatherSaved, stale: model.weatherStale } : null;
    const result = {};
    for (const family of ['small', 'medium', 'large']) {
      const plan = widgetPlan({ ...model, storedWeather, family });
      let stopURL = actionURL('overview');
      const byKey = new Map((model.buses || []).map(stop => [stop.key, stop]));
      const stops = uniqueStops(effectiveStopKeys(model.position).map(key => byKey.get(key)).filter(Boolean)).slice(0, SETTINGS.appearance.widgetStopLimits[family]);
      let dashboardStop = 0;
      const groups = plan.groups.map(group => {
        if (group.section === 'buses') {
          const texts = group.rows.flat().map(c => c.text).join(' ');
          let stop = stops.find(s => texts.includes(s.name + ' ·') || texts.includes('· ' + s.name) || texts === s.name);
          if (plan.dashboard) { stop ||= stops[dashboardStop]; dashboardStop++; }
          else if (group.priority >= 79) stop ||= stops[80 - group.priority];
          if (stop) stopURL = stopBoardURL(stop);
        }
        return { ...group, lane: plan.lane(group), sectionHeight: plan.sectionHeight(group.section), url: group.section === 'buses' ? stopURL : actionURL('overview'), rows: group.rows.map(row => row.map(cell => ({ ...cell, url: group.section === 'buses' ? stopURL : undefined, date: cell.date ? new Date(cell.date).toISOString() : undefined, points: widgetPoints(cell.size, cell.kind || 'body', family, cell.role || ''), font: widgetFont(cell.size, !!cell.bold, cell.kind || 'body', family, cell.role || '', !!cell.fixed) }))) };
      });
      result[family] = clone({ ...plan, groups, appearance: SETTINGS.appearance, url: actionURL('overview'), refreshAfter: nextWidgetRefresh(model.now, model.upcoming || model.lessons, model.buses).toISOString(), background: { mode: SETTINGS.appearance.widgetBackgroundMode, color: SETTINGS.appearance.widgetBackground, image: widgetBackgroundImage(family)?.toJSON() || null } });
    }
    return result;
  }
  function snapshot(model = capturedModel) {
    if (!model) throw Error('Данные ещё не загружены.');
    return clone({ schemaVersion: 1, generatedAt: new Date().toISOString(), refreshAfter: nextWidgetRefresh(model.now, model.upcoming || model.lessons, model.buses).toISOString(), html: g.config.runsInWidget ? undefined : originalHTMLRenderer?.(model), state: { model, profile: currentProfile(), dataFolder: SETTINGS.storageFolder, files: state.files, directories: state.directories, device: state.device || {}, calendarEvents: state.calendarEvents || [] }, plans: exportWidgetPlans(model), diagnostics: storageError ? [storageError.message] : [] });
  }
  async function publish() { if (!capturedModel) return; await flush(); return call('widget.publish', { snapshot: snapshot(), plans: exportWidgetPlans(capturedModel), profile: currentProfile() }); }
  const UniDay = {
    async start(query = {}) {
      if (launchTask) return true;
      args.queryParameters = typeof query === 'string' ? queryFromURL(query) : query;
      installHooks();
      launchTask = main().catch(error => AlertError(error)).finally(() => { launchTask = null; });
      return true;
    },
    navigate(url) { return activeView ? activeView.navigate(url) : UniDay.relaunch(queryFromURL(url)); },
    async resume() {
      if (!activeView || !capturedModel) return UniDay.start();
      if (resumeTask) return resumeTask;
      if ([...pending.values()].some(item => ['alert', 'calendar.create', 'photos.pick', 'document.pick', 'widget.preview'].includes(item.method))) return false;
      resumeTask = (async () => {
        const result = await main({ skipSetup: true, returnModel: true, withLocation: true });
        if (result.signature !== overviewSignature() || !activeView) return;
        if (!overviewRefresh || overviewRefresh.view !== activeView) throw Error('Экран ещё открывается. Повтори обновление.');
        await overviewRefresh.apply(result);
      })().catch(error => AlertError(error)).finally(() => { resumeTask = null; });
      return resumeTask;
    },
    async relaunch(query = {}) { activeView?.close(); if (launchTask) await launchTask; capturedModel = null; return UniDay.start(query); },
    exportWidgetPlans, snapshot, flush,
    shortcutHTML() { if (!capturedModel || !originalHTMLRenderer) throw Error('Данные ещё не загружены.'); return originalHTMLRenderer(capturedModel); },
    async retrySaving() { storageError = null; await flush(); const banner = typeof document !== 'undefined' && document.getElementById('storage-error'); if (banner) banner.hidden = true; await publish(); },
    async exportBackup() {
      try { await flush(); } catch { /* A backup can still rescue unsaved in-memory data. */ }
      return call('data.export', { files: state.files, directories: state.directories, schemaVersion: 1, containsUnsavedChanges: !!storageError });
    },
    debug: { call, virtualPath, coldStartURL, state: () => state, pendingOperations: () => clone(operations), storageError: () => storageError }
  };
  g.UniDay = UniDay;
  g.UniDayRuntime = { navigate: url => UniDay.navigate(url), prepareHTML, call, bindOverview(view, model, apply) { overviewRefresh = { view, model, apply }; } };
  g.UniDayWidget = {
    async refresh(seed) {
      try {
        await g.UniDayNative.bootstrap({ ...seed.state, widget: true });
        applyProfile(seed.state.profile); SETTINGS.storageFolder = seed.state.dataFolder || 'UniDay-Personal';
        // Same parser, caches, route filters and geometry as the app. No native UI.
        const result = await main({ skipSetup: true, returnModel: true }); capturedModel = result.model;
        await flush();
        const payload = { snapshot: snapshot(result.model), operations: clone(operations) };
        await call('widget.result', payload); return payload;
      } catch (error) { await call('widget.error', { message: error.message || String(error) }); throw error; }
    }
  };
})(globalThis);
