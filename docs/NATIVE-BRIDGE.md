# Контракт адаптеров UniDay

`legacy.js` содержит все 271 функции 7.9.0 без изменения. Из исходника удалены только два завершающих вызова: `await main(); Script.complete();`. Приложение загружает `index.html` → `runtime.js` → `legacy.js`; нативная сторона ожидает `UniDayNative.bootstrap(value)`, затем вызывает `UniDay.start(query)`. Все результаты JSON; даты календаря из native допускают ISO8601 или миллисекунды Unix и преобразуются обратно в `Date`.

Запрос: `window.webkit.messageHandlers.uniday.postMessage({id,method,payload})`. Ответ: `UniDayNative.resolve(id,result,error)`; `error` — строка или `null`. В JavaScriptCore вместо WebKit используется `__native(JSON.stringify(message))`. Нативный host виджета предоставляет `__setTimeout`, `__clearTimeout`, `__setInterval`, `__clearInterval`; callback исполняется на очереди JavaScriptCore.

Bootstrap: `{files,directories,device,version,updateSourceURL,widget,calendarEvents}`. `files` — словарь виртуальных путей `/documents/...`; текст: `{kind:'text',value}`, картинка: `{kind:'image',dataURL,width,height}`. На iOS виртуальные пути отображаются только в собственный Documents/container. Нельзя открывать произвольный абсолютный путь или чужую песочницу. `device` включает размеры/масштаб экрана, модель, версию iOS и, при наличии, `fontNames` установленных iOS-шрифтов. Текущие GPS-координаты runtime в файлы не сохраняет; сохраняется только результат выбора зоны, как в 7.9.0.

| method | payload | result |
| --- | --- | --- |
| `storage.apply` | `{operations:[{op:'writeText',path,value},{op:'writeImage',path,dataURL,width,height},{op:'mkdir',path},{op:'remove',path}]}` | любое подтверждение; ошибка отклоняет Promise |
| `request` | `{url,method,headers,body,timeoutSeconds}` | `{text,status,headers?}`; HTTPS, статус проверяет NetworkClient |
| `alert` | `{title,message,actions:[{title,destructive}],cancel,fields:[{placeholder,value,secure}],style:'alert'|'sheet'}` | `{index,values}`; отмена index=-1 |
| `calendar.between` | `{from,to}` ISO8601 | события `[{identifier,title,startDate,endDate,notes,location,isAllDay,calendar?}]` |
| `calendar.create` | `{}` | сохранённое событие или null при отмене; без второго сохранения |
| `location.current` | `{accuracy:100}` | `{latitude,longitude,horizontalAccuracy,...}` или явная ошибка |
| `photos.pick` | `{latestScreenshot}` | `{dataURL,width,height}`; PNG/JPEG декодируется до Canvas crop |
| `document.pick` | `{types:['public.json']}` | `[{path:'/documents/Imports/...',text}]` |
| `quickLook` | `{text,fullscreen}` либо `{image:{kind,dataURL,width,height},fullscreen}` | подтверждение |
| `safari.open` | `{url}` | подтверждение |
| `notifications.pending`, `notifications.delivered` | `{}` | `[{identifier,...}]` только текущего приложения |
| `notifications.remove` | `{identifiers,delivered}` | подтверждение; исходный фильтр удаляет только PREFIX UniDay |
| `widget.preview` | `{family,plan,tree}` | подтверждение; UIKit показывает настоящий SwiftUI `WidgetCardView(plan:)` |
| `widget.publish` | `{snapshot,plans,profile}` | подтверждение; после успешного flush, перезагрузка Timeline |
| `data.export` | `{files,directories,schemaVersion:1,containsUnsavedChanges}` | экспорт всей локальной копии; не публикуется |
| `widget.result` | `{snapshot,operations}` | WidgetKit host завершает расчёт snapshot |
| `widget.error` | `{message}` | WidgetKit host использует последнюю полную копию и диагностику |

`UniDayNative.call`, `.flush`, `.resolve`, `.bootstrap` доступны native. `UniDay.start`, `.navigate(url)`, `.resume()`, `.relaunch(query)`, `.flush()`, `.snapshot()`, `.exportWidgetPlans(model)`, `.exportBackup()`, `.retrySaving()`, `.shortcutHTML()` доступны приложению. `UniDay.resume` обращается к исходному `applyRefresh` closure и сохраняет выбранную неделю, раскрытые HTML-карточки, положение прокрутки и страницу настроек. runtime регистрирует этот closure одной проверенной вставкой в функцию при загрузке в память; исходный файл не меняется. Обновление не применяется при смене профиля во время сетевого запроса. Native должен заканчивать вызов JavaScript выражением `true;`, чтобы WKWebView не пытался сериализовать Promise.

Файлы читаются синхронно из проверенной памяти VFS; записи идут последовательной очередью native. Нативная сторона использует атомарную запись. Ошибка сохранения остаётся видимой в красной полосе, очередь не удаляется, последующие записи отвергаются до retry. Резервная копия runtime включает также изменения в памяти после ошибки диска (`containsUnsavedChanges=true`). Нельзя показывать «сохранено на диске» на основании одной синхронной записи VFS: подтверждение — `flush()`.

Snapshot: `{schemaVersion:1,generatedAt,refreshAfter,html?,state:{model,profile,dataFolder,files,directories,device,calendarEvents},plans:{small,medium,large},diagnostics:[]}`. Даты модели и плана — ISO8601; native календарь в cache допускает миллисекунды и преобразуется при чтении. App private snapshot включает raw HTML исходного renderer для Shortcut export, без parent-bridge rewrite и без recursive publish. Widget snapshot не включает HTML. Plan содержит материализованные `group.lane`, `group.sectionHeight`, `cell.points`, `cell.font`, `cell.date`, `cell.timer`, ссылки остановок, фон и полную `appearance`. Исходные closures не сериализуются. `UniDayWidget.refresh(seed)` загружает runtime/files/profile, запускает исходный `main({returnModel:true,skipSetup:true})`, сетевые loaders и тот же widgetPlan, затем сообщает `widget.result`. Весь полученный результат проходит проверку нативного SharedStore.

Сетевые ответы никогда не исполняются как JavaScript. HTML интерфейса принадлежит приложению; пользовательские строки экранирует исходный `escapeHTML`. runtime переводит только системные сообщения Scriptable и меняет внутри принадлежащих UniDay script-элементов `window.location.assign` на контролируемую навигацию. Заметки и содержимое календаря не переписываются. Выполняемый код меняется только при установке нового IPA.
