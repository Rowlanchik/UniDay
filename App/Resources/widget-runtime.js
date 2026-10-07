/* The WidgetKit JavaScriptCore host injects __native and four timer callbacks.
   Load runtime.js, legacy.js, then this file. No browser or Scriptable is needed.
   UniDayWidget.refresh(snapshot) emits widget.result or widget.error to __native. */
globalThis.window = globalThis;
if (typeof setTimeout === 'undefined') globalThis.setTimeout = (callback, ms) => __setTimeout(callback, ms);
if (typeof clearTimeout === 'undefined') globalThis.clearTimeout = id => __clearTimeout(id);
if (typeof setInterval === 'undefined') globalThis.setInterval = (callback, ms) => __setInterval(callback, ms);
if (typeof clearInterval === 'undefined') globalThis.clearInterval = id => __clearInterval(id);
