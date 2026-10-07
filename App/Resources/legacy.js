// Variables used by Scriptable.
// icon-color: deep-green; icon-glyph: graduation-cap;
// UniDay 7.9.0 — локальные часы, автономное расписание и сохранённые рейсы.
// Один скрипт для виджетов Small/Medium/Large и подробного экрана. См. инструкцию.
// Устройство файла: конфигурация → интерфейсные помощники → независимые движки
// CalendarEngine / TransitTimes / NetworkClient / LessonClock → адаптеры хранения
// и Scriptable → HTML и виджеты → настройки/профиль → main/запуск.
// Движки не читают профиль и не открывают интерфейс; зависимости передаются явно.
// Для изменения интеграции сохраняйте контракты Date/series/lessons/departures.
// Нативная дата конца пары: минус — до конца, плюс — время после конца.
// Её формат задаёт iOS; смена названия пары/полосы требует нового запуска виджета.
// Запуском виджета управляет iOS. Счётчик не требует новых сетевых ответов.

// Настройки заполняются мастером при первом запуске. Редактировать код не нужно.
const SETTINGS = {
  "storageFolder": "UniDay-Personal",
  "universityLabel": "",
  "city": "",
  "calendarURL": "",
  "studyWeekAnchor": null,
  "stops": [],
  "extraStops": [],
  "departureCount": 5,
  "widgetDepartureCount": 2,
  "widgetStopCount": 2,
  "widgetStopKeys": [],
  "widgetNearbyStopFirst": true,
  "widgetStopOrderHome": [],
  "widgetStopOrderUni": [],
  "locationAnchors": {"home":null,"uni":null},
  "removedPlaces": [],
  "stopPriorities": {},
  "hiddenRoutes": {},
  "allowedRoutes": {},
  "travelChains": [],
  "activeTravelChain": null,
  "journeyPlanner": {"enabled":false,"maxTransfers":2,"maxWalkDistance":1000,"transferMinutes":3},
  "widgetCustomText": [],
  "appearance": {"screenScale":100,"screenFont":"system","screenCustomFont":"","widgetScale":100,"categoryFont":"system","categoryCustomFont":"","bodyFont":"system","bodyCustomFont":"","categoryScale":100,"bodyScale":100,"widgetBackground":"#f3f3ed","widgetText":"#243c32","widgetMuted":"#6b796e","widgetAccent":"#276848","widgetBackgroundMode":"solid","widgetSections":["header","weather","classes","countdown","buses","location","footer"],"wallpaperBackgrounds":{}},
  "apiURL": "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql",
  "timezone": "Europe/Tallinn",
  "excludedCourses": [],
  "onlineCourses": [],
  "alwaysBring": [],
  "courseItems": {},
  "courseHints": {},
  "calendarCacheMinutes": 10,
  "requestTimeoutSeconds": 6,
  "busCacheSeconds": 30,
  "tripCacheSeconds": 30,
  "widgetRefreshMinutes": 5,
  "widgetWeatherMaxHours": 3,
  "weatherCacheMinutes": 15,
  "weatherTimeoutSeconds": 3,
  "locationRadiusMeters": 1200,
  "locationTimeoutSeconds": 3,
  "locationCacheMinutes": 5,
  "cacheMaxHours": 168
};

const PREFIX = "uniday-personal-";
const MINUTE = 60000;
const DAY = 86400000;
// Operational limits, separate from appearance sizes and the user's preferences.
const MAX_TRAVEL_CHAINS = 12;
const STOP_SEARCH_LIMIT = 1000;
const LEGACY_STOP_SEARCH_LIMIT = 100;
const GEOCODE_CHUNK_SIZE = 90;
const GEOCODE_CONCURRENCY = 3;
const MAX_CALENDAR_OCCURRENCES = 2000;
const CHOICE_PAGE_SIZE = 15;
const RESOLVED_STOP_CACHE_MS = 7 * DAY;
const CACHED_REQUEST_TIMEOUT_SECONDS = 2;
const OFFLINE_RETRY_MIN_MS = MINUTE;
const OFFLINE_RETRY_MAX_MS = 5 * MINUTE;
const OFFLINE_BUS_MAX_AGE_MS = DAY;
const OFFLINE_BUS_DEPARTURES = 120;
/** @typedef {{latitude:number, longitude:number, address?:string}} GeoPoint */
/** @typedef {GeoPoint & {key:string, id:string, code:string, name:string, direction:string, label:string}} TransitStop */
/** @typedef {{uid:string, title:string, code?:string, notes?:string, location?:string, start:Date, end:Date, personal?:boolean}} Lesson */
/** @typedef {{events:Array<object>, warning:string, fresh:boolean, saved:number}} CalendarResult */
let INFLIGHT_LOCATION = null;
const TEXT_FONTS = {system:"Системный",rounded:"Округлый",mono:"Моноширинный",custom:"Свой шрифт",serif:"Georgia · с засечками",avenir:"Avenir Next"};
const WIDGET_SECTIONS=["header","weather","classes","buses","location","custom","footer","countdown"];
const WIDGET_SECTION_NAMES={countdown:"Таймер до пары / перерыва",header:"Шапка",weather:"Погода",classes:"Пары",buses:"Автобусы",location:"Геопозиция",custom:"Свой текст",footer:"Нижняя строка"};
function appearanceDefaults() {return {...appearanceExtras(),screenScale:100,screenFont:"system",screenCustomFont:"",widgetScale:100,categoryFont:"system",categoryCustomFont:"",bodyFont:"system",bodyCustomFont:"",categoryScale:100,bodyScale:100,widgetBackground:"#f3f3ed",widgetText:"#243c32",widgetMuted:"#6b796e",widgetAccent:"#276848",widgetBackgroundMode:"solid",widgetSections:["header","weather","classes","countdown","buses","location","footer"],wallpaperBackgrounds:{}};}
// Additive profile fields: old profiles retain their existing choices and data folder.
// Per-family block geometry is separate from global typography.
function blockDefaults(){return {scale:100,width:100,height:0,padding:0,gap:2,lines:1,radius:0,background:"",color:""};}
const BLOCK_DIMENSION_FIELDS=[
  ["scale","Текст, %",50,300],
  ["width","Ширина, %",30,100],
  ["height","Минимальная высота (0 — авто)",0,1200],
  ["padding","Поля внутри",0,40],
  ["gap","Между строками",0,24],
  ["lines","Строк текста (виджет)",1,4],
  ["radius","Скругление",0,40]
];
/** Parse all values before the caller changes its draft profile. */
function parseBlockDimensions(values,fields=BLOCK_DIMENSION_FIELDS) {
  return Object.fromEntries(fields.map(([key,label,min,max],i)=>{
    const value=Number(values[i]);
    if(!Number.isInteger(value)||value<min||value>max)throw Error(label+`: от ${min} до ${max}.`);
    return [key,value];
  }));
}
/** @param {"widget"|"screen"} surface @param {string} key @param {string} family */
function blockStyle(surface,key,family="large") {
  const a=SETTINGS.appearance;
  return {...blockDefaults(),...(surface==="widget"?a.widgetBlocks?.[family]?.[key]:a.screenBlocks?.[key])};
}
function validLayoutSettings(a) {
  const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
  if(!["top","center","bottom"].includes(a.widgetAlignment)||!integer(a.widgetPadding,0,32)||!integer(a.widgetGap,0,24))return false;
  if(!["timeScale","metaScale","screenTimeScale","screenHeadingScale"].every(k=>integer(a[k],50,300)))return false;
  const map=(m,keys)=>m&&typeof m==="object"&&!Array.isArray(m)&&Object.entries(m).every(([k,b])=>keys.includes(k)&&b&&typeof b==="object"&&
    integer(b.scale,50,300)&&integer(b.width,30,100)&&integer(b.height,0,1200)&&integer(b.padding,0,40)&&integer(b.gap,0,24)&&integer(b.lines,1,4)&&integer(b.radius,0,40)&&
    [b.background,b.color].every(c=>c===""||typeof c==="string"&&/^#[0-9a-f]{6}$/i.test(c)));
  return map(a.screenBlocks,SCREEN_SECTIONS)&&a.widgetBlocks&&["small","medium","large"].every(f=>map(a.widgetBlocks[f],WIDGET_SECTIONS));
}
function detailedScreenCSS(){
  const a=SETTINGS.appearance;
  return `.stop-heading-row{display:flex;gap:8px;align-items:center}.stop-heading-row .stop-heading{flex:1;min-width:0}.stop-heading-row{-webkit-touch-callout:none;touch-action:pan-y}.stop-heading-row a{-webkit-touch-callout:none}.stop-route-menu{flex:0 0 44px}[data-section][hidden]{display:none!important}.lesson-heading{display:flex;gap:8px;align-items:flex-start}.lesson-heading h3{flex:1;min-width:0}.lesson-menu{display:flex;align-items:center;justify-content:center;flex:0 0 44px;min-height:44px;font-size:1.5rem;text-decoration:none;color:var(--accent);border-radius:10px;background:var(--chip)}.break-card{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:16px}.break-card[hidden]{display:none}.break-card [data-break-count]{font-size:${1.6*a.screenTimeScale/100}rem;font-variant-numeric:tabular-nums}.break-card small{color:var(--muted)}.lesson-time{flex-basis:auto;min-width:2.8rem}.lesson-time b{font-size:${a.screenTimeScale/100}rem}.lesson-time span{font-size:${.8*a.screenTimeScale/100}rem}
  .arrival>b,.times>b{font-size:${1.25*a.screenTimeScale/100}rem}.clock{font-size:${1.6875*a.screenTimeScale/100}rem}.section-title h2,.stop-heading h3,.pack-category{font-size:${1.1*a.screenHeadingScale/100}rem}`+
  SCREEN_SECTIONS.filter(key=>a.screenBlocks[key]).map(key=>{const b=blockStyle("screen",key),s=`[data-section="${key}"]`;
    return `${s}{width:${b.width}%;min-height:${b.height}px;padding:${b.padding}px;margin-left:auto;margin-right:auto;${b.background?`background:${b.background};`:""}${b.color?`color:${b.color};`:""}${b.radius?`border-radius:${b.radius}px;`:""}}
    ${s} .card{padding-top:${b.padding}px;padding-bottom:${b.padding}px}${s} .lesson,${s} .bus-row{gap:${b.gap+8}px}
    ${s} h3,${s} .notes,${s} .item span,${s} .weather-condition,${s} .lesson-body{font-size:${b.scale/100}rem}
    ${key==="countdown"?`${s}{padding:0}`:""}${s} .break-card [data-break-count]{font-size:${1.6*b.scale/100*a.screenTimeScale/100}rem}${s} .break-card{min-height:${b.height}px;padding:${b.padding}px;gap:${b.gap}px;${b.background?`background:${b.background};`:""}${b.color?`color:${b.color};`:""}border-radius:${b.radius}px}
    ${s} h1,${s} .weather-temp{font-size:${2*b.scale/100}rem}${s} h2,${s} .route{font-size:${1.2*b.scale/100}rem}
    ${b.color?`${s} h1,${s} h2,${s} h3,${s} .notes{color:${b.color}}`:""}`;
  }).join("");
}
async function editBlockDimensions(block,name) {
  const values=await setupInput("Размеры · "+name,
    "На виджете высота ограничивается доступным местом. Если всё не помещается, убираются дополнительные строки.",
    BLOCK_DIMENSION_FIELDS.map(([key,label,min,max])=>({label:label+` · ${min}–${max}`,value:String(block[key])})));
  return values?{...block,...parseBlockDimensions(values)}:null;
}
async function editBlockColors(block) {
  const values=await setupInput("Цвета блока","#RRGGBB; пустое поле — общий цвет / прозрачный фон.",
    [{label:"Фон",value:block.background},{label:"Текст",value:block.color}]);
  if(!values)return null;
  if(values.some(x=>x&&!/^#[0-9a-f]{6}$/i.test(x)))throw Error("Нужен HEX #RRGGBB.");
  return {...block,background:values[0],color:values[1]};
}
async function blockEditor(profile,screen=false) {
  const appearance=profile.appearance;
  const keys=screen?SCREEN_SECTIONS:WIDGET_SECTIONS;
  const names=screen?SCREEN_SECTION_NAMES:WIDGET_SECTION_NAMES;
  let family="large";
  if(!screen){
    const index=await setupChoice("Размер виджета","Каждый размер имеет своё оформление.",["Small","Medium","Large"]);
    if(index<0)return false;
    family=["small","medium","large"][index];
  }
  let changed=false;
  while(true){
    const index=await setupChoice(screen?"Размеры блоков экрана":"Редактор · "+family,
      "Размеры в pt (экран — CSS px). Высота 0 — по содержимому. Большой текст занимает больше места.",
      ["Готово",...keys.map(key=>names[key])]);
    if(index<=0)return changed;
    const key=keys[index-1],map=screen?appearance.screenBlocks:appearance.widgetBlocks[family];
    const block={...blockDefaults(),...map[key]};
    const action=await setupChoice(names[key],"Видимость и порядок — в разделе «Блоки». Здесь меняется геометрия и оформление.",
      ["Размеры и отступы","Цвет блока и текста · HEX","Сбросить этот блок"]);
    if(action<0)continue;
    if(action===2)delete map[key];
    else {
      const updated=action===1?await editBlockColors(block):await editBlockDimensions(block,names[key]);
      if(!updated)continue;
      map[key]=updated;
    }
    saveProfile(profile);
    changed=true;
  }
}
async function fineLayoutSettings(profile){
  const a=profile.appearance,i=await setupChoice("Точная настройка","Отдельные размеры времени, подписей и каждого блока.",["Блоки виджета · размеры и цвета","Блоки главного экрана · размеры и цвета","Время в виджете · "+a.timeScale+"%","Мелкие подписи виджета · "+a.metaScale+"%","Время на экране · "+a.screenTimeScale+"%","Заголовки на экране · "+a.screenHeadingScale+"%","Поля, расстояния и выравнивание виджета"]);
  if(i<0)return false;if(i<2)return blockEditor(profile,i===1);
  if(i<6)return numericAppearance(a,["timeScale","metaScale","screenTimeScale","screenHeadingScale"][i-2],"Размер текста",50,300);
  const v=await setupInput("Поля виджета","В pt: поля 0–32, расстояние между блоками 0–24.",[{label:"Поля",value:String(a.widgetPadding)},{label:"Между блоками",value:String(a.widgetGap)}]);if(!v)return false;
  const [p,g]=v.map(Number);if(!Number.isInteger(p)||p<0||p>32||!Number.isInteger(g)||g<0||g>24)throw Error("Проверь диапазоны полей.");
  const k=await setupChoice("Выравнивание по высоте","Куда сдвинуть содержимое при наличии свободного места?",["Вверх","По центру","Вниз"]);if(k<0)return false;a.widgetPadding=p;a.widgetGap=g;a.widgetAlignment=["top","center","bottom"][k];return true;
}
function sameStop(a,b){
  if(!a||!b)return false;
  if(a.id&&b.id&&a.id===b.id)return true;
  if(!a.code||!b.code||a.code!==b.code)return false;
  if(a.direction&&b.direction&&a.direction.trim().toLowerCase()!==b.direction.trim().toLowerCase())return false;
  // Stop codes can be reused by different agencies/cities. A matching code is
  // an alias only when both platforms are actually close to one another.
  return validLocationAnchor(a)&&validLocationAnchor(b)?distanceMeters(a,b)<150:
    !!(a.name&&b.name&&a.direction&&b.direction&&a.name===b.name&&a.direction===b.direction);
}
function uniqueStops(stops){const result=[];for(const s of stops)if(s&&!result.some(x=>sameStop(x,s)))result.push(s);return result;}
function routeVisible(stop,route,profile=SETTINGS){
  const number=String(route).trim().toUpperCase();
  // The same physical platform may have acquired another logical key in an old profile.
  const aliases=[stop,...[...(profile.stops||[]),...(profile.extraStops||[])].filter(s=>sameStop(s,stop))];
  const contains=list=>(list||[]).some(r=>String(r).trim().toUpperCase()===number);
  return aliases.every(s=>!contains(profile.hiddenRoutes?.[s.key])&&
    (!Array.isArray(profile.allowedRoutes?.[s.key])||contains(profile.allowedRoutes[s.key])));
}
function setRouteVisibility(profile,stop,route,visible){
  for(const s of [stop,...[...profile.stops,...profile.extraStops].filter(s=>sameStop(s,stop))]){
    const hidden=normalizeRouteNumbers(profile.hiddenRoutes[s.key]||[]);
    profile.hiddenRoutes[s.key]=visible?hidden.filter(r=>r!==route):normalizeRouteNumbers([...hidden,route]);
    if(Array.isArray(profile.allowedRoutes[s.key]))profile.allowedRoutes[s.key]=visible?normalizeRouteNumbers([...profile.allowedRoutes[s.key],route]):profile.allowedRoutes[s.key].filter(r=>r!==route);
  }
}
function stopRoutesURL(stop){return actionURL("stop-routes",{stop:stop.key});}
function stopHeading(stop,details=""){
  return `<div class="stop-heading-row" data-stop-menu="${escapeHTML(stopRoutesURL(stop))}"><a class="stop-heading stop-heading-link" href="${escapeHTML(stopBoardURL(stop))}"><h3>${escapeHTML(stop.name)} <span class="stop-open">табло ›</span></h3>${details||`<p class="place">${escapeHTML(stop.direction)}</p>`}</a><a class="stop-route-menu lesson-menu" aria-label="Выбрать автобусы остановки" href="${escapeHTML(stopRoutesURL(stop))}">⋯</a></div>`;
}
function normalizeRouteNumbers(values){return [...new Set(values.map(x=>String(x??"").trim().toUpperCase()).filter(x=>x&&x.length<=12&&!/[,;\s]/.test(x)))].sort((a,b)=>a.localeCompare(b,"en",{numeric:true}));}
async function loadStopRoutes(fm,stop,now=new Date()){
  const path=fm.joinPath(profileFiles().dir,"routes-"+stop.key+".json"),source=JSON.stringify([SETTINGS.apiURL,stop.id,stop.code]);let cached=null;
  try{const old=JSON.parse(fm.readString(path));if(old.source===source&&Number.isFinite(old.saved)&&old.saved<=+now&&Array.isArray(old.routes)&&old.routes.every(x=>typeof x==="string"))cached=old;}catch{}
  if(cached&&+now-cached.saved<DAY)return {...cached,stale:false};
  try{
    const result=JSON.parse(await loadRequest(SETTINGS.apiURL,{query:`{ stop(id:${JSON.stringify(stop.id)}) { code routes { shortName } } }`}));
    const data=result.data?.stop;if(result.errors?.length||data?.code!==stop.code||!Array.isArray(data.routes))throw Error("Нет списка маршрутов");
    const value={source,saved:+now,routes:normalizeRouteNumbers(data.routes.map(r=>r.shortName))};try{fm.writeString(path,JSON.stringify(value));}catch{}return {...value,stale:false};
  }catch(error){if(cached)return {...cached,stale:true};return {routes:[],saved:null,stale:true};}
}
async function stopRoutesMenu(stop){
  const {fm}=profileFiles(),catalog=await loadStopRoutes(fm,stop),p=currentProfile();
  const known=normalizeRouteNumbers([...catalog.routes,...(p.hiddenRoutes[stop.key]||[]),...(p.allowedRoutes[stop.key]||[]),...(p.stopPriorities[stop.key]||[]),...(stop.preferred||[]).map(b=>b.route),...(stop.other||[]).map(b=>b.route),...(stop.all||[]).map(b=>b.route)]);
  let changed=false;
  while(true){
    const hidden=p.hiddenRoutes[stop.key]||[],priorities=p.stopPriorities[stop.key]||[];
    const index=await setupChoice(stop.name+" · автобусы",stop.direction+"\n☑ показывать · ☐ скрыть. Изменения сохраняются сразу и действуют на виджет, обзор и табло."+(Array.isArray(p.allowedRoutes[stop.key])?"\nТолько выбранные номера: новые маршруты API останутся скрытыми.":"")+(catalog.stale?"\nAPI недоступен: сохранённый/неполный список. Номер можно добавить вручную.":""),[
      "Готово",...known.map(r=>(routeVisible(stop,r,p)?"☑ ":"☐ ")+"№ "+r+(priorities.includes(r)?" ★":"")),"Показать все","Оставить только приоритетные ★","Добавить номер вручную"]);
    if(index<=0)return changed;
    if(index<=known.length){const route=known[index-1];setRouteVisibility(p,stop,route,!routeVisible(stop,route,p));}
    else if(index===known.length+1){for(const s of [stop,...[...p.stops,...p.extraStops].filter(s=>sameStop(s,stop))]){p.hiddenRoutes[s.key]=[];delete p.allowedRoutes[s.key];}}
    else if(index===known.length+2){if(!priorities.length){await setupMessage("Приоритеты не выбраны","Сначала выбери нужные номера в Настройки → Транспорт → Приоритеты по остановкам.");continue;}for(const s of [stop,...[...p.stops,...p.extraStops].filter(s=>sameStop(s,stop))]){p.hiddenRoutes[s.key]=[];p.allowedRoutes[s.key]=priorities.slice();}}
    else {const value=await setupInput("Номер автобуса","Для маршрута, которого нет в списке API. Он будет добавлен в скрытые; нажми на его строку, чтобы вернуть показ.",[{label:"Например: 3",value:""}]);if(!value)continue;const routes=normalizeRouteNumbers(value);if(routes.length!==1)throw Error("Введи один номер маршрута, до 12 символов.");if(!known.includes(routes[0])){known.push(routes[0]);known.sort((a,b)=>a.localeCompare(b,"en",{numeric:true}));}p.hiddenRoutes[stop.key]=normalizeRouteNumbers([...hidden,routes[0]]);}
    saveProfile(p);changed=true;
  }
}
async function refreshBusFilters(model,fm){
  const path=fm.joinPath(profileFiles().dir,"buses.json"),options={detailed:true,count:Math.max(SETTINGS.departureCount,SETTINGS.widgetDepartureCount)};
  let result;try{result=await loadBuses(fm,path,new Date(),{...options,cacheOnly:true});}catch{result=await loadBuses(fm,path,new Date(),options);}
  model.buses=nearestBuses(result.data,new Date(),transitStops(true),SETTINGS.departureCount,result.stale===true);model.busSaved=result.saved;model.busStale=result.stale===true;
}
function liveStopMenu(){
  for(const heading of document.querySelectorAll('[data-stop-menu]')){
    let x=0,y=0,fired=false;const stop=()=>{clearTimeout(window.__uniStopHoldTimer);window.__uniStopHoldTimer=null;};
    const fire=()=>{if(fired)return;fired=true;stop();window.location.assign(heading.dataset.stopMenu);};
    heading.addEventListener('pointerdown',e=>{if(e.target.closest('.stop-route-menu'))return;stop();x=e.clientX;y=e.clientY;fired=false;window.__uniStopHoldTimer=setTimeout(fire,650);});
    heading.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-x)+Math.abs(e.clientY-y)>12)stop();});
    for(const event of ['pointerup','pointercancel','pointerleave'])heading.addEventListener(event,stop);
    heading.addEventListener('click',e=>{if(fired){e.preventDefault();e.stopPropagation();fired=false;}},true);
    heading.addEventListener('contextmenu',e=>{e.preventDefault();fire();});
  }
}

async function hiddenRoutesSettings(profile){
  const stops=[...profile.stops,...profile.extraStops],n=await setupChoice("Скрытые автобусы","Настройка действует на виджет, обзор и табло. Скрытые номера можно вернуть здесь.",stops.map(s=>s.name+" · "+s.direction));if(n<0)return false;
  const stop=stops[n],v=await setupInput("Скрыть маршруты · "+stop.name,"Номера через запятую. Удали номер из поля, чтобы вернуть его. Пустое поле показывает все маршруты.",[{label:"Скрытые номера",value:(profile.hiddenRoutes[stop.key]||[]).join(", ")}]);if(!v)return false;
  const routes=[...new Set(v[0].split(/[,;\s]+/).filter(Boolean).map(x=>x.toUpperCase()))];if(routes.some(x=>x.length>12)||routes.length>100)throw Error("Проверь номера маршрутов.");for(const s of [stop,...stops.filter(s=>sameStop(s,stop))]){profile.hiddenRoutes[s.key]=routes.slice();delete profile.allowedRoutes[s.key];}return true;
}
function screenThemeHead(){
  const c=SETTINGS.appearance.screenColors;
  const bg=c?.bg||"#f3f3ed",scheme=c?(colorLuminance(bg)<.18?"dark":"light"):"light dark";
  return `<meta data-uniday-theme name="color-scheme" content="${scheme}">`+(c?`<meta data-uniday-theme name="theme-color" content="${bg}">`:
    '<meta data-uniday-theme name="theme-color" content="#f3f3ed" media="(prefers-color-scheme: light)"><meta data-uniday-theme name="theme-color" content="#151e19" media="(prefers-color-scheme: dark)">')+
    `<style data-uniday-style>html{min-height:100%;background:${bg};color-scheme:${scheme}}body{min-height:100vh}html,body{background:var(--bg,${bg})}${c?"":"@media(prefers-color-scheme:dark){html{background:#151e19}}"}</style>`;
}
function uiPause(ms){return typeof Timer==="undefined"?Promise.resolve():new Promise(resolve=>Timer.schedule(ms,false,resolve));}
async function webOperation(operation,label,ms=5000){
  if(typeof Timer==="undefined")return operation();let timer;
  try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=Timer.schedule(ms,false,()=>reject(Error(label+" timed out")));})]);}
  finally{if(timer)timer.invalidate();}
}
function logLaunch(fm,stage){
  // No schedule, addresses, URLs or notes in this small local diagnostic log.
  try{const path=fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"launch-diagnostics.json");let entries=[];
    try{const old=JSON.parse(fm.readString(path));if(Array.isArray(old))entries=old.slice(-39);}catch{}
    entries.push({at:Date.now(),version:"7.9.0",stage,inApp:!!config.runsInApp,home:!!config.runsFromHomeScreen,widget:!!config.runsInWidget,siri:!!config.runsWithSiri});fm.writeString(path,JSON.stringify(entries));
  }catch{}
}
async function showLaunchDiagnostics(){
  const {fm,dir}=profileFiles();let entries=[];try{entries=JSON.parse(fm.readString(fm.joinPath(dir,"launch-diagnostics.json")));}catch{}
  const lines=Array.isArray(entries)?entries.slice(-12).map(e=>time(new Date(e.at))+" · "+e.stage+" · "+(e.inApp?"app":e.siri?"siri":"other")):[];
  await setupMessage("Запуск UniDay · 7.9.0",lines.join("\n")||"Пока нет записей. Здесь сохраняются только этапы открытия, без личных данных.");return false;
}
function overviewDOMUpdate(html,scroll=0){
  // Never replace the host's head/body or its bridge nodes. Only UniDay-owned content.
  return `(()=>{const doc=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
    const source=doc.querySelector('main'),old=document.querySelector('main');if(!source||!old)throw Error('Missing UniDay main');
    const next=document.importNode(source,true),position=${scroll===null?'window.scrollY':Math.max(0,Number(scroll)||0)};
    const detailKey=d=>(d.closest('[data-section]')?.dataset.section||'')+'|'+(d.dataset.day||d.closest('[data-edit-lesson]')?.dataset.editLesson||d.querySelector('summary')?.textContent);
    const opened=${scroll===null?`[...old.querySelectorAll('details')].map(d=>[detailKey(d),d.open,d.dataset.autoDay])`:'[]'};
    const styles=[...doc.head.querySelectorAll('[data-uniday-style],[data-uniday-theme]')].map(n=>document.importNode(n,true));
    const previousStyles=[...document.head.querySelectorAll('[data-uniday-style],[data-uniday-theme]')];
    styles.forEach(n=>document.head.appendChild(n));old.replaceWith(next);previousStyles.forEach(n=>n.remove());
    if(window.__uniLessonTimer)clearInterval(window.__uniLessonTimer);if(window.__uniBreakTimer)clearInterval(window.__uniBreakTimer);if(window.__uniBusTimer)clearInterval(window.__uniBusTimer);
    clearTimeout(window.__uniHoldTimer);clearTimeout(window.__uniStopHoldTimer);if(window.__uniVisibility)document.removeEventListener('visibilitychange',window.__uniVisibility);if(window.__uniBusVisibility)document.removeEventListener('visibilitychange',window.__uniBusVisibility);
    document.querySelectorAll('script[data-uniday-script]').forEach(n=>n.remove());
    document.title=doc.title;for(const script of doc.querySelectorAll('script[data-uniday-script]')){const node=document.createElement('script');node.dataset.unidayScript='';node.textContent=script.textContent;document.body.appendChild(node);}
    for(const d of next.querySelectorAll('details')){const match=opened.find(x=>x[0]===detailKey(d));if(match&&match[2]!=='1'){d.open=match[1];if(d.dataset.autoDay!==undefined)d.dataset.autoDay='0';}}
    window.scrollTo(0,position);return !!document.querySelector('main');})()`;
}


function wallpaperRect(image,base,dx=0,dy=0,zoom=100){
  // Positive displacement moves the PHOTO right/down, negative moves it left/up.
  if(![dx,dy,zoom].every(Number.isFinite)||zoom<25||zoom>400)throw Error("Масштаб: 25–400%.");
  if(Math.abs(dx)>image.size.width*4||Math.abs(dy)>image.size.height*4)throw Error("Сдвиг не должен превышать четыре размера снимка.");
  return {...base,dx,dy,zoom};
}
function drawWallpaper(image,rect,background){
  const draw=new DrawContext();draw.size=new Size(rect.width,rect.height);draw.respectScreenScale=false;draw.opaque=true;
  draw.setFillColor(new Color(background));draw.fillRect(new Rect(0,0,rect.width,rect.height));
  const scale=(rect.zoom||100)/100;
  draw.drawImageInRect(image,new Rect(-rect.x*scale+(rect.dx||0),-rect.y*scale+(rect.dy||0),image.size.width*scale,image.size.height*scale));return draw.getImage();
}
async function adjustWallpaper(profile,family,image,base,sourceFile){
  let rect={...base,dx:base.dx||0,dy:base.dy||0,zoom:base.zoom||100};
  while(true){
    const choice=await setupChoice("Фон · "+family.toUpperCase(),`X ${rect.dx}, Y ${rect.dy}, масштаб ${rect.zoom}%. Минус Y двигает изображение вверх.`,["Предпросмотр фона","Сдвиг и масштаб","Сохранить"]);if(choice<0)return false;
    if(choice===1){const v=await setupInput("Положение изображения","Сдвиг в пикселях снимка. Отрицательный Y — вверх. За пределами фото используется цвет фона виджета.",[{label:"X (вправо + / влево −)",value:String(rect.dx)},{label:"Y (вниз + / вверх −)",value:String(rect.dy)},{label:"Масштаб 25–400%",value:String(rect.zoom)}]);if(!v)continue;rect=wallpaperRect(image,rect,...v.map(Number));continue;}
    const crop=drawWallpaper(image,rect,profile.appearance.widgetBackground);
    if(choice===0){await QuickLook.present(crop,false);continue;}
    const {fm,dir}=profileFiles(),stamp=Date.now()+"-"+Math.floor(Math.random()*1000000),file=`widget-wallpaper-${family}-${stamp}.png`;
    const source=sourceFile||`widget-source-${family}-${stamp}.png`;if(!sourceFile)fm.writeImage(fm.joinPath(dir,source),image);
    fm.writeImage(fm.joinPath(dir,file),crop);
    profile.appearance.wallpaperBackgrounds[family]={file,source,rect};profile.appearance.widgetBackgroundMode="wallpaper";
    saveProfile(profile);
    await setupMessage("Фон сохранён","Предпросмотр показывает новую обрезку сразу. Домашний виджет прочитает её при следующем обновлении iOS; приложение не может принудительно перезагрузить его.");return true;
  }
}
async function editSavedWallpaper(profile){
  const entries=Object.entries(profile.appearance.wallpaperBackgrounds),n=await setupChoice("Сдвинуть сохранённый фон","Скриншот заново выбирать не нужно.",entries.map(([f])=>f.toUpperCase()));if(n<0)return false;
  const [family,bg]=entries[n],{fm,dir}=profileFiles();
  if(!bg.source||!bg.rect||!fm.fileExists(fm.joinPath(dir,bg.source))){await setupMessage("Нужен исходный снимок","Этот фон создан старой версией. Настрой его один раз заново — исходник будет сохранён для последующих сдвигов.");return false;}
  return adjustWallpaper(profile,family,fm.readImage(fm.joinPath(dir,bg.source)),bg.rect,bg.source);
}

function appearanceExtras() {
  return {mediumLayout:"dashboard",mediumLayoutVersion:2,mediumColumnSplit:55,mediumColumnGap:10,mediumColumns:defaultMediumColumns(),widgetClassProgress:true,countdownVersion:1,widgetBlocks:{small:{},medium:{},large:{}},screenBlocks:{},timeScale:100,metaScale:100,screenTimeScale:100,screenHeadingScale:100,widgetPadding:10,widgetGap:3,widgetAlignment:"top",screenSections:["header","weather","countdown","today","week","packing","buses","footer"],familySections:{small:null,medium:null,large:null},screenColors:null,screenWeight:0,screenRadius:20,screenDensity:"normal",widgetWeight:"auto",weatherTextColor:"",weatherScale:100,widgetStopLimits:{small:1,medium:1,large:3},
    familyScales:{small:100,medium:100,large:100},currentScale:100,nextScale:100,busScale:100,
    widgetDensity:"normal",largeLayout:"auto"};
}
const COLOR_PALETTES={
  forest:{name:"Лес",bg:"#f3f3ed",card:"#fffefa",ink:"#243c32",muted:"#637064",accent:"#276848"},
  ocean:{name:"Океан",bg:"#edf5fc",card:"#ffffff",ink:"#17364c",muted:"#516c80",accent:"#14638d"},
  lavender:{name:"Лаванда",bg:"#f3effb",card:"#ffffff",ink:"#342447",muted:"#705c84",accent:"#7041a3"},
  rose:{name:"Розовый",bg:"#fff0f4",card:"#fffafb",ink:"#502738",muted:"#815969",accent:"#aa345c"},
  sand:{name:"Песок",bg:"#faf1df",card:"#fffaf0",ink:"#49351e",muted:"#796449",accent:"#8b551b"},
  graphite:{name:"Графит · тёмный",bg:"#171a20",card:"#242832",ink:"#f1f3f7",muted:"#b0b8c8",accent:"#aac9ff"},
  midnight:{name:"Ночной лес · тёмный",bg:"#151e19",card:"#1f2c23",ink:"#e1ebdd",muted:"#a1af9f",accent:"#b2d5a0"},
  contrast:{name:"Чёрный на белом",bg:"#ffffff",card:"#ffffff",ink:"#111111",muted:"#444444",accent:"#003ea8"}
};
function colorValues(p) {return Object.fromEntries(["bg","card","ink","muted","accent"].map(k=>[k,p[k]]));}
function colorLuminance(hex) {
  const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
}
function onColor(hex) {return colorLuminance(hex)>.179?"#101010":"#ffffff";}
function cssFontName(value) {return Array.from(String(value)).map(c=>"\\"+c.codePointAt(0).toString(16)+" ").join("");}
function screenAppearanceCSS() {
  const a=SETTINGS.appearance,c=a.screenColors,pad={compact:11,normal:18,airy:24}[a.screenDensity];
  return (c?`:root{color-scheme:${colorLuminance(c.bg)<.18?"dark":"light"};--bg:${c.bg};--card:${c.card};--ink:${c.ink};--muted:${c.muted};--accent:${c.accent};--line:${c.muted}45;--chip:${c.card};--warm:${c.card}}
  .weather,.origin,.add-event,.week-nav button.current{background:var(--accent);color:${onColor(c.accent)}}.weather-source,.weather-source a{color:inherit}`:"")+`
  .card,.list,.origin,.weather{border-radius:${a.screenRadius}px}.lesson,.bus-row,.point{padding-top:${pad}px;padding-bottom:${pad}px}
  ${a.screenWeight?`body,button,select,input{font-weight:${a.screenWeight}}`:""}
  .pack-category{font-size:.82rem;margin:18px 0 5px;color:var(--accent)}.pack-category:first-child{margin-top:2px}
  .bus-row,.point{flex-wrap:wrap}.arrival,.point .times{max-width:100%;overflow-wrap:anywhere}.bus-row .stop{min-width:5rem}.point .name{min-width:4rem}
  .week-nav{grid-template-columns:repeat(3,minmax(0,1fr))}.week-nav button{overflow-wrap:anywhere}
  .week-picker{max-width:100%}.section-title{flex-wrap:wrap;gap:8px}.lesson-main{min-width:0}
  h1,h2,h3,.button,.item span,.hint,.notes{overflow-wrap:anywhere}${SCREEN_SECTIONS.filter(k=>!a.screenSections.includes(k)).map(k=>`[data-section="${k}"]{display:none!important}`).join("")}`;
}
function widgetPoints(size,kind="body",family=widgetFamilyKey(),role="") {
  const a=SETTINGS.appearance,roleScale=a[role+"Scale"]||100;
  return Math.min(64,size*a.widgetScale/100*(kind==="category"?a.categoryScale:a.bodyScale)/100*(a.familyScales?.[family]||100)/100*roleScale/100);
}
function validExtraAppearance(a) {
  const color=c=>typeof c==="string"&&/^#[0-9a-f]{6}$/i.test(c);
  if(a.screenColors!==null && (!a.screenColors||typeof a.screenColors!=="object"||!["bg","card","ink","muted","accent"].every(k=>color(a.screenColors[k]))))return false;
  return typeof a.widgetClassProgress==="boolean"&&Number.isInteger(a.mediumColumnGap)&&a.mediumColumnGap>=0&&a.mediumColumnGap<=24&&a.mediumColumns&&WIDGET_SECTIONS.every(k=>[0,1].includes(a.mediumColumns[k]))&&["dashboard","columns","list"].includes(a.mediumLayout)&&Number.isInteger(a.mediumColumnSplit)&&a.mediumColumnSplit>=30&&a.mediumColumnSplit<=70&&validLayoutSettings(a)&&[0,400,500,600,700,800].includes(a.screenWeight)&&[0,8,12,16,20,24,28,32].includes(a.screenRadius)&&
    (a.weatherTextColor===""||color(a.weatherTextColor))&&Number.isInteger(a.weatherScale)&&a.weatherScale>=50&&a.weatherScale<=300&&a.widgetStopLimits&&["small","medium","large"].every(k=>Number.isInteger(a.widgetStopLimits[k])&&a.widgetStopLimits[k]>=1&&a.widgetStopLimits[k]<={small:1,medium:2,large:4}[k])&&
    ["compact","normal","airy"].includes(a.screenDensity)&&["compact","normal","airy"].includes(a.widgetDensity)&&
    ["auto","regular","bold","heavy"].includes(a.widgetWeight)&&["auto","compact","expanded"].includes(a.largeLayout)&&
    a.familyScales&&["small","medium","large"].every(k=>Number.isInteger(a.familyScales[k])&&a.familyScales[k]>=70&&a.familyScales[k]<=180)&&
    ["currentScale","nextScale","busScale"].every(k=>Number.isInteger(a[k])&&a[k]>=70&&a[k]<=180);
}
function packingItemKey(item) {return String(item).trim().toLocaleLowerCase("ru-RU");}
const PACKING_CATEGORY_NAMES=["Техника","Канцелярия","Документы и папки","Личное","Другое"];
function packingCategory(item) {
  const key=packingItemKey(item),custom=SETTINGS.packingCategories||{};
  if(Object.prototype.hasOwnProperty.call(custom,key))return custom[key];
  if(/ноут|laptop|arvuti|флеш|usb|заряд|кабел|калькулятор|наушник|планшет/.test(key))return "Техника";
  if(/õpimapp|папк|паспорт|документ|билет|пропуск/.test(key))return "Документы и папки";
  if(/ручк|карандаш|линейк|тетрад|бумаг|треугольник|pen|vihik|paber|joonlaud/.test(key))return "Канцелярия";
  if(/вод[ау]|бутыл|ед[ау]|обед|ключ|кошел|зонт|одеж|перчат/.test(key))return "Личное";
  return "Другое";
}
function packingGroups(items) {
  const groups=new Map();for(const item of items){const category=packingCategory(item);if(!groups.has(category))groups.set(category,[]);groups.get(category).push(item);}
  return [...groups].sort(([a],[b])=>{const rank=x=>PACKING_CATEGORY_NAMES.includes(x)?PACKING_CATEGORY_NAMES.indexOf(x):3.5;return rank(a)-rank(b)||a.localeCompare(b,"ru");});
}
function packingHTML(items,date,checks={}) {
  return packingGroups(items).map(([name,list])=>`<h3 class="pack-category">${escapeHTML(name)}</h3>${list.map(x=>`<label class="item ${/^(?:!|❗)/.test(x)?"important":""}"><input type="checkbox" data-pack-url="${escapeHTML(actionURL("pack-check",{date,item:x}))}" ${checks[date]?.[packingCheckKey(x)]===true?"checked":""}><span>${escapeHTML(x.replace("❗ ОБЯЗАТЕЛЬНО ","Обязательно: "))}</span></label>`).join("")}`).join("");
}
async function packingCategorySettings() {
  const p=currentProfile(),{fm,dir}=profileFiles(),dated=readPacking(fm,fm.joinPath(dir,"packing.json"));
  const items=[...new Set([...p.alwaysBring,...Object.values(p.courseItems).flatMap(v=>Array.isArray(v)?v:[]),...Object.values(dated).flat()])].sort((a,b)=>a.localeCompare(b,"ru"));
  if(!items.length){await setupMessage("Категории вещей","Сначала добавь вещи для предмета или дня.");return false;}
  const i=await setupChoice("Категории вещей","Автоматическая группировка — подсказка. Любую вещь можно перенести или задать свою категорию.",items.map(x=>x+" · "+packingCategory(x)));if(i<0)return false;
  const k=await setupChoice(items[i],"Категория применяется к этой вещи во всех списках.",[...PACKING_CATEGORY_NAMES,"Своя категория","Определять автоматически"]);if(k<0)return false;
  const key=packingItemKey(items[i]);
  if(k===6)delete p.packingCategories[key];
  else if(k===5){const v=await setupInput("Название категории","До 40 символов.",[{label:"Категория",value:packingCategory(items[i])}]);if(!v)return false;if(!v[0]||v[0].length>40)throw Error("Введи название от 1 до 40 символов.");p.packingCategories[key]=v[0];}
  else p.packingCategories[key]=PACKING_CATEGORY_NAMES[k];
  saveProfile(p);return true;
}
async function colorSettings(profile) {
  const a=profile.appearance,target=await setupChoice("Где изменить цвета?","Виджет и подробный экран настраиваются независимо.",["Виджет","Подробный экран","Виджет и экран вместе"]);if(target<0)return false;
  const mode=await setupChoice("Способ выбора","Готовые гаммы содержат согласованные цвета текста и фона.",["Готовая палитра","Ввести HEX-коды","Стандартные цвета"]);if(mode<0)return false;
  let colors;
  if(mode===0){const keys=Object.keys(COLOR_PALETTES),i=await setupChoice("Цветовая гамма","Светлые и тёмные варианты.",keys.map(k=>COLOR_PALETTES[k].name));if(i<0)return false;colors=colorValues(COLOR_PALETTES[keys[i]]);}
  else if(mode===1){const base=target===1?(a.screenColors||COLOR_PALETTES.forest):{bg:a.widgetBackground,card:a.widgetBackground,ink:a.widgetText,muted:a.widgetMuted,accent:a.widgetAccent};
    const keys=target===0?["bg","ink","muted","accent"]:["bg","card","ink","muted","accent"],names={bg:"Фон",card:"Карточки",ink:"Основной текст",muted:"Вторичный текст",accent:"Акцент"};
    const v=await setupInput("Свои цвета","Формат #RRGGBB, например #243c32.",keys.map(k=>({label:names[k],value:base[k]})));if(!v)return false;if(v.some(x=>!/^#[0-9a-f]{6}$/i.test(x)))throw Error("Цвет должен быть в формате #RRGGBB.");colors={...base,...Object.fromEntries(keys.map((k,i)=>[k,v[i].toLowerCase()]))};
  } else colors=colorValues(COLOR_PALETTES.forest);
  if(target!==1){a.widgetBackground=colors.bg;a.widgetText=colors.ink;a.widgetMuted=colors.muted;a.widgetAccent=colors.accent;if(mode!==1)a.widgetBackgroundMode="solid";}
  if(target!==0)a.screenColors=mode===2?null:colors;
  return true;
}

function screenBaseTypographyCSS() {
  const a=SETTINGS.appearance;
  const families={serif:'Georgia,serif',avenir:'"Avenir Next",-apple-system,sans-serif',system:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',rounded:'ui-rounded,"SF Pro Rounded",-apple-system,sans-serif',mono:'ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace',custom:a.screenCustomFont?`"${cssFontName(a.screenCustomFont)}",-apple-system,sans-serif`:'-apple-system,sans-serif'};
  return `html{font-size:${16*a.screenScale/100}px}body{font-family:${families[a.screenFont]};font-size:.9375rem;-webkit-text-size-adjust:100%}${a.screenWeight?`body,button,select,input{font-weight:${a.screenWeight}}`:""}`;
}
function screenTypographyCSS() {
  return `${screenBaseTypographyCSS()}header{flex-wrap:wrap}header>div{min-width:0}h1,.origin{overflow-wrap:anywhere}.lesson-time{flex-basis:2.8125rem}.route{min-width:2.25rem;width:auto;padding:0 5px;height:2.625rem}.arrival{max-width:9rem;flex-shrink:0}.point .times{flex-basis:6.0625rem}.actions{flex-wrap:wrap}.button{min-width:0;overflow-wrap:anywhere}.progress-labels{flex-wrap:wrap;gap:4px}.pack-actions{flex-wrap:wrap}${screenAppearanceCSS()}${detailedScreenCSS()}`;
}
function widgetFont(size,bold=false,kind="body",family=widgetFamilyKey(),role="",fixed=false) {
  const a=SETTINGS.appearance,points=widgetPoints(size,kind,family,role||(fixed?"meta":""));
  const mode=kind==="category"?a.categoryFont:a.bodyFont,custom=kind==="category"?a.categoryCustomFont:a.bodyCustomFont;
  if(mode==="custom"&&custom){try{return new Font(custom,points);}catch{}}
  if(mode==="serif"||mode==="avenir"){try{return new Font(mode==="serif"?(bold?"Georgia-Bold":"Georgia"):(bold?"AvenirNext-DemiBold":"AvenirNext-Regular"),points);}catch{}}
  const weight=a.widgetWeight==="auto"?(bold?"semibold":"regular"):a.widgetWeight;
  const suffix=mode==="rounded"?"RoundedSystemFont":mode==="mono"?"MonospacedSystemFont":"SystemFont";
  const method=weight+suffix;
  if(weight==="regular"&&suffix==="SystemFont")return Font.systemFont(points);
  if(typeof Font[method]==="function")return Font[method](points);
  return bold?Font.semiboldSystemFont(points):Font.systemFont(points);
}

function validateProfile() {
  validateHTTPSURL(SETTINGS.calendarURL);
  if(!SETTINGS.storageFolder || /[\\/]/.test(SETTINGS.storageFolder) || [".",".."].includes(SETTINGS.storageFolder))throw Error("Неверное имя storageFolder.");
  if(!Array.isArray(SETTINGS.stops) || SETTINGS.stops.length>2 || new Set(SETTINGS.stops.map(s=>s.key)).size!==SETTINGS.stops.length ||
    SETTINGS.stops.some(s=>!["home","uni"].includes(s.key)||!s.name||!s.label))
    throw Error("Проверь основные остановки в настройках транспорта.");
}
async function resolveProfileStops(fm,path,cacheOnly=false) {
  const complete=s=>s.id && s.code && Number.isFinite(s.latitude) && Number.isFinite(s.longitude) && Math.abs(s.latitude)<=90 && Math.abs(s.longitude)<=180;
  if(SETTINGS.stops.every(complete))return;
  const source=JSON.stringify([SETTINGS.apiURL,SETTINGS.stops]);
  try {
    const cache=JSON.parse(fm.readString(path)),age=Date.now()-cache.saved;
    if(cache.source===source && age>=0 && age<RESOLVED_STOP_CACHE_MS && cache.stops?.length===SETTINGS.stops.length && cache.stops.every(complete)) {SETTINGS.stops=cache.stops;return;}
  } catch {}
  if(cacheOnly)throw Error("Остановки ещё не сохранены на телефоне.");
  const stops=await Promise.all(SETTINGS.stops.map(async s=>{
    if(complete(s))return s;
    const result=JSON.parse(await loadRequest(SETTINGS.apiURL,{query:`{ stops(name:${JSON.stringify(s.name)},maxResults:${LEGACY_STOP_SEARCH_LIMIT+1}) { gtfsId name code desc lat lon } }`}));
    if(result.errors || !Array.isArray(result.data?.stops))throw Error("Не удалось найти остановку "+s.name);
    const candidates=result.data.stops.filter(x=>x.name.toLowerCase()===s.name.toLowerCase() && (!s.code || x.code===s.code) && (!s.direction || (x.desc||"")===s.direction));
    if(candidates.length!==1)throw Error(`Для ${s.name} найдено ${candidates.length} остановок. Выбери нужную сторону через настройки.`);
    const x=candidates[0],resolved={...s,id:x.gtfsId,code:x.code,direction:x.desc||"",latitude:x.lat,longitude:x.lon};
    if(!complete(resolved))throw Error("У остановки нет координат: "+s.name);
    return resolved;
  }));
  fm.writeString(path,JSON.stringify({source,stops,saved:Date.now()}));SETTINGS.stops=stops;
}

// ═══ DOMAIN: calendar and timezone engine ═══
// No Scriptable API, filesystem, network, UI or profile writes inside this engine.
// Public contract: ICS text → series; series + range → lessons; wall-time ↔ Date.
function createCalendarEngine({getTimezone=()=>"Europe/Tallinn",isCourseExcluded=()=>false,maxOccurrences=2000,dayMilliseconds=86400000}={}) {
  const WALL_FORMATTERS = new Map();
  function wallParts(date, zone = getTimezone()) {
    if(!WALL_FORMATTERS.has(zone)) WALL_FORMATTERS.set(zone,new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }));
    const parts = WALL_FORMATTERS.get(zone).formatToParts(date);
    const p = {};
    for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
    return [p.year, p.month, p.day, p.hour, p.minute, p.second];
  }
  function wallUTC(p) { return Date.UTC(p[0], p[1]-1, p[2], p[3]||0, p[4]||0, p[5]||0); }
  /**
   * Convert wall-clock components to an instant in the given timezone.
   * The offset is re-evaluated after correction because it can change at DST.
   * A nonexistent local time is rejected instead of silently moving a lesson.
   * @param {number[]} p Year, month, day, hour, minute, second.
   * @param {string} zone
   * @returns {Date}
   */
  function fromWall(p, zone = getTimezone()) {
    const target = wallUTC(p);
    let value = target;
    for (let i = 0; i < 4; i++) {
      const correction = target - wallUTC(wallParts(new Date(value), zone));
      value += correction;
      if (!correction) break;
    }
    if (wallUTC(wallParts(new Date(value), zone)) !== target) throw Error("Некорректное время календаря");
    return new Date(value);
  }
  function unescapeICS(s) { return s.replace(/\\([nN,;\\])/g, (_,c)=>/[nN]/.test(c)?"\n":c); }
  function field(line) {
    const i=line.indexOf(":");
    if (i<0) throw Error("Повреждённая строка календаря");
    const head=line.slice(0,i).split(";");
    const params={};
    for (const part of head.slice(1)) { const j=part.indexOf("="); params[part.slice(0,j)]=part.slice(j+1).replace(/^"|"$/g,""); }
    return {name:head[0].toUpperCase(), params, value:line.slice(i+1)};
  }
  function parseDate(f) {
    if (!f) throw Error("В календаре нет времени пары");
    const m=f.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) throw Error("Новый формат даты календаря — требуется обновление скрипта");
    const p=m.slice(1,7).map(Number), zone=m[7]?"UTC":(f.params.TZID||getTimezone());
    const normalized=new Date(wallUTC(p));
    const actual=[normalized.getUTCFullYear(),normalized.getUTCMonth()+1,normalized.getUTCDate(),normalized.getUTCHours(),normalized.getUTCMinutes(),normalized.getUTCSeconds()];
    if(actual.some((value,i)=>value!==p[i]))throw Error("Некорректная дата или время события календаря");
    // Use the runtime's timezone database. Never silently shift an unknown TZID to Tallinn.
    try {wallParts(new Date(0),zone);}catch {throw Error("Неизвестный часовой пояс: "+zone);}
    return {date:fromWall(p,zone), p, zone};
  }
  /**
   * Read the supported ICS subset, preserving series and explicit cancellations.
   * Folded lines are joined before parsing; nested alarms are ignored.
   * Unknown recurrence rules are rejected so incomplete data cannot replace a cache.
   * @param {string} ics
   * @returns {Array<object>} Calendar series; expandCalendar creates actual lessons.
   */
  function parseCalendar(ics) {
    if (!ics.includes("BEGIN:VCALENDAR") || !ics.includes("END:VCALENDAR")) throw Error("Сайт не вернул календарь ICS");
    const lines=ics.replace(/\r\n/g,"\n").replace(/\r/g,"\n").replace(/\n[ \t]/g,"").split("\n");
    const raw=[]; let current=null, nested=0;
    for (let line of lines) {
      line=line.replace(/^\uFEFF/,"");
      if (line==="BEGIN:VEVENT") { current={}; nested=0; }
      else if (line==="END:VEVENT") { if(current) raw.push(current); current=null; }
      else if (current && line) {
        if (line.startsWith("BEGIN:")) { nested++; continue; }
        if (line.startsWith("END:")) { nested--; continue; }
        if (nested) continue;
        const f=field(line); (current[f.name]||(current[f.name]=[])).push(f);
      }
    }
    if (current) throw Error("Календарь загружен не полностью");
    return raw.map(r=>{
      const first=n=>r[n]?.[0], val=n=>first(n)?.value||"";
      if (!val("UID")) throw Error("У события нет UID");
      const cancelled=val("STATUS")==="CANCELLED";
      const recurrence=first("RECURRENCE-ID")?parseDate(first("RECURRENCE-ID")).date:null;
      if (cancelled) return {uid:val("UID"), cancelled, recurrence};
      const start=parseDate(first("DTSTART")), end=parseDate(first("DTEND"));
      if (end.date<=start.date) throw Error("Неверная длительность пары");
      const rule={};
      if ((r.RRULE||[]).length>1 || r.RDATE || r.EXRULE) throw Error("Новый тип повторения в календаре — требуется обновление скрипта");
      if (val("RRULE")) {
        for(const item of val("RRULE").split(";")) { const [k,v]=item.split("="); rule[k]=v; }
        if (!['WEEKLY','DAILY'].includes(rule.FREQ) || Object.keys(rule).some(k=>!["FREQ","UNTIL","INTERVAL","COUNT"].includes(k)))
          throw Error("Новое правило повторения: "+val("RRULE"));
        if (rule.INTERVAL && (!/^\d+$/.test(rule.INTERVAL)||!Number.isSafeInteger(Number(rule.INTERVAL))||Number(rule.INTERVAL)<1)) throw Error("Неверный интервал повторения");
        if (rule.COUNT && (!/^\d+$/.test(rule.COUNT)||!Number.isSafeInteger(Number(rule.COUNT))||Number(rule.COUNT)<1)) throw Error("Неверное количество повторений");
      }
      const excluded=new Set((r.EXDATE||[]).flatMap(f=>f.value.split(",").map(v=>+parseDate({...f,value:v}).date)));
      const title=unescapeICS(val("SUMMARY")), code=title.match(/\b[A-Z]{2}\.\d{4}\b/)?.[0]||"";
      return {uid:val("UID"), title, code, notes:unescapeICS(val("DESCRIPTION")),
        location:unescapeICS(val("LOCATION")), start, end, rule, excluded, recurrence, cancelled:false};
    });
  }
  /** @param {Array<object>} events @param {Date} from @param {Date} to @param {boolean} firstPerSeries @returns {Lesson[]} */
  function expandCalendar(events, from, to, firstPerSeries=false) {
    const result=[], overrides=new Set(), cancelled=new Set();
    for(const e of events) {
      if(e.recurrence) overrides.add(e.uid+"/"+(+e.recurrence));
      else if(e.cancelled) cancelled.add(e.uid);
    }
    for(const e of events) {
      if(e.cancelled || cancelled.has(e.uid) || isCourseExcluded(e)) continue;
      const step=e.rule.FREQ?(e.rule.FREQ==="WEEKLY"?7:1)*Number(e.rule.INTERVAL||1):0;
      const until=e.rule.UNTIL?parseDate({value:e.rule.UNTIL,params:{TZID:e.start.zone}}).date:null;
      const duration=+e.end.date-+e.start.date;
      let index=0;
      if(step) index=Math.max(0,Math.floor((wallUTC(wallParts(from,e.start.zone))-wallUTC(e.start.p))/(step*dayMilliseconds))-1);
      for(let safety=0;safety<maxOccurrences;safety++,index++) {
        if(e.rule.COUNT && index>=Number(e.rule.COUNT)) break;
        const p=e.start.p.slice(); p[2]+=index*step;
        // Normalize date arithmetic before conversion (month/year boundaries).
        const normalized=new Date(wallUTC(p));
        const start=fromWall([normalized.getUTCFullYear(),normalized.getUTCMonth()+1,normalized.getUTCDate(),p[3],p[4],p[5]],e.start.zone);
        if(start>=to || (until && start>until)) break;
        const end=new Date(+start+duration);
        if(end>from && !e.excluded.has(+start) && (e.recurrence || !overrides.has(e.uid+"/"+(+start)))) {
          result.push({uid:e.uid,title:e.title,code:e.code,notes:e.notes,location:e.location,start,end});
          if(firstPerSeries)break;
        }
        if(!step) break;
        if(safety===maxOccurrences-1) throw Error("Слишком много повторений календаря");
      }
    }
    const unique=new Map(result.map(e=>[e.uid+"/"+(+e.start),e]));
    return [...unique.values()].sort((a,b)=>a.start-b.start);
  }


  return Object.freeze({wallParts,wallUTC,fromWall,unescapeICS,field,parseDate,parseCalendar,expandCalendar});
}
const CalendarEngine=createCalendarEngine({getTimezone:()=>SETTINGS.timezone,isCourseExcluded:event=>SETTINGS.excludedCourses.includes(courseKey(event)),maxOccurrences:MAX_CALENDAR_OCCURRENCES,dayMilliseconds:DAY});
// Compatibility names: callers retain the existing function contract.
const {wallParts,wallUTC,fromWall,unescapeICS,field,parseDate,parseCalendar,expandCalendar}=CalendarEngine;

// ═══ PRESENTATION: local date labels ═══
function pad(v) { return String(v).padStart(2,"0"); }
function dayKey(d) { const p=wallParts(d); return `${p[0]}-${pad(p[1])}-${pad(p[2])}`; }
function time(d) { const p=wallParts(d); return `${pad(p[3])}:${pad(p[4])}`; }
function datedTime(d, now) { return (dayKey(d)===dayKey(now)?"":dayKey(d)+" ")+time(d); }
function relativeMinutesLabel(minutes) {if(minutes===0)return "сейчас";if(minutes>65){const h=Math.floor(minutes/60),m=minutes%60;return "через "+h+" ч"+(m?" "+m+" мин":"");}return "через "+minutes+" мин";}
function compactTime(d,now) {
  return (dayKey(d)===dayKey(now)?"":dayKey(d)===dayKey(shiftDay(now,1))?"завтра ":dayKey(d).split("-").reverse().join(".")+" ")+time(d);
}
function dayBounds(now) {
  const p = wallParts(now); p[3]=p[4]=p[5]=0;
  return [fromWall(p), fromWall([p[0],p[1],p[2]+1])];
}
// ═══ DOMAIN: transport times ═══
// Raw provider data + selection + clock → departures/points. No requests or UI.
function createTransitTimes() {
  function departures(stop, now, preferredRoutes=null,scheduledOnly=false) {
    if (!stop || !Array.isArray(stop.stoptimesForPatterns)) throw Error("Остановка недоступна");
    const list=[];
    for(const group of stop.stoptimesForPatterns) {
      const route=String(group.pattern?.route?.shortName||"");
      if(!route || (Array.isArray(preferredRoutes) && preferredRoutes.length && !preferredRoutes.includes(route))) continue;
      for(const st of group.stoptimes||[]) {
        if(["CANCELED","CANCELLED","DELETED"].includes(st.realtimeState)) continue;
        const live=!scheduledOnly && st.realtime===true && Number.isFinite(st.realtimeDeparture);
        const seconds=live?st.realtimeDeparture:st.scheduledDeparture;
        if(!Number.isFinite(st.serviceDay)||!Number.isFinite(seconds)) continue;
        const date=new Date((st.serviceDay+seconds)*1000);
        if(date>=now) list.push({date,route,live,headsign:st.headsign||"",scheduled:new Date((st.serviceDay+st.scheduledDeparture)*1000),
          tripId:typeof st.trip?.gtfsId==="string"?st.trip.gtfsId:null,serviceDay:st.serviceDay,stopSequence:st.stopSequence});
      }
    }
    return [...new Map(list.map(x=>[JSON.stringify([x.route,+x.date,x.headsign,x.tripId,x.stopSequence]),x])).values()].sort((a,b)=>a.date-b.date);
  }
  function busTripData(raw,selection,scheduledOnly=false) {
    if(!raw || raw.gtfsId!==selection.trip || !Array.isArray(raw.stoptimesForDate))throw Error("Этот рейс больше не найден.");
    if(raw.stoptimesForDate.some(s=>!s || s.serviceDay!==selection.day || !Number.isInteger(s.stopSequence)) ||
      new Set(raw.stoptimesForDate.map(s=>s.stopSequence)).size!==raw.stoptimesForDate.length)throw Error("Сервис вернул неполные данные остановок рейса.");
    const times=raw.stoptimesForDate.slice().sort((a,b)=>a.stopSequence-b.stopSequence);
    const matches=times.map((s,i)=>({s,i})).filter(({s})=>s.stop?.gtfsId===selection.stop && s.stopSequence===selection.seq && s.serviceDay===selection.day);
    if(matches.length!==1)throw Error("Не удалось однозначно найти выбранную остановку в этом рейсе.");
    function point(s) {
      const cancelled=["CANCELED","CANCELLED","DELETED"].includes(s.realtimeState);
      const valid=v=>Number.isFinite(v) && v>=0;
      const arrivalLive=!scheduledOnly && !cancelled && s.realtime===true && valid(s.realtimeArrival);
      const departureLive=!scheduledOnly && !cancelled && s.realtime===true && valid(s.realtimeDeparture);
      const arrivalSeconds=arrivalLive?s.realtimeArrival:s.scheduledArrival;
      const departureSeconds=departureLive?s.realtimeDeparture:s.scheduledDeparture;
      const date=v=>!cancelled && valid(s.serviceDay) && valid(v)?new Date((s.serviceDay+v)*1000):null;
      return {name:s.stop?.name||"Остановка без названия",direction:s.stop?.desc||"",sequence:s.stopSequence,
        arrival:date(arrivalSeconds),departure:date(departureSeconds),arrivalLive,departureLive,cancelled,
        delay:arrivalLive && valid(s.scheduledArrival)?Math.round((s.realtimeArrival-s.scheduledArrival)/60):null};
    }
    const origin=point(matches[0].s),following=times.slice(matches[0].i+1).map(point);
    return {route:String(raw.route?.shortName||"—"),headsign:String(raw.tripHeadsign||""),origin,following};
  }

  return Object.freeze({departures,busTripData});
}
const TransitTimes=createTransitTimes();
const {departures,busTripData}=TransitTimes;

// ═══ ADAPTER: Peatus requests and offline storage ═══
function busQuery(now,options={}) {
  if(typeof options==="boolean")options={detailed:options};
  const detailed=options.detailed!==false;
  const stops=Array.isArray(options.stops)?options.stops:transitStops(detailed);
  const requested=Math.max(1,Number(options.count)|| (detailed?SETTINGS.departureCount:SETTINGS.widgetDepartureCount));
  // A little headroom is enough to mix priority and non-priority routes without pulling a huge payload.
  const count=options.offlineCoverage?OFFLINE_BUS_DEPARTURES:Math.min(12,Math.max(4,requested+2));
  const tripFields=detailed?" stopSequence trip { gtfsId }":"";
  const fields=`gtfsId name code desc stoptimesForPatterns(startTime:${Math.floor(+now/1000)},numberOfDepartures:${count},timeRange:86400,omitCanceled:true) {
    pattern { route { shortName } } stoptimes { scheduledDeparture realtimeDeparture realtime serviceDay realtimeState headsign${tripFields} }
  }`;
  return `{ ${stops.map(s=>`${s.key}:stop(id:${JSON.stringify(s.id)}) { ${fields} }`).join(" ")} }`;
}
/**
 * Structural HTTPS validation without depending on a browser URL implementation.
 * Calendar hosts stay user-selectable; this is not a DNS/IP allowlist.
 * @param {string} url
 * @returns {string}
 */
function validateHTTPSURL(url) {
  const invalid=()=>{throw Error("Нужна корректная HTTPS-ссылка с адресом сервера, без пробелов и логина в ссылке.");};
  if(typeof url!=="string"||url.length>8192||/[\s\u0000-\u001f\u007f\\<>"']/u.test(url))invalid();
  const parts=/^https:\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(url);if(!parts)invalid();
  const authority=parts[1],hostPort=/^(\[[0-9a-f:.]+\]|[^:@]+)(?::([0-9]{1,5}))?$/i.exec(authority);if(!hostPort)invalid();
  const host=hostPort[1],port=hostPort[2];
  if(port&&(Number(port)<1||Number(port)>65535))invalid();
  if(host.startsWith("[")){if(!host.includes(":"))invalid();}
  else if(host.length>253||!host.replace(/\.$/,"").split(".").every(label=>/^[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?$/i.test(label)))invalid();
  return url;
}
/** @param {string} url @param {object|null} body @param {number} timeoutSeconds @returns {Promise<string>} */
// ═══ ADAPTER: bounded network client ═══
// The module owns its in-flight map; native Request and timeout mechanism are injected.
function createNetworkClient({createRequest,validateURL,runWithTimeout}) {
  const INFLIGHT_REQUESTS=new Map();
  async function load(url, body,timeoutSeconds) {
    validateURL(url);
    const key=JSON.stringify([url,body??null,timeoutSeconds]);
    if(INFLIGHT_REQUESTS.has(key))return INFLIGHT_REQUESTS.get(key);
    const task=(async()=>{
      const request=createRequest(url);request.timeoutInterval=timeoutSeconds;
      if(body){request.method="POST";request.headers={"Content-Type":"application/json"};request.body=JSON.stringify(body);}
      // Some network failures outlive Request.timeoutInterval. Also bound the awaited work.
      const response=request.loadString();
      const text=await runWithTimeout(()=>response,"Сеть",timeoutSeconds*1000);
      if(request.response?.statusCode<200||request.response?.statusCode>=300)throw Error("HTTP "+request.response.statusCode);
      return text;
    })();
    INFLIGHT_REQUESTS.set(key,task);
    try {return await task;}finally {if(INFLIGHT_REQUESTS.get(key)===task)INFLIGHT_REQUESTS.delete(key);}
  }

  return Object.freeze({load});
}
const NetworkClient=createNetworkClient({createRequest:url=>new Request(url),validateURL:validateHTTPSURL,runWithTimeout:webOperation});
function loadRequest(url,body,timeoutSeconds=SETTINGS.requestTimeoutSeconds){return NetworkClient.load(url,body,timeoutSeconds);}

/** Cached content stays usable while a source is unavailable. Backoff survives script restarts. */
async function refreshCachedSource(fm,url,body,hasCache,timeoutSeconds=SETTINGS.requestTimeoutSeconds) {
  const path=fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"network-retry.json");
  // Opaque endpoint key: don't copy private calendar URLs into diagnostics/retry metadata.
  let h1=2166136261,h2=5381;for(const ch of url){const n=ch.charCodeAt(0);h1=Math.imul(h1^n,16777619);h2=Math.imul(h2,33)^n;}
  const key=(h1>>>0).toString(16)+"-"+(h2>>>0).toString(16);
  const read=()=>{try{const value=JSON.parse(fm.readString(path));return value&&typeof value==="object"&&!Array.isArray(value)?value:{};}catch{return {};}};
  const state=read(),old=state[key],now=Date.now();
  if(hasCache&&Number.isFinite(old?.retryAt)&&old.retryAt>now&&old.retryAt<=now+OFFLINE_RETRY_MAX_MS)throw Error("Источник временно недоступен; использую сохранённые данные.");
  try {
    const text=await loadRequest(url,body,hasCache?Math.min(timeoutSeconds,CACHED_REQUEST_TIMEOUT_SECONDS):timeoutSeconds);
    const latest=read();if(latest[key]){delete latest[key];try{fm.writeString(path,JSON.stringify(latest));}catch{}}
    return text;
  }catch(error){
    if(hasCache){const latest=read(),attempts=Math.min(4,Number.isInteger(old?.attempts)&&old.attempts>0?old.attempts+1:1);
      latest[key]={attempts,retryAt:Date.now()+Math.min(OFFLINE_RETRY_MAX_MS,OFFLINE_RETRY_MIN_MS*2**(attempts-1))};
      const bounded=Object.fromEntries(Object.entries(latest).filter(([,v])=>Number.isFinite(v?.retryAt)&&v.retryAt>Date.now()).slice(-32));
      try{fm.writeString(path,JSON.stringify(bounded));}catch{}
    }
    throw error;
  }
}
/** @param {object} fm @param {string} path @param {Date} now @param {boolean} cacheOnly @returns {Promise<CalendarResult>} */
async function loadCalendar(fm,path,now,cacheOnly=false) {
  const source=SETTINGS.calendarURL;let cached=null,cachedEvents=null;
  const backupPath=path+".last-good.json";
  for(const candidate of [path,backupPath])try {
    if(!fm.fileExists(candidate))continue;
    const entry=JSON.parse(fm.readString(candidate)),age=+now-entry.saved;
    if(entry.source!==source||!Number.isFinite(entry.saved)||age<0)continue;
    const events=parseCalendar(entry.text);if(!events.length)continue;
    if(!cached||entry.saved>cached.saved){cached=entry;cachedEvents=events;}
  }catch{} // Empty or corrupt cached responses must not mask a valid backup/download.
  if(cached&&+now-cached.saved<SETTINGS.calendarCacheMinutes*MINUTE&&dayKey(new Date(cached.saved))===dayKey(now))
    return {events:cachedEvents,warning:"",fresh:true,saved:cached.saved};
  try {
    if(cacheOnly)throw Error("Обновляю расписание");
    const text=await refreshCachedSource(fm,source,null,!!cached), events=parseCalendar(text);
    if(!events.length){const error=Error("Источник вернул календарь без занятий. Проверь расписание в ÕIS и заново скопируй ссылку экспорта. Это не подтверждение, что пар нет.");error.code="EMPTY_CALENDAR";throw error;}
    const saved=Date.now();
    const entry=JSON.stringify({text,saved,source});
    // Cache writes must not discard an otherwise valid network response.
    if(SETTINGS.calendarURL===source){try{fm.writeString(backupPath,entry);}catch{}try{fm.writeString(path,entry);}catch{}}
    return {events,warning:"",fresh:true,saved};
  } catch(error) {
    if(cached){if(SETTINGS.calendarURL===source)try{fm.writeString(backupPath,JSON.stringify(cached));}catch{}
      return {events:cachedEvents,fresh:false,saved:cached.saved,
      warning:`${error.code==="EMPTY_CALENDAR"?"Источник вернул пустой календарь. Проверь ссылку экспорта в ÕIS.":"Расписание не обновилось."} ${now-cached.saved>SETTINGS.cacheMaxHours*3600000?"Архивная":"Сохранённая"} копия от ${dayKey(new Date(cached.saved))} ${time(new Date(cached.saved))}; изменения и отмены могут отсутствовать.`};}
    throw error;
  }
}
function transitKey() {return JSON.stringify([SETTINGS.apiURL,SETTINGS.stops]);}
function transitStops(detailed=true) {return detailed?[...SETTINGS.stops,...SETTINGS.extraStops]:SETTINGS.stops;}
function widgetTransitStops() {
  const p=SETTINGS,nearbyKeys=p.widgetNearbyStopFirst?[...placeKeys(p).flatMap(k=>safeOriginStopKeys(p,k,placeStops(p,k))),...(activeChain(p)?.legs.flatMap(l=>safeOriginStopKeys(p,l.from,l.stopKeys))||[])]:[];
  const keys=new Set([...p.widgetStopKeys,...nearbyKeys]);
  return [...p.stops,...p.extraStops].filter(s=>keys.has(s.key));
}
function busCacheKey(options={}) {
  if(typeof options==="boolean")options={detailed:options};
  const detailed=options.detailed!==false,stops=Array.isArray(options.stops)?options.stops:transitStops(detailed);
  const count=Math.max(1,Number(options.count)|| (detailed?SETTINGS.departureCount:SETTINGS.widgetDepartureCount));
  return JSON.stringify(["trip-links-v3",SETTINGS.apiURL,detailed,count,stops.map(s=>[s.key,s.id,s.code])]);
}
function readBusArchive(fm,now) {
  try {
    const path=fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"buses-offline.json"),entry=JSON.parse(fm.readString(path));
    if(entry.apiURL!==SETTINGS.apiURL||!entry.stops||typeof entry.stops!=="object"||Array.isArray(entry.stops))return {};
    return Object.fromEntries(Object.entries(entry.stops).filter(([,s])=>Number.isFinite(s?.saved)&&s.saved<=+now&&+now-s.saved<=OFFLINE_BUS_MAX_AGE_MS&&Array.isArray(s.raw?.stoptimesForPatterns)));
  }catch{return {};}
}
function archivedBusData(archive,stops) {
  const data={},timestamps=[];
  for(const stop of stops){const cached=archive[stop.id];if(cached?.raw.code===stop.code&&(!cached.raw.gtfsId||cached.raw.gtfsId===stop.id)){data[stop.key]=cached.raw;timestamps.push(cached.saved);}}
  return timestamps.length?{data,saved:Math.min(...timestamps),stale:true}:null;
}
function saveBusArchive(fm,data,stops,now,fullDay=false) {
  try {
    const archive=readBusArchive(fm,now),configuredIds=new Set(transitStops(true).map(s=>s.id));
    for(const stop of stops){
      const raw=data?.[stop.key];if(!raw||raw.code!==stop.code||raw.gtfsId&&raw.gtfsId!==stop.id||!Array.isArray(raw.stoptimesForPatterns))continue;
      const previous=archive[stop.id],patterns=new Map();
      // A short online refresh must not erase the rest of a previously downloaded day.
      for(const item of [...(!fullDay?previous?.raw.stoptimesForPatterns||[]:[]),...raw.stoptimesForPatterns]){
        const route=item.pattern?.route?.shortName;if(!route||!Array.isArray(item.stoptimes))continue;
        if(!patterns.has(route))patterns.set(route,{pattern:item.pattern,stoptimes:new Map()});
        const times=patterns.get(route).stoptimes;
        for(const st of item.stoptimes){
          if(!Number.isFinite(st.serviceDay)||!Number.isFinite(st.scheduledDeparture)||(st.serviceDay+st.scheduledDeparture)*1000<+now)continue;
          const alias=[...times.entries()].find(([,old])=>old.serviceDay===st.serviceDay&&old.scheduledDeparture===st.scheduledDeparture&&(old.headsign||"")===(st.headsign||"")&&
            (!old.trip?.gtfsId||!st.trip?.gtfsId||old.trip.gtfsId===st.trip.gtfsId)&&(old.stopSequence===undefined||st.stopSequence===undefined||old.stopSequence===st.stopSequence));
          const merged=alias?{...alias[1],...st}:st;if(alias)times.delete(alias[0]);
          const identity=JSON.stringify([merged.serviceDay,merged.scheduledDeparture,merged.trip?.gtfsId||null,merged.stopSequence??null,merged.headsign||""]);
          times.set(identity,merged);
        }
      }
      archive[stop.id]={raw:{...raw,stoptimesForPatterns:[...patterns.values()].map(p=>({pattern:p.pattern,stoptimes:[...p.stoptimes.values()]}))},saved:fullDay||!previous?+now:Math.min(previous.saved,+now),coverageDay:fullDay?dayKey(now):previous?.coverageDay||null};
    }
    const bounded=Object.fromEntries(Object.entries(archive).filter(([id])=>configuredIds.has(id)));
    fm.writeString(fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"buses-offline.json"),JSON.stringify({apiURL:SETTINGS.apiURL,stops:bounded}));
  }catch{} // Storage failure must not discard a usable online response.
}
async function loadBuses(fm,path,now,options={}) {
  if(typeof options==="boolean")options={detailed:options};
  const detailed=options.detailed!==false,stops=Array.isArray(options.stops)?options.stops:transitStops(detailed);
  const count=Math.max(1,Number(options.count)|| (detailed?SETTINGS.departureCount:SETTINGS.widgetDepartureCount));
  if(!stops.length)return {data:{},saved:Date.now(),detailed,source:busCacheKey({detailed,stops,count})};
  const source=busCacheKey({detailed,stops,count}),endpoint=SETTINGS.apiURL,folder=SETTINGS.storageFolder;
  let cached=null;
  try {const entry=JSON.parse(fm.readString(path)),age=+now-entry.saved;
    if(entry.source===source&&Number.isFinite(entry.saved)&&age>=0&&age<=OFFLINE_BUS_MAX_AGE_MS&&entry.data&&typeof entry.data==="object"){
      cached=entry;if(age<SETTINGS.busCacheSeconds*1000)return {...entry,stale:false};
    }
  }catch{}
  const archive=readBusArchive(fm,now),fallback=archivedBusData(archive,stops)||cached;
  try {
    if(options.cacheOnly)throw Error("Обновляю автобусы");
    const offlineCoverage=options.offlineCoverage===true&&stops.some(s=>archive[s.id]?.coverageDay!==dayKey(now));
    const result=JSON.parse(await refreshCachedSource(fm,endpoint,{query:busQuery(now,{detailed,stops,count,offlineCoverage})},!!fallback));
    if(!result.data || !Object.values(result.data).some(s=>s && Array.isArray(s.stoptimesForPatterns)))throw Error("Ошибка Peatus.ee");
    const entry={data:result.data,saved:Date.now(),detailed,source};
    const currentStops=transitStops(true);
    if(SETTINGS.apiURL===endpoint&&SETTINGS.storageFolder===folder&&stops.every(s=>currentStops.some(x=>x.key===s.key&&x.id===s.id&&x.code===s.code))){
      try {fm.writeString(path,JSON.stringify(entry));} catch {}
      saveBusArchive(fm,entry.data,stops,new Date(entry.saved),offlineCoverage);
    }
    return {...entry,stale:false};
  }catch(error){if(fallback)return {...fallback,detailed,source,stale:true};throw error;}
}
// Single-screen interface. All calendar/API text is escaped before rendering.
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function weatherData(input) {
  const obj=input && typeof input==="object"?input:{};
  const raw=typeof input==="string"?input:String(obj.weather||obj.condition||"");
  // Keep compatibility with the existing Shortcuts Text action.
  const match=raw.match(/([+−-]?\d+(?:[.,]\d+)?)\s*°\s*([CFС])?/i);
  let temp=Number.isFinite(obj.temperature)?obj.temperature:match?Number(match[1].replace("−","-").replace(",",".")):null;
  const unit=String(obj.unit||match?.[2]||"C").toUpperCase();
  if(temp!==null && unit==="F") temp=(temp-32)*5/9;
  const phrases={
    "isolated thunderstorms":"Местами грозы", "scattered thunderstorms":"Местами грозы",
    "strong thunderstorms":"Сильные грозы", "severe thunderstorms":"Сильные грозы",
    "thunderstorms":"Грозы", "thunderstorm":"Гроза", "thundershowers":"Ливень с грозой",
    "light rain showers":"Небольшие ливни", "heavy rain showers":"Сильные ливни",
    "scattered showers":"Местами ливни", "scattered snow showers":"Местами снег",
    "rain and snow":"Дождь со снегом", "rain/snow":"Дождь со снегом", "wintry mix":"Смешанные осадки",
    "freezing drizzle":"Переохлаждённая морось", "freezing rain":"Ледяной дождь",
    "light rain":"Небольшой дождь", "heavy rain":"Сильный дождь", "rain showers":"Ливни",
    "light snow":"Небольшой снег", "heavy snow":"Сильный снег", "snow showers":"Снежные заряды",
    "mostly cloudy":"Преимущественно облачно", "partly cloudy":"Переменная облачность",
    "mostly clear":"Преимущественно ясно", "mostly sunny":"Преимущественно солнечно",
    "partly sunny":"Переменная облачность", "clear skies":"Ясно",
    "blowing snow":"Позёмок", "blowing dust":"Пыльная буря", "sun showers":"Дождь при солнце",
    "sun flurries":"Снег при солнце", "light drizzle":"Небольшая морось",
    "heavy drizzle":"Сильная морось", "dense fog":"Густой туман", "patchy fog":"Местами туман",
    "overcast":"Пасмурно", "cloudy":"Облачно", "clear":"Ясно", "sunny":"Солнечно",
    "drizzle":"Морось", "rain":"Дождь", "showers":"Ливни", "snow":"Снег",
    "flurries":"Небольшой снег", "sleet":"Мокрый снег", "hail":"Град", "blizzard":"Метель",
    "foggy":"Туман", "fog":"Туман", "mist":"Дымка", "haze":"Мгла", "hazy":"Мгла",
    "smoky":"Дымка от дыма", "smoke":"Дымка от дыма", "breezy":"Лёгкий ветер", "windy":"Ветрено",
    "hot":"Жарко", "frigid":"Сильный мороз", "hurricane":"Ураган", "tropical storm":"Тропический шторм"
  };
  let condition="", icon="◌";
  const lower=raw.toLowerCase();
  for(const key of Object.keys(phrases).sort((a,b)=>b.length-a.length)) {
    if(new RegExp("\\b"+key+"\\b","i").test(lower)) {condition=phrases[key];break;}
  }
  if(!condition && /[а-яё]/i.test(raw)) {
    const ru=raw.replace(/тарту/gi,"").replace(/[+−-]?\d+(?:[.,]\d+)?\s*°\s*[CFС]?/gi,"")
      .replace(/^[\s,:;·—-]+|[\s,:;·—-]+$/g,"");
    if(ru && !/[a-z]/i.test(ru)) condition=ru[0].toUpperCase()+ru.slice(1);
  }
  if(/гроз/.test(condition)) icon="⛈";
  else if(/дожд|лив|морось/.test(condition)) icon="🌧";
  else if(/снег|метель|позём/.test(condition)) icon="❄";
  else if(/облач|пасмур/.test(condition)) icon="☁";
  else if(/ясно|солнечно|солнце/.test(condition)) icon="☀";
  else if(/туман|дым|мгла/.test(condition)) icon="🌫";
  else if(/ветер|ветрено/.test(condition)) icon="〰";
  return {temperature:temp===null?"—":(Math.round(temp)>0?"+":"")+Math.round(temp)+"°",
    condition:condition||(raw.trim()?"Описание погоды недоступно":"Погода не передана"), icon,
    missing:!raw.trim() && temp===null};
}
function missingWeather() {return {temperature:"—",condition:"Погода временно недоступна",icon:"◌",missing:true};}
function weatherQuery() {
  const primary=placeKeys().filter(k=>k==="home"||k==="uni");
  const point=[...primary.map(k=>SETTINGS.locationAnchors[k]),...primary.map(k=>SETTINGS.stops.find(s=>s.key===k)),...SETTINGS.extraPlaces,...SETTINGS.extraStops].find(validLocationAnchor);
  if(!point)throw Error("Не задано место для погоды.");
  return "https://api.open-meteo.com/v1/forecast?latitude="+point.latitude.toFixed(4)+"&longitude="+point.longitude.toFixed(4)+
    "&current=temperature_2m,apparent_temperature,weather_code,is_day&temperature_unit=celsius&timeformat=unixtime&forecast_days=1";
}
function openMeteoWeather(data,now) {
  const current=data?.current,observedAt=Number(current?.time)*1000;
  if(data?.error || !current || !Number.isFinite(current.temperature_2m) || !Number.isInteger(current.weather_code) ||
    !Number.isFinite(observedAt) || observedAt>+now+5*MINUTE || +now-observedAt>SETTINGS.widgetWeatherMaxHours*3600000 ||
    data.current_units?.temperature_2m!=="°C")throw Error("Некорректный или устаревший ответ погоды.");
  // Open-Meteo supplies WMO codes; descriptions never depend on the phone language.
  const descriptions={0:"Ясно",1:"Преимущественно ясно",2:"Переменная облачность",3:"Пасмурно",45:"Туман",48:"Туман с изморозью",
    51:"Небольшая морось",53:"Морось",55:"Сильная морось",56:"Небольшая ледяная морось",57:"Сильная ледяная морось",
    61:"Небольшой дождь",63:"Дождь",65:"Сильный дождь",66:"Небольшой ледяной дождь",67:"Сильный ледяной дождь",
    71:"Небольшой снег",73:"Снег",75:"Сильный снег",77:"Снежная крупа",80:"Небольшие ливни",81:"Ливни",82:"Сильные ливни",
    85:"Небольшие снежные ливни",86:"Сильные снежные ливни",95:"Гроза",96:"Гроза с градом",97:"Сильная гроза",99:"Гроза с сильным градом"};
  const code=current.weather_code,condition=descriptions[code]||"Описание погоды недоступно";
  const icon=code===0 || code===1?(current.is_day===0?"☾":"☀"):code===2?"⛅":code===3?"☁":[45,48].includes(code)?"🌫":
    [71,73,75,77,85,86].includes(code)?"❄":[95,96,97,99].includes(code)?"⛈":descriptions[code]?"🌧":"◌";
  const degrees=n=>(Math.round(n)>0?"+":"")+Math.round(n)+"°";
  return {weather:{temperature:degrees(current.temperature_2m),condition,icon,missing:false,
    feelsLike:Number.isFinite(current.apparent_temperature)?degrees(current.apparent_temperature):null},observedAt};
}
async function loadWeather(fm,path,now,cacheOnly=false) {
  const source=weatherQuery();let cached=null;
  try {
    const saved=JSON.parse(fm.readString(path)),age=+now-saved.saved,weatherAge=+now-saved.observedAt;
    if(saved.source===source && Number.isFinite(saved.saved) && age>=0 && age<=SETTINGS.widgetWeatherMaxHours*3600000 &&
      Number.isFinite(saved.observedAt) && weatherAge>=-5*MINUTE && weatherAge<=SETTINGS.widgetWeatherMaxHours*3600000 &&
      saved.weather?.missing===false && typeof saved.weather.temperature==="string" && typeof saved.weather.condition==="string" && typeof saved.weather.icon==="string") {
      cached=saved;
      // Retry near the next 15-minute weather timestamp instead of always waiting
      // another full cache interval when the first fetch was just before it.
      const refreshAt=Math.max(saved.saved+MINUTE,Math.min(saved.saved+SETTINGS.weatherCacheMinutes*MINUTE,saved.observedAt+15*MINUTE+30000));
      if(+now<refreshAt)return {...saved,stale:weatherAge>30*MINUTE};
    }
  } catch {}
  try {
    if(cacheOnly)throw Error("Обновляю погоду");
    const result=JSON.parse(await refreshCachedSource(fm,source,null,!!cached,SETTINGS.weatherTimeoutSeconds));
    const entry={...openMeteoWeather(result,new Date()),source,saved:Date.now()};
    try {if(weatherQuery()===source)fm.writeString(path,JSON.stringify(entry));}catch{}
    return {...entry,stale:Date.now()-entry.observedAt>30*MINUTE};
  } catch(error) {if(cached)return {...cached,stale:true};throw error;}
}
function packData(lessons) {
  const items=new Set(lessons.some(l=>!l.personal)?SETTINGS.alwaysBring:[]), unknown=[];
  for(const l of lessons.filter(l=>!l.personal)) {
    const list=SETTINGS.courseItems[courseKey(l)];
    if(Array.isArray(list)) list.forEach(x=>items.add(x));
    else unknown.push(l.title.replace(/\s+[A-Z]{2}\.\d{4}.*/,""));
  }
  return {items:[...items],unknown:[...new Set(unknown)]};
}
function stopPriorityRoutes(stop) {
  return Array.isArray(SETTINGS.stopPriorities?.[stop.key])?[...new Set(SETTINGS.stopPriorities[stop.key].map(x=>String(x).trim().toUpperCase()).filter(Boolean))]:[];
}
function departureIdentity(b) {return JSON.stringify([b.route,+b.date,b.tripId,b.stopSequence,b.headsign]);}
function mixedPriorityDepartures(preferred,other,priorityRouteCount,limit) {
  limit=Math.max(0,Math.floor(limit||0));if(!limit)return [];
  preferred=(preferred||[]).slice();other=(other||[]).slice();
  if(!priorityRouteCount || !preferred.length)return [...preferred,...other].sort((a,b)=>a.date-b.date).slice(0,limit);
  if(!other.length)return preferred.slice(0,limit);
  // Exact balance requested for the visible list: 1→1/0, 2→1/1, 3→2/1,
  // 4→2/2, 5→3/2, 6→3/3, 7→4/3, etc. Priority stays on top.
  const targetPreferred=Math.ceil(limit/2),targetOther=Math.floor(limit/2);
  const shownPreferred=preferred.slice(0,targetPreferred),shownOther=other.slice(0,targetOther);
  let shown=[...shownPreferred,...shownOther];
  if(shown.length<limit) {
    const used=new Set(shown.map(departureIdentity));
    const leftovers=[...preferred,...other].filter(b=>!used.has(departureIdentity(b))).sort((a,b)=>a.date-b.date);
    shown.push(...leftovers.slice(0,limit-shown.length));
  }
  return shown;
}
function orderedStopDepartures(stop, raw, now, limit=SETTINGS.departureCount,scheduledOnly=false) {
  const every=departures(raw,now,null,scheduledOnly).filter(b=>routeVisible(stop,b.route)), priorities=stopPriorityRoutes(stop);
  // Put one next departure of every selected priority route first, then the rest of priority buses.
  const firstPerRoute=priorities.map(route=>every.find(b=>b.route.toUpperCase()===route)).filter(Boolean).sort((a,b)=>a.date-b.date);
  const firstIds=new Set(firstPerRoute.map(departureIdentity));
  const remainingPreferred=every.filter(b=>priorities.includes(b.route.toUpperCase())&&!firstIds.has(departureIdentity(b))).sort((a,b)=>a.date-b.date);
  const preferred=[...firstPerRoute,...remainingPreferred];
  const other=every.filter(b=>!priorities.includes(b.route.toUpperCase())).sort((a,b)=>a.date-b.date);
  const shown=mixedPriorityDepartures(preferred,other,priorities.length,limit);
  return {priorities,preferred,other,all:shown,bus:(preferred[0]||every[0]||null)};
}
function nearestBuses(data,now,stops=transitStops(true),limit=SETTINGS.departureCount,stale=false) {
  return stops.map(s=>{
    try {
      const stop=data?.[s.key];
      if(!stop || stop.code!==s.code || stop.gtfsId&&stop.gtfsId!==s.id) throw Error("Нет данных");
      return {...s,...orderedStopDepartures(s,stop,now,limit,stale),error:false,stale};
    } catch {return {...s,bus:null,all:[],preferred:[],other:[],priorities:stopPriorityRoutes(s),error:true};}
  });
}
function shiftDay(date,days) {
  const p=wallParts(date), d=new Date(Date.UTC(p[0],p[1]-1,p[2]+days));
  return fromWall([d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate()]);
}
function weekBounds(date) {
  const p=wallParts(date), weekday=new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay();
  const start=shiftDay(date,-((weekday+6)%7));
  return [start,shiftDay(start,7)];
}
function isoWeekInfo(date) {
  const p=wallParts(date), d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
  const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);
  const year=d.getUTCFullYear(), first=new Date(Date.UTC(year,0,1));
  return {year,week:Math.ceil((((d-first)/DAY)+1)/7)};
}
function wallDayNumber(date) {const p=wallParts(date);return Math.floor(Date.UTC(p[0],p[1]-1,p[2])/DAY);}
function studyYearBounds(date) {
  const selected=weekBounds(date)[0];let year=wallParts(selected)[0];
  if(selected<weekBounds(fromWall([year,9,1]))[0])year--;
  return [weekBounds(fromWall([year,9,1]))[0],weekBounds(fromWall([year+1,9,1]))[0]];
}
function studyAnchorDate(text){
  const match=typeof text==="string"&&text.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)throw Error("Дата первой недели: ГГГГ-ММ-ДД.");
  const parts=match.slice(1).map(Number);if(parts[0]<2000||parts[0]>2100)throw Error("Проверь год первой недели.");
  const date=fromWall(parts);if(dayKey(date)!==text||dayKey(weekBounds(date)[0])!==text)throw Error("Укажи существующую дату понедельника первой недели.");return date;
}
function studyWeekBase(date){
  const [from,to]=studyYearBounds(date),custom=SETTINGS.studyWeekAnchor;
  if(custom?.source===SETTINGS.calendarURL){const start=studyAnchorDate(custom.start);if(start>=from&&start<to)return start;}
  // Verified EMÜ 2026/27: Sep 21 is week 4, Jan 11 is week 20, Feb 1 is week 23.
  // https://www.emu.ee/akadeemiline-kalender — do not infer academic weeks from sparse lessons.
  if(/^https:\/\/ois\.emu\.ee(?=\/|$)/i.test(SETTINGS.calendarURL)&&dayKey(from)==="2026-08-31")return from;
  return null;
}
function studyWeekOptions(calendarEvents,date) {
  // A fixed academic-year date window; never rebase numbering on the chosen week or events.
  const [from,to]=studyYearBounds(date),base=studyWeekBase(date),count=Math.round((wallDayNumber(to)-wallDayNumber(from))/7);
  return Array.from({length:count},(_,i)=>{const start=shiftDay(from,i*7),n=base?Math.round((wallDayNumber(start)-wallDayNumber(base))/7)+1:null;
    return {number:n>0?n:null,start,end:shiftDay(start,6)};});
}
function studyWeekNumber(weeks,date) {
  const key=dayKey(weekBounds(date)[0]),found=(weeks||[]).find(w=>dayKey(w.start)===key);
  return found?.number||null;
}
function studyWeekLabel(w) {
  const fmt=new Intl.DateTimeFormat("ru-RU",{timeZone:SETTINGS.timezone,day:"numeric",month:"short"});
  return `${w.number? w.number+" · ":""}${fmt.format(w.start)} — ${fmt.format(w.end)}`;
}
async function studyWeekSettings(date=new Date()){
  const base=studyWeekBase(date),[from,to]=studyYearBounds(date),profile=currentProfile();
  const choice=await setupChoice("Нумерация учебных недель",`Период ${dayKey(from)} — ${dayKey(shiftDay(to,-1))}. ${base?"Первая неделя с "+dayKey(base):"Начало отсчёта не задано"}. Выбор недели и отмена пар не меняют отсчёт.`,["Указать понедельник первой недели","Автоматически для EMÜ 2026/27"]);if(choice<0)return false;
  if(choice===1)profile.studyWeekAnchor=null;
  else {const values=await setupInput("Первая учебная неделя","Дата понедельника в формате ГГГГ-ММ-ДД. Настройка относится к текущему календарю и этому учебному году.",[{label:"Например: 2026-08-31",value:base?dayKey(base):dayKey(from)}]);if(!values)return false;
    const start=studyAnchorDate(values[0].trim());if(start<from||start>=to)throw Error("Дата должна относиться к выбранному учебному году.");profile.studyWeekAnchor={source:SETTINGS.calendarURL,start:dayKey(start)};}
  saveProfile(profile);return true;
}
// ═══ DOMAIN: lesson clock ═══
// All callers pass their current clock; cache timestamps never determine lesson status.
function createLessonClock({dayKey,minuteMilliseconds=60000,leadMinutes=30}) {
  function currentAndNext(lessons,now) {
    const sorted=lessons.filter(l=>!l.personal).slice().sort((a,b)=>a.start-b.start);
    return {current:sorted.filter(l=>l.start<=now && l.end>now),next:sorted.find(l=>l.start>now)||null};
  }
  function countdownLesson(lessons,now){
    const today=lessons.filter(l=>!l.personal&&dayKey(l.start)===dayKey(now)).sort((a,b)=>a.start-b.start);
    if(!today.length||now<+today[0].start-leadMinutes*minuteMilliseconds||+now>=Math.max(...today.map(l=>+l.end)))return null;
    if(lessons.some(l=>!l.personal&&l.start<=now&&l.end>now))return null;
    return today.find(l=>l.start>now)||null;
  }

  return Object.freeze({currentAndNext,countdownLesson});
}
const LessonClock=createLessonClock({dayKey,minuteMilliseconds:MINUTE,leadMinutes:30});
const {currentAndNext,countdownLesson}=LessonClock;

// ═══ ADAPTER: named places and GPS ═══
function distanceMeters(a,b) {
  const rad=Math.PI/180, lat=(b.latitude-a.latitude)*rad, lon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(lat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(lon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
function validLocationAnchor(value) {
  return !!value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && Math.abs(value.latitude)<=90 && Math.abs(value.longitude)<=180;
}
function locationZones() {
  const anchors=SETTINGS.locationAnchors||{},fallback=new Map(SETTINGS.stops.map(s=>[s.key,s]));
  const primary=["home","uni"].filter(key=>!SETTINGS.removedPlaces.includes(key)).map(key=>{const point=validLocationAnchor(anchors[key])?anchors[key]:fallback.get(key);return point?{key,latitude:point.latitude,longitude:point.longitude,radiusMeters:SETTINGS.locationRadii[key]}:null;}).filter(Boolean);
  return [...primary,...SETTINGS.extraPlaces.map(p=>({key:p.key,latitude:p.latitude,longitude:p.longitude,radiusMeters:p.radiusMeters}))];
}
function locationSourceKey() {return JSON.stringify(["zones-v3",locationZones().map(z=>[z.key,z.latitude,z.longitude,z.radiusMeters])]);}
function currentLocationFix() {
  if(INFLIGHT_LOCATION)return INFLIGHT_LOCATION;
  // Location has no cancellation API. Reuse a still-running native request after timeout.
  const request=Location.current();INFLIGHT_LOCATION=request;
  const clear=()=>{if(INFLIGHT_LOCATION===request)INFLIGHT_LOCATION=null;};request.then(clear,clear);
  return request;
}

function locationSide(point,previousSide=null) {
  if(!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
    Math.abs(point.latitude)>90 || Math.abs(point.longitude)>180 || !Number.isFinite(point.horizontalAccuracy) ||
    point.horizontalAccuracy<0 || point.horizontalAccuracy>400) return null;
  const zones=locationZones().map(z=>({...z,distance:distanceMeters(point,z)}));
  const close=zones.filter(z=>z.distance+point.horizontalAccuracy<=z.radiusMeters).sort((a,b)=>a.distance-b.distance);
  const previous=zones.find(z=>z.key===previousSide);
  // At most 50 m of hysteresis; a materially closer different place still wins.
  if(previous&&previous.distance+point.horizontalAccuracy<=previous.radiusMeters+50&&(!close[0]||close[0].key===previous.key||previous.distance-close[0].distance<=50))return previous.key;
  return close[0]?.key||null;
}
async function locate(fm,path,now) {
  // GPS was one of the biggest causes of slow widget starts. A recent zone is good enough,
  // so use it immediately and only ask iOS for a new fix after the cache expires.
  const source=locationSourceKey();let previousSide=null;
  try {
    if(fm.fileExists(path)) {
      const old=JSON.parse(fm.readString(path)),age=+now-old.saved;
      if(old.source===source&&Number.isFinite(old.saved)&&age>=0&&age<=15*MINUTE)previousSide=old.side;
      if(old.source===source && Number.isFinite(old.saved) && age>=0 && age<=SETTINGS.locationCacheMinutes*MINUTE && old.side && locationZones().some(z=>z.key===old.side))
        return {...old,cached:true};
    }
  } catch {}
  let timer;
  try {
    Location.setAccuracyToHundredMeters();
    const point=await Promise.race([currentLocationFix(),new Promise((_,reject)=>{
      timer=Timer.schedule(SETTINGS.locationTimeoutSeconds*1000,false,()=>reject(Error("GPS timeout")));
    })]);
    const result={side:locationSide(point,previousSide),located:Number.isFinite(point.horizontalAccuracy)&&point.horizontalAccuracy>=0&&point.horizontalAccuracy<=400,saved:Date.now(),cached:false,source};
    // The profile may contain user-pinned home/university coordinates, but the runtime cache
    // still stores only the resulting zone, never the phone's current coordinates.
    try {fm.writeString(path,JSON.stringify(result));} catch {}
    return result;
  } catch {
    try {
      const old=JSON.parse(fm.readString(path)),age=+now-old.saved;
      if(old.source===source && Number.isFinite(old.saved) && age>=0 && age<=24*60*MINUTE && (old.side===null||locationZones().some(z=>z.key===old.side)))
        return {...old,cached:true,stale:true};
    } catch {}
    return {side:null,saved:null,cached:false};
  } finally {if(timer)timer.invalidate();}
}
function eventIndex(fm,path) {
  if(!fm.fileExists(path)) return [];
  const ids=JSON.parse(fm.readString(path));
  if(!Array.isArray(ids) || ids.some(id=>typeof id!=="string")) throw Error("Повреждён список своих событий");
  return ids;
}
async function createPersonalEvent(fm,path) {
  const ids=eventIndex(fm,path); // Do not replace a damaged index.
  const event=await CalendarEvent.presentCreate();
  if(!event?.identifier) return null; // The native composer already saves; no second save().
  fm.writeString(path,JSON.stringify([...new Set([...ids,event.identifier])]));
  return event.startDate;
}
async function personalEvents(fm,path,from,to) {
  const ids=new Set(eventIndex(fm,path));
  if(!ids.size) return [];
  const events=await CalendarEvent.between(from,to);
  return events.filter(e=>ids.has(e.identifier)).map(e=>({uid:"personal:"+e.identifier,personal:true,
    title:e.title||"Событие",notes:e.notes||"",location:e.location||"",code:"",allDay:e.isAllDay,
    start:e.startDate,end:e.endDate})).sort((a,b)=>a.start-b.start);
}
function actionURL(action,params={}) {
  // Keep Scriptable's native URL. HTTPS universal links can fall back to Safari
  // and a 404, especially on bus rows with their own widget tap target.
  // Inside our WebView these links are intercepted and handled without a rerun.
  const base=URLScheme.forRunningScript();
  return base+(base.includes("?")?"&":"?")+"action="+encodeURIComponent(action)+Object.entries(params).map(([k,v])=>"&"+encodeURIComponent(k)+"="+encodeURIComponent(v)).join("");
}
function readPacking(fm,path) {
  if(!fm.fileExists(path)) return {};
  const data=JSON.parse(fm.readString(path));
  if(!data || typeof data!=="object" || Array.isArray(data) || Object.entries(data).some(([k,v])=>!/^\d{4}-\d{2}-\d{2}$/.test(k)||!Array.isArray(v)||v.some(x=>typeof x!=="string")))
    throw Error("Не удалось прочитать свои списки вещей");
  return data;
}
async function editPacking(fm,path,dateKey) {
  const data=readPacking(fm,path);
  const form=new Alert();form.title="Что взять с собой";
  form.message="Дата: ГГГГ-ММ-ДД. Свои вещи разделяй точкой с запятой. Пустая строка удалит свои записи за выбранный день. Список по предметам останется.";
  form.addTextField("Дата",dateKey);
  form.addTextField("Например: флешка; зарядка; документы",(data[dateKey]||[]).join("; "));
  form.addAction("Сохранить");form.addCancelAction("Отмена");
  if(await form.presentAlert()<0) return null;
  const key=form.textFieldValue(0).trim(),match=key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match || dayKey(fromWall(match.slice(1).map(Number)))!==key) throw Error("Укажи существующую дату в формате ГГГГ-ММ-ДД");
  const items=[...new Set(form.textFieldValue(1).split(/[;\n]/).map(x=>x.trim()).filter(Boolean))];
  if(items.length)data[key]=items;else delete data[key];
  fm.writeString(path,JSON.stringify(data));
  return key;
}
async function choosePackingDate() {
  const menu=new Alert();menu.title="Вещи на какой день?";
  menu.addAction("Сегодня");menu.addAction("Завтра");menu.addAction("Другая дата");menu.addCancelAction("Отмена");
  const choice=await menu.presentSheet();
  if(choice<0)return null;
  if(choice<2)return dayKey(shiftDay(new Date(),choice));
  const form=new Alert();form.title="Дата списка";form.addTextField("ГГГГ-ММ-ДД",dayKey(new Date()));
  form.addAction("Продолжить");form.addCancelAction("Отмена");
  if(await form.presentAlert()<0)return null;
  const key=form.textFieldValue(0).trim(),m=key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m || dayKey(fromWall(m.slice(1).map(Number)))!==key)throw Error("Неверная дата");
  return key;
}
async function chooseWeekDate(initial=new Date()) {
  const form=new Alert();form.title="Выбрать учебную неделю";
  form.message="Введи любую дату нужной недели. Откроется неделя с понедельника по воскресенье.";
  form.addTextField("ГГГГ-ММ-ДД",dayKey(initial));form.addAction("Открыть");form.addCancelAction("Отмена");
  if(await form.presentAlert()<0)return null;
  const key=form.textFieldValue(0).trim(),m=key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)throw Error("Укажи дату в формате ГГГГ-ММ-ДД.");
  const date=fromWall(m.slice(1).map(Number));if(dayKey(date)!==key)throw Error("Такой даты не существует.");
  return date;
}

function lessonEditURL(l){return actionURL("edit-lesson",{ref:lessonNoteRef(l)});}
function courseEditKey(l){return JSON.stringify(["course-edit",SETTINGS.calendarURL,courseKey(l)]);}
function lessonEditsPath(fm){return fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"lesson-edits.json");}
function readLessonEdits(fm,path=lessonEditsPath(fm)){
  if(!fm.fileExists(path))return {};
  const data=JSON.parse(fm.readString(path));
  if(!data||typeof data!=="object"||Array.isArray(data)||Object.values(data).some(v=>!v||typeof v!=="object"||Array.isArray(v)||
    (v.hidden!==undefined&&typeof v.hidden!=="boolean")||(v.title!==undefined&&(typeof v.title!=="string"||!v.title.trim()||v.title.length>200))||
    typeof v.label!=="string"||v.label.length>300||!["one","course"].includes(v.scope)||
    (v.startMinute!==undefined||v.endMinute!==undefined)&&(!Number.isInteger(v.startMinute)||!Number.isInteger(v.endMinute)||v.startMinute<0||v.endMinute>1440||v.endMinute<=v.startMinute)))
    throw Error("Свои правки расписания не удалось прочитать. Файл не перезаписан.");
  return data;
}
function applyLessonEdits(lessons,edits){
  return lessons.flatMap(source=>{
    if(!source.personal&&SETTINGS.excludedCourses.includes(courseKey(source)))return [];
    const l={...source},key=lessonNoteKey(l),common=l.personal?{}:edits[courseEditKey(l)]||{},one=edits[key]||{};
    if(common.hidden||one.hidden)return [];
    l.originalStart=l.originalStart??+l.start;l.originalEnd=l.originalEnd??+l.end;l.originalCourseKey=l.originalCourseKey||courseKey(l);
    delete l.displayTitle;
    if(common.title||one.title)l.displayTitle=one.title||common.title;
    l.start=new Date(l.originalStart);l.end=new Date(l.originalEnd);
    if(one.startMinute!==undefined){const p=wallParts(l.start);l.start=fromWall([p[0],p[1],p[2],Math.floor(one.startMinute/60),one.startMinute%60]);l.end=fromWall([p[0],p[1],p[2],Math.floor(one.endMinute/60),one.endMinute%60]);}
    l.locallyEdited=Object.keys(common).length>0||Object.keys(one).length>0;return [l];
  }).sort((a,b)=>a.start-b.start);
}
function refreshEditedModel(model,fm){
  const edits=readLessonEdits(fm);
  model.upcoming=applyLessonEdits(model.rawUpcoming||model.upcoming||[],edits);
  model.weekEvents=applyLessonEdits(model.rawWeekEvents||model.weekEvents||[],edits);
  const [from,to]=dayBounds(model.now),all=[...model.upcoming,...model.weekEvents,...applyLessonEdits(model.personalUpcoming||[],edits)];
  model.lessons=[...new Map(all.filter(l=>l.start<to&&l.end>from).map(l=>[lessonNoteKey(l),l])).values()].sort((a,b)=>a.start-b.start);
}
function clockMinutes(text){const m=String(text).trim().match(/^(\d{1,2}):(\d{2})$/);if(!m||Number(m[1])>23||Number(m[2])>59)throw Error("Время в формате ЧЧ:ММ, например 12:15.");return Number(m[1])*60+Number(m[2]);}
async function editLesson(fm,lesson){
  const path=lessonEditsPath(fm);readLessonEdits(fm,path); // Never overwrite a damaged file.
  const n=await setupChoice(courseTitle(lesson),dayKey(lesson.start)+" · "+time(lesson.start)+"–"+time(lesson.end)+". Правки только в UniDay; исходный календарь не меняется.",[
    "Изменить название","Изменить время этого занятия","Скрыть занятие","Заметка","Сбросить правки этого занятия"]);if(n<0)return false;
  if(n===3)return editLessonNote(fm,fm.joinPath(profileFiles().dir,"lesson-notes.json"),lesson);
  let common=false;
  if((n===0||n===2)&&!lesson.personal){const i=await setupChoice("К каким занятиям?","Один раз или ко всему предмету, включая будущие занятия.",["Только это занятие","Все занятия предмета"]);if(i<0)return false;common=i===1;}
  const key=common?courseEditKey(lesson):lessonNoteKey(lesson);
  let patch={label:courseTitle(lesson)+(common?" · весь предмет":" · "+dayKey(new Date(lesson.originalStart??+lesson.start))+" "+time(new Date(lesson.originalStart??+lesson.start))),scope:common?"course":"one"};
  if(n===0){const v=await setupInput("Название","До 200 символов. Исходное название останется в календаре университета.",[{label:"Название",value:courseTitle(lesson)}]);if(!v)return false;const title=v[0].trim();if(!title||title.length>200)throw Error("Название: от 1 до 200 символов.");patch.title=title;}
  if(n===1){const v=await setupInput("Время занятия","В пределах этого дня. Часовой пояс: "+SETTINGS.timezone+".",[{label:"Начало",value:time(lesson.start)},{label:"Конец",value:time(lesson.end)}]);if(!v)return false;patch.startMinute=clockMinutes(v[0]);patch.endMinute=clockMinutes(v[1]);if(patch.endMinute<=patch.startMinute)throw Error("Конец должен быть позже начала в этот же день.");}
  if(n===2)patch.hidden=true;
  const data=readLessonEdits(fm,path);if(n===4)delete data[key];else data[key]={...(data[key]||{}),...patch};fm.writeString(path,JSON.stringify(data));return true;
}
async function restoreLessonEdits(){
  const {fm}=profileFiles(),path=lessonEditsPath(fm),data=readLessonEdits(fm,path),entries=Object.entries(data);
  if(!entries.length){await setupMessage("Своих правок нет","Зажми занятие на главном экране или нажми ⋯ рядом с его названием.");return false;}
  const n=await setupChoice("Свои правки расписания","Скрытые занятия и переименования можно отменить отдельно.",entries.map(([,v])=>(v.hidden?"Скрыто · ":"Изменено · ")+v.label));if(n<0)return false;
  const [key,v]=entries[n],i=await setupChoice(v.label,"Университетский календарь сохраняется без изменений.",v.hidden?["Вернуть показ занятия","Удалить все эти правки"]:["Удалить эти правки"]);if(i<0)return false;
  const fresh=readLessonEdits(fm,path);if(v.hidden&&i===0&&fresh[key]){delete fresh[key].hidden;if(!fresh[key].title&&fresh[key].startMinute===undefined)delete fresh[key];}else delete fresh[key];fm.writeString(path,JSON.stringify(fresh));return true;
}
function breakHTML(lessons,now,ok){
  if(!ok)return "";const events=lessons.filter(l=>!l.personal).map(l=>({start:+l.start,end:+l.end,day:dayKey(l.start),title:courseTitle(l)}));
  return `<div class="break-card" hidden data-timezone="${escapeHTML(SETTINGS.timezone)}" data-break-events="${escapeHTML(JSON.stringify(events))}"><b data-break-title></b><span data-break-count></span><small data-break-next></small></div>`;
}
function liveBreakUI(){
  const box=document.querySelector('[data-break-events]');if(!box)return;const events=JSON.parse(box.dataset.breakEvents);
  const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:box.dataset.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const tick=()=>{const now=Date.now(),parts=dateFormat.formatToParts(new Date(now)),day=['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
    const today=events.filter(l=>l.day===day).sort((a,b)=>a.start-b.start),active=today.some(l=>l.start<=now&&l.end>now),next=today.find(l=>l.start>now);
    box.hidden=active||!next||!today.length||now<today[0].start-30*60000||now>=Math.max(...today.map(l=>l.end));
    if(box.parentElement.matches('[data-section="countdown"]'))box.parentElement.hidden=box.hidden;
    if(box.hidden)return;const seconds=Math.max(0,Math.ceil((next.start-now)/1000)),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
    box.querySelector('[data-break-title]').textContent='До следующей пары';box.querySelector('[data-break-count]').textContent=[h,m,s].map(n=>String(n).padStart(2,'0')).join(':');box.querySelector('[data-break-next]').textContent=next.title;};
  tick();window.__uniBreakTimer=setInterval(tick,1000);
}
function liveLessonMenu(){
  for(const card of document.querySelectorAll('[data-edit-lesson]')){
    let x=0,y=0,fired=false;const stop=()=>{clearTimeout(window.__uniHoldTimer);window.__uniHoldTimer=null;};
    const fire=()=>{if(fired)return;fired=true;stop();window.location.assign(card.dataset.editLesson);};
    card.addEventListener('pointerdown',e=>{if(e.target.closest('a,button,input,select,summary'))return;stop();x=e.clientX;y=e.clientY;fired=false;window.__uniHoldTimer=setTimeout(fire,650);});
    card.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-x)+Math.abs(e.clientY-y)>12)stop();});
    card.addEventListener('pointerup',stop);card.addEventListener('pointercancel',stop);card.addEventListener('pointerleave',stop);
    card.addEventListener('contextmenu',e=>{if(e.target.closest('a,input,summary'))return;e.preventDefault();fire();});
  }
}
function liveSectionOrder(order){
  const main=document.querySelector('main');if(!main)return;
  const sections=[...main.children].filter(el=>el.hasAttribute('data-section'));
  const sorted=sections.slice().sort((a,b)=>{const rank=e=>{const i=order.indexOf(e.dataset.section);return i<0?999:i;};return rank(a)-rank(b);});
  const markers=sections.map(el=>{const marker=document.createComment('section');el.replaceWith(marker);return marker;});
  markers.forEach((marker,i)=>marker.replaceWith(sorted[i]));
}

function courseTitle(l) {return l.displayTitle||(l.personal?l.title:l.title.replace(/\s+[A-Z]{2}\.\d{4}.*/,""));}
function lessonRoom(l) {
  const raw=String(l?.location||"").trim();
  return raw?raw.split(/\s+[-–—]\s+/).pop().trim():"";
}
function lessonNoteKey(l) {return JSON.stringify([l.personal?"personal":SETTINGS.calendarURL,l.uid,l.originalStart??+l.start]);}
function courseNoteKey(l) {return l.personal?null:JSON.stringify(["course-note",SETTINGS.calendarURL,courseKey(l)]);}
function lessonNoteRef(l) {
  // Only an opaque reference and date go into the app link, never note text or calendar URL.
  let a=2166136261,b=5381;for(const c of lessonNoteKey(l)){const n=c.charCodeAt(0);a=Math.imul(a^n,16777619);b=Math.imul(b,33)^n;}
  return (a>>>0).toString(16).padStart(8,"0")+(b>>>0).toString(16).padStart(8,"0");
}
function lessonNoteURL(l) {return actionURL("edit-note",{date:dayKey(l.start),ref:lessonNoteRef(l)});}
function readLessonNotes(fm,path) {
  if(!fm.fileExists(path))return {};
  const data=JSON.parse(fm.readString(path));
  if(!data || typeof data!=="object" || Array.isArray(data) || Object.values(data).some(x=>typeof x!=="string"))throw Error("Свои заметки не удалось прочитать.");
  return data;
}
async function editLessonNote(fm,path,lesson) {
  const notes=readLessonNotes(fm,path),commonKey=courseNoteKey(lesson);
  let common=false;
  if(commonKey) {
    const scope=new Alert();scope.title="К каким занятиям относится заметка?";
    scope.message=courseTitle(lesson)+"\nОбщая заметка и заметка для отдельной пары сохраняются отдельно. Можно использовать обе.";
    scope.addAction("Только это занятие · "+dayKey(lesson.start)+" "+time(lesson.start));
    scope.addAction("Все занятия предмета");scope.addCancelAction("Отмена");
    const selected=await scope.presentSheet();if(selected<0)return false;common=selected===1;
  }
  const key=common?commonKey:lessonNoteKey(lesson),a=new Alert();
  a.title=common?"Заметка для всех занятий":"Заметка для этого занятия";
  a.message=courseTitle(lesson)+"\n"+(common?"Будет видна у всех занятий этого предмета в твоём расписании.":dayKey(lesson.start)+" · "+time(lesson.start))+"\nПустое поле удалит только выбранную заметку. Текст из расписания останется.";
  a.addTextField("Твоя заметка",notes[key]||"");a.addAction("Сохранить");a.addCancelAction("Отмена");
  if(await a.presentAlert()<0)return false;
  // Keep the old occurrence keys; shared notes add a separate key in the same file.
  // Re-read on save so another editor's unrelated notes are not overwritten.
  const latest=readLessonNotes(fm,path),value=a.textFieldValue(0).trim();
  if(value)latest[key]=value;else delete latest[key];
  fm.writeString(path,JSON.stringify(latest));return true;
}
function busTripSelection(stop,bus) {
  if(!bus?.tripId || !Number.isInteger(bus.serviceDay) || !Number.isInteger(bus.stopSequence))return null;
  return {trip:bus.tripId,day:bus.serviceDay,stop:stop.id,seq:bus.stopSequence};
}
function busTripURL(selection) {
  return selection?actionURL("bus-trip",{trip:selection.trip,day:String(selection.day),stop:selection.stop,seq:String(selection.seq)}):"";
}
function parseBusTripSelection(params) {
  const trip=String(params.trip||""),stop=String(params.stop||""),day=Number(params.day),seq=Number(params.seq);
  if(!trip || trip.length>512 || /[\u0000-\u001f]/.test(trip) || !transitStops().some(s=>s.id===stop) ||
    !/^\d+$/.test(String(params.day||"")) || !Number.isSafeInteger(day) || day<946684800 || day>4102444800 ||
    !/^\d+$/.test(String(params.seq??"")) || !Number.isSafeInteger(seq) || seq<0 || seq>100000)
    throw Error("Ссылка на рейс устарела или остановка больше не выбрана. Открой автобус из списка заново.");
  return {trip,day,stop,seq};
}
function busTripQuery(selection) {
  const serviceDate=dayKey(new Date(selection.day*1000)).replace(/-/g,"");
  return `{ trip(id:${JSON.stringify(selection.trip)}) { gtfsId tripHeadsign route { shortName }
    stoptimesForDate(serviceDate:${JSON.stringify(serviceDate)}) { stop { gtfsId name code desc } stopSequence serviceDay
      scheduledArrival realtimeArrival scheduledDeparture realtimeDeparture realtime realtimeState } } }`;
}
async function loadBusTrip(fm,path,selection,now,force=false) {
  const source=JSON.stringify([SETTINGS.apiURL,selection.trip,selection.day]);
  let cached=null;try {
    const entry=JSON.parse(fm.readString(path)),age=+now-entry.saved;
    if(entry.source===source&&Number.isFinite(entry.saved)&&age>=0&&age<=OFFLINE_BUS_MAX_AGE_MS){
      const data=busTripData(entry.raw,selection);cached=entry;
      if(!force&&age<SETTINGS.tripCacheSeconds*1000)return {...data,saved:entry.saved,stale:false};
    }
  }catch{}
  try {
    const result=JSON.parse(await refreshCachedSource(fm,SETTINGS.apiURL,{query:busTripQuery(selection)},!!cached));
    if(result.errors?.length)throw Error("Времена остановок сейчас недоступны.");
    const data=busTripData(result.data?.trip,selection),saved=Date.now();
    try {fm.writeString(path,JSON.stringify({source,raw:result.data.trip,saved}));}catch{}
    return {...data,saved,stale:false};
  }catch(error){if(cached)return {...busTripData(cached.raw,selection,true),saved:cached.saved,stale:true};throw error;}
}
function renderBusTrip({selection,data=null,error="",loading=false,now=new Date()}) {
  const origin=data?.origin,departure=origin?.departure?compactTime(origin.departure,now):"—";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${screenThemeHead()}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Остановки рейса</title><style data-uniday-style>
  :root{color-scheme:light dark;--bg:#f3f3ed;--card:#fffefa;--ink:#243c32;--muted:#6b796e;--line:#dce5d9;--accent:#276848;--chip:#edf2e9}
  *{box-sizing:border-box}body{margin:0;font:.9375rem -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}main{max-width:540px;margin:auto;padding:max(24px,calc(env(safe-area-inset-top) + 16px)) 20px max(30px,env(safe-area-inset-bottom))}
  .eyebrow{font-size:0.625rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted)}h1{font-size:1.8125rem;margin:8px 0}h2{font-size:1.1875rem;margin:24px 0 12px}.muted{color:var(--muted);font-size:0.75rem;line-height:1.5}.actions{display:flex;gap:10px;margin:20px 0}.button{display:flex;align-items:center;justify-content:center;min-height:52px;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--accent);font-size:0.875rem;font-weight:650;text-decoration:none;flex:1}.origin{padding:18px;background:var(--accent);color:var(--bg);border-radius:20px}.origin b{display:block;font-size:1.1875rem;margin:6px 0}.origin small{opacity:.85}.list{border:1px solid var(--line);border-radius:20px;background:var(--card);padding:0 16px}.point{display:flex;gap:10px;padding:16px 0;align-items:flex-start}.point+.point{border-top:1px solid var(--line)}.number{flex:0 0 24px;height:24px;border-radius:50%;background:var(--chip);color:var(--accent);text-align:center;font-size:0.6875rem;line-height:24px}.name{flex:1;min-width:0;overflow-wrap:anywhere}.name b{font-size:0.875rem}.times{text-align:right;flex:0 0 97px;font-variant-numeric:tabular-nums}.times b{font-size:1.0625rem;display:block}.source{font-size:0.625rem;color:var(--muted);display:block;margin-top:4px}.message{padding:20px;background:var(--card);border-radius:16px;line-height:1.6}.cancelled{color:#a45040}.footer{margin-top:18px;text-align:center}.button:active{background:var(--chip)}
  @media(prefers-color-scheme:dark){:root{--bg:#151e19;--card:#1f2c23;--ink:#e1ebdd;--muted:#a1af9f;--line:#324236;--accent:#b2d5a0;--chip:#2a3a2d}}@media(max-width:350px){main{padding-left:13px;padding-right:13px}.list{padding:0 12px}.times{flex-basis:85px}.times b{font-size:0.9375rem}}
  
  ${screenTypographyCSS()}
  a.bus-row{color:inherit;text-decoration:none;touch-action:manipulation}a.bus-row:active{background:var(--chip)}a.bus-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  </style></head><body><main><div class="eyebrow">Остановки конкретного рейса</div><h1>${data?"Автобус № "+escapeHTML(data.route):"Маршрут автобуса"}</h1><div class="muted">${data?escapeHTML(data.headsign):"Времена прибытия на следующие остановки"}</div>
  <nav class="actions"><a class="button" href="${escapeHTML(actionURL("overview"))}">‹ К расписанию</a><a class="button" href="${escapeHTML(busTripURL(selection))}">Обновить времена</a></nav>
  ${loading?'<div class="message" role="status">Загружаю остановки и время прибытия…</div>':error?`<div class="message">${escapeHTML(error)}<br><span class="muted">Можно повторить запрос кнопкой выше.</span></div>`:data?`
  <div class="origin"><small>Выбранная остановка</small><b>${escapeHTML(origin.name)}</b><div>${escapeHTML(origin.direction)}</div><p>${origin.cancelled?"Рейс на выбранной остановке отменён":"Отправление · "+escapeHTML(departure)}</p><small>${origin.cancelled?"":origin.departureLive?"По данным онлайн":"По расписанию"}</small></div>
  <h2>Следующие остановки · ${data.following.length}</h2>${data.following.length?`<div class="list">${data.following.map((s,i)=>`<div class="point"><span class="number">${i+1}</span><div class="name"><b>${escapeHTML(s.name)}</b><div class="muted">${escapeHTML(s.direction)}</div></div><div class="times"><b class="${s.cancelled?"cancelled":""}">${s.cancelled?"Отменено":s.arrival?escapeHTML(compactTime(s.arrival,now)):"—"}</b><span class="source">${s.cancelled?"":!s.arrival?"Нет времени":s.arrivalLive?"онлайн":"расписание"}</span>${s.arrivalLive && s.delay?`<span class="source">${s.delay>0?"+":""}${s.delay} мин к расписанию</span>`:""}</div></div>`).join("")}</div>`:'<div class="message">Это конечная остановка рейса.</div>'}
  <div class="footer muted">Peatus.ee · данные на ${datedTime(new Date(data.saved),now)}${data.stale?" · сохранённое расписание":""}<br>«Онлайн» — прогноз, если перевозчик его передаёт.</div>`:""}</main></body></html>`;
}
function weekHTML(events,start,now,ok=true,openDate=null,annotations={},autoToday=false) {
  return Array.from({length:7},(_,i)=>{
    const date=shiftDay(start,i),end=shiftDay(date,1),today=dayKey(date)===dayKey(now);
    const list=events.filter(e=>e.start<end && e.end>date).sort((a,b)=>a.start-b.start);
    const label=new Intl.DateTimeFormat("ru-RU",{timeZone:SETTINGS.timezone,weekday:"long",day:"numeric",month:"short"}).format(date);
    return `<details class="week-day" data-day="${dayKey(date)}" data-auto-day="${autoToday && today?"1":"0"}" ${openDate && dayKey(date)===dayKey(openDate)?"open":""}><summary><span>${escapeHTML(label)}${today?" · сегодня":""}</span><span class="count">${ok?list.length:list.length?list.length+"+":"—"}</span></summary><div class="card">${list.length?list.map(l=>lessonCard(l,now,annotations)).join(""):`<p class="empty">${ok?"Нет занятий и событий":"Занятия недоступны"}</p>`}</div></details>`;
  }).join("");
}
function lessonCard(l,now,annotations={}) {
  const online=SETTINGS.onlineCourses.includes(courseKey(l));
  const active=l.start<=now && l.end>now;
  const title=courseTitle(l);
  const kind=l.title.match(/\b[A-Z]{2}\.\d{4}\s+(.*)$/)?.[1]||"";
  const notes=[l.notes,SETTINGS.courseHints[courseKey(l)]].filter(Boolean).join("\n\n");
  const own=annotations[lessonNoteKey(l)]||"";
  const commonKey=courseNoteKey(l),common=commonKey?annotations[commonKey]||"":"";
  const elapsed=Math.max(0,Math.floor((now-l.start)/MINUTE)),left=Math.max(0,Math.ceil((l.end-now)/MINUTE));
  return `<article class="lesson ${active?"active":""} ${l.personal?"personal":""}" data-edit-lesson="${escapeHTML(lessonEditURL(l))}" data-start="${+l.start}" data-end="${+l.end}" data-personal="${l.personal?"1":"0"}">
    <div class="lesson-time"><b>${l.allDay?"Весь":time(l.start)}</b><span>${l.allDay?"день":time(l.end)}</span></div>
    <div class="lesson-body"><span class="status-badge" data-status ${active?"":"hidden"}>СЕЙЧАС ИДЁТ</span><div class="meta">${l.personal?"Моё событие · ":""}${l.allDay?"Весь день":Math.round((l.end-l.start)/MINUTE)+" мин"}${online?" · Онлайн":""}</div>
      <div class="lesson-heading"><h3>${escapeHTML(title)}</h3><a class="lesson-menu" aria-label="Изменить занятие" href="${escapeHTML(lessonEditURL(l))}">⋯</a></div>${l.locallyEdited?'<small class="muted">Своя правка</small>':""}<p class="place">${escapeHTML(kind)}${l.location?" · "+escapeHTML(l.location):""}</p>
      <div class="lesson-progress" data-progress ${active?"":"hidden"}><progress aria-label="Ход занятия" max="${+l.end-+l.start}" value="${Math.min(+l.end-+l.start,Math.max(0,+now-+l.start))}"></progress><div class="progress-labels"><span data-elapsed>Прошло ${elapsed} мин</span><b data-left>Осталось ${left} мин</b></div></div>
      <details class="notes" ${own||common?"open":""}><summary>Заметки${own||common?" · есть своя":""} <span>+</span></summary>${notes?`<p><b>Из расписания и настроек</b>\n${escapeHTML(notes)}</p>`:""}${common?`<p><b>Все занятия предмета</b>\n${escapeHTML(common)}</p>`:""}${own?`<p><b>Только это занятие · ${dayKey(l.start)} ${time(l.start)}</b>\n${escapeHTML(own)}</p>`:""}<a class="note-edit" href="${escapeHTML(lessonNoteURL(l))}">${own||common?"Добавить или изменить заметку":"＋ Моя заметка"}</a></details></div>
  </article>`;
}
function liveLessonUI() {
  // Runs only while the expanded page is visible. No network requests or widget claims.
  for(const summary of document.querySelectorAll('.week-day > summary'))summary.addEventListener('click',()=>{summary.parentElement.dataset.autoDay='0';});
  const go=url=>{if(url)window.location.assign(url);};
  for(const button of document.querySelectorAll('button[data-nav-url]'))button.addEventListener('click',()=>go(button.dataset.navUrl));
  const weekPicker=document.querySelector('#study-week-picker');
  if(weekPicker)weekPicker.addEventListener('change',()=>{const url=weekPicker.value;weekPicker.blur();go(url);});
  const clock=document.querySelector('.clock[data-timezone]'),clockFormat=clock?new Intl.DateTimeFormat('ru-RU',{timeZone:clock.dataset.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}):null;
  function tick() {
    const now=Date.now();
    if(clock)clock.textContent=clockFormat.format(new Date(now));
    for(const card of document.querySelectorAll('.lesson[data-start]')) {
      const start=Number(card.dataset.start),end=Number(card.dataset.end),active=start<=now && now<end;
      card.classList.toggle('active',active);
      const badge=card.querySelector('[data-status]'),box=card.querySelector('[data-progress]');
      badge.hidden=!active;box.hidden=!active;
      if(active) {
        const progress=box.querySelector('progress');progress.value=Math.max(0,now-start);
        box.querySelector('[data-elapsed]').textContent='Прошло '+Math.floor((now-start)/60000)+' мин';
        box.querySelector('[data-left]').textContent='Осталось '+Math.ceil((end-now)/60000)+' мин';
      }
    }
    for(const day of document.querySelectorAll('.week-day[data-auto-day="1"]'))
      day.open=Array.from(day.querySelectorAll('.lesson[data-personal="0"]')).some(card=>Number(card.dataset.end)>now);
  }
  tick();window.__uniLessonTimer=setInterval(tick,1000);window.__uniVisibility=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',window.__uniVisibility);
}
function stopBoardURL(stop) {return actionURL("stop-board",{stop:stop.key});}
function liveBusUI() {
  if(!document.querySelector('[data-departure]'))return;
  const tick=()=>{
    const now=Date.now();
    for(const row of document.querySelectorAll('[data-departure]')){
      const departure=Number(row.dataset.departure);row.hidden=!Number.isFinite(departure)||departure<now;
      const label=row.querySelector('[data-bus-left]');if(row.hidden||!label)continue;
      const mins=Math.max(0,Math.ceil((departure-now)/60000));
      label.textContent=mins===0?'сейчас':mins>65?'через '+Math.floor(mins/60)+' ч'+(mins%60?' '+mins%60+' мин':''):'через '+mins+' мин';
    }
    for(const group of document.querySelectorAll('[data-bus-group]')){
      const count=[...group.querySelectorAll('[data-departure]')].filter(r=>!r.hidden).length;group.hidden=!count;
      const title=group.querySelector('.bus-group-title');if(title)title.textContent=group.dataset.busGroup+' · '+count;
    }
    for(const card of document.querySelectorAll('[data-bus-card]')){
      const empty=card.querySelector('[data-bus-empty]');if(empty)empty.hidden=[...card.querySelectorAll('[data-departure]')].some(r=>!r.hidden);
    }
  };
  tick();window.__uniBusTimer=setInterval(tick,5000);window.__uniBusVisibility=()=>{if(!document.hidden)tick();};document.addEventListener('visibilitychange',window.__uniBusVisibility);
}
function stopBoardQuery(stop,now) {
  const fields=`name code desc stoptimesForPatterns(startTime:${Math.floor(+now/1000)},numberOfDepartures:120,timeRange:86400,omitCanceled:true) {
    pattern { route { shortName } } stoptimes { scheduledDeparture realtimeDeparture realtime serviceDay realtimeState headsign stopSequence trip { gtfsId } }
  }`;
  return `{ board:stop(id:${JSON.stringify(stop.id)}) { ${fields} } }`;
}
async function loadStopBoard(fm,path,stop,now,force=false) {
  const source=JSON.stringify(["stop-board-v1",SETTINGS.apiURL,stop.id,stop.code,dayKey(now)]);
  let cached=readBusArchive(fm,now)[stop.id]||null;
  if(cached&&cached.raw.code!==stop.code)cached=null;
  try {
    const entry=JSON.parse(fm.readString(path)),age=+now-entry.saved,signature=JSON.parse(entry.source);
    if(signature.slice(0,4).join("\n")===["stop-board-v1",SETTINGS.apiURL,stop.id,stop.code].join("\n")&&Number.isFinite(entry.saved)&&age>=0&&age<=OFFLINE_BUS_MAX_AGE_MS&&entry.raw?.code===stop.code){
      if(!force&&entry.source===source&&age<SETTINGS.busCacheSeconds*1000)return {all:departures(entry.raw,now,null).filter(b=>routeVisible(stop,b.route)),saved:entry.saved,stale:false};
      if(!cached||entry.saved>cached.saved)cached=entry;
    }
  }catch{}
  try {
    const result=JSON.parse(await refreshCachedSource(fm,SETTINGS.apiURL,{query:stopBoardQuery(stop,now)},!!cached,10));
    const raw=result.data?.board;if(result.errors?.length||!raw||raw.code!==stop.code)throw Error("Не удалось загрузить табло остановки.");
    const saved=Date.now();try {fm.writeString(path,JSON.stringify({source,raw,saved}));}catch{}
    saveBusArchive(fm,{[stop.key]:raw},[stop],new Date(saved),true);
    return {all:departures(raw,now,null).filter(b=>routeVisible(stop,b.route)),saved,stale:false};
  }catch(error){if(cached)return {all:departures(cached.raw,now,null,true).filter(b=>routeVisible(stop,b.route)),saved:cached.saved,stale:true};throw error;}
}
function renderStopBoard({stop,data=null,error="",loading=false,now=new Date()}) {
  const priorities=stopPriorityRoutes(stop),all=(data?.all||[]).filter(b=>routeVisible(stop,b.route));
  const rows=all.map(b=>{
    const priority=priorities.includes(String(b.route).toUpperCase()),url=busTripURL(busTripSelection(stop,b)),tag=url?"a":"div",mins=Math.max(0,Math.ceil((b.date-now)/MINUTE));
    return `<${tag} class="bus-row"${url?` href="${escapeHTML(url)}"`:""} data-departure="${+b.date}"><span class="route ${priority?"route-priority":""}">${escapeHTML(b.route)}</span><div class="stop"><b>${priority?"★ ":""}${escapeHTML(b.headsign||"Автобус")}</b><small>${b.live?"По данным онлайн":"По расписанию"}${url?" · маршрут ›":""}</small></div><div class="arrival"><b>${escapeHTML(compactTime(b.date,now))}</b><small data-bus-left>${escapeHTML(relativeMinutesLabel(mins))}</small></div></${tag}>`;
  }).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${screenThemeHead()}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHTML(stop.name)}</title><style data-uniday-style>
  :root{color-scheme:light dark;--bg:#f3f3ed;--card:#fffefa;--ink:#243c32;--muted:#6b796e;--line:#dce5d9;--accent:#276848;--chip:#edf2e9}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:.9375rem -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:540px;margin:auto;padding:max(24px,calc(env(safe-area-inset-top) + 16px)) 20px max(30px,env(safe-area-inset-bottom))}.eyebrow{font-size:.625rem;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted)}h1{font-size:1.8rem;margin:7px 0 4px}.muted{color:var(--muted);font-size:.75rem;line-height:1.5}.actions{display:flex;gap:9px;margin:18px 0}.button{display:flex;align-items:center;justify-content:center;min-height:48px;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--accent);font-weight:700;text-decoration:none;flex:1}.card{border:1px solid var(--line);border-radius:20px;background:var(--card);padding:0 16px;overflow:hidden}.bus-row{display:flex;gap:11px;align-items:center;padding:15px 0;color:inherit;text-decoration:none}.bus-row+.bus-row{border-top:1px solid var(--line)}.route{width:38px;height:42px;border-radius:11px;background:var(--ink);color:var(--card);display:grid;place-items:center;font-size:1.15rem;font-weight:750;flex-shrink:0}.route-priority{background:var(--accent)}.stop{flex:1;min-width:0}.stop b{display:block;font-size:.9rem;overflow-wrap:anywhere}.stop small,.arrival small{display:block;color:var(--muted);font-size:.65rem;margin-top:4px}.arrival{text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0}.arrival>b{font-size:1.15rem}.arrival small{color:var(--accent)}.message{padding:18px;background:var(--card);border-radius:16px;line-height:1.5}.footer{text-align:center;margin-top:14px;color:var(--muted);font-size:.65rem}
  @media(prefers-color-scheme:dark){:root{--bg:#151e19;--card:#1f2c23;--ink:#e1ebdd;--muted:#a1af9f;--line:#324236;--accent:#b2d5a0;--chip:#2a3a2d}}${screenTypographyCSS()}</style></head><body><main>
  <div class="eyebrow">Полное табло остановки</div><h1>${escapeHTML(stop.name)}</h1><div class="muted">${escapeHTML(stop.direction||"")}${priorities.length?`<br>★ Приоритет: ${escapeHTML(priorities.join(", "))}`:""}</div>
  <nav class="actions"><a class="button" href="${escapeHTML(actionURL("overview"))}">‹ Главный экран</a><a class="button" href="${escapeHTML(stopBoardURL(stop))}">Обновить</a></nav>
  ${loading?'<div class="message">Загружаю все ближайшие автобусы…</div>':error?`<div class="message">${escapeHTML(error)}</div>`:all.length?`<div class="card" data-bus-card>${rows}<p class="message" data-bus-empty hidden>Показанные рейсы уже ушли. Для новых данных нужен интернет.</p></div>`:`<div class="message">${data?.stale?"Сохранённых будущих рейсов нет. Для обновления нужен интернет.":"В ближайшие 24 часа рейсов не найдено."}</div>`}
  ${data?`<div class="footer">${all.length} рейсов · данные на ${escapeHTML(datedTime(new Date(data.saved),now))}${data.stale?" · сохранённое расписание":""}</div>`:""}</main><script data-uniday-script>(${liveBusUI.toString()})();</script></body></html>`;
}

function settingsPageParent(page){
  if(page==="root")return "overview";
  if(page==="places"||page==="stops")return "transport";
  if(page==="medium-columns")return "widget-medium";
  if(page.startsWith("screen-block-"))return "screen-blocks";
  if(page==="screen-blocks")return "screen";
  if(page.startsWith("block-"))return "widget-"+page.split("-")[1];
  if(page.startsWith("widget-")&&page!=="widgets")return "widgets";
  if(page.startsWith("place-"))return "places";
  if(page.startsWith("stop-"))return "stops";
  return "root";
}
function renderSettingsPage(model){
  const p=SETTINGS,a=p.appearance,page=model.settingsPage||"root",families={small:"Small",medium:"Medium",large:"Large"};
  const link=(label,description,page,value="",icon="›")=>`<a class="setting-row" href="${escapeHTML(actionURL("settings-page",{page}))}"><span class="setting-copy"><b>${escapeHTML(label)}</b><small>${escapeHTML(description)}</small></span><span class="setting-value">${escapeHTML(value)} <i>${icon}</i></span></a>`;
  const action=(label,description,op,params={},value="")=>`<a class="setting-row" href="${escapeHTML(actionURL("setting-op",{op,...params}))}"><span class="setting-copy"><b>${escapeHTML(label)}</b><small>${escapeHTML(description)}</small></span><span class="setting-value">${escapeHTML(value)} <i>›</i></span></a>`;
  const group=(title,body)=>`<section class="setting-group"><h2>${escapeHTML(title)}</h2><div class="setting-list">${body}</div></section>`;
  const enabled=(family,key)=>(a.familySections[family]??a.widgetSections).includes(key),stopName=key=>[...p.stops,...p.extraStops].find(s=>s.key===key)?.name||"Не выбрана";
  let title="Настройки",intro="Все изменения сохраняются в профиле отдельно от кода.",body="";
  if(page==="root"){
    body=`<label class="settings-search">⌕ <input id="settings-search" type="search" placeholder="Найти настройку" autocomplete="off"></label>`+
      group("Основное",link("Учёба","Расписание, предметы, вещи, учебные недели","study","📚")+link("Транспорт","Места, остановки, рейсы, цепочки","transport","🚌"))+
      group("Внешний вид",link("Виджеты","Состав и оформление каждого размера","widgets","▦")+link("Подробный экран","Текст, блоки и карточки","screen","◫")+link("Цвета и обои","Палитры, HEX, прозрачный фон","colors","◉"))+
      group("Сервис",link("Данные и помощь","Импорт, сброс оформления, диагностика","data","⋯"));
  } else if(page==="study"){
    title="Учёба";intro="Расписание и личные записи можно менять независимо.";
    body=group("Расписание",action("Ссылка ÕIS","Обновить ссылку без потери заметок и вещей","calendar-link",{},"Изменить")+action("Учебные недели","Настроить начало учебного года","study-weeks")+action("Новые предметы","Добавить вещи и формат после смены семестра","new-courses"))+
      group("Предметы и вещи",action("Вещи по предметам","Выбрать предмет и настроить список","course-items")+action("Что брать всегда","Общий список на каждый учебный день","always-bring",{},p.alwaysBring.length+" вещей")+action("Категории вещей","Разнести вещи по понятным группам","packing-categories")+action("Скрытые и изменённые пары","Вернуть собственные правки","restore-lessons"))+
      group("Перенастройка",action("Мастер учёбы","Если хочешь заново выбрать календарь и предметы","setup-wizard"));
  } else if(page==="transport"){
    title="Транспорт";intro="Места определяют, какой набор остановок нужен виджету. Табло подробно показывает все сохранённые остановки.";
    body=group("Поездки",link("Места и адреса","Дом, универ и дополнительные места","places",placeKeys().length+" мест")+link("Остановки","Добавить, заменить или удалить отдельно","stops",(p.stops.length+p.extraStops.length)+" ост.")+action("Автопереключение по месту","Применяется только к виджету","toggle-auto",{},p.widgetNearbyStopFirst?"Вкл.":"Выкл."))+
      group("Автобусы",action("Рейсов в подробном экране","Сколько показывать на каждой остановке","departure-count",{},String(p.departureCount))+action("Рейсов на остановку в виджете","Дополнительные отправления при наличии места","widget-departure-count",{},String(p.widgetDepartureCount))+action("Обычный набор остановок","Используется, когда место не определено","general-stops",{},p.widgetStopKeys.length+" выбрано")+action("Скрытые номера","Скрыть или вернуть маршрут","hidden-routes")+action("Приоритетные номера","Важные маршруты первыми","priority-routes"))+
      group("Сложные маршруты",action("Цепочки поездок","Дом → универ → работа и другие схемы","travel-chains")+action("Поездки с пересадками","Настроить расчёт через Peatus","journey-planner")+action("Проверить выбор места","GPS, расстояния и выбранные остановки","location-diagnostic"));
  } else if(page==="places"){
    title="Места";intro="У каждого места свой адрес и набор остановок. Можно очистить одно место, не проходя мастер заново.";
    body=group("Основные места",["home","uni"].map(k=>link(placeName(k),p.removedPlaces.includes(k)?"Удалено — можно настроить заново":(p.locationAnchors[k]?.address||"Адрес не задан"),"place-"+k,p.removedPlaces.includes(k)?"Добавить":"Настроить")).join(""))+
      group("Другие места",p.extraPlaces.map(x=>link(x.name,x.address||"Адрес", "place-"+x.key,(x.stopKeys||[]).length+" ост.")).join("")+action("Добавить место","Например, работа или спортзал","add-place"));
  } else if(page.startsWith("place-")){
    const key=page.slice(6),extra=p.extraPlaces.find(x=>x.key===key),primary=key==="home"||key==="uni",removed=primary&&p.removedPlaces.includes(key),point=extra||p.locationAnchors[key],name=placeName(key);
    if(!primary&&!extra)return renderSettingsPage({...model,settingsPage:"places"});
    title=name;intro=removed?"Место удалено. Его можно добавить заново отдельно от других настроек.":"Изменения этого места не трогают остальные места, предметы и заметки.";
    body=removed?group("Настроить заново",action("Добавить «"+name+"»","Выбрать остановку и адрес","restore-place",{key})):
      group("Где это",action("Адрес или геопозиция","Поиск по улице и номеру дома","place-address",{key},point?.address||"Не задан")+action("Название места","Это имя будет в направлениях виджета","place-name",{key},name)+action("Радиус распознавания","Когда виджет считает, что ты рядом","place-radius",{key},String(primary?p.locationRadii[key]:extra.radiusMeters)+" м"))+
      group("Транспорт рядом",action("Остановки этого места","Включить, выключить и упорядочить","place-stops",{key},placeStops(p,key).map(stopName).join(", ")||"Нет")+action("Порядок остановок","Какая остановка важнее","place-order",{key}))+
      group("Очистка",(primary?action("Очистить адрес","Место останется, GPS пока не определит его","clear-place-address",{key}):"")+action("Удалить место","Адрес и привязки остановок убираются. Можно добавить снова.","delete-place",{key}));
  } else if(page==="stops"){
    title="Остановки";intro="Здесь можно удалить любую остановку. Основную затем легко выбрать заново для своего места.";
    body=group("Сохранённые",[...p.stops,...p.extraStops].map(s=>link(s.name,s.direction,"stop-"+s.key,s.key==="home"?placeName("home"):s.key==="uni"?placeName("uni"):"Доп.")).join("")+action("Добавить остановку","Поиск в выбранном городе и нужной стороне","add-stop"))+
      group("Пустые основные места",["home","uni"].filter(k=>!p.stops.some(s=>s.key===k)&&!p.removedPlaces.includes(k)).map(k=>action("Выбрать остановку · "+placeName(k),"Для этого места","restore-stop",{key})).join(""));
  } else if(page.startsWith("stop-")){
    const key=page.slice(5),s=[...p.stops,...p.extraStops].find(x=>x.key===key);if(!s)return renderSettingsPage({...model,settingsPage:"stops"});
    title=s.name;intro=s.direction;
    body=group("Остановка",action("Заменить остановку","Выбрать другую сторону или адрес","replace-stop",{key})+action("Приоритетные номера","Показывать первыми","stop-priorities",{key},(p.stopPriorities[key]||[]).join(", ")||"Нет")+action("Скрытые номера","Можно вернуть в любое время","stop-hidden",{key},(p.hiddenRoutes[key]||[]).join(", ")||"Нет"))+
      group("Удаление",action("Удалить остановку","Место и другие остановки сохранятся","delete-stop",{key}));
  } else if(page==="widgets"){
    title="Виджеты";intro="Одна и та же структура в трёх размерах: место, пара, следующая пара, автобус. У каждого размера свои детали.";
    body=group("Размеры",["small","medium","large"].map(f=>link(families[f],"Блоки, шрифты, остановки и предпросмотр","widget-"+f,"До "+a.widgetStopLimits[f]+" ост.")).join(""))+
      group("Общие настройки",action("Цвет погоды","Применяется ко всем размерам","weather-color",{},a.weatherTextColor||"Акцент")+action("Размер погоды","Текст температуры на виджетах","weather-scale",{},a.weatherScale+"%")+action("Свой текст","Дополнительные строки на виджете","custom-text")+link("Фон и палитры","Цвета, HEX, обои и прозрачность","colors"));
  } else if(page.startsWith("widget-")&&families[page.slice(7)]){
    const f=page.slice(7),sections=a.familySections[f]??a.widgetSections;
    title="Виджет "+families[f];intro="Отдельные параметры этого размера. Изменения сохраняются сразу; iOS обновит виджет по своему расписанию.";
    let preview="";try{const plan=widgetPlan({...model,family:f,storedWeather:model.weather&&!model.weather.missing?{weather:model.weather}:null});preview=`<div class="widget-preview" style="background:${escapeHTML(a.widgetBackground)};color:${escapeHTML(a.widgetText)}"><div class="preview-caption">${escapeHTML(families[f])} · ${a.widgetBackgroundMode==="wallpaper"?"фон под обои":"живые данные"}</div>${plan.groups.slice(0,7).map(g=>`<div class="preview-line" style="color:${escapeHTML(g.style.color||a.widgetText)}">${escapeHTML(g.rows.flat().map(c=>c.text).filter(Boolean).join(" · "))}</div>`).join("")}</div>`;}catch{preview="";}
    body=preview+group("Просмотр и автобусы",action("Открыть полный предпросмотр","Проверить в Scriptable, включая фон под обои","preview-family",{family:f})+action("Остановок показывать","Одинаковый предел независимо от свободного места","stop-limit",{family:f},String(a.widgetStopLimits[f])))+
      group("Состав виджета",WIDGET_SECTIONS.map(k=>`<div class="setting-split">${link(WIDGET_SECTION_NAMES[k],"Размеры, цвета, поля и строки","block-"+f+"-"+k,enabled(f,k)?"Показан":"Скрыт")}<a class="setting-toggle" aria-label="${enabled(f,k)?"Скрыть":"Показать"} ${escapeHTML(WIDGET_SECTION_NAMES[k])}" href="${escapeHTML(actionURL("setting-op",{op:"toggle-widget-block",family:f,section:k}))}">${enabled(f,k)?"☑":"☐"}</a></div>`).join(""))+group("Порядок блоков",action("Переместить блок в начало","Порядок на виджете "+families[f],"widget-order",{family:f})+(f==="medium"?link("Настроить две колонки","Ширина, промежуток и сторона каждого блока","medium-columns"):""))+
      group("Текст и фон",action("Размер всего виджета","Только для этого размера","family-scale",{family:f},a.familyScales[f]+"%")+action("Шрифт содержимого","Системный, округлый, моно или свой","body-font")+action("Шрифт заголовков","Общий для виджетов","category-font")+action("Размер текущей пары","Дополнительный масштаб","current-scale",{},a.currentScale+"%")+action("Размер следующей пары","Дополнительный масштаб","next-scale",{},a.nextScale+"%")+action("Размер автобусов","Дополнительный масштаб","bus-scale",{},a.busScale+"%")+action("Размер времени","Отдельно от текста пар","time-scale",{},a.timeScale+"%")+action("Размер подписей","Мелкие метки и источники","meta-scale",{},a.metaScale+"%")+action("Размер заголовков","Общий для виджетов","category-scale",{},a.categoryScale+"%")+action("Размер обычного текста","Общий для виджетов","body-scale",{},a.bodyScale+"%"))+
      group("Компоновка",(f==="medium"?action("Режим Medium","Полная ширина, колонки или список","medium-layout",{},a.mediumLayout):"")+(f==="large"?action("Плотность Large","Обычно, компактно или больше деталей","large-layout",{},a.largeLayout):"")+action("Прогресс текущей пары","Полоса пройденного времени","class-progress",{},a.widgetClassProgress?"Показан":"Скрыт")+action("Насыщенность текста","Обычный, жирный или очень жирный","widget-weight",{},a.widgetWeight)+action("Плотность","Компактно, обычно или свободно","widget-density",{},a.widgetDensity)+action("Вертикальное выравнивание","Вверх, по центру или вниз","widget-alignment",{},a.widgetAlignment)+action("Поля и расстояния","Отступы внутри виджета","widget-spacing")+link("Цвета и обои","Палитра, HEX, прозрачный фон","colors"));
  } else if(page==="medium-columns"){
    title="Две колонки Medium";intro="Распределение действует, когда выбран режим «Две колонки». У каждого блока своя сторона.";
    body=group("Размеры колонок",action("Левая колонка","Ширина от 30 до 70%","column-split",{},a.mediumColumnSplit+"%")+action("Промежуток","От 0 до 24 pt","column-gap",{},a.mediumColumnGap+" pt"))+
      group("Распределение блоков",WIDGET_SECTIONS.map(k=>action(WIDGET_SECTION_NAMES[k],"Нажми для переноса","column-lane",{section:k},a.mediumColumns[k]===0?"Слева":"Справа")).join(""));
  } else if(page.startsWith("block-")){
    const match=page.match(/^block-(small|medium|large)-([a-z]+)$/),f=match?.[1],key=match?.[2];if(!f||!WIDGET_SECTIONS.includes(key))return renderSettingsPage({...model,settingsPage:"widgets"});
    const b=blockStyle("widget",key,f);title=WIDGET_SECTION_NAMES[key];intro="Виджет "+families[f]+" · настройки только этого блока.";
    body=group("Геометрия",action("Текст блока","Масштаб относительно виджета","block-size",{family:f,section:key},b.scale+"%")+action("Ширина и высота","Высота 0 — автоматически","block-geometry",{family:f,section:key},b.width+"% / "+(b.height||"авто"))+action("Поля и расстояния","Внутренние отступы и строки","block-spacing",{family:f,section:key},b.padding+" / "+b.gap+" pt"))+
      group("Цвет и видимость",action("Цвет фона и текста","Ввести #RRGGBB, пусто — общая тема","block-colors",{family:f,section:key},b.color||"Тема")+action("Показать / скрыть","Только на виджете "+families[f],"toggle-widget-block",{family:f,section:key},enabled(f,key)?"Показан":"Скрыт")+action("Сбросить блок","Вернуть стандартные размеры и цвета","block-reset",{family:f,section:key}));
  } else if(page==="screen"){
    title="Подробный экран";intro="Экран расписания настраивается отдельно от виджетов.";
    body=group("Текст",action("Размер текста","Все разделы подробного экрана","screen-scale",{},a.screenScale+"%")+action("Шрифт","Встроенный или установленный на iPhone","screen-font",{},fontLabel(a,"screenFont","screenCustomFont"))+action("Размер времени","Рядом с парами и автобусами","screen-time",{},a.screenTimeScale+"%")+action("Размер заголовков","Названия разделов","screen-heading",{},a.screenHeadingScale+"%")+action("Насыщенность текста","От обычного до жирного","screen-weight",{},a.screenWeight||"Системная")+action("Плотность карточек","Компактные, обычные, свободные","screen-density",{},a.screenDensity)+action("Скругление карточек","Радиус углов","screen-radius",{},a.screenRadius+" pt"))+
      group("Состав",link("Блоки экрана","Показать, скрыть и изменить каждый блок","screen-blocks",a.screenSections.length+" показано")+link("Цвета экрана","Гаммы и HEX","colors"));
  } else if(page==="screen-blocks"){
    title="Блоки экрана";intro="Каждый блок можно скрыть и настроить отдельно. Нажми название для размеров и цвета.";
    body=group("Состав",SCREEN_SECTIONS.map(k=>`<div class="setting-split">${link(SCREEN_SECTION_NAMES[k],"Размер, фон, текст и поля","screen-block-"+k,a.screenSections.includes(k)?"Показан":"Скрыт")}<a class="setting-toggle" aria-label="${a.screenSections.includes(k)?"Скрыть":"Показать"} ${escapeHTML(SCREEN_SECTION_NAMES[k])}" href="${escapeHTML(actionURL("setting-op",{op:"toggle-screen-block",section:k}))}">${a.screenSections.includes(k)?"☑":"☐"}</a></div>`).join(""))+group("Порядок",action("Поменять порядок","Выбрать блок, который будет первым","screen-order"));
  } else if(page.startsWith("screen-block-")){
    const key=page.slice(13);if(!SCREEN_SECTIONS.includes(key))return renderSettingsPage({...model,settingsPage:"screen-blocks"});
    const b=blockStyle("screen",key);title=SCREEN_SECTION_NAMES[key];intro="Размеры и цвета только этого блока подробного экрана.";
    body=group("Геометрия",action("Размер текста","Масштаб внутри блока","screen-block-size",{section:key},b.scale+"%")+action("Ширина и высота","Высота 0 — по содержимому","screen-block-geometry",{section:key},b.width+"% / "+(b.height||"авто"))+action("Поля и расстояния","Внутренние отступы и строки","screen-block-spacing",{section:key},b.padding+" / "+b.gap+" px"))+
      group("Оформление",action("Цвет фона и текста","Свои HEX или общая тема","screen-block-colors",{section:key},b.color||"Тема")+action("Показать / скрыть","Только на подробном экране","toggle-screen-block",{section:key},a.screenSections.includes(key)?"Показан":"Скрыт")+action("Сбросить блок","Вернуть стандартные размеры и цвета","screen-block-reset",{section:key}));
  } else if(page==="colors"){
    title="Цвета и обои";intro="Цвета виджета и экрана независимы. Обои виджета не сбрасываются при смене цвета текста.";
    body=group("Виджеты",action("Готовая гамма","Согласованные цвета текста и фона","widget-palette")+action("Свои HEX-цвета","Фон, основной, вторичный, акцент","widget-hex")+action("Цвет погоды","Температура на всех размерах","weather-color",{},a.weatherTextColor||"Акцент")+action("Фон под обои","Выровнять снимок для прозрачного вида","widget-background",{},a.widgetBackgroundMode))+
      group("Подробный экран",action("Готовая гамма экрана","Светлые и тёмные темы","screen-palette")+action("Свои HEX-цвета экрана","Фон, карточки, текст и акцент","screen-hex")+action("Системные цвета","Следовать светлой и тёмной теме iPhone","screen-default"));
  } else if(page==="data"){
    title="Данные и помощь";intro="Настройки, заметки и вещи хранятся отдельно от кода. Сброс оформления не удаляет расписание.";
    body=group("Данные",action("Импорт настроек","Из файла профиля UniDay","import")+action("Сбросить только оформление","Вещи, заметки и остановки остаются","reset-appearance"))+
      group("Проверка",action("Диагностика запуска","Последние этапы открытия без личных данных","launch-diagnostics")+action("Проверить выбор места","GPS и выбранные остановки","location-diagnostic"));
  } else return renderSettingsPage({...model,settingsPage:"root"});
  const parent=settingsPageParent(page),back=parent==="overview"?actionURL("overview"):actionURL("settings-page",{page:parent});
  const colors=a.screenColors,css=colors?`:root{--bg:${colors.bg};--card:${colors.card};--ink:${colors.ink};--muted:${colors.muted};--accent:${colors.accent};--line:${colors.muted}44;--chip:${colors.card}}`:`:root{--bg:#f3f3ed;--card:#fffefa;--ink:#243c32;--muted:#6b796e;--accent:#276848;--line:#dce5d9;--chip:#edf2e9}@media(prefers-color-scheme:dark){:root{--bg:#151e19;--card:#1f2c23;--ink:#e1ebdd;--muted:#a1af9f;--accent:#b2d5a0;--line:#324236;--chip:#2a3a2d}}`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${screenThemeHead()}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHTML(title)} · UniDay</title><style data-uniday-style>${css}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:${16*a.screenScale/100}px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-text-size-adjust:100%}main{max-width:620px;margin:auto;padding:max(20px,calc(env(safe-area-inset-top) + 12px)) 18px max(36px,env(safe-area-inset-bottom))}.setting-back{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;color:var(--accent);font-weight:650}.settings-head{margin:6px 0 26px}.settings-head h1{font-size:2rem;line-height:1.1;letter-spacing:-.04em;margin:12px 0}.settings-head p{color:var(--muted);line-height:1.45;margin:0}.setting-group{margin:25px 0}.setting-group h2{font-size:.76rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 10px 4px}.setting-list{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden}.setting-row{min-height:64px;display:flex;align-items:center;gap:12px;padding:12px 15px;text-decoration:none;color:var(--ink);touch-action:manipulation}.setting-row+.setting-row,.setting-split+.setting-split{border-top:1px solid var(--line)}.setting-row:active,.setting-toggle:active{background:var(--chip)}.setting-copy{flex:1;min-width:0}.setting-copy b{display:block;font-size:.95rem;line-height:1.24}.setting-copy small{display:block;color:var(--muted);font-size:.73rem;line-height:1.35;margin-top:3px;overflow-wrap:anywhere}.setting-value{color:var(--muted);font-size:.76rem;text-align:right;max-width:36%;overflow-wrap:anywhere}.setting-value i{font-style:normal;color:var(--accent);font-size:1rem;margin-left:3px}.setting-split{display:flex;align-items:stretch}.setting-split .setting-row{flex:1;min-width:0}.setting-toggle{display:grid;place-items:center;width:52px;flex:none;color:var(--accent);text-decoration:none;font-size:1.35rem;border-left:1px solid var(--line)}.settings-search{display:flex;align-items:center;gap:9px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0 14px;min-height:48px;color:var(--muted)}.settings-search input{border:0;outline:0;background:transparent;color:var(--ink);font:inherit;width:100%;min-width:0}.widget-preview{border-radius:20px;padding:14px;margin:12px 0;border:1px solid var(--line);max-height:240px;overflow:hidden}.preview-caption{font-weight:750;font-size:.78rem;opacity:.65;margin-bottom:7px}.preview-line{font-size:.75rem;line-height:1.38;margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.setting-notice{padding:11px 13px;margin:12px 0;border-radius:12px;background:var(--chip);font-size:.8rem;color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}${screenBaseTypographyCSS()}</style></head><body><main><a class="setting-back" href="${escapeHTML(back)}">← ${parent==="overview"?"Мой день":"Назад"}</a><div class="settings-head"><h1>${escapeHTML(title)}</h1><p>${escapeHTML(intro)}</p></div>${model.eventNotice?`<div class="setting-notice" role="status">${escapeHTML(model.eventNotice)}</div>`:""}${body}</main><script data-uniday-script>(function(){const search=document.getElementById('settings-search');if(search)search.addEventListener('input',()=>{const q=search.value.toLocaleLowerCase();for(const r of document.querySelectorAll('.setting-row'))r.hidden=!r.textContent.toLocaleLowerCase().includes(q);for(const g of document.querySelectorAll('.setting-group'))g.hidden=![...g.querySelectorAll('.setting-row')].some(r=>!r.hidden);});})()</script></body></html>`;
}

function renderHTML({now,lessons,calendarOK,calendarWarning,weather,buses,cleanupWarning="",calendarSaved=null,busSaved=null,busStale=false,
  weekEvents=lessons,upcoming=weekEvents,weekStart=weekBounds(now)[0],personalWarning="",eventNotice="",addURL="",weatherSaved=null,weatherStale=false,
  packing={},packingChecks={},packURL="",packTodayURL="",packTomorrowURL="",packingWarning="",weekOpenDate=null,annotations={},notesWarning="",settingsURL="",studyWeeks=[],loadingOverview=false,newCourses=[],
  journeySelection=null,journeyData=null,journeyError="",journeyLoading=false,tripSelection=null,tripData=null,tripError="",tripLoading=false,stopBoardStop=null,stopBoardData=null,stopBoardError="",stopBoardLoading=false,settingsPage=null,position={side:null}}) {
  if(settingsPage&&settingsURL)return renderSettingsPage({now,lessons,upcoming,calendarOK,calendarWarning,weather,buses,position,settingsPage,settingsURL,eventNotice});
  if(journeySelection)return renderJourney({journeySelection,journeyData,journeyError,journeyLoading,now});
  if(tripSelection)return renderBusTrip({selection:tripSelection,data:tripData,error:tripError,loading:tripLoading,now});
  if(stopBoardStop)return renderStopBoard({stop:stopBoardStop,data:stopBoardData,error:stopBoardError,loading:stopBoardLoading,now});
  const pendingCourses=newCourses.filter(c=>!courseIsConfigured(c));
  const weekday=new Intl.DateTimeFormat("ru-RU",{timeZone:SETTINGS.timezone,weekday:"long"}).format(now);
  const dateLabel=new Intl.DateTimeFormat("ru-RU",{timeZone:SETTINGS.timezone,day:"numeric",month:"long"}).format(now);
  const remaining=lessons.filter(l=>l.end>now), past=lessons.filter(l=>l.end<=now), pack=packData(lessons);
  const openDay=weekOpenDate || (lessons.some(l=>!l.personal && l.end>now)?now:null);
  pack.items=[...new Set([...pack.items,...(packing[dayKey(now)]||[])])];
  const tomorrow=dayBounds(shiftDay(now,1))[0],afterTomorrow=shiftDay(tomorrow,1);
  const tomorrowPack=packData(upcoming.filter(l=>l.start<afterTomorrow && l.end>tomorrow));
  tomorrowPack.items=[...new Set([...tomorrowPack.items,...(packing[dayKey(tomorrow)]||[])])];
  const currentWeekStart=weekBounds(now)[0],selectedStudyWeek=studyWeekNumber(studyWeeks,weekStart);
  const weekOptions=(studyWeeks||[]).map(w=>`<option value="${escapeHTML(actionURL("week",{date:dayKey(w.start)}))}" ${dayKey(w.start)===dayKey(weekStart)?"selected":""}>${escapeHTML(studyWeekLabel(w))}</option>`).join("");
  const busRow=(s,b)=>{
    const minutes=Math.max(0,Math.ceil((b.date-now)/MINUTE)),url=busTripURL(busTripSelection(s,b)),tag=url?"a":"div",priority=(s.priorities||[]).includes(String(b.route).toUpperCase());
    return `<${tag} class="bus-row"${url?` href="${escapeHTML(url)}"`:""} data-departure="${+b.date}"><span class="route ${priority?"route-three":""}">${escapeHTML(b.route)}</span><div class="stop"><h3>${priority?"★ ":""}${escapeHTML(b.headsign||"Автобус")}</h3><span class="bus-source">${b.live?"По данным онлайн":"По расписанию"}${url?" · остановки ›":""}</span></div><div class="arrival"><b>${compactTime(b.date,now)}</b><span data-bus-left>${relativeMinutesLabel(minutes)}</span></div></${tag}>`;
  };
  const cards=uniqueStops(buses).map(s=>{
    const head=stopHeading(s);
    if(s.loading)return head+'<div class="card"><p class="empty">Загружаю рейсы…</p></div>';
    if(s.error)return head+'<div class="card"><p class="empty">Нет связи</p></div>';
    const shown=(s.all||[]).filter(b=>routeVisible(s,b.route));
    if(!shown.length)return head+'<div class="card"><p class="empty">'+((SETTINGS.hiddenRoutes[s.key]||[]).length||Array.isArray(SETTINGS.allowedRoutes[s.key])?'Нет видимых рейсов. Нажми ⋯, чтобы вернуть скрытые маршруты.':s.stale?'Нет сохранённых будущих рейсов. Для обновления нужен интернет.':'Нет рейсов в ближайшие 24 ч')+'</p></div>';
    const preferred=shown.filter(b=>(s.priorities||[]).includes(String(b.route).toUpperCase())),other=shown.filter(b=>!(s.priorities||[]).includes(String(b.route).toUpperCase()));
    const group=(label,list)=>list.length?'<div data-bus-group="'+escapeHTML(label)+'"><div class="bus-group-title">'+escapeHTML(label)+' · '+list.length+'</div>'+list.map(b=>busRow(s,b)).join('')+'</div>':'';
    const groups=group('★ Приоритетные',preferred)+group(preferred.length?'Другие':'Ближайшие',other);
    const details='<p class="place">'+escapeHTML(s.direction)+((s.priorities||[]).length?'<br>Приоритет: '+escapeHTML(s.priorities.join(', ')):'')+((SETTINGS.hiddenRoutes[s.key]||[]).length?'<br>Скрыто номеров: '+SETTINGS.hiddenRoutes[s.key].length:'')+(Array.isArray(SETTINGS.allowedRoutes[s.key])?'<br>Показывать только: '+escapeHTML(SETTINGS.allowedRoutes[s.key].join(', ')||'ничего'):'')+'</p>';
    return stopHeading(s,details)+'<div class="card bus-card" data-bus-card>'+groups+'<p class="empty" data-bus-empty hidden>Показанные рейсы уже ушли. Открой табло остановки для сохранённых следующих рейсов.</p></div>';
  }).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${screenThemeHead()}<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Мой день</title>
  <style data-uniday-style>
  :root{color-scheme:light dark;--bg:#f3f3ed;--card:#fffefa;--ink:#243c32;--muted:#6b796e;--line:#e2e7db;--accent:#276848;--chip:#edf2e9;--warm:#fff0ca}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%;font-size:0.9375rem}
  main{max-width:540px;margin:auto;padding:max(24px,calc(env(safe-area-inset-top) + 16px)) 20px max(30px,env(safe-area-inset-bottom))}header{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:20px}
  .eyebrow{font-size:0.625rem;font-weight:700;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:9px}h1{font-size:2rem;letter-spacing:-1.2px;margin:0;font-weight:750;text-transform:capitalize}
  .date{color:var(--muted);margin:5px 0 0}.clock{font-variant-numeric:tabular-nums;font-size:1.6875rem;font-weight:500;letter-spacing:-1px}.city{text-align:right;color:var(--muted);font-size:0.75rem;margin-top:5px}
  .weather{background:#244f3b;color:#fafcf4;border-radius:24px;padding:22px 24px;display:flex;align-items:center;gap:20px;min-height:132px;position:relative;overflow:hidden}
  .weather:after{content:"";position:absolute;width:170px;height:170px;border:1px solid #ffffff13;border-radius:50%;right:-58px;top:-65px;pointer-events:none}
  .weather-icon{font-size:2.5625rem;min-width:46px;text-align:center}.weather-temp{font-size:3rem;line-height:1;letter-spacing:-2px;font-weight:500}.weather-condition{font-size:0.9375rem;margin-top:8px;line-height:1.35}.weather-source{font-size:0.625rem;letter-spacing:.3px;color:#c2d3c2;margin-top:8px}.weather-source a{color:inherit}
  section{margin-top:26px}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}h2{font-size:1.1875rem;letter-spacing:-.4px;margin:0}.count{font-size:0.75rem;color:var(--muted);background:var(--chip);padding:5px 9px;border-radius:10px}
  .card{background:var(--card);border-radius:20px;padding:4px 17px;border:1px solid var(--line)}.lesson{display:flex;gap:15px;padding:16px 0}.lesson+.lesson{border-top:1px solid var(--line)}.lesson-time{flex:0 0 45px;font-size:0.9375rem;font-variant-numeric:tabular-nums}.lesson-time b,.lesson-time span{display:block}.lesson-time span{color:var(--muted);font-size:0.75rem;margin-top:5px}.lesson-body{min-width:0;flex:1}
  .meta{font-size:0.6875rem;color:var(--muted);margin-bottom:6px}.active .meta{color:var(--accent);font-weight:650}.live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:5px;vertical-align:1px}
  h3{font-size:0.9375rem;line-height:1.35;font-weight:650;margin:0;overflow-wrap:anywhere}.place{font-size:0.6875rem;line-height:1.5;color:var(--muted);margin:6px 0 0}.notes{margin-top:10px;font-size:0.75rem}.notes summary{display:flex;justify-content:space-between;color:var(--accent);min-height:28px;align-items:center;cursor:pointer}.notes p{white-space:pre-wrap;font-size:0.75rem;line-height:1.55;margin:6px 0;background:var(--chip);padding:11px;border-radius:10px}.notes[open] summary span{transform:rotate(45deg)}summary{list-style:none}summary::-webkit-details-marker{display:none}
  .past{margin-top:10px}.past>summary{padding:12px 4px;color:var(--muted);font-size:0.75rem;cursor:pointer}.past>summary:after{content:"＋";float:right}.past[open]>summary:after{content:"−"}.past .card{opacity:.8}
  .pack{display:flex;flex-wrap:wrap;gap:8px;padding:16px}.item{display:flex;align-items:center;gap:7px;font-size:0.75rem;line-height:1.35;border-radius:12px;padding:10px 11px;background:var(--chip);cursor:pointer}.item input{margin:0;accent-color:var(--accent);width:16px;height:16px;flex-shrink:0}.item:has(input:checked){opacity:.5}.item:has(input:checked) span{text-decoration:line-through}.item.important{background:var(--warm);font-weight:750;width:100%}.hint{width:100%;font-size:0.6875rem;color:var(--muted);line-height:1.55;margin:5px 0 0}.empty{padding:17px 0;font-size:0.8125rem;color:var(--muted);line-height:1.5}
  .bus-group-title{font-size:0.625rem;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);font-weight:750;padding:13px 0 5px}.bus-group-title+.bus-row{border-top:0}.bus-row{display:flex;align-items:center;gap:11px;padding:18px 0}.bus-row+.bus-row{border-top:1px solid var(--line)}.route{border-radius:11px;background:var(--ink);color:var(--card);font-size:1.25rem;font-weight:700;width:36px;height:42px;display:grid;place-items:center;flex-shrink:0}.stop{flex:1;min-width:0}.stop h3{font-size:0.875rem}.stop p{font-size:0.625rem;color:var(--muted);margin:4px 0}.bus-source{color:var(--muted);font-size:0.625rem}.arrival{text-align:right;font-variant-numeric:tabular-nums;max-width:115px}.arrival b{display:block;font-size:1.25rem;font-weight:650;letter-spacing:-.5px}.arrival span{display:block;font-size:0.6875rem;color:var(--accent);margin-top:4px}
  .warning{border-radius:12px;padding:12px;font-size:0.75rem;line-height:1.5;background:var(--warm);margin:12px 0}.footer{text-align:center;font-size:0.625rem;line-height:1.6;color:var(--muted);margin-top:22px}
  .note-edit{display:inline-block;padding:10px 0;color:var(--accent);font-weight:600;text-decoration:none}
  .settings-button{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:14px 16px;margin:0 0 16px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--accent);font-size:0.9375rem;font-weight:650;text-decoration:none;touch-action:manipulation}.settings-button .settings-arrow{margin-left:auto;font-size:1.4375rem;line-height:1}.settings-button:active{background:var(--chip)}.settings-button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  [hidden]{display:none!important}.lesson.active{background:var(--chip);border-left:4px solid var(--accent);border-radius:12px;padding:15px 10px;margin:8px -6px}.status-badge{display:inline-block;background:var(--accent);color:var(--bg);padding:5px 8px;border-radius:7px;font-size:0.625rem;font-weight:800;letter-spacing:.6px;margin-bottom:8px}.lesson-progress{margin-top:12px}.lesson-progress progress{appearance:none;-webkit-appearance:none;width:100%;height:7px;border:0;border-radius:8px;overflow:hidden;background:var(--line)}.lesson-progress progress::-webkit-progress-bar{background:var(--line)}.lesson-progress progress::-webkit-progress-value{background:var(--accent);border-radius:8px}.lesson-progress progress::-moz-progress-bar{background:var(--accent)}.progress-labels{display:flex;justify-content:space-between;gap:8px;font-size:0.625rem;color:var(--muted);margin-top:6px}.progress-labels b{color:var(--accent)}
  .week-day{margin:8px 0}.week-day>summary{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 2px;cursor:pointer;font-size:0.875rem;text-transform:capitalize}.week-day>summary:before{content:"+";color:var(--accent)}.week-day[open]>summary:before{content:"−"}.week-day>summary>span:first-child{flex:1}.stop-heading-link{display:block;color:inherit;text-decoration:none;border-radius:12px}.stop-heading-link:active{background:var(--chip)}.stop-open{font-size:.65rem;color:var(--accent);font-weight:650;white-space:nowrap}.add-event{display:block;text-align:center;text-decoration:none;background:var(--accent);color:var(--bg);border-radius:14px;padding:14px;font-size:0.875rem;font-weight:650;margin:14px 0}.personal h3{color:var(--accent)}.stop-heading{padding:16px 4px 10px}.route-three{background:var(--accent)}.week-range{font-size:0.75rem;color:var(--muted);margin:0 0 12px}.week-picker-box{position:relative;margin:10px 0 10px}.week-picker-label{display:block;font-size:0.6875rem;font-weight:750;color:var(--muted);margin:0 0 6px 3px;text-transform:uppercase;letter-spacing:.5px}.week-picker-shell{position:relative}.week-picker-shell:after{content:"⌄";position:absolute;right:15px;top:50%;transform:translateY(-54%);color:var(--accent);font-size:1.2rem;pointer-events:none}.week-picker{appearance:none;-webkit-appearance:none;width:100%;min-height:54px;border:1px solid var(--line);border-radius:15px;background:var(--card);color:var(--ink);padding:0 44px 0 15px;font:inherit;font-size:0.9375rem;font-weight:700;outline:none}.week-picker:focus{border-color:var(--accent)}.week-nav{display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:8px;margin:10px 0 14px}.week-nav button{appearance:none;-webkit-appearance:none;min-height:44px;border:1px solid var(--line);border-radius:13px;background:var(--card);color:var(--ink);font:inherit;font-size:0.75rem;font-weight:700;padding:8px 5px}.week-nav button.current{background:var(--accent);color:var(--bg);border-color:var(--accent)}.week-nav button:active{transform:scale(.98);background:var(--chip)}.week-nav button.current:active{background:var(--accent)}.extra-week>summary{padding:15px 2px;color:var(--accent);cursor:pointer}
  @media(prefers-color-scheme:dark){:root{--bg:#151e19;--card:#1f2c23;--ink:#e1ebdd;--muted:#a1af9f;--line:#324236;--accent:#b2d5a0;--chip:#2a3a2d;--warm:#463d23}.weather{background:#2c513c}}
  @media(max-width:350px){main{padding:max(18px,calc(env(safe-area-inset-top) + 16px)) 13px max(30px,env(safe-area-inset-bottom))}h1{font-size:1.8125rem}.bus-row{gap:8px}.arrival b{font-size:1.125rem}.lesson{gap:10px}}
  
  ${screenTypographyCSS()}
  a.bus-row{color:inherit;text-decoration:none;touch-action:manipulation}a.bus-row:active{background:var(--chip)}a.bus-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  </style></head><body><main>
  <header data-section="header"><div><div class="eyebrow">Мой день · ${escapeHTML(SETTINGS.universityLabel)}</div><h1>${escapeHTML(weekday)}</h1><p class="date">${escapeHTML(dateLabel)}</p></div><div><div class="clock" data-timezone="${escapeHTML(SETTINGS.timezone)}">${time(now)}</div><div class="city">${escapeHTML(SETTINGS.city)}</div></div></header>
  ${settingsURL?`<a class="settings-button" href="${escapeHTML(settingsURL)}"><span aria-hidden="true">⚙</span><span>Настройки</span><span class="settings-arrow" aria-hidden="true">›</span></a>`:""}
  <div class="weather" data-section="weather"><div class="weather-icon" aria-hidden="true">${escapeHTML(weather.icon)}</div><div><div class="weather-temp">${escapeHTML(weather.temperature)}</div><div class="weather-condition">${escapeHTML(weather.condition)}</div>${weather.feelsLike?`<div class="weather-source">Ощущается как ${escapeHTML(weather.feelsLike)}</div>`:""}<div class="weather-source"><a href="https://open-meteo.com/">Open-Meteo</a> · ${escapeHTML(placeKeys()[0]?placeName(placeKeys()[0]):"рядом с выбранной остановкой")}<br>${weather.missing?"Автозагрузка при следующем запуске":weatherStale?"Сохранённые данные":"Текущие условия"}${weatherSaved?" · "+datedTime(new Date(weatherSaved),now):""}</div></div></div>
  ${eventNotice?`<div class="warning">${escapeHTML(eventNotice)}</div>`:""}
  ${calendarWarning?`<div class="warning calendar-warning" role="status"><b>${loadingOverview?"Обновление расписания":"Расписание не обновлено"}</b><br>${escapeHTML(calendarWarning)}${!loadingOverview?`<br><a class="settings-button" style="margin:10px 0 0" href="${escapeHTML(actionURL("calendar-repair"))}">Ввести новую ссылку →</a><small>При временной ошибке сети можно открыть UniDay позже. Сохранённые занятия не удаляются.</small>`:""}</div>`:""}
  ${missingPlaceAddresses().length?`<div class="warning missing-places" role="status"><b>Где находятся ${escapeHTML(missingPlaceAddresses().map(k=>placeName(k)).join(" и "))}?</b><p>Укажи адреса для выбора остановок по близости и расчёта поездок. Можно найти адрес или сохранить текущее местоположение.</p><a class="settings-button" style="margin:0" href="${escapeHTML(actionURL("place-setup"))}">Указать адреса →</a></div>`:""}
  ${pendingCourses.length&&!loadingOverview?`<div class="warning new-courses" role="status"><b>Новые предметы · ${pendingCourses.length}</b><br>${escapeHTML(pendingCourses.slice(0,3).map(courseTitle).join(" · "))}${pendingCourses.length>3?"…":""}<p>Настроить вещи и формат занятий? Ответы для прежних предметов сохранены.</p><a class="settings-button" style="margin:0" href="${escapeHTML(actionURL("new-courses"))}">Настроить новые предметы →</a></div>`:""}
  ${personalWarning?`<div class="warning">${escapeHTML(personalWarning)}</div>`:""}
  ${notesWarning?`<div class="warning">${escapeHTML(notesWarning)}</div>`:""}
  <section data-section="countdown" hidden>${breakHTML(upcoming,now,calendarOK)}</section>
  <section data-section="today"><div class="section-title"><h2>Сегодня</h2><span class="count">${calendarOK?lessons.length+" в расписании":lessons.length?lessons.length+" своих событий":"Нет данных"}</span></div>
    <div class="card">${remaining.length?remaining.map(l=>lessonCard(l,now,annotations)).join(""):!calendarOK?`<div class="empty">${loadingOverview?"Загружаю расписание…":"Расписание временно недоступно."}</div>`:`<div class="empty">${past.length?"На сегодня всё. Можно выдохнуть.":"Сегодня без занятий."}</div>`}</div>
    ${past.length?`<details class="past"><summary>Уже прошли · ${past.length}</summary><div class="card">${past.map(l=>lessonCard(l,now,annotations)).join("")}</div></details>`:""}
  </section>
  <section id="week" data-section="week"><div class="section-title"><h2>${dayKey(weekStart)===dayKey(currentWeekStart)?"Текущая учебная неделя":"Учебная неделя"}</h2><span class="count">${selectedStudyWeek?"Неделя "+selectedStudyWeek:"Неделя · даты"}</span></div>
    <p class="week-range">Пн ${dayKey(weekStart)} — Вс ${dayKey(shiftDay(weekStart,6))}</p>
    ${!studyWeekBase(weekStart)?'<p class="muted">Номер учебной недели не задан. Настройки → Учёба → Нумерация учебных недель.</p>':""}
    <div class="week-picker-box"><label class="week-picker-label" for="study-week-picker">Выбрать неделю</label><div class="week-picker-shell"><select class="week-picker" id="study-week-picker">${weekOptions||`<option>Недели недоступны</option>`}</select></div></div>
    <div class="week-nav"><button type="button" data-nav-url="${escapeHTML(actionURL("week",{date:dayKey(shiftDay(weekStart,-7))}))}">← Пред.</button><button type="button" class="current" data-nav-url="${escapeHTML(actionURL("week",{date:dayKey(currentWeekStart)}))}">Текущая</button><button type="button" data-nav-url="${escapeHTML(actionURL("week",{date:dayKey(shiftDay(weekStart,7))}))}">След. →</button></div>
    ${addURL?`<a class="add-event" href="${escapeHTML(addURL)}">＋ Добавить событие</a>`:""}
    ${loadingOverview&&!calendarOK?'<div class="empty">Загружаю расписание…</div>':weekHTML(weekEvents,weekStart,now,calendarOK,openDay,annotations,!weekOpenDate)}
  </section>
  <section data-section="packing"><div class="section-title"><h2>Взять с собой</h2><span class="count">Сегодня · ${pack.items.length}</span></div>
  ${packingWarning?`<div class="warning">${escapeHTML(packingWarning)}</div>`:""}
  <div class="card pack">
    ${packingHTML(pack.items,dayKey(now),packingChecks)}
    ${!pack.items.length?`<div class="empty">${!calendarOK?"Нужно обновить расписание.":lessons.length?"Ничего специального.":"Сегодня можно налегке."}</div>`:""}
    ${pack.unknown.length?`<p class="hint">Уточнить, что взять: ${escapeHTML(pack.unknown.join("; "))}.</p>`:""}
  </div>
  <details class="extra-week"><summary>На завтра · ${tomorrowPack.items.length} ＋</summary><div class="card pack">
    ${packingHTML(tomorrowPack.items,dayKey(tomorrow),packingChecks)||'<p class="empty">Список пока пуст.</p>'}
    ${tomorrowPack.unknown.length?`<p class="hint">Уточнить, что взять: ${escapeHTML(tomorrowPack.unknown.join("; "))}.</p>`:""}
  </div></details>
  ${packURL||packTodayURL?`<a class="add-event" href="${escapeHTML(packURL||packTodayURL)}">✎ Изменить список вещей</a>`:""}
  </section>
  <section data-section="buses"><div class="section-title"><h2>Автобусы</h2><span class="count">до ${SETTINGS.departureCount} с каждой</span></div>${SETTINGS.journeyPlanner.enabled?`<a class="button" href="${escapeHTML(actionURL("journey"))}">Рассчитать поездку · пересадки</a>`:""}${cards}</section>
  ${cleanupWarning?`<div class="warning">${escapeHTML(cleanupWarning)}</div>`:""}
  <div class="footer" data-section="footer">Автобусы — ${busSaved?"на "+datedTime(new Date(busSaved),now):"не загружены"}${busStale?" · сохранённое расписание, без онлайн-прогноза":""}${calendarSaved?` · расписание — ${datedTime(new Date(calendarSaved),now)}`:""}.<br>Повторное открытие в течение 30 секунд использует тот же ответ автобусов.</div>
  </main><script data-uniday-script>(${liveSectionOrder.toString()})(${JSON.stringify(SETTINGS.appearance.screenSections)});(${liveLessonUI.toString()})();(${liveBusUI.toString()})();(${livePackingUI.toString()})();(${liveBreakUI.toString()})();(${liveLessonMenu.toString()})();(${liveStopMenu.toString()})();</script></body></html>`;
}

async function clearLegacyNotifications(fm,markerPath) {
  if(fm.fileExists(markerPath)) return;
  // Migration: delete only notifications scheduled by the earlier UniDay version.
  for(const [read,remove] of [["allPending","removePending"],["allDelivered","removeDelivered"]]) {
    const list=await Notification[read]();
    const ids=list.filter(n=>String(n.identifier).startsWith(PREFIX)).map(n=>n.identifier);
    if(ids.length) await Notification[remove](ids);
  }
  fm.writeString(markerPath,"done");
}

function readWidgetWeather(fm,path,now) {
  try {
    const value=JSON.parse(fm.readString(path));
    const age=+now-value.saved;
    if(Number.isFinite(value.saved) && age>=0 && age<=SETTINGS.widgetWeatherMaxHours*3600000 && value.weather &&
      typeof value.weather.temperature==="string" && typeof value.weather.condition==="string") return value;
  } catch {}
  return null;
}
function nextWidgetRefresh(now,lessons,buses) {
  const future=[+now+SETTINGS.widgetRefreshMinutes*MINUTE];
  const first=lessons.filter(l=>!l.personal&&dayKey(l.start)===dayKey(now)).sort((a,b)=>a.start-b.start)[0];
  if(first&&+first.start-30*MINUTE>+now)future.push(+first.start-30*MINUTE+1000);
  for(const l of lessons)for(const date of [l.start,l.end])if(date>now)future.push(+date+1000);
  for(const s of buses)for(const b of [...(s.preferred||[]),...(s.other||[]),...(s.all||[]),s.bus].filter(Boolean))if(b.date>now)future.push(+b.date+1000);
  // Earliest requested refresh only; iOS can defer it. Never claim an exact timer.
  return new Date(Math.min(...future));
}
function widgetFamilyKey() {
  const family=String(config.widgetFamily||"large");
  return ["small","medium","large"].includes(family)?family:"large";
}
function widgetBackgroundImage(family) {
  const meta=SETTINGS.appearance.wallpaperBackgrounds?.[family];
  if(!meta?.file)return null;
  try {
    const {fm,dir}=profileFiles(),path=fm.joinPath(dir,meta.file);
    return fm.fileExists(path)?fm.readImage(path):null;
  } catch {return null;}
}
function applyWidgetBackground(widget,family) {
  const mode=SETTINGS.appearance.widgetBackgroundMode;
  if(mode==="wallpaper") {
    const image=widgetBackgroundImage(family);
    if(image){widget.backgroundImage=image;return "wallpaper";}
  }
  const hex=String(SETTINGS.appearance.widgetBackground||"#f3f3ed").replace("#","");
  widget.backgroundColor=mode==="clear"?Color.clear():new Color(hex);
  return mode==="wallpaper"?"fallback":mode;
}
function widgetDimensions(family) {
  // Conservative point sizes; unknown devices use the smaller layout. No extraLarge on iPhone.
  let width=375;try {const s=Device.screenSize();width=Math.min(s.width,s.height);}catch{}
  const small=width<375?141:width<390?148:width<414?158:width<430?169:170;
  const large=width<375?311:width<390?324:width<414?354:376;
  return {width:family==="small"?small:width<390?321:width<414?338:364,height:family==="large"?large:small};
}
function widgetPlan({now,lessons,upcoming=lessons,calendarOK,calendarWarning,buses,storedWeather,position={side:null},busSaved=null,studyWeeks=[],family=widgetFamilyKey()}) {
  const a=SETTINGS.appearance,small=family==="small",large=family==="large",dashboard=family==="medium"&&a.mediumLayout==="dashboard",columns=family==="medium"&&a.mediumLayout==="columns",dim=widgetDimensions(family),padding=a.widgetPadding;
  const gap=a.widgetGap,groups=[],enabled=effectiveWidgetSections(family);
  const cell=(text,size=11,options={})=>({text,size,...options});
  const row=(...cells)=>cells;
  function add(section,priority,rows){if(enabled.includes(section)&&rows.length){const style=blockStyle("widget",section,family);if((small||large||dashboard)&&!a.widgetBlocks?.[family]?.[section]){if(!large)style.gap=0;if(section==="classes"||section==="buses"){style.padding=large?4:2;style.radius=8;}}rows.forEach(r=>r.forEach(c=>{c.size*=style.scale/100;c.role=c.role||(c.fixed?"meta":"");c.fixed=false;c.lines=style.lines;}));groups.push({section,priority,rows,style});}}
  const state=currentAndNext(upcoming,now),base=small||columns||dashboard?10:12;
  const placeCaption=position.side&&!position.stale?placeName(position.side):"Место?";
  const dateCaption=new Intl.DateTimeFormat("ru-RU",{timeZone:SETTINGS.timezone,weekday:"short",day:"numeric",month:"short"}).format(now);
  const integratedWeather=dashboard&&enabled.includes("header")&&enabled.includes("weather")&&!a.widgetBlocks?.medium?.weather;
  add("header",dashboard?98:40,[row(cell(dashboard?dateCaption+" · "+placeCaption:dateCaption,small?9:dashboard?11:13,{bold:true,kind:"category"}),
    ...(!small?[cell(integratedWeather?(storedWeather?storedWeather.weather.icon+" "+storedWeather.weather.temperature:"Погода —"):dashboard?"":placeCaption+" · "+SETTINGS.universityLabel,9,{color:integratedWeather?"weather":"muted",role:integratedWeather?"weather":"meta"})]:[]))]);
  if(!integratedWeather&&storedWeather)add("weather",99,[row(cell(storedWeather.weather.icon+" "+storedWeather.weather.temperature,small?10:13,{bold:true,color:"weather",role:"weather"}),
    ...(!small?[cell((storedWeather.stale?"копия · ":"")+storedWeather.weather.condition,10,{color:"muted",role:"weather"})]:[]))]);
  else if(!integratedWeather)add("weather",99,[row(cell("Погода недоступна",9,{color:"muted"}))]);
  const current=state.current[0];
  function classRows(label,l,role){
    if(!calendarOK)return [row(cell(label+" · нет расписания",base,{color:"muted"}))];
    if(!l)return [row(cell("На "+time(now)+" · пары нет",base,{color:"muted",role}))];
    const room=lessonRoom(l),shortLabel=label+(room?" · "+room:"");
    const timing=role==="current"&&!large?cell("",small?8:9,{date:l.end,color:"muted",role:"time"}):cell(role==="current"?time(l.start)+"–"+time(l.end):compactTime(l.start,now),small?8:9,{color:"muted",role:"time"});
    const labelRow=row(cell(shortLabel,small?8:9,{color:"accent",bold:true,kind:"category"}),timing);
    const rows=[labelRow,row(cell(courseTitle(l),base,{bold:true,role}))];
    if(role==="current"&&large)rows.push(row(cell("Конец "+time(l.end),9,{color:"muted",role:"time"}),cell("",11,{date:l.end,role:"time"})));
    if(large&&l.location&&l.location!==room)rows.push(row(cell(l.location,8,{color:"muted",role:"meta"})));
    return rows;
  }
  add("classes",100,classRows("СЕЙЧАС",current,"current"));
  if(current&&calendarOK){
    if((large||columns||dashboard)&&a.widgetClassProgress){
      add("classes",dashboard?95:columns?88:45,[row(cell("",dashboard?8:9,{progress:Math.min(1,Math.max(0,(now-current.start)/(current.end-current.start))),text:Math.round((now-current.start)/(current.end-current.start)*100)+"% · на "+time(now),color:"muted",role:"meta"}))]);
      if(large)add("classes",46,[row(cell("От начала",9,{color:"muted",role:"time"}),cell("",10,{date:current.start,timer:true,color:"muted",role:"time"}))]);
    }
  }
  add("classes",dashboard?96:90,classRows("ДАЛЕЕ",state.next,"next"));
  const countdown=countdownLesson(upcoming,now);
  if(countdown&&calendarOK)add("countdown",91,[row(cell("Старт "+time(countdown.start),9,{color:"muted",kind:"category"}),cell("",11,{date:countdown.start,timer:true,role:"time"}))]);
  const roomy=large&&a.largeLayout!=="compact";
  if(roomy&&calendarOK){const count=a.largeLayout==="expanded"?6:dim.width>=360?4:2;
    const later=upcoming.filter(l=>!l.personal&&l.start>now&&l!==state.next).slice(0,count);
    later.forEach((l,i)=>add("classes",22-i,[row(cell(compactTime(l.start,now)+(lessonRoom(l)?" · "+lessonRoom(l):""),9,{color:"accent",fixed:true}),cell(courseTitle(l),11))]));
  }
  const configuredStops=new Map(transitStops(true).map(s=>[s.key,s]));
  const leg=activeChainLeg(position),byKey=new Map(buses.filter(s=>{const configured=configuredStops.get(s.key);return configured&&s.id===configured.id&&s.code===configured.code;}).map(s=>[s.key,s]));
  const allKeys=uniqueStops(effectiveStopKeys(position).map(k=>byKey.get(k)).filter(Boolean)).map(s=>s.key),keys=allKeys.slice(0,a.widgetStopLimits[family]);
  if(!keys.length)add("buses",60,[row(cell(activeChain()&&position.side&&!position.stale?"Нет перехода или остановок для этого места":"Остановки не выбраны",10,{color:"muted"}))]);
  keys.forEach((key,index)=>{
    const s=byKey.get(key),list=mixedPriorityDepartures((s.preferred||[]).filter(b=>b.date>=now&&routeVisible(s,b.route)&&(!leg?.routes||leg.routes.includes(String(b.route).trim().toUpperCase()))),(s.other||[]).filter(b=>b.date>=now&&routeVisible(s,b.route)&&(!leg?.routes||leg.routes.includes(String(b.route).trim().toUpperCase()))),(s.priorities||[]).length,SETTINGS.widgetDepartureCount);
    const knownSide=SETTINGS.widgetNearbyStopFirst&&!position.stale&&position.side;
    const direction=leg?directionName(leg.from,leg.to):knownSide==="home"?directionName("home","uni"):knownSide==="uni"?directionName("uni","home"):dashboard?"Место? · "+s.name:s.name;
    const label=index===0&&allKeys.length>keys.length?direction+" · "+keys.length+" из "+allKeys.length:direction;
    if(dashboard){
      const busPriority=keys.length>1?97:94;
      if(s.error||!list.length){add("buses",busPriority,[row(cell(index?"№ — · "+s.name:label,9,{color:"muted",bold:true,kind:"category"})),row(cell(s.error?"Нет связи":s.stale?"Нет сохранённых рейсов":"Нет ближайших рейсов",9,{color:"muted"}))]);return;}
      const first=list[0];if(index){add("buses",busPriority,[row(cell("№ "+first.route+" · "+s.name,9,{bold:true,color:"accent",role:"bus"}),cell(compactTime(first.date,now),10,{bold:true,role:"time"}))]);return;}
      add("buses",busPriority,[row(cell(label,9,{color:"muted",bold:true,kind:"category"}),cell(compactTime(first.date,now),11,{bold:true,role:"time"})),row(cell((s.priorities?.includes(first.route.toUpperCase())?"★ ":"")+"№ "+first.route+" · "+s.name,10,{bold:true,color:"accent",role:"bus"}))]);
      return;
    }
    const title=row(cell(label,9,{color:"muted",bold:true,kind:"category"}));
    const platform=row(cell(s.name+" · "+s.direction,8,{color:"muted",role:"meta"}));
    if(s.error||!list.length){add("buses",80-index,[title,platform,row(cell(s.error?"Нет связи":s.stale?"Нет сохранённых рейсов":"Нет ближайших рейсов",10,{color:"muted"}))]);return;}
    const busRow=b=>row(cell((s.priorities?.includes(b.route.toUpperCase())?"★ ":"")+"№ "+b.route,base,{bold:true,color:"accent",role:"bus"}),
      cell(compactTime(b.date,now),base,{bold:true,role:"time"}));
    // Every selected stop competes fairly for space before extra departures do.
    add("buses",80-index,[title,platform,busRow(list[0])]);
    list.slice(1).forEach((b,i)=>add("buses",(roomy?36:18)-i-index,busRow(b).length?[busRow(b)]:[]));
  });
  const zone=position.side?placeName(position.side):null;
  const missingPlaces=missingPlaceAddresses();
  const positionText=missingPlaces.length?"Укажи адрес: "+missingPlaces.map(k=>placeName(k)).join(" / ")+" · в UniDay":!SETTINGS.widgetNearbyStopFirst?"Обычный набор остановок":position.stale?"Геопозиция устарела · обычный набор":zone?"Место: "+zone:position.located?"Вне сохранённых мест":"Геопозиция недоступна";
  add("location",12,[row(cell(positionText,8,{color:"muted",fixed:true}))]);
  SETTINGS.widgetCustomText.forEach((line,i)=>add("custom",25-i,[row(cell(line,base))]));
  add("footer",50,[row(cell((calendarWarning?(calendarOK?"⚠ Копия · ":"⚠ Нет расписания · "):"")+"данные на "+time(now)+(busSaved?" · бус "+time(new Date(busSaved)):"")+(buses.some(s=>s.stale)?" · расп. копия":""),8,{color:"muted",fixed:true}))]);
  groups.sort((x,y)=>enabled.indexOf(x.section)-enabled.indexOf(y.section));
  const height=g=>g.rows.reduce((sum,r)=>sum+Math.ceil(Math.max(...r.map(c=>widgetPoints(c.size,c.kind||"body",family,c.role)*(c.progress!==undefined?1:c.lines||1)))*1.35)+g.style.gap,0);
  const sectionHeight=(list,key)=>{const parts=list.filter(g=>g.section===key);if(!parts.length)return 0;const b=parts[0].style,content=parts.reduce((n,g)=>n+height(g),0);return Math.max(Math.min(b.height,dim.height-padding*2-18),content+b.padding*2);};
  const lane=g=>columns?a.mediumColumns[g.section]:0;
  const laneHeight=(list,n)=>{const selected=list.filter(g=>lane(g)===n),sections=[...new Set(selected.map(g=>g.section))];return sections.reduce((sum,key)=>sum+sectionHeight(selected,key),0)+Math.max(0,sections.length-1)*gap;};
  const total=list=>Math.max(laneHeight(list,0),laneHeight(list,1));
  let visible=groups.slice(),omitted=0;
  const budget=dim.height-padding*2-4;
  const omittedHeight=dashboard?0:14;
  while(total(visible)+(omitted?omittedHeight:0)>budget&&visible.length>1){
    const over=laneHeight(visible,1)>laneHeight(visible,0)?1:0;
    const candidates=visible.map((g,i)=>({g,i})).filter(x=>lane(x.g)===over);
    const lowest=candidates.reduce((best,x)=>x.g.priority<=best.g.priority?x:best).i;
    omitted+=visible[lowest].rows.length;visible.splice(lowest,1);
  }
  // An extreme custom block must still fit its native family. Preserve its main line.
  if(visible.length===1&&total(visible)+(omitted?omittedHeight:0)>budget){
    const g=visible[0],available=budget-omittedHeight;omitted++;
    while(g.rows.length>1&&height(g)>available)g.rows.shift();
    g.style.padding=Math.min(g.style.padding,Math.max(0,(available-height(g))/2));
    if(height(g)>available){g.style.gap=0;g.rows.forEach(r=>r.forEach(c=>{c.lines=1;const points=widgetPoints(c.size,c.kind||"body",family,c.role);c.size*=Math.min(1,(available/g.rows.length/1.35-1)/points);}));}
  }
  return {columns,dashboard,lane,sectionHeight:key=>sectionHeight(visible,key),groups:visible,omitted,stopCount:{selected:allKeys.length,limit:keys.length,visible:visible.filter(g=>g.section==="buses"&&g.priority>=79).length},gap,padding,family,dimensions:dim,estimatedHeight:total(visible)+(omitted?omittedHeight:0)+padding*2,budget:dim.height};
}
function buildLargeWidget(model) {
  const plan=widgetPlan(model),{family}=plan,a=SETTINGS.appearance,w=new ListWidget();
  const colors={ink:new Color(a.widgetText),muted:new Color(a.widgetMuted),accent:new Color(a.widgetAccent),weather:new Color(a.weatherTextColor||a.widgetAccent)};
  const background=applyWidgetBackground(w,family);
  w.setPadding(plan.padding,plan.padding,plan.padding,plan.padding);w.spacing=0;w.url=actionURL("overview");
  w.refreshAfterDate=nextWidgetRefresh(model.now,model.upcoming||model.lessons,model.buses);
  function draw(c,r,style,availableWidth){
    if(c.progress!==undefined){const bar=r.addStack(),width=Math.max(8,Math.min(110,(availableWidth*style.width/100-style.padding*2)*.28));bar.size=new Size(width,5);bar.cornerRadius=3;bar.backgroundColor=new Color(a.widgetMuted,.25);
      if(c.progress>0){const fill=bar.addStack();fill.size=new Size(width*c.progress,5);fill.backgroundColor=colors.accent;fill.addSpacer();}if(c.progress<1)bar.addSpacer(width*(1-c.progress));r.addSpacer(6);}
    const t=c.date?r.addDate(c.date):r.addText(String(c.text));
    if(c.date){if(c.timer)t.applyTimerStyle();else t.applyOffsetStyle();}
    t.font=widgetFont(c.size,!!c.bold,c.kind||"body",family,c.role||"",!!c.fixed);t.textColor=style.color?new Color(style.color):c.color==="weather"&&a.weatherTextColor?colors.weather:colors[c.color||"ink"];t.lineLimit=c.progress!==undefined?1:c.lines||1;t.minimumScaleFactor=.85;
  }
  if(a.widgetAlignment!=="top")w.addSpacer();
  const root=plan.columns?w.addStack():w;
  for(let lane=0;lane<(plan.columns?2:1);lane++){
  if(lane)root.addSpacer(a.mediumColumnGap);
  const container=plan.columns?root.addStack():root;if(plan.columns)container.layoutVertically();
  const contentWidth=plan.columns?(plan.dimensions.width-plan.padding*2-a.mediumColumnGap)*(lane===0?a.mediumColumnSplit:100-a.mediumColumnSplit)/100:plan.dimensions.width-plan.padding*2;
  if(plan.columns)container.size=new Size(contentWidth,0);
  [...new Set(plan.groups.filter(g=>plan.lane(g)===lane).map(g=>g.section))].forEach((section,si)=>{if(si)container.addSpacer(plan.gap);const parts=plan.groups.filter(g=>g.section===section),b=parts[0].style;
    const outer=container.addStack();const block=outer.addStack();block.layoutVertically();block.setPadding(b.padding,b.padding,b.padding,b.padding);block.cornerRadius=b.radius;
     block.size=new Size(contentWidth*b.width/100,plan.sectionHeight(section));if(b.background)block.backgroundColor=new Color(b.background);
     else if((plan.dashboard||family==="small"||family==="large")&&(section==="classes"||section==="buses"))block.backgroundColor=new Color(a.widgetAccent,section==="classes"?.08:.12);
    parts.forEach(g=>g.rows.forEach(cells=>{const r=block.addStack();r.centerAlignContent();cells.forEach((c,i)=>{if(i)r.addSpacer();draw(c,r,b,contentWidth);});block.addSpacer(b.gap);}));if(b.width<100)outer.addSpacer();
  });
  }
  if(a.widgetAlignment!=="bottom")w.addSpacer();
   if(plan.omitted&&!plan.dashboard){w.addSpacer(2);const t=w.addText("Ещё в UniDay ›");t.font=Font.systemFont(8);t.textColor=colors.muted;t.lineLimit=1;}
  if(!plan.groups.length){const t=w.addText("UniDay · блоки скрыты");t.font=Font.systemFont(12);t.textColor=colors.muted;}
  if(background==="fallback"&&!plan.omitted&&plan.estimatedHeight+13<plan.budget){const t=w.addText("Фон не найден");t.font=Font.systemFont(8);t.textColor=colors.muted;}
  return w;
}

async function presentInteractiveOverview(model,fm,personalPath,packingPath,universityEvents,refreshData=null) {
  const view=new WebView();
  logLaunch(fm,"overview-start");
  let busy=false,pending=Promise.resolve(),closed=false,queuedRefresh=null,interactions=0,hasDocument=false,presented=false;
  async function redraw(scroll=0){
    if(closed)return;const html=renderHTML(model);
    if(hasDocument){
      try{const ok=await webOperation(()=>view.evaluateJavaScript(overviewDOMUpdate(html,scroll)),"update");if(ok===true){logLaunch(fm,"content-updated");return;}}
      catch(error){logLaunch(fm,"update-failed");if(presented)throw error;}
      // A failed update must not erase the page currently displayed.
      if(presented)throw Error("Экран не подтвердил обновление. Сохранённая страница оставлена на месте.");
    }
    await webOperation(()=>view.loadHTML(html),"load",7000);hasDocument=true;logLaunch(fm,"html-loaded");
  }
  async function applyRefresh(result) {
    if(closed||result.signature!==overviewSignature())return;
    if(busy){queuedRefresh=result;return;}
    busy=true;
    try {
      // Scroll and expanded cards are preserved inside the single DOM transaction.
      const week=model.weekStart,open=model.weekOpenDate,notice=interactions&&!/^(Обновляю|Сохранённые данные)/.test(model.eventNotice||"")?model.eventNotice:"";
      Object.assign(model,result.model);universityEvents=result.events;
      model.loadingOverview=false;
      // Read user edits again: the network refresh may have started before a checkbox/note edit.
      const dir=fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder);
      try {model.packing=readPacking(fm,fm.joinPath(dir,"packing.json"));model.packingChecks=readPackingChecks(fm,fm.joinPath(dir,"packing-checks.json"));}catch{}
      try {model.annotations=readLessonNotes(fm,fm.joinPath(dir,"lesson-notes.json"));refreshEditedModel(model,fm);}catch{}
      if(interactions&&week)await selectWeek(week,open);
      if(notice)model.eventNotice=notice;
      if(!closed)await redraw(null);
    }catch(error){console.log("Экран обновления: "+String(error));}finally {busy=false;}
  }
  async function selectWeek(date,openDate=date) {
    const start=weekBounds(date)[0],end=shiftDay(start,7);
    const university=model.calendarOK?expandCalendar(universityEvents,start,end):[];
    let personal=[];
    try {personal=await personalEvents(fm,personalPath,start,end);model.personalWarning="";
      model.personalUpcoming=[...(model.personalUpcoming||model.rawWeekEvents||model.weekEvents||[]).filter(e=>e.personal&&!(e.start<end&&e.end>start)),...personal];}
    catch {model.personalWarning="Свои события не удалось прочитать. Проверь доступ Scriptable к Календарю.";}
    model.weekStart=start;model.weekOpenDate=openDate;model.rawWeekEvents=[...university,...personal].sort((a,b)=>a.start-b.start);model.weekEvents=applyLessonEdits(model.rawWeekEvents,readLessonEdits(fm));
    model.studyWeeks=studyWeekOptions(universityEvents,date);
  }
  // In Scriptable, consume known button URLs ourselves: no browser navigation or rerun.
  view.shouldAllowRequest=request=>{
    const url=String(request.url||"");
    if(url.includes("action=pack-check")){if(!closed){interactions++;handlePackingCheck(url,model,fm,view);}return false;}
    if(url==="https://open-meteo.com/"){if(!busy && !closed)Safari.open(url);return false;}
    const editMatches=url.includes("action=edit-lesson")?[...new Map([...(model.weekEvents||[]),...(model.lessons||[])].filter(l=>lessonEditURL(l)===url).map(l=>[lessonNoteKey(l),l])).values()]:[];
    const editedLesson=editMatches.length===1?editMatches[0]:null;
    const noteMatches=url.includes("action=edit-note")?[...new Map([...(model.weekEvents||[]),...(model.lessons||[])].filter(l=>lessonNoteURL(l)===url).map(l=>[lessonNoteKey(l),l])).values()]:[];
    const noteLesson=noteMatches.length===1?noteMatches[0]:null;
    const tripChoices=url.includes("action=bus-trip")?(model.buses||[]).flatMap(s=>[...(s.all||[]),s.bus].filter(Boolean).map(b=>busTripSelection(s,b))).filter(Boolean):[];
    if(model.stopBoardStop&&model.stopBoardData?.all)tripChoices.push(...model.stopBoardData.all.map(b=>busTripSelection(model.stopBoardStop,b)).filter(Boolean));
    if(model.tripSelection)tripChoices.push(model.tripSelection);
    const tripSelection=tripChoices.find(s=>busTripURL(s)===url);
    const routesStop=url.includes("action=stop-routes")?[...(model.buses||[]),model.stopBoardStop].filter(Boolean).find(s=>stopRoutesURL(s)===url):null;
    const stopBoardStop=url.includes("action=stop-board")?(model.buses||[]).find(s=>stopBoardURL(s)===url):null;
    const ownURL=url.startsWith(URLScheme.forRunningScript()),settingsAction=ownURL?settingURLValue(url,"action"):"";
    const action=url===actionURL("place-setup")?"place-setup":SETTINGS.journeyPlanner.enabled&&url===actionURL("journey")?"journey":url===actionURL("new-courses")?"new-courses":url===actionURL("calendar-repair")?"calendar-repair":routesStop?"stop-routes":editedLesson?"lesson-edit":tripSelection?"trip":stopBoardStop?"stop-board":settingsAction==="settings-page"?"settings-page":settingsAction==="setting-op"?"setting-op":url.includes("action=pick-week")?"pick-week":url.includes("action=week")?"week":(model.settingsPage||model.tripSelection||model.stopBoardStop||model.journeySelection) && url===actionURL("overview")?"overview":url===model.settingsURL?"settings":noteLesson?"note":url===model.addURL?"event":url===model.packURL?"pack":url===model.packTodayURL?"today":url===model.packTomorrowURL?"tomorrow":null;
    if(!action) return true; // Keep Scriptable/WebKit internal resource requests intact.
    if(!busy && !closed) {
      interactions++;
      busy=true;
      pending=Promise.resolve().then(async()=>{
        try {
          if(action==="place-setup"){
            const count=await setupMissingPlaceAddresses();model.eventNotice=count?"Адреса сохранены. Виджет применит их при следующем обновлении iOS.":"Адреса можно указать позже этой же кнопкой.";
          } else if(action==="journey"){
            const selection=await chooseJourney();if(!selection)return;
            model.journeySelection=selection;model.journeyLoading=true;model.journeyError="";model.journeyData=null;
            await redraw();
            try{model.journeyData=await loadJourney(selection);}catch(error){model.journeyError=String(error.message||error);}
            model.journeyLoading=false;
          } else if(action==="new-courses"){
            let count=0;try{count=await setupNewCourses(model.newCourses||[]);}finally{model.newCourses=(model.newCourses||[]).filter(c=>!courseIsConfigured(c));refreshEditedModel(model,fm);}
            model.eventNotice=count?"Настроено новых предметов: "+count+". Ответы сохранены.":"Настройку можно продолжить позже этой же кнопкой.";
          } else if(action==="stop-routes"){
            if(!await stopRoutesMenu(routesStop))return;
            try{await refreshBusFilters(model,fm);}catch{model.eventNotice="Фильтр сохранён, но свежие рейсы пока недоступны.";await redraw();return;}
            if(model.stopBoardStop)try{model.stopBoardData=await loadStopBoard(fm,fm.joinPath(profileFiles().dir,"stop-board-"+model.stopBoardStop.key+".json"),model.stopBoardStop,new Date());}catch{}
            model.eventNotice="Показ автобусов сохранён. Вернуть скрытые номера можно через ⋯ у остановки.";
          } else if(action==="lesson-edit"){
            if(!await editLesson(fm,editedLesson))return;refreshEditedModel(model,fm);model.annotations=readLessonNotes(fm,fm.joinPath(profileFiles().dir,"lesson-notes.json"));model.eventNotice="Свои изменения сохранены. Исходный календарь не изменён.";
          } else if(action==="trip") {
            const force=!!model.tripSelection;
            model.tripSelection=tripSelection;model.tripLoading=true;model.tripError="";model.tripData=null;
            await redraw();
            model.tripData=await loadBusTrip(fm,fm.joinPath(profileFiles().dir,"bus-trip.json"),tripSelection,new Date(),force);
            model.tripLoading=false;
          } else if(action==="stop-board") {
            const force=model.stopBoardStop?.key===stopBoardStop.key;
            model.stopBoardStop=stopBoardStop;model.stopBoardLoading=true;model.stopBoardError="";model.stopBoardData=null;
            model.tripSelection=null;model.tripData=null;model.tripError="";model.tripLoading=false;
            await redraw();
            try {model.stopBoardData=await loadStopBoard(fm,fm.joinPath(profileFiles().dir,"stop-board-"+stopBoardStop.key+".json"),stopBoardStop,new Date(),force);}
            catch(error){model.stopBoardError="Не удалось загрузить полное табло. "+String(error.message||error);}
            model.stopBoardLoading=false;
          } else if(action==="overview") {
            model.settingsPage=null;model.eventNotice="";
            model.journeySelection=null;model.journeyData=null;model.journeyError="";model.journeyLoading=false;
            model.tripSelection=null;model.tripData=null;model.tripError="";model.tripLoading=false;
            model.stopBoardStop=null;model.stopBoardData=null;model.stopBoardError="";model.stopBoardLoading=false;
          } else if(action==="settings-page") {
            model.settingsPage=settingURLValue(url,"page")||"root";model.eventNotice="";
          } else if(action==="setting-op") {
            const op=settingURLValue(url,"op"),params=Object.fromEntries(["key","family","section"].map(k=>[k,settingURLValue(url,k)]));
            const beforeData=profileDataSignature(),previousFolder=SETTINGS.storageFolder;
            if(!await performSettingOperation(op,params,model))return;
            if(beforeData!==profileDataSignature()||previousFolder!==SETTINGS.storageFolder){
              const refreshed=await main({skipSetup:true,returnModel:true});Object.assign(model,refreshed.model);universityEvents=refreshed.events;
            }
            const folder=profileFiles().dir;
            personalPath=fm.joinPath(folder,"personal-event-ids.json");packingPath=fm.joinPath(folder,"packing.json");
            refreshEditedModel(model,fm);model.studyWeeks=studyWeekOptions(universityEvents,model.weekStart||model.now);
            if(op==="delete-place")model.settingsPage="places";
            if(op==="delete-stop")model.settingsPage="stops";
            model.eventNotice="Сохранено.";
          } else if(action==="week") {
            const match=url.match(/[?&]date=([^&]+)/),key=match?decodeURIComponent(match[1]):"",m=key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if(!m)throw Error("Не удалось определить выбранную неделю.");
            const date=fromWall(m.slice(1).map(Number));if(dayKey(date)!==key)throw Error("Некорректная дата недели.");
            await selectWeek(date,null);model.eventNotice="";
          } else if(action==="pick-week") {
            const date=await chooseWeekDate(model.weekStart||model.now);if(!date)return;
            await selectWeek(date,date);model.eventNotice="Открыта неделя "+dayKey(model.weekStart)+" — "+dayKey(shiftDay(model.weekStart,6))+".";
          } else if(action==="calendar-repair") {
            const week=model.weekStart,open=model.weekOpenDate;if(!await replaceCalendarLink())return;
            const refreshed=await main({skipSetup:true,returnModel:true});Object.assign(model,refreshed.model);universityEvents=refreshed.events;model.loadingOverview=false;
            if(week)await selectWeek(week,open);model.eventNotice="Ссылка обновлена. Заметки, вещи и свои правки сохранены.";
          } else if(action==="settings") {
            model.settingsPage="root";model.eventNotice="";
          } else if(action==="note") {
            const path=fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"lesson-notes.json");
            if(!await editLessonNote(fm,path,noteLesson))return;
            model.annotations=readLessonNotes(fm,path);model.notesWarning="";model.weekOpenDate=noteLesson.start;
            model.eventNotice="Своя заметка сохранена. Текст из расписания не изменён.";
          } else if(action==="event") {
            const date=await createPersonalEvent(fm,personalPath);
            if(!date)return;
            await selectWeek(date,date);
            const [todayStart,todayEnd]=dayBounds(model.now);
            const todayPersonal=await personalEvents(fm,personalPath,todayStart,todayEnd);
            model.personalUpcoming=[...(model.personalUpcoming||[]).filter(e=>!(e.start<todayEnd&&e.end>todayStart)),...todayPersonal];
            model.lessons=[...model.upcoming.filter(e=>e.start<todayEnd && e.end>todayStart),...todayPersonal].sort((a,b)=>a.start-b.start);
            model.personalWarning="";
            model.eventNotice="Событие добавлено в Календарь iPhone и расписание ниже.";
          } else {
            const date=action==="pack"?await choosePackingDate():dayKey(shiftDay(new Date(),action==="tomorrow"?1:0));
            if(!date)return;
            const key=await editPacking(fm,packingPath,date);
            if(!key)return;
            model.packing=readPacking(fm,packingPath);model.packingWarning="";
            model.eventNotice="Список вещей сохранён на "+key+".";
          }
        } catch(error) {
          if(action==="trip") {model.tripLoading=false;model.tripError="Не удалось загрузить остановки. "+String(error.message||error);}
          else {const prefix=action==="new-courses"?"Не удалось завершить настройку предметов. Уже сохранённые ответы остались: ":action==="calendar-repair"?"Не удалось завершить обновление ссылки: ":action==="stop-routes"?"Не удалось завершить настройку маршрутов: ":action==="lesson-edit"?"Не удалось сохранить правку: ":action==="event"?"Не удалось обновить событие. Если уже нажал Add, проверь Calendar перед повторным добавлением. ":action==="settings"||action==="setting-op"?"Настройка не сохранена: ":action==="note"?"Заметка не сохранена: ":action==="week"||action==="pick-week"?"Неделя не открыта: ":"Список не сохранён: ";model.eventNotice=prefix+String(error.message||error);}
        }
        if(!closed) {
          model.now=new Date();const [from,to]=dayBounds(model.now);
          const universityToday=(model.upcoming||[]).filter(e=>e.start<to && e.end>from);
          const personalToday=(model.personalUpcoming||model.rawWeekEvents||model.weekEvents||[]).filter(e=>e.personal&&e.start<to&&e.end>from);
          model.lessons=applyLessonEdits([...universityToday,...personalToday],readLessonEdits(fm)).sort((a,b)=>a.start-b.start);
          await redraw();
        }
      }).catch(error=>console.log(String(error))).finally(async()=>{busy=false;if(queuedRefresh){const result=queuedRefresh;queuedRefresh=null;await applyRefresh(result);}});
    }
    return false;
  };
  try{
    await redraw();
    const ready=await webOperation(()=>view.evaluateJavaScript("!!document.querySelector('main')"),"ready",2500);
    if(ready!==true)throw Error("Начальная страница не загрузилась.");
    logLaunch(fm,"document-ready");
    // Let an external app launch finish its transition before presenting native UI.
    if(config.runsFromHomeScreen||args.queryParameters?.action==="overview")await uiPause(300);
    if(closed)return;
    presented=true;logLaunch(fm,"present-start");
    const presentation=Promise.resolve(view.present(true)).then(()=>{closed=true;logLaunch(fm,"closed");},error=>{closed=true;throw error;});
    // Observe rejection now, even while waiting for the opening animation.
    presentation.catch(()=>{});
    const update=async()=>{await uiPause(450);if(closed||!refreshData)return;logLaunch(fm,"refresh-start");
      try{await applyRefresh(await refreshData());}catch(error){logLaunch(fm,"refresh-failed");if(!closed&&!busy){model.eventNotice="Не удалось обновить данные. Сохранённая копия остаётся на экране.";try{await redraw(null);}catch{}}}
    };
    update().catch(()=>logLaunch(fm,"refresh-failed"));
    await presentation;
  }catch(error){logLaunch(fm,"open-failed");if(!presented)await setupMessage("Экран не открылся","WebView не подтвердил загрузку. Попробуй запустить этот скрипт кнопкой ▶ внутри Scriptable. Настройки сохранены. Этапы запуска доступны в настройках → Диагностика запуска.");else throw error;}
  finally{closed=true;await pending;}

}

// First-run setup and persistent settings, shared by every installation.
const PROFILE_FIELDS=["studyWeekAnchor","universityLabel","city","calendarURL","stops","alwaysBring","courseItems","courseHints","onlineCourses","excludedCourses","extraStops","departureCount","widgetDepartureCount","widgetStopCount","widgetStopKeys","widgetNearbyStopFirst","widgetStopOrderHome","widgetStopOrderUni","locationAnchors","removedPlaces","locationRadiusMeters","stopPriorities","hiddenRoutes","allowedRoutes","travelChains","activeTravelChain","journeyPlanner","widgetCustomText","packingCategories","widgetStopKeysHome","widgetStopKeysUni","locationNames","locationRadii","extraPlaces","appearance"];
function courseKey(course) {return course.originalCourseKey || course.code || "title:"+courseTitle(course);}
function profileFiles() {
  const fm=FileManager.local(),configDir=fm.joinPath(fm.documentsDirectory(),"UniDay-Personal");
  if(!fm.fileExists(configDir))fm.createDirectory(configDir,true);
  const dir=fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder);
  if(!fm.fileExists(dir))fm.createDirectory(dir,true);
  return {fm,dir,path:fm.joinPath(configDir,"profile.json")};
}
function currentProfile() {
  return JSON.parse(JSON.stringify(Object.fromEntries(PROFILE_FIELDS.map(k=>[k,SETTINGS[k]]))));
}
function profileDataSignature(profile=currentProfile()) {
  // Widget-only choices should not trigger fresh calendar/weather/transit requests.
  const keys=["universityLabel","city","calendarURL","stops","extraStops","removedPlaces","departureCount","widgetDepartureCount","locationAnchors","locationRadiusMeters","locationRadii","extraPlaces","stopPriorities","hiddenRoutes","allowedRoutes","alwaysBring","courseItems","courseHints","onlineCourses","excludedCourses"];
  return JSON.stringify(Object.fromEntries(keys.map(k=>[k,profile[k]])));
}
function overviewSignature() {return JSON.stringify([SETTINGS.storageFolder,profileDataSignature(),SETTINGS.studyWeekAnchor,SETTINGS.locationNames,SETTINGS.travelChains,SETTINGS.activeTravelChain,SETTINGS.journeyPlanner]);}
function normalizeWidgetSections(list,legacy=false) {
  if(!Array.isArray(list))return appearanceDefaults().widgetSections.slice();
  const clean=[...new Set(list.filter(x=>WIDGET_SECTIONS.includes(x)))];
  if(legacy) {
    // UniDay 6.x did not expose header/location as configurable blocks.
    if(!clean.includes("header"))clean.unshift("header");
    if(!clean.includes("location") && clean.includes("buses")){const i=clean.indexOf("footer");if(i>=0)clean.splice(i,0,"location");else clean.push("location");}
  }
  return clean;
}
/** Validate/migrate a profile before committing it to the shared runtime state. @param {object} input */
function applyProfile(input) {
  if(!input || typeof input!=="object" || Array.isArray(input))throw Error("Неверный формат настроек.");
  input=JSON.parse(JSON.stringify(input));
  if("appearance" in input && (!input.appearance||typeof input.appearance!=="object"||Array.isArray(input.appearance)))throw Error("Повреждены настройки оформления.");
  const legacyRoute=typeof input.route==="string"?input.route.trim():"";
  const legacyAppearance=input.appearance&&typeof input.appearance==="object"&&!Array.isArray(input.appearance)?input.appearance:{};
  const hadWidgetStopKeys=Array.isArray(input.widgetStopKeys);
  const defaults={allowedRoutes:{},travelChains:[],activeTravelChain:null,journeyPlanner:{enabled:false,maxTransfers:2,maxWalkDistance:1000,transferMinutes:3},studyWeekAnchor:null,hiddenRoutes:{},widgetStopKeysHome:null,widgetStopKeysUni:null,locationNames:{home:"Дом",uni:"Универ"},locationRadii:{home:input.locationRadiusMeters||1200,uni:input.locationRadiusMeters||1200},extraPlaces:[],removedPlaces:[],packingCategories:{},appearance:appearanceDefaults(),extraStops:[],departureCount:5,widgetDepartureCount:2,widgetStopCount:2,widgetStopKeys:[],widgetNearbyStopFirst:true,widgetStopOrderHome:[],widgetStopOrderUni:[],locationAnchors:{home:null,uni:null},locationRadiusMeters:1200,stopPriorities:{},widgetCustomText:[],...input};
  const migratedAppearance={...appearanceDefaults(),...legacyAppearance};
  migratedAppearance.widgetStopLimits={small:1,medium:1,large:3,...legacyAppearance.widgetStopLimits};
  // Existing untouched two-column defaults get the new readable layout. Explicitly
  // customised columns and lists remain as their owner configured them.
  if(legacyAppearance.mediumLayoutVersion!==2){
    const standardColumns=defaultMediumColumns();
    if((!legacyAppearance.mediumLayout||legacyAppearance.mediumLayout==="columns")&&
      (legacyAppearance.mediumColumnSplit??55)===55&&(legacyAppearance.mediumColumnGap??10)===10&&
      WIDGET_SECTIONS.every(k=>(legacyAppearance.mediumColumns?.[k]??standardColumns[k])===standardColumns[k]))migratedAppearance.mediumLayout="dashboard";
    migratedAppearance.mediumLayoutVersion=2;
  }
  migratedAppearance.widgetBlocks={small:{},medium:{},large:{},...legacyAppearance.widgetBlocks};
  migratedAppearance.familyScales={small:100,medium:100,large:100,...legacyAppearance.familyScales};
  migratedAppearance.familySections={small:null,medium:null,large:null,...legacyAppearance.familySections};
  if(legacyAppearance.widgetFont){
    if(!("categoryFont" in legacyAppearance))migratedAppearance.categoryFont=legacyAppearance.widgetFont;
    if(!("bodyFont" in legacyAppearance))migratedAppearance.bodyFont=legacyAppearance.widgetFont;
  }
  delete migratedAppearance.widgetFont;delete migratedAppearance.widgetTransparent;
  if(typeof legacyAppearance.widgetTransparent==="boolean" && !("widgetBackgroundMode" in legacyAppearance))migratedAppearance.widgetBackgroundMode=legacyAppearance.widgetTransparent?"clear":"solid";
  const legacyWidgetAppearance=!("categoryFont" in legacyAppearance)||("widgetFont" in legacyAppearance)||("widgetTransparent" in legacyAppearance);
  migratedAppearance.widgetSections=normalizeWidgetSections(legacyAppearance.widgetSections,legacyWidgetAppearance);
  if(legacyAppearance.countdownVersion!==1){
    const insert=(list,after)=>list.includes("countdown")||!list.includes(after)?list:list.flatMap(k=>k===after?[k,"countdown"]:[k]);
    migratedAppearance.widgetSections=insert(migratedAppearance.widgetSections,"classes");
    for(const family of ["small","medium","large"])if(Array.isArray(migratedAppearance.familySections[family]))migratedAppearance.familySections[family]=insert(migratedAppearance.familySections[family],"classes");
    if(!migratedAppearance.screenSections.includes("countdown"))migratedAppearance.screenSections=migratedAppearance.screenSections.flatMap(k=>k==="today"?["countdown",k]:[k]);
  }
  migratedAppearance.countdownVersion=1;
  migratedAppearance.wallpaperBackgrounds=legacyAppearance.wallpaperBackgrounds&&typeof legacyAppearance.wallpaperBackgrounds==="object"&&!Array.isArray(legacyAppearance.wallpaperBackgrounds)?legacyAppearance.wallpaperBackgrounds:{};
  defaults.appearance=migratedAppearance;
  if(!Array.isArray(defaults.stops)||!Array.isArray(defaults.extraStops))throw Error("Повреждён список остановок.");
  const allStops=[...(defaults.stops||[]),...(defaults.extraStops||[])],keys=new Set(allStops.map(s=>s?.key).filter(Boolean));
  defaults.stopPriorities=defaults.stopPriorities&&typeof defaults.stopPriorities==="object"&&!Array.isArray(defaults.stopPriorities)?defaults.stopPriorities:{};
  if(!Object.keys(defaults.stopPriorities).some(k=>keys.has(k)) && legacyRoute)for(const stop of defaults.stops||[])defaults.stopPriorities[stop.key]=[legacyRoute];
  defaults.stopPriorities=Object.fromEntries(Object.entries(defaults.stopPriorities).filter(([k])=>keys.has(k)).map(([k,v])=>[k,Array.isArray(v)?[...new Set(v.map(x=>String(x).trim().toUpperCase()).filter(Boolean))]:[]]));
  for(const k of keys)if(!(k in defaults.stopPriorities))defaults.stopPriorities[k]=[];
  defaults.widgetStopKeys=Array.isArray(defaults.widgetStopKeys)?[...new Set(defaults.widgetStopKeys.filter(k=>keys.has(k)))]:[];
  // Older profiles without this field default to all stops. An explicit empty array stays empty.
  if(!hadWidgetStopKeys)defaults.widgetStopKeys=allStops.map(s=>s.key);
  defaults.widgetStopCount=defaults.widgetStopKeys.length; // deprecated count kept only for profile compatibility
  if(!Array.isArray(defaults.extraPlaces)||defaults.extraPlaces.length>8)throw Error("Можно добавить до восьми мест.");
  if(!Array.isArray(defaults.removedPlaces)||new Set(defaults.removedPlaces).size!==defaults.removedPlaces.length||defaults.removedPlaces.some(k=>k!=="home"&&k!=="uni"))throw Error("Повреждён список удалённых мест.");
  const validSelection=x=>x===null||Array.isArray(x)&&x.every(k=>typeof k==="string");
  if(!validSelection(defaults.widgetStopKeysHome)||!validSelection(defaults.widgetStopKeysUni))throw Error("Повреждены наборы остановок мест.");
  const radius=x=>Number.isInteger(x)&&x>=100&&x<=3000;
  if(!defaults.locationNames||!["home","uni"].every(k=>typeof defaults.locationNames[k]==="string"&&defaults.locationNames[k].trim()&&defaults.locationNames[k].length<=40)||!defaults.locationRadii||!["home","uni"].every(k=>radius(defaults.locationRadii[k])))throw Error("Повреждены названия или радиусы мест.");
  if(defaults.extraPlaces.some(p=>!p||!/^place_\d+$/.test(p.key)||typeof p.name!=="string"||!p.name.trim()||p.name.length>40||!validLocationAnchor(p)||!radius(p.radiusMeters)||!validSelection(p.stopKeys)||!Array.isArray(p.stopOrder)||typeof p.address!=="string"||p.address.length>250)||new Set(defaults.extraPlaces.map(p=>p.key)).size!==defaults.extraPlaces.length)throw Error("Повреждены сохранённые места.");
  if(!Array.isArray(input.widgetStopOrderHome)||!input.widgetStopOrderHome.length)defaults.widgetStopOrderHome=["home",...defaults.widgetStopKeys];
  if(!Array.isArray(input.widgetStopOrderUni)||!input.widgetStopOrderUni.length)defaults.widgetStopOrderUni=["uni",...defaults.widgetStopKeys];
  normalizeProfileWidgetOrders(defaults);
  if(!defaults.locationAnchors||typeof defaults.locationAnchors!=="object"||Array.isArray(defaults.locationAnchors)||["home","uni"].some(k=>defaults.locationAnchors[k]!=null&&!validLocationAnchor(defaults.locationAnchors[k])))throw Error("Повреждены точки дома/университета.");
  const rawAnchors=defaults.locationAnchors;
  const migrateAnchor=x=>validLocationAnchor(x)?{latitude:x.latitude,longitude:x.longitude,...(typeof x.address==="string"&&x.address.length<=250?{address:x.address}:{})}:null;
  defaults.locationAnchors={home:migrateAnchor(rawAnchors.home),uni:migrateAnchor(rawAnchors.uni)};
  const profile=defaults;
  if(PROFILE_FIELDS.some(k=>!(k in profile)))throw Error("Профиль сохранён не полностью.");
  if(profile.studyWeekAnchor!==null){const a=profile.studyWeekAnchor;if(!a||typeof a!=="object"||Array.isArray(a)||typeof a.source!=="string")throw Error("Повреждена настройка учебных недель.");validateHTTPSURL(a.source);studyAnchorDate(a.start);}
  const strings=["universityLabel","city","calendarURL"];
  if(strings.some(k=>typeof profile[k]!=="string") || ["alwaysBring","onlineCourses","excludedCourses"].some(k=>!Array.isArray(profile[k])||profile[k].some(x=>typeof x!=="string")))throw Error("Неверный формат настроек.");
  if(!profile.courseItems || Array.isArray(profile.courseItems) || typeof profile.courseItems!=="object" || Object.values(profile.courseItems).some(v=>v!==null && (!Array.isArray(v)||v.some(x=>typeof x!=="string"))))throw Error("Повреждён список вещей.");
  if(!profile.courseHints || Array.isArray(profile.courseHints) || typeof profile.courseHints!=="object" || Object.values(profile.courseHints).some(v=>typeof v!=="string"))throw Error("Повреждены примечания.");
  if(!Number.isInteger(profile.departureCount)||profile.departureCount<1||profile.departureCount>10)throw Error("Количество рейсов должно быть от 1 до 10.");
  if(!Number.isInteger(profile.widgetDepartureCount)||profile.widgetDepartureCount<1||profile.widgetDepartureCount>8)throw Error("В виджете можно показывать от 1 до 8 рейсов.");
  if(!Number.isInteger(profile.widgetStopCount)||profile.widgetStopCount<0||profile.widgetStopCount>8)throw Error("В виджете можно показывать от 0 до 8 остановок.");
  if(!Array.isArray(profile.extraStops)||profile.extraStops.length>6||profile.extraStops.some(s=>!s || !/^extra_\d+$/.test(s.key) || typeof s.name!=="string" || !s.name || typeof s.label!=="string"))throw Error("Можно добавить до шести дополнительных остановок.");
  if(!Array.isArray(profile.stops)||profile.stops.length>2||profile.stops.some(s=>s.key!=="home"&&s.key!=="uni")||[...profile.stops,...profile.extraStops].some(s=>!s || typeof s.id!=="string" || !s.id || typeof s.code!=="string" || !s.code || typeof s.direction!=="string" || !Number.isFinite(s.latitude)||!Number.isFinite(s.longitude)||Math.abs(s.latitude)>90||Math.abs(s.longitude)>180))throw Error("Повреждены остановки.");
  const checkedStops=[...profile.stops,...profile.extraStops],checkedKeys=new Set(checkedStops.map(s=>s.key));
  if(checkedStops.some(s=>s.searchCity!==undefined && (typeof s.searchCity!=="string" || s.searchCity.trim().length<2 || s.searchCity.length>100)))throw Error("Повреждён город поиска остановки.");
  if(new Set(checkedStops.map(s=>s.key)).size!==checkedStops.length || new Set(checkedStops.map(s=>s.id)).size!==checkedStops.length)throw Error("Одна и та же сторона остановки добавлена дважды.");
  if(!Array.isArray(profile.widgetStopKeys)||new Set(profile.widgetStopKeys).size!==profile.widgetStopKeys.length||profile.widgetStopKeys.some(k=>!checkedKeys.has(k)))throw Error("Повреждён список остановок виджета.");
  if(typeof profile.widgetNearbyStopFirst!=="boolean")throw Error("Повреждена настройка геопозиции виджета.");
  for(const key of placeKeys(profile)){const selected=placeStops(profile,key),order=placeOrder(profile,key);if(order.length!==selected.length||new Set(order).size!==order.length||order.some(k=>!selected.includes(k)))throw Error("Повреждён порядок остановок места.");}
  if(!profile.locationAnchors || typeof profile.locationAnchors!=="object" || Array.isArray(profile.locationAnchors) || !["home","uni"].every(k=>profile.locationAnchors[k]===null||validLocationAnchor(profile.locationAnchors[k])))throw Error("Повреждены точки дома/университета.");
  if(!Number.isInteger(profile.locationRadiusMeters)||profile.locationRadiusMeters<100||profile.locationRadiusMeters>3000)throw Error("Радиус дома/университета должен быть от 100 до 3000 м.");
  if(!profile.hiddenRoutes||typeof profile.hiddenRoutes!=="object"||Array.isArray(profile.hiddenRoutes)||Object.values(profile.hiddenRoutes).some(v=>!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=="string"||!x||x.length>12||/[,;\s]/.test(x))))throw Error("Повреждён список скрытых автобусов.");
  if(!profile.stopPriorities || typeof profile.stopPriorities!=="object" || Array.isArray(profile.stopPriorities) || Object.entries(profile.stopPriorities).some(([k,v])=>!checkedKeys.has(k)||!Array.isArray(v)||v.some(x=>typeof x!=="string"||!x||x.length>12||/[,;\s]/.test(x))))throw Error("Повреждены приоритеты автобусов.");
  if(!Array.isArray(profile.widgetCustomText)||profile.widgetCustomText.length>8||profile.widgetCustomText.some(x=>typeof x!=="string"||x.length>120))throw Error("Повреждён свой текст виджета.");
  if(!profile.packingCategories||typeof profile.packingCategories!=="object"||Array.isArray(profile.packingCategories)||Object.entries(profile.packingCategories).some(([k,v])=>!k||typeof v!=="string"||!v.trim()||v.length>40))throw Error("Повреждены категории вещей.");
  validateTravelSettings(profile);
  for(const map of [profile.hiddenRoutes,profile.allowedRoutes])for(const key of Object.keys(map))map[key]=normalizeRouteNumbers(map[key]);
  const a=profile.appearance;
  if(!a || typeof a!=="object" || Array.isArray(a) || (!Number.isInteger(a.screenScale)||a.screenScale<70||a.screenScale>180) || (!Number.isInteger(a.widgetScale)||a.widgetScale<70||a.widgetScale>180) ||
    !Object.prototype.hasOwnProperty.call(TEXT_FONTS,a.screenFont) || !Object.prototype.hasOwnProperty.call(TEXT_FONTS,a.categoryFont) || !Object.prototype.hasOwnProperty.call(TEXT_FONTS,a.bodyFont) ||
    [a.screenCustomFont,a.categoryCustomFont,a.bodyCustomFont].some(x=>typeof x!=="string"||x.length>80||/[\r\n]/.test(x)) ||
    (!Number.isInteger(a.categoryScale)||a.categoryScale<70||a.categoryScale>180) || (!Number.isInteger(a.bodyScale)||a.bodyScale<70||a.bodyScale>180) ||
    !/^#[0-9a-f]{6}$/i.test(a.widgetBackground) || !/^#[0-9a-f]{6}$/i.test(a.widgetText) || !/^#[0-9a-f]{6}$/i.test(a.widgetMuted) || !/^#[0-9a-f]{6}$/i.test(a.widgetAccent) ||
    !["solid","clear","wallpaper"].includes(a.widgetBackgroundMode) || !Array.isArray(a.widgetSections) || new Set(a.widgetSections).size!==a.widgetSections.length || a.widgetSections.some(x=>!WIDGET_SECTIONS.includes(x)) ||
    !a.wallpaperBackgrounds || typeof a.wallpaperBackgrounds!=="object" || Array.isArray(a.wallpaperBackgrounds))throw Error("Не удалось прочитать настройки оформления.");
  const validSections=(list,keys)=>Array.isArray(list)&&new Set(list).size===list.length&&list.every(k=>keys.includes(k));
  if(!validExtraAppearance(a)||!validSections(a.screenSections,SCREEN_SECTIONS)||!a.familySections||!["small","medium","large"].every(k=>a.familySections[k]===null||validSections(a.familySections[k],WIDGET_SECTIONS)))throw Error("Повреждены дополнительные настройки оформления.");
  for(const [family,bg] of Object.entries(a.wallpaperBackgrounds)){if(!["small","medium","large"].includes(family)||!bg||typeof bg!=="object"||typeof bg.file!=="string"||!/^widget-wallpaper-(small|medium|large)(-\d+-\d+)?\.png$/.test(bg.file))throw Error("Повреждены настройки прозрачного фона.");if(bg.source&&(!/^widget-source-(small|medium|large)-\d+-\d+\.png$/.test(bg.source)||!bg.rect||!["x","y","width","height","dx","dy","zoom"].every(k=>Number.isFinite(bg.rect[k]))||bg.rect.width<=0||bg.rect.height<=0||bg.rect.width>10000||bg.rect.height>10000))throw Error("Повреждён исходник фона.");}
  const previous=currentProfile();
  for(const key of PROFILE_FIELDS)SETTINGS[key]=JSON.parse(JSON.stringify(profile[key]));
  try {validateProfile();} catch(error) {Object.assign(SETTINGS,previous);throw error;}
}
function profileEnvelope(value) {
  if(!value || ![1,2,3].includes(value.version))throw Error("Неизвестная версия файла настроек.");
  const dataFolder=value.version===1?"UniDay-Personal":value.dataFolder||"UniDay-Personal";
  if(!["UniDay-Personal","UniDay-EMU"].includes(dataFolder))throw Error("Неизвестная папка данных.");
  const previous=currentProfile();
  try {applyProfile(value.profile);return {profile:currentProfile(),dataFolder};}
  finally {Object.assign(SETTINGS,previous);}
}
/** Persist a validated profile; failed primary writes restore the previous runtime state. @param {object} profile @param {string} dataFolder */
function saveProfile(profile,dataFolder=SETTINGS.storageFolder) {
  if(!["UniDay-Personal","UniDay-EMU"].includes(dataFolder))throw Error("Неизвестная папка данных.");
  const {fm,path}=profileFiles(),previous=currentProfile(),previousFolder=SETTINGS.storageFolder;
  applyProfile(profile);
  const text=JSON.stringify({version:3,dataFolder,profile:currentProfile()});
  try {fm.writeString(path,text);SETTINGS.storageFolder=dataFolder;SETTINGS.profileRecoveryWarning="";
    // Keep a complete, validated profile for recovery from a truncated main file.
    try{fm.writeString(path+".last-good.json",text);}catch{}
  }
  catch(error) {Object.assign(SETTINGS,previous);SETTINGS.storageFolder=previousFolder;throw error;}
}
async function importProfile() {
  const paths=await DocumentPicker.open(["public.json"]);
  if(!paths?.length)return false;
  if(paths.length!==1)throw Error("Выбери один файл настроек JSON.");
  const text=FileManager.local().readString(paths[0]);
  if(!text || text.length>500000)throw Error("Файл настроек пустой или слишком большой.");
  const imported=profileEnvelope(JSON.parse(text)),p=imported.profile;
  const a=new Alert();a.title="Импортировать настройки?";
  const priorities=[...p.stops,...p.extraStops].map(s=>s.name+": "+((p.stopPriorities[s.key]||[]).join(", ")||"без приоритета")).join("\n");
  a.message=p.universityLabel+" · "+p.city+"\n"+p.stops.map(s=>stopDirectionName(s,p)+": "+s.name+" · "+s.direction).join("\n")+"\nПриоритеты автобусов:\n"+priorities+"\nПредметов со списками: "+Object.keys(p.courseItems).length+"\nСохранённые заметки, вещи по датам и события остаются в своей папке.";
  a.addAction("Импортировать");a.addCancelAction("Отмена");if(await a.presentAlert()<0)return false;
  saveProfile(p,imported.dataFolder);return true;
}
async function firstSetup() {
  const a=new Alert();a.title="Добро пожаловать в UniDay";
  a.message="Один скрипт для всех. Пройди настройку или выбери готовый файл настроек.";
  a.addAction("Настроить с нуля");a.addAction("Импортировать настройки");a.addCancelAction("Отмена");
  const choice=await a.presentAlert();if(choice<0)return false;
  return choice===1?importProfile():setupWizard();
}
async function setupMessage(title,message) {
  const a=new Alert();a.title=title;a.message=message;a.addAction("Понятно");await a.presentAlert();
}
async function setupInput(title,message,fields) {
  const a=new Alert();a.title=title;a.message=message;
  for(const f of fields)a.addTextField(f.label,String(f.value??""));
  a.addAction("Продолжить");a.addCancelAction("Отмена");
  if(await a.presentAlert()<0)return null;
  return fields.map((_,i)=>a.textFieldValue(i).trim());
}
async function setupChoice(title,message,labels) {
  if(!labels.length){await setupMessage(title,"Пока нечего выбрать. Сначала добавь место, остановку или занятие в соответствующем разделе.");return -1;}
  // Pages avoid an unmanageable list when several towns have stops with the same name.
  let page=0;
  while(true) {
    const offset=page*CHOICE_PAGE_SIZE,chunk=labels.slice(offset,offset+CHOICE_PAGE_SIZE),a=new Alert();a.title=title;a.message=message;
    chunk.forEach(x=>a.addAction(x));
    const next=offset+CHOICE_PAGE_SIZE<labels.length,previous=page>0;
    if(next)a.addAction("Ещё варианты →");if(previous)a.addAction("← Назад");a.addCancelAction("Отмена");
    const index=await a.presentSheet();if(index<0)return -1;
    if(index<chunk.length)return offset+index;
    if(next && index===chunk.length)page++;else page--;
  }
}
async function setupCalendar(initial="") {
  let value=initial;
  while(true) {
    const input=await setupInput("Твоё расписание","Вставь прямую ссылку на календарь ICS. Поддерживается формат EMÜ с ежедневными/еженедельными повторами; обычная страница сайта не подойдёт.",[{label:"https://…",value}]);
    if(!input)return null;
    value=input[0].replace(/^webcal:\/\//i,"https://");
    try {
      validateHTTPSURL(value);
      const text=await loadRequest(value),events=parseCalendar(text);
      if(!events.some(e=>!e.cancelled))throw Error("В этом календаре нет занятий.");
      expandCalendar(events,dayBounds(new Date())[0],shiftDay(new Date(),14));
      return {url:value,text,events};
    } catch(error) {await setupMessage("Календарь не прочитан",String(error.message||error)+"\nПроверь ссылку и интернет. Можно исправить ссылку или отменить настройку.");}
  }
}
function copyCalendarKeys(data,oldURL,newURL){
  const result={...data};if(oldURL===newURL)return result;
  for(const [key,value]of Object.entries(data)){
    let parts;try{parts=JSON.parse(key);}catch{continue;}if(!Array.isArray(parts))continue;
    const index=parts[0]===oldURL?0:["course-note","course-edit"].includes(parts[0])&&parts[1]===oldURL?1:-1;if(index<0)continue;
    parts[index]=newURL;const target=JSON.stringify(parts);if(!Object.prototype.hasOwnProperty.call(result,target))result[target]=value;
  }
  return result; // Original keys stay intact if any subsequent file write fails.
}
function replaceCalendarSource(calendar){
  if(!calendar.events?.some(e=>!e.cancelled))throw Error("Новая ссылка не содержит занятий. Старая настройка сохранена.");
  const {fm,dir}=profileFiles(),profile=currentProfile(),oldURL=profile.calendarURL;
  const notesPath=fm.joinPath(dir,"lesson-notes.json"),editsPath=fm.joinPath(dir,"lesson-edits.json");
  // Validate all saved records first. Do not overwrite an unreadable file.
  const notes=readLessonNotes(fm,notesPath),edits=readLessonEdits(fm,editsPath);
  const changes=[[notesPath,copyCalendarKeys(notes,oldURL,calendar.url)],[editsPath,copyCalendarKeys(edits,oldURL,calendar.url)]];
  for(const [path,data]of changes)if(fm.fileExists(path))fm.writeString(path,JSON.stringify(data));
  profile.calendarURL=calendar.url;
  if(profile.studyWeekAnchor?.source===oldURL)profile.studyWeekAnchor.source=calendar.url;
  saveProfile(profile);
  const entry=JSON.stringify({text:calendar.text,saved:Date.now(),source:calendar.url}),path=fm.joinPath(dir,"calendar.json");
  try{fm.writeString(path+".last-good.json",entry);}catch{}try{fm.writeString(path,entry);}catch{}
}
async function replaceCalendarLink(){
  const calendar=await setupCalendar(SETTINGS.calendarURL);if(!calendar)return false;
  replaceCalendarSource(calendar);return true;
}
function stopCityKey(value) {
  const key=String(value||"").trim().toLowerCase().replace(/^город\s+/,"").replace(/\s+linn$/,"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  const aliases={"тарту":"tartu","таллин":"tallinn","таллинн":"tallinn","tallinna":"tallinn"};
  return Object.prototype.hasOwnProperty.call(aliases,key)?aliases[key]:key;
}
function stopIsInCity(feature,city) {
  // Match whole locality components, not substrings: Tartu is neither Tartumaa
  // nor Tartu vald. Do not infer a city from the stop's name or nearby coordinates.
  const locality=feature?.properties?.locality;
  return typeof locality==="string" && locality.split(",").some(part=>stopCityKey(part)===stopCityKey(city));
}
async function loadStopPlaces(stops) {
  // Same Peatus service as its website. Look up administrative metadata by exact
  // GTFS ID/code; a fuzzy text search can mix Tartu with its surrounding county.
  const chunks=[];for(let i=0;i<stops.length;i+=GEOCODE_CHUNK_SIZE)chunks.push(stops.slice(i,i+GEOCODE_CHUNK_SIZE));
  const places=new Map();
  // Bound concurrency deliberately: larger searches must not flood Peatus.
  for(let i=0;i<chunks.length;i+=GEOCODE_CONCURRENCY) {
    const replies=await Promise.all(chunks.slice(i,i+GEOCODE_CONCURRENCY).map(async chunk=>{
      const ids=chunk.map(s=>"gtfsestonia:stop:GTFS:"+s.gtfsId+"#"+s.code).join(",");
      const data=JSON.parse(await loadRequest("https://api.peatus.ee/geocoding/v1/place?ids="+encodeURIComponent(ids)));
      if(data.geocoding?.errors?.length || !Array.isArray(data.features))throw Error("Peatus не вернул города остановок. Попробуй ещё раз.");
      return data.features;
    }));
    for(const reply of replies)for(const feature of reply)if(feature?.properties?.id)places.set(feature.properties.id,feature);
  }
  return places;
}
/** @param {string} name @param {string} city @returns {Promise<{options:Array<object>,unknown:number}>} */
async function searchCityStops(name,city) {
  const result=JSON.parse(await loadRequest(SETTINGS.apiURL,{query:`{ stops(name:${JSON.stringify(name)},maxResults:${STOP_SEARCH_LIMIT+1}) { gtfsId name code desc lat lon } }`}));
  if(result.errors?.length || !Array.isArray(result.data?.stops))throw Error("Поиск временно недоступен.");
  if(result.data.stops.length>STOP_SEARCH_LIMIT)throw Error("Слишком короткое название. Введи его точнее, чтобы поиск не обрезал результаты.");
  const stops=[...new Map(result.data.stops.filter(s=>s?.gtfsId && s.name && s.code && Number.isFinite(s.lat) && Number.isFinite(s.lon)).map(s=>[s.gtfsId,s])).values()];
  if(!stops.length)return {options:[],unknown:0};
  const places=await loadStopPlaces(stops),requestedName=name.toLowerCase();
  let unknown=0;
  const options=stops.filter(s=>{
    const place=places.get("GTFS:"+s.gtfsId+"#"+s.code);
    if(!place?.properties?.locality){unknown++;return false;}
    return stopIsInCity(place,city);
  }).sort((a,b)=>Number(b.name.toLowerCase()===requestedName)-Number(a.name.toLowerCase()===requestedName) || a.name.localeCompare(b.name,"et") || a.code.localeCompare(b.code));
  return {options,unknown};
}
async function setupStop(key,initial=null,defaultCity=SETTINGS.city) {
  const cityInput=await setupInput("Город остановки","В каком городе искать? Укажи название по-эстонски, например Tartu или Tallinn. Остановки из других городов и волостей не попадут в список.",[{label:"Город",value:initial?.searchCity||defaultCity}]);
  if(!cityInput)return null;
  const city=cityInput[0].trim();
  if(city.length<2 || city.length>100)throw Error("Введи название города от 2 до 100 символов.");
  let name=initial?.name||"";
  while(true) {
    const input=await setupInput(["home","uni"].includes(key)?"Остановка · "+placeName(key):"Дополнительная остановка","Город: "+city+". Введи название, затем выбери нужное направление из списка Peatus.ee.",[{label:"Название остановки",value:name}]);
    if(!input)return null;name=input[0];
    if(name.length<2){await setupMessage("Уточни название","Введи хотя бы две буквы.");continue;}
    try {
      const {options,unknown}=await searchCityStops(name,city);
      if(!options.length){await setupMessage("Ничего не найдено в "+city,"Проверь написание названия и города."+(unknown?" У "+unknown+" совпадений Peatus не указал город; они не показаны.":"")+" Чтобы сменить город, отмени поиск и выбери остановку заново.");continue;}
      if(options.length>100){await setupMessage("Слишком много совпадений","Введи название точнее.");continue;}
      const index=await setupChoice("Выбери сторону остановки",city+" · Сверь направление и код с нужной остановкой."+(unknown?"\nБез данных о городе пропущено: "+unknown+".":""),options.map(s=>`${s.name} · ${s.desc||"без описания направления"} · ${s.code}`));
      if(index<0)return null;
      const s=options[index];
      return {key,id:s.gtfsId,code:s.code,name:s.name,direction:s.desc||"",latitude:s.lat,longitude:s.lon,searchCity:city,label:key==="home"?directionName("home","uni"):key==="uni"?directionName("uni","home"):s.name};
    } catch(error) {await setupMessage("Поиск не удался",String(error.message||error));}
  }
}
function splitThings(value) {return [...new Set(value.split(/[;\n]/).map(x=>x.trim()).filter(Boolean))];}
function setupCourses(events) {
  return [...new Map(events.filter(e=>!e.cancelled).map(e=>[courseKey(e),e])).values()];
}
function courseIsConfigured(course,profile=SETTINGS){
  const key=courseKey(course),has=(obj)=>Object.prototype.hasOwnProperty.call(obj||{},key);
  // [] = nothing special, null = explicitly "don't know yet". Both are saved answers.
  return has(profile.courseItems)||has(profile.courseHints)||profile.onlineCourses.includes(key)||profile.excludedCourses.includes(key);
}
function discoverNewCourses(events,now=new Date()){
  const profile=currentProfile();
  if(!events.some(e=>!e.cancelled&&!courseIsConfigured(e,profile)))return [];
  // Only one future occurrence per series is needed; do not expand the entire year's lessons.
  const future=expandCalendar(events,dayBounds(now)[0],shiftDay(now,370),true);
  return setupCourses(future).filter(e=>!e.personal&&!courseIsConfigured(e,profile));
}
async function setupNewCourses(courses){
  const pending=setupCourses(courses).filter(e=>!e.personal&&!courseIsConfigured(e));let saved=0;
  for(let i=0;i<pending.length;i++){
    const profile=currentProfile();if(courseIsConfigured(pending[i],profile))continue;
    if(!await setupOneCourse(profile,pending[i],i,pending.length))break;
    // Save each completed answer, so cancelling the next subject never loses prior progress.
    saveProfile(profile);saved++;
  }
  return saved;
}
async function setupOneCourse(profile,course,index=null,total=null) {
  const key=courseKey(course),a=new Alert();a.title=(index===null?"":`${index+1}/${total} · `)+courseTitle(course);
  a.message="Что брать? Перечисли через точку с запятой. Пустое поле — ничего специального. Выбери формат занятия или отметь, что предмет не твой.";
  a.addTextField("Например: ноутбук; тетрадь",(profile.courseItems[key]||[]).join("; "));
  a.addTextField("Примечание к предмету",profile.courseHints[key]||"");
  a.addAction("Сохранить · очно");a.addAction("Сохранить · онлайн");a.addAction("Пока не знаю");a.addAction("Не мой предмет");a.addCancelAction("Настроить позже");
  const choice=await a.presentAlert();if(choice<0)return false;
  profile.courseItems[key]=choice===2?null:splitThings(a.textFieldValue(0));
  const hint=a.textFieldValue(1).trim();if(hint)profile.courseHints[key]=hint;else delete profile.courseHints[key];
  profile.onlineCourses=profile.onlineCourses.filter(k=>k!==key);if(choice===1)profile.onlineCourses.push(key);
  profile.excludedCourses=profile.excludedCourses.filter(k=>k!==key);if(choice===3)profile.excludedCourses.push(key);
  return true;
}
async function setupWizard(existing=null) {
  const profile=existing?JSON.parse(JSON.stringify(existing)):currentProfile();
  const intro=new Alert();intro.title="Настроим UniDay";
  intro.message="Расписание, остановки, отдельные приоритетные автобусы для каждой остановки и вещи по предметам. Всё сохраним на этом iPhone. Транспорт — Эстония; время — Europe/Tallinn.";
  intro.addAction("Начать");intro.addCancelAction("Отмена");if(await intro.presentAlert()<0)return false;
  const info=await setupInput("Как подписать виджет?","Укажи сокращение университета и город.",[{label:"Университет",value:profile.universityLabel},{label:"Город",value:profile.city}]);
  if(!info)return false;profile.universityLabel=info[0]||"UniDay";profile.city=info[1];
  const calendar=await setupCalendar(profile.calendarURL);if(!calendar)return false;profile.calendarURL=calendar.url;
  const home=await setupStop("home",profile.stops.find(s=>s.key==="home"),profile.city);if(!home)return false;
  const uni=await setupStop("uni",profile.stops.find(s=>s.key==="uni"),profile.city);if(!uni)return false;profile.stops=[home,uni];profile.removedPlaces=[];
  profile.stopPriorities=profile.stopPriorities||{};
  if(!(home.key in profile.stopPriorities))profile.stopPriorities[home.key]=[];
  if(!(uni.key in profile.stopPriorities))profile.stopPriorities[uni.key]=[];
  if(!existing && !(profile.widgetStopKeys||[]).length)profile.widgetStopKeys=[home.key,uni.key];
  else profile.widgetStopKeys=[...new Set((profile.widgetStopKeys||[]).filter(k=>[home.key,uni.key,...profile.extraStops.map(s=>s.key)].includes(k)))];
  if(!await editStopPriorities(profile,home))return false;
  if(!await editStopPriorities(profile,uni))return false;
  const always=await setupInput("Что брать всегда?","Эти вещи добавляются в список учебного дня. Если ничего — оставь пустым.",[{label:"Вещи через ;",value:profile.alwaysBring.join("; ")}]);
  if(!always)return false;profile.alwaysBring=splitThings(always[0]);
  const courses=setupCourses(calendar.events);
  for(let i=0;i<courses.length;i++)if(!await setupOneCourse(profile,courses[i],i,courses.length))break;
  const confirm=new Alert();confirm.title="Сохранить настройки?";
  confirm.message=`${profile.universityLabel}\n${home.name} (${home.direction}) → ${uni.name} (${uni.direction})\nПриоритеты: ${home.name} — ${(profile.stopPriorities.home||[]).join(", ")||"нет"}; ${uni.name} — ${(profile.stopPriorities.uni||[]).join(", ")||"нет"}\nПредметов в календаре: ${courses.length}. Списки можно изменить позже через «Настройки».`;
  confirm.addAction("Сохранить");confirm.addCancelAction("Отмена");if(await confirm.presentAlert()<0)return false;
  saveProfile(profile);
  const {fm,dir}=profileFiles();
  try {fm.writeString(fm.joinPath(dir,"calendar.json"),JSON.stringify({text:calendar.text,saved:Date.now(),source:calendar.url}));}catch{}
  return true;
}

function fontLabel(a,key,customKey) {return a[key]==="custom"?(a[customKey]||"свой не задан"):TEXT_FONTS[a[key]];}
async function chooseFontSetting(a,key,customKey,title) {
  const values=Object.keys(TEXT_FONTS);
  const selected=await setupChoice(title,"Можно выбрать встроенный стиль или ввести PostScript-имя любого установленного в iOS шрифта.",values.map(v=>(a[key]===v?"✓ ":"")+TEXT_FONTS[v]+(v==="custom"&&a[customKey]?" · "+a[customKey]:"")));
  if(selected<0)return false;
  const value=values[selected];
  if(value==="custom") {
    const input=await setupInput("Свой шрифт","Введи точное имя шрифта. Например, имя, которое показывает приложение со шрифтами.",[{label:"Имя шрифта",value:a[customKey]||""}]);
    if(!input)return false;
    const name=input[0].trim();if(!name)throw Error("Имя шрифта не может быть пустым.");
    try {new Font(name,12);} catch {throw Error("iOS не нашла шрифт «"+name+"». Проверь точное имя.");}
    a[customKey]=name;
  }
  a[key]=value;return true;
}
async function editWidgetSections(profile) {
  const a=profile.appearance;
  const choice=await setupChoice("Блоки виджета","Порядок ниже — реальный порядок на виджете. Блок можно скрыть, вернуть или передвинуть.",["↕ Изменить порядок","◉ Показать / скрыть","✎ Свой текст"]);
  if(choice<0)return false;
  if(choice===2)return editWidgetCustomText(profile);
  if(choice===1) {
    const id=await setupChoice("Показать / скрыть","Скрытые блоки остаются в настройках и их можно вернуть.",WIDGET_SECTIONS.map(x=>(a.widgetSections.includes(x)?"✓ ":"○ ")+WIDGET_SECTION_NAMES[x]));
    if(id<0)return false;const key=WIDGET_SECTIONS[id];
    if(a.widgetSections.includes(key))a.widgetSections=a.widgetSections.filter(x=>x!==key);else a.widgetSections.push(key);
    saveProfile(profile);return true;
  }
  if(!a.widgetSections.length)throw Error("Сначала включи хотя бы один блок.");
  const i=await setupChoice("Какой блок передвинуть?","Текущий порядок — сверху вниз.",a.widgetSections.map((x,n)=>(n+1)+". "+WIDGET_SECTION_NAMES[x]));if(i<0)return false;
  const move=await setupChoice(WIDGET_SECTION_NAMES[a.widgetSections[i]],"Куда передвинуть блок?",["В самый верх","На одну позицию выше","На одну позицию ниже","В самый низ"]);if(move<0)return false;
  const list=a.widgetSections,item=list.splice(i,1)[0];let to=move===0?0:move===1?Math.max(0,i-1):move===2?Math.min(list.length,i+1):list.length;list.splice(to,0,item);saveProfile(profile);return true;
}
function missingPlaceAddresses(p=SETTINGS,keys=["home","uni"]) {
  return keys.filter(k=>!(p.removedPlaces||[]).includes(k)&&(["home","uni"].includes(k)?!validLocationAnchor(p.locationAnchors[k]):!validLocationAnchor(p.extraPlaces.find(x=>x.key===k))));
}
async function setupMissingPlaceAddresses(keys=["home","uni"]) {
  let count=0;
  for(const key of missingPlaceAddresses(SETTINGS,keys)){
    const p=currentProfile();if(!await editLocationAnchor(p,key))break;count++;
  }
  return count;
}
function nextChainKey(p){let n=1;while(p.travelChains.some(c=>c.key==="chain_"+n))n++;return "chain_"+n;}
async function createTravelTemplate(p,round=false) {
  if(p.travelChains.length>=MAX_TRAVEL_CHAINS)throw Error("Уже добавлено 12 цепочек.");
  if(round&&placeKeys(p).length<3){await setupMessage("Нужно третье место","Сначала добавь, например, работу в Транспорт → Места.");return null;}
  const first=await choosePlaceKey(p,"Откуда начинается путь?");if(!first)return null;
  const second=await choosePlaceKey(p,"Следующее место",[first]);if(!second)return null;
  const sequence=[first,second];if(round){const third=await choosePlaceKey(p,"Третье место",sequence);if(!third)return null;sequence.push(third);}sequence.push(first);
  const chain={key:nextChainKey(p),name:"",legs:[]};
  for(let i=0;i<sequence.length-1;i++){
    const from=sequence[i],to=sequence[i+1],leg=await configureChainLeg(p,{from,to,stopKeys:placeStops(p,from).slice(),routes:null});
    if(!leg)return null;chain.legs.push(leg);
  }
  return chain;
}
function defaultMediumColumns(){return {header:0,classes:0,countdown:0,footer:0,weather:1,buses:1,location:1,custom:1};}
async function mediumLayoutSettings(a) {
  let changed=false;
  while(true){const n=await setupChoice("Средний виджет","Порядок применяется внутри колонки. В режиме списка порядок общий. Размеры и цвета каждого блока — в точной настройке.",[
    "✓ Готово","Компоновка: "+({dashboard:"компактная",columns:"две колонки",list:"список"}[a.mediumLayout]),"Ширина левой колонки · "+a.mediumColumnSplit+"%","Между колонками · "+a.mediumColumnGap+" pt","Распределить блоки по колонкам","Прогресс пары: "+(a.widgetClassProgress?"показан":"скрыт"),"Шаблон · больше места для пар","Шаблон · больше места для автобусов"]);
    if(n<=0)return changed;
    if(n===1){const modes=["dashboard","columns","list"],k=await setupChoice("Компоновка Medium","Компактная — на всю ширину: пара, кабинет, следующая пара и автобус. Остальные режимы сохраняют ручную компоновку.",["Компактная","Две колонки","Список"]);if(k<0)continue;a.mediumLayout=modes[k];a.mediumLayoutVersion=2;changed=true;}
    else if(n===2||n===3){if(await numericAppearance(a,n===2?"mediumColumnSplit":"mediumColumnGap",n===2?"Ширина левой колонки, %":"Расстояние между колонками, pt",n===2?30:0,n===2?70:24))changed=true;}
    else if(n===4){const keys=WIDGET_SECTIONS,k=await setupChoice("Блоки по колонкам","Нажми на блок, чтобы перенести его в другую колонку. Видимость блока этим не меняется.",keys.map(k=>WIDGET_SECTION_NAMES[k]+" · "+(a.mediumColumns[k]===0?"слева":"справа")));if(k<0)continue;a.mediumColumns[keys[k]]=1-a.mediumColumns[keys[k]];changed=true;}
    else if(n===5){a.widgetClassProgress=!a.widgetClassProgress;changed=true;}
    else {a.mediumLayout="columns";a.mediumLayoutVersion=2;a.mediumColumnSplit=n===6?65:40;a.mediumColumns=defaultMediumColumns();changed=true;}
  }
}

async function chooseJourney(p=currentProfile()) {
  if(!p.journeyPlanner.enabled)return null;
  const places=placeKeys(p);
  if(places.length<2){await setupMessage("Поездка","Для расчёта нужны хотя бы два места. Добавь их в настройках транспорта.");return null;}
  const chain=activeChain(p),legs=chain?.legs||
    (places.includes("home")&&places.includes("uni")?[{from:"home",to:"uni",routes:null},{from:"uni",to:"home",routes:null}]:[]);
  const i=await setupChoice("Рассчитать поездку","Пешие участки и пересадки считаются между адресами мест. Фильтры скрытых автобусов учитываются при посадке на сохранённых остановках.",[...legs.map(l=>directionName(l.from,l.to,p)),"Другие места"]);if(i<0)return null;
  let leg=legs[i];if(!leg){const from=await choosePlaceKey(p,"Откуда едем?");if(!from)return null;const to=await choosePlaceKey(p,"Куда едем?",[from]);if(!to)return null;leg={from,to,routes:null};}
  if(missingPlaceAddresses(p,[leg.from,leg.to]).length){await setupMissingPlaceAddresses([leg.from,leg.to]);p=currentProfile();if(missingPlaceAddresses(p,[leg.from,leg.to]).length)return null;}
  const from=placePoint(leg.from,p),to=placePoint(leg.to,p);
  if(!validLocationAnchor(from)||!validLocationAnchor(to))throw Error("Сначала задай адреса этих мест в настройках транспорта.");
  const now=new Date(),v=await setupInput(directionName(leg.from,leg.to,p),"Отправление не раньше этого времени. Поиск включает автобус и пешие участки.",[{label:"Дата · ГГГГ-ММ-ДД",value:dayKey(now)},{label:"Время · ЧЧ:ММ",value:time(now)}]);if(!v)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v[0])||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v[1]))throw Error("Дата: ГГГГ-ММ-ДД, время: ЧЧ:ММ.");
  const depart=fromWall([...v[0].split("-").map(Number),...v[1].split(":").map(Number)]);
  if(dayKey(depart)!==v[0]||time(depart)!==v[1])throw Error("Такой даты или местного времени нет.");
  if(+depart<+now-MINUTE)throw Error("Выбери настоящее или будущее время отправления.");
  return {from:{latitude:from.latitude,longitude:from.longitude},to:{latitude:to.latitude,longitude:to.longitude},fromName:placeName(leg.from,p),toName:placeName(leg.to,p),label:directionName(leg.from,leg.to,p),depart:+depart,routes:leg.routes};
}
function journeyQuery(selection,options=SETTINGS.journeyPlanner) {
  const point=p=>`{lat:${p.latitude},lon:${p.longitude}}`,date=new Date(selection.depart);
  return `{plan(from:${point(selection.from)},to:${point(selection.to)},date:${JSON.stringify(dayKey(date))},time:${JSON.stringify(time(date))},numItineraries:5,transportModes:[{mode:BUS},{mode:WALK}],maxTransfers:${options.maxTransfers},maxWalkDistance:${options.maxWalkDistance},minTransferTime:${options.transferMinutes*60},omitCanceled:true) { itineraries { startTime endTime duration legs { mode startTime endTime duration distance realTime route { shortName } from { name stop { gtfsId code } } to { name stop { gtfsId code } } } } } }`;
}
function journeyResults(raw,selection,options=SETTINGS.journeyPlanner) {
  if(!raw||!Array.isArray(raw.itineraries))throw Error("Peatus не вернул варианты поездки.");
  const all=transitStops(true);
  return raw.itineraries.filter(it=>{
    if(!it||!Number.isFinite(it.startTime)||!Number.isFinite(it.endTime)||it.endTime<=it.startTime||it.startTime<selection.depart-MINUTE||!Array.isArray(it.legs)||!it.legs.length)return false;
    let buses=0,walk=0,previous=it.startTime,lastBusEnd=null;
    for(const l of it.legs){
      if(!l||!["BUS","WALK"].includes(l.mode)||!Number.isFinite(l.startTime)||!Number.isFinite(l.endTime)||l.startTime<previous||l.endTime<l.startTime||l.endTime>it.endTime||!Number.isFinite(l.distance)||l.distance<0||typeof l.from?.name!=="string"||typeof l.to?.name!=="string")return false;
      previous=l.endTime;
      if(l.mode==="WALK")walk+=l.distance;
      else {if(lastBusEnd!==null&&l.startTime-lastBusEnd<options.transferMinutes*MINUTE)return false;lastBusEnd=l.endTime;buses++;const route=String(l.route?.shortName||"").trim().toUpperCase();if(!route||selection.routes&&!selection.routes.includes(route))return false;
        const boarded=l.from.stop;
        if(all.some(s=>(boarded?.gtfsId?s.id===boarded.gtfsId:
          !!(boarded?.code&&s.code===boarded.code&&s.name.trim().toLowerCase()===l.from.name.trim().toLowerCase()))&&!routeVisible(s,route)))return false;
      }
    }
    return buses>0&&buses-1<=options.maxTransfers&&walk<=options.maxWalkDistance;
  }).sort((a,b)=>a.startTime-b.startTime).slice(0,3);
}
async function loadJourney(selection) {
  const result=JSON.parse(await loadRequest(SETTINGS.apiURL,{query:journeyQuery(selection)},8));
  if(result.errors?.length)throw Error("Peatus сейчас не может рассчитать поездку. Попробуй позже.");
  return {itineraries:journeyResults(result.data?.plan,selection),saved:Date.now()};
}
function renderJourney({journeySelection,journeyData=null,journeyError="",journeyLoading=false,now=new Date()}) {
  const title=journeySelection.label,items=journeyData?.itineraries||[];
  const pointName=point=>!point.stop&&point.name==="Origin"?journeySelection.fromName||"Начальная точка":!point.stop&&point.name==="Destination"?journeySelection.toName||"Конечная точка":point.name;
  const content=journeyLoading?'<p role="status">Ищу поездки и пересадки…</p>':journeyError?'<p>'+escapeHTML(journeyError)+'</p>':!items.length?'<p>Подходящих поездок не найдено. Попробуй другое время или увеличь лимиты ходьбы и пересадок. Скрытые автобусы и номера перехода не возвращаются автоматически.</p>':items.map((it,i)=>{
    const buses=it.legs.filter(l=>l.mode==="BUS"),walk=Math.round(it.legs.filter(l=>l.mode==="WALK").reduce((n,l)=>n+l.distance,0));
    return `<article class="card"><h2>Вариант ${i+1} · ${escapeHTML(compactTime(new Date(it.startTime),now))}–${escapeHTML(compactTime(new Date(it.endTime),now))}</h2><p>${Math.ceil((it.endTime-it.startTime)/MINUTE)} мин · пересадок: ${buses.length-1} · пешком ${walk} м</p>${it.legs.map(l=>`<div class="leg"><b>${l.mode==="WALK"?"Пешком · "+Math.round(l.distance)+" м":"Автобус № "+escapeHTML(l.route.shortName)}</b><div>${escapeHTML(pointName(l.from))} → ${escapeHTML(pointName(l.to))}</div><small>${escapeHTML(compactTime(new Date(l.startTime),now))} — ${escapeHTML(compactTime(new Date(l.endTime),now))}${l.mode==="BUS"?l.realTime?" · онлайн":" · расписание":""}</small></div>`).join("")}</article>`;
  }).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">${screenThemeHead()}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style data-uniday-style>
  :root{--bg:#f3f3ed;--card:#fffefa;--ink:#243c32;--muted:#6b796e;--line:#dce5d9;--accent:#276848;--chip:#edf2e9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px -apple-system,sans-serif}main{max-width:600px;margin:auto;padding:24px 18px calc(24px + env(safe-area-inset-bottom))}h1,h2,div,p{overflow-wrap:anywhere}h1{font-size:1.6rem}h2{font-size:1.1rem}.card{background:var(--card);border-radius:18px;padding:16px;margin:16px 0}.leg{border-top:1px solid var(--line);padding:12px 0}.leg div{margin:6px 0}small,p{color:var(--muted)}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{display:block;min-height:48px;padding:12px;border-radius:12px;background:var(--card);color:var(--accent);text-decoration:none}.footer{font-size:.8rem}
  @media(prefers-color-scheme:dark){:root{--bg:#151e19;--card:#1f2c23;--ink:#e1ebdd;--muted:#a1af9f;--line:#324236;--accent:#b2d5a0;--chip:#2a3a2d}}${screenTypographyCSS()}</style></head><body><main><h1>${escapeHTML(title)}</h1><nav class="actions"><a class="button" href="${escapeHTML(actionURL("overview"))}">‹ К расписанию</a><a class="button" href="${escapeHTML(actionURL("journey"))}">Другой маршрут / время</a></nav><p>Отправление от ${escapeHTML(compactTime(new Date(journeySelection.depart),now))}. Поиск между адресами мест; набор остановок виджета не ограничивает пеший путь.</p>${content}<p class="footer">Peatus.ee${journeyData?" · данные на "+escapeHTML(time(new Date(journeyData.saved))):""}. Проверь пересадку перед поездкой.</p></main></body></html>`;
}

function placePoint(key,p=SETTINGS) {
  return p.extraPlaces.find(x=>x.key===key)||p.locationAnchors[key]||p.stops.find(s=>s.key===key)||null;
}
function directionName(from,to,p=SETTINGS){return placeName(from,p)+" → "+placeName(to,p);}
function stopDirectionName(stop,p=SETTINGS) {
  return stop.key==="home"?directionName("home","uni",p):stop.key==="uni"?directionName("uni","home",p):stop.name;
}
function chainName(chain,p=SETTINGS) {
  return chain.name||[chain.legs[0]?.from,...chain.legs.map(l=>l.to)].filter(Boolean).map(k=>placeName(k,p)).join(" → ");
}
function activeChain(p=SETTINGS){return p.travelChains.find(c=>c.key===p.activeTravelChain)||null;}
function activeChainLeg(position,p=SETTINGS) {
  if(!p.widgetNearbyStopFirst||position?.stale||!position?.side)return null;
  return activeChain(p)?.legs.find(l=>l.from===position.side)||null;
}
function validateTravelSettings(p) {
  const places=new Set(placeKeys(p)),stops=new Set([...p.stops,...p.extraStops].map(s=>s.key));
  const routes=x=>Array.isArray(x)&&x.length<=100&&x.every(r=>typeof r==="string"&&r.length>0&&r.length<=12&&!/[,;\s]/.test(r));
  if(!p.allowedRoutes||typeof p.allowedRoutes!=="object"||Array.isArray(p.allowedRoutes)||Object.entries(p.allowedRoutes).some(([k,v])=>!stops.has(k)||!routes(v)))throw Error("Повреждён список разрешённых автобусов.");
  if(!Array.isArray(p.travelChains)||p.travelChains.length>MAX_TRAVEL_CHAINS||p.travelChains.some(c=>!c||!/^chain_\d+$/.test(c.key)||typeof c.name!=="string"||c.name.length>80||!Array.isArray(c.legs)||!c.legs.length||c.legs.length>10||
    c.legs.some((l,i)=>!l||!places.has(l.from)||!places.has(l.to)||l.from===l.to||i>0&&c.legs[i-1].to!==l.from||!Array.isArray(l.stopKeys)||l.stopKeys.some(k=>!stops.has(k))||new Set(l.stopKeys).size!==l.stopKeys.length||l.routes!==null&&!routes(l.routes))||
    new Set(c.legs.map(l=>l.from)).size!==c.legs.length)||new Set(p.travelChains.map(c=>c.key)).size!==p.travelChains.length)throw Error("Проверь цепочки: последовательность мест, остановки и номера автобусов. Из одного места в цепочке может быть один выход.");
  if(p.activeTravelChain!==null&&!p.travelChains.some(c=>c.key===p.activeTravelChain))throw Error("Выбранная цепочка не найдена.");
  const j=p.journeyPlanner;
  if(!j||typeof j.enabled!=="boolean"||!Number.isInteger(j.maxTransfers)||j.maxTransfers<0||j.maxTransfers>4||!Number.isInteger(j.maxWalkDistance)||j.maxWalkDistance<100||j.maxWalkDistance>5000||!Number.isInteger(j.transferMinutes)||j.transferMinutes<1||j.transferMinutes>30)throw Error("Проверь настройки пересадок и пешего пути.");
}
async function choosePlaceKey(p,title,exclude=[]) {
  const keys=placeKeys(p).filter(k=>!exclude.includes(k));
  const i=await setupChoice(title,"Новые места и их адреса добавляются в Транспорт → Места.",keys.map(k=>placeName(k,p)));
  return i<0?null:keys[i];
}
async function configureChainLeg(p,leg) {
  const draft=JSON.parse(JSON.stringify(leg)),all=[...p.stops,...p.extraStops];
  while(true){const i=await setupChoice(directionName(draft.from,draft.to,p),"Выбери именно остановки ОТПРАВЛЕНИЯ и их сторону. Цепочка переключает виджет по месту; подробный экран сохраняет все остановки.",[
    "✓ Сохранить переход","Номера: "+(draft.routes===null?"все разрешённые на остановке":draft.routes.join(", ")||"все скрыты"),...all.map(s=>(draft.stopKeys.includes(s.key)?"☑ ":"☐ ")+s.name+" · "+s.direction)]);
    if(i<0)return null;if(i===0)return draft;
    if(i===1){const v=await setupInput("Автобусы этого перехода","Номера через запятую. Пустое поле — все разрешённые на остановке. Общие скрытые номера останутся скрытыми.",[{label:"Например: 3, 13",value:(draft.routes||[]).join(", ")}]);if(v){const raw=v[0].split(/[,;\s]+/).filter(Boolean);if(raw.some(r=>r.length>12)||raw.length>100)throw Error("Проверь номера автобусов.");draft.routes=raw.length?normalizeRouteNumbers(raw):null;}}
    else {const s=all[i-2];if(s)draft.stopKeys=draft.stopKeys.includes(s.key)?draft.stopKeys.filter(k=>k!==s.key):[...draft.stopKeys,s.key];}
  }
}
async function appendChainLeg(p,chain) {
  if(chain.legs.length>=10)throw Error("В цепочке уже 10 переходов.");
  const from=chain.legs.length?chain.legs[chain.legs.length-1].to:await choosePlaceKey(p,"Откуда начинается цепочка?");
  if(!from)return false;
  if(chain.legs.some(l=>l.from===from)){await setupMessage("Цепочка уже замкнулась","Из одного места может быть один выход. Для другого направления добавь отдельную цепочку.");return false;}
  const to=await choosePlaceKey(p,"Куда после «"+placeName(from,p)+"»?",[from]);if(!to)return false;
  const leg=await configureChainLeg(p,{from,to,stopKeys:placeStops(p,from).slice(),routes:null});if(!leg)return false;
  chain.legs.push(leg);return true;
}
async function replaceChainSequence(p,chain) {
  const draft={key:chain.key,name:chain.name,legs:[]};
  if(!await appendChainLeg(p,draft))return false;
  while(true){const i=await setupChoice("Новая последовательность",chainName(draft,p)+"\nСтарая цепочка сохраняется до нажатия «Сохранить».",["Сохранить последовательность","＋ Следующее место"]);
    if(i<0)return false;if(i===0){chain.legs=draft.legs;return true;}
    await appendChainLeg(p,draft);
  }
}
async function editTravelChain(p,chain) {
  while(true){const i=await setupChoice(chainName(chain,p),"Активная цепочка выбирает переход по твоему месту. В последнем месте без выхода автобусы цепочки не показываются.",[
    "✓ Готово",p.activeTravelChain===chain.key?"● Сейчас активна":"Сделать активной","Переименовать","＋ Добавить следующее место","Удалить последний переход","Удалить цепочку",...chain.legs.map(l=>directionName(l.from,l.to,p)+" · "+l.stopKeys.length+" ост."),"Изменить последовательность мест","Копировать цепочку"]);
    if(i<=0)return true;
    if(i===1)p.activeTravelChain=chain.key;
    else if(i===2){const v=await setupInput("Название цепочки","Пустое поле — названия мест автоматически.",[{label:"Название",value:chain.name}]);if(!v)continue;if(v[0].length>80)throw Error("Название до 80 символов.");chain.name=v[0];}
    else if(i===3){if(!await appendChainLeg(p,chain))continue;}
    else if(i===4){if(chain.legs.length===1){await setupMessage("Последний переход","В цепочке нужен хотя бы один переход. Можно удалить цепочку целиком.");continue;}chain.legs.pop();}
    else if(i===5){if(await setupChoice("Удалить цепочку?","Места и остановки сохранятся.",["Удалить"])<0)continue;p.travelChains=p.travelChains.filter(c=>c.key!==chain.key);if(p.activeTravelChain===chain.key)p.activeTravelChain=null;saveProfile(p);return true;}
    else if(i===7+chain.legs.length){if(p.travelChains.length>=MAX_TRAVEL_CHAINS)throw Error("Уже добавлено 12 цепочек.");const copy=JSON.parse(JSON.stringify(chain));copy.key=nextChainKey(p);copy.name=(chainName(chain,p)+" · копия").slice(0,80);p.travelChains.push(copy);saveProfile(p);await editTravelChain(p,copy);continue;}
    else if(i===6+chain.legs.length){if(!await replaceChainSequence(p,chain))continue;}
    else {const old=chain.legs[i-6];if(!old)continue;const leg=await configureChainLeg(p,old);if(!leg)continue;chain.legs[i-6]=leg;}
    saveProfile(p);
  }
}
async function journeyPlannerSettings(p) {
  while(true){const j=p.journeyPlanner,i=await setupChoice("Поездки с пересадками","Дополнительный поиск Peatus по адресам сохранённых мест. Запускается кнопкой в подробном экране; открытие виджета не замедляет.",[
    "✓ Готово","Поиск поездок: "+(j.enabled?"включён":"выключен"),"Лимиты пересадок и ходьбы"]);if(i<=0)return true;
    if(i===1)j.enabled=!j.enabled;
    else {const v=await setupInput("Поиск поездки","Пересадки: 0–4, пешком: 100–5000 м, запас на пересадку: 1–30 мин.",[{label:"Максимум пересадок",value:j.maxTransfers},{label:"Максимум пешком, м",value:j.maxWalkDistance},{label:"Запас на пересадку, мин",value:j.transferMinutes}]);if(!v)continue;const next={...j,maxTransfers:Number(v[0]),maxWalkDistance:Number(v[1]),transferMinutes:Number(v[2])};validateTravelSettings({...p,journeyPlanner:next});p.journeyPlanner=next;}
    saveProfile(p);
  }
}
async function travelChainSettings(p) {
  while(true){const i=await setupChoice("Цепочки поездок","По умолчанию: "+directionName("home","uni",p)+" и обратно. Можно хранить 12 своих цепочек; активна одна. Места переименовываются в разделе «Места».",[
    "✓ Готово",(p.activeTravelChain===null?"● ":"")+"Обычный режим · места и их остановки","＋ Добавить цепочку","Расчёт поездок с пересадками",...p.travelChains.map(c=>(c.key===p.activeTravelChain?"● ":"")+chainName(c,p)),"＋ Шаблон · туда и обратно","＋ Шаблон · круг через три места"]);
    if(i<=0)return true;
    if(i===1){p.activeTravelChain=null;saveProfile(p);}
    else if(i===2){if(p.travelChains.length>=MAX_TRAVEL_CHAINS)throw Error("Уже добавлено 12 цепочек.");let n=1;while(p.travelChains.some(c=>c.key==="chain_"+n))n++;const chain={key:"chain_"+n,name:"",legs:[]};if(!await appendChainLeg(p,chain))continue;p.travelChains.push(chain);p.activeTravelChain=chain.key;saveProfile(p);await editTravelChain(p,chain);}
    else if(i===3)await journeyPlannerSettings(p);
    else if(i>=4+p.travelChains.length){const chain=await createTravelTemplate(p,i===5+p.travelChains.length);if(!chain)continue;p.travelChains.push(chain);p.activeTravelChain=chain.key;saveProfile(p);await editTravelChain(p,chain);}
    else await editTravelChain(p,p.travelChains[i-4]);
  }
}

function placeKeys(profile=SETTINGS) {return ["home","uni"].filter(k=>!(profile.removedPlaces||[]).includes(k)).concat(profile.extraPlaces.map(p=>p.key));}
function placeName(key,profile=SETTINGS) {return profile.locationNames[key]||profile.extraPlaces.find(p=>p.key===key)?.name||"Место";}
function configuredPlaceStops(profile,key) {
  return key==="home"?profile.widgetStopKeysHome:key==="uni"?profile.widgetStopKeysUni:profile.extraPlaces.find(p=>p.key===key)?.stopKeys??null;
}
function setPlaceStops(profile,key,keys) {
  if(key==="home")profile.widgetStopKeysHome=keys;else if(key==="uni")profile.widgetStopKeysUni=keys;else profile.extraPlaces.find(p=>p.key===key).stopKeys=keys;
}
function placeStops(profile,key) {
  const chosen=configuredPlaceStops(profile,key);if(chosen!==null)return chosen;
  // Null is the automatic origin set. Never inherit the opposite main platform here.
  if(key==="home"||key==="uni")return [...new Set([...profile.stops.filter(s=>s.key===key).map(s=>s.key),...profile.widgetStopKeys.filter(k=>k!=="home"&&k!=="uni")])];
  return profile.widgetStopKeys;
}
function safeOriginStopKeys(profile,side,keys) {
  if(side!=="home"&&side!=="uni"||!keys.length)return keys;
  const own=profile.stops.find(s=>s.key===side),opposite=profile.stops.find(s=>s.key===(side==="home"?"uni":"home"));
  const anchor=profile.locationAnchors?.[side]||own;
  if(!own||!opposite||!validLocationAnchor(anchor))return keys;
  const ownDistance=distanceMeters(anchor,own),otherDistance=distanceMeters(anchor,opposite);
  if(otherDistance<2000||otherDistance<ownDistance+1500)return keys;
  // A saved set can accidentally contain the opposite platform. Do not let that
  // turn a home widget into "University → Home" (or vice versa).
  const cleaned=keys.filter(k=>k!==opposite.key);
  return cleaned.length?cleaned:keys.includes(opposite.key)?[own.key]:keys;
}
function placeOrder(profile,key) {return key==="home"?profile.widgetStopOrderHome:key==="uni"?profile.widgetStopOrderUni:profile.extraPlaces.find(p=>p.key===key)?.stopOrder||[];}
function setPlaceOrder(profile,key,order) {if(key==="home")profile.widgetStopOrderHome=order;else if(key==="uni")profile.widgetStopOrderUni=order;else profile.extraPlaces.find(p=>p.key===key).stopOrder=order;}
function effectiveStopKeys(position,profile=SETTINGS) {
  const side=profile.widgetNearbyStopFirst&&!position?.stale?position?.side:null;
  const chain=activeChain(profile);
  if(chain&&side&&placeKeys(profile).includes(side))return safeOriginStopKeys(profile,side,chain.legs.find(l=>l.from===side)?.stopKeys.slice()||[]);
  const keys=side&&placeKeys(profile).includes(side)?placeStops(profile,side):profile.widgetStopKeys;
  const order=side?placeOrder(profile,side):keys;
  return safeOriginStopKeys(profile,side,[...order.filter(k=>keys.includes(k)),...keys.filter(k=>!order.includes(k))]);
}
function normalizeProfileWidgetOrders(profile) {
  const valid=new Set([...profile.stops,...profile.extraStops].map(s=>s.key)),clean=v=>[...new Set((v||[]).filter(k=>valid.has(k)))];
  profile.widgetStopKeys=clean(profile.widgetStopKeys);
  for(const key of placeKeys(profile)) {
    const selected=configuredPlaceStops(profile,key);if(selected!==null)setPlaceStops(profile,key,clean(selected));
    const base=placeStops(profile,key),order=clean(placeOrder(profile,key)).filter(k=>base.includes(k));
    setPlaceOrder(profile,key,[...order,...base.filter(k=>!order.includes(k))]);
  }
  profile.widgetStopCount=profile.widgetStopKeys.length;
}
async function placeStopSettings(profile,key) {
  const all=[...profile.stops,...profile.extraStops];
  while(true){const selected=placeStops(profile,key),i=await setupChoice("Остановки · "+placeName(key,profile),"Этот набор включается только в виджете рядом с выбранным местом. Активная цепочка имеет приоритет над этим набором. Изменения сохраняются сразу.",[
    "✓ Готово","Использовать обычный набор","Скрыть все остановки здесь",...all.map(s=>(selected.includes(s.key)?"☑ ":"☐ ")+s.name+" · "+s.direction),"Авто · основная остановка этого места"]);
    if(i<=0)return true;
    if(i===1)setPlaceStops(profile,key,profile.widgetStopKeys.slice());
    else if(i===2)setPlaceStops(profile,key,[]);
    else if(i===all.length+3)setPlaceStops(profile,key,null);
    else {const stop=all[i-3];if(!stop)continue;setPlaceStops(profile,key,selected.includes(stop.key)?selected.filter(k=>k!==stop.key):[...selected,stop.key]);}
    normalizeProfileWidgetOrders(profile);saveProfile(profile);
  }
}
async function editZoneStopOrder(profile,key) {
  normalizeProfileWidgetOrders(profile);const all=[...profile.stops,...profile.extraStops];
  while(true){const list=placeOrder(profile,key),i=await setupChoice("Порядок · "+placeName(key,profile),"Выбери остановку, чтобы переместить её в начало.",["✓ Готово",...list.map((k,n)=>(n+1)+". "+(all.find(s=>s.key===k)?.name||k))]);if(i<=0)return true;
    setPlaceOrder(profile,key,[list[i-1],...list.filter((_,n)=>n!==i-1)]);saveProfile(profile);
  }
}
async function chooseAddressPoint(name,city,initial=null) {
  const i=await setupChoice("Место · "+name,anchorLabel(initial),["Найти по адресу","Я сейчас здесь · сохранить геопозицию"]);if(i<0)return null;
  if(i===1)return {...await captureLocationPoint(),address:"Место, где я сохранил геопозицию"};
  const v=await setupInput("Адрес · "+name,"Укажи город и улицу с номером дома. Поиск через Peatus.ee.",[{label:"Город",value:city},{label:"Улица и дом",value:""}]);if(!v)return null;
  const found=await searchAddress(v[1],v[0]);if(!found.length)throw Error("Адрес в этом городе не найден. Уточни его или выбери текущую геопозицию.");
  const n=await setupChoice("Выбери адрес","Проверь город и номер дома.",found.map(x=>x.address));return n<0?null:found[n];
}
async function placeSettings(profile,key) {
  while(true){const extra=profile.extraPlaces.find(p=>p.key===key),primary=!extra,point=primary?profile.locationAnchors[key]:extra;
    const radius=primary?profile.locationRadii[key]:extra.radiusMeters;
    const n=await setupChoice(placeName(key,profile),"Адрес: "+anchorLabel(point)+". В перекрывающихся зонах выбирается ближайшая точка.",[
      "✓ Готово","Адрес / текущее местоположение","Переименовать","Остановки · "+placeStops(profile,key).length,"Порядок остановок","Радиус · "+radius+" м",...(primary?[]:["Удалить место"])]);
    if(n<=0)return true;
    if(n===1){if(primary)await editLocationAnchor(profile,key);else{const chosen=await chooseAddressPoint(extra.name,profile.city,extra);if(chosen){Object.assign(extra,chosen);saveProfile(profile);}}}
    else if(n===2){const v=await setupInput("Название места","От 1 до 40 символов.",[{label:"Название",value:placeName(key,profile)}]);if(!v)continue;if(!v[0]||v[0].length>40)throw Error("Введи название от 1 до 40 символов.");if(primary)profile.locationNames[key]=v[0];else extra.name=v[0];saveProfile(profile);}
    else if(n===3)await placeStopSettings(profile,key);
    else if(n===4)await editZoneStopOrder(profile,key);
    else if(n===5){const v=await setupInput("Радиус места","От 100 до 3000 метров.",[{label:"Метры",value:String(radius)}]);if(!v)continue;const value=Number(v[0]);if(!Number.isInteger(value)||value<100||value>3000)throw Error("Введи целое число от 100 до 3000.");if(primary)profile.locationRadii[key]=value;else extra.radiusMeters=value;saveProfile(profile);}
    else if(extra){const confirm=await setupChoice("Удалить «"+extra.name+"»?","Остановки останутся. Цепочки, проходящие через это место, будут удалены.",["Удалить место"]);if(confirm<0)continue;profile.extraPlaces=profile.extraPlaces.filter(p=>p.key!==key);profile.travelChains=profile.travelChains.filter(c=>!c.legs.some(l=>l.from===key||l.to===key));if(!profile.travelChains.some(c=>c.key===profile.activeTravelChain))profile.activeTravelChain=null;saveProfile(profile);return true;}
  }
}
async function locationOrderSettings(profile) {
  normalizeProfileWidgetOrders(profile);
  while(true){const keys=placeKeys(profile),i=await setupChoice("Места и остановки","Основные места уже есть. Можно добавить до 8 своих мест. Рядом с местом виджет включает его набор остановок; вдали от всех мест — обычный. Подробное табло не фильтруется.",[
    "✓ Готово","Автопереключение: "+(profile.widgetNearbyStopFirst?"включено":"выключено"),"＋ Добавить место",...keys.map(k=>placeName(k,profile)),"Проверить выбор места сейчас"]);
    if(i<=0)return true;
    if(i===1){profile.widgetNearbyStopFirst=!profile.widgetNearbyStopFirst;saveProfile(profile);}
    else if(i===2){if(profile.extraPlaces.length>=8)throw Error("Уже добавлено 8 своих мест.");const v=await setupInput("Новое место","Например: Работа, Спортзал, Библиотека.",[{label:"Название",value:""}]);if(!v)continue;if(!v[0]||v[0].length>40)throw Error("Введи название от 1 до 40 символов.");
      const point=await chooseAddressPoint(v[0],profile.city);if(!point)continue;let n=1;while(keys.includes("place_"+n))n++;const key="place_"+n;
      profile.extraPlaces.push({...point,key,name:v[0],radiusMeters:500,stopKeys:null,stopOrder:profile.widgetStopKeys.slice()});saveProfile(profile);await placeStopSettings(profile,key);
    }else if(i===3+keys.length)await diagnoseWidgetLocation(profile);
    else await placeSettings(profile,keys[i-3]);
  }
}

async function diagnoseWidgetLocation(profile) {
  let timer,point=null,error="";
  try{
    Location.setAccuracyToHundredMeters();
    point=await Promise.race([currentLocationFix(),new Promise((_,reject)=>{timer=Timer.schedule(Math.max(4,SETTINGS.locationTimeoutSeconds)*1000,false,()=>reject(Error("GPS timeout")));})]);
  }catch(e){error=String(e.message||e);}finally{if(timer)timer.invalidate();}
  const side=point?locationSide(point):null,accuracy=Number.isFinite(point?.horizontalAccuracy)?Math.round(point.horizontalAccuracy):null;
  const places=locationZones().map(z=>placeName(z.key,profile)+": "+(point&&validLocationAnchor(point)?Math.round(distanceMeters(point,z))+" м":"GPS нет")+" / радиус "+z.radiusMeters+" м");
  const selected=side?effectiveStopKeys({side},profile).map(k=>[...profile.stops,...profile.extraStops].find(s=>s.key===k)?.name||k).join(", "):"обычный набор без подтверждённого места";
  await setupMessage("Проверка места",(profile.widgetNearbyStopFirst?"Автопереключение включено":"Автопереключение выключено")+"\n"+
    "iPhone видит: "+(side?placeName(side,profile):"место не определено")+(accuracy!==null?" · точность ±"+accuracy+" м":"")+"\n"+
    places.join("\n")+"\nОстановки виджета: "+selected+(error?"\nОшибка GPS: "+error:""));
}

async function captureLocationPoint() {
  let timer;
  try {
    Location.setAccuracyToHundredMeters();
    const point=await Promise.race([currentLocationFix(),new Promise((_,reject)=>{timer=Timer.schedule(Math.max(4,SETTINGS.locationTimeoutSeconds)*1000,false,()=>reject(Error("GPS timeout")));})]);
    if(!point||!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||Math.abs(point.latitude)>90||Math.abs(point.longitude)>180)throw Error("iPhone не вернул координаты.");
    if(!Number.isFinite(point.horizontalAccuracy)||point.horizontalAccuracy<0||point.horizontalAccuracy>400)throw Error("Геопозиция слишком неточная. Попробуй ещё раз или найди место по адресу.");
    return {latitude:point.latitude,longitude:point.longitude};
  } finally {if(timer)timer.invalidate();}
}
function readPackingChecks(fm,path) {
  if(!fm.fileExists(path))return {};
  const value=JSON.parse(fm.readString(path));
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.entries(value).some(([day,items])=>!/^\d{4}-\d{2}-\d{2}$/.test(day)||!items||typeof items!=="object"||Array.isArray(items)||Object.values(items).some(v=>typeof v!=="boolean")))throw Error("Сохранённые галочки не прочитаны. Файл не перезаписан.");
  return value;
}
function packingCheckKey(item) {return JSON.stringify([String(item)]);}
function savePackingCheck(fm,path,date,item,checked) {
  const value=readPackingChecks(fm,path),items={...(value[date]||{})};
  // Store false explicitly: an unchecked item stays unchecked on every reopening.
  items[packingCheckKey(item)]=checked;value[date]=items;
  fm.writeString(path,JSON.stringify(value));return value;
}
function visiblePackingItems(model,date) {
  const now=model.now,today=dayKey(now),tomorrow=dayKey(shiftDay(now,1));
  if(![today,tomorrow].includes(date))return [];
  const start=date===today?dayBounds(now)[0]:shiftDay(now,1),end=shiftDay(start,1);
  const lessons=date===today?model.lessons:(model.upcoming||[]).filter(l=>l.start<end&&l.end>start);
  return [...new Set([...packData(lessons).items,...(model.packing?.[date]||[])])];
}
function livePackingUI() {
  for(const input of document.querySelectorAll('input[data-pack-url]'))input.addEventListener('change',()=>{
    input.dataset.pending='1';window.location.assign(input.dataset.packUrl+'&checked='+(input.checked?'1':'0'));
  });
}
function handlePackingCheck(url,model,fm,view) {
  const match=url.match(/&checked=([01])$/);if(!match)return false;
  const base=url.slice(0,match.index),dates=[dayKey(model.now),dayKey(shiftDay(model.now,1))];
  for(const date of dates)for(const item of visiblePackingItems(model,date)) {
    if(actionURL("pack-check",{date,item})!==base)continue;
    try {const path=fm.joinPath(fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder),"packing-checks.json");model.packingChecks=savePackingCheck(fm,path,date,item,match[1]==="1");}
    catch(error){
      // No full-page redraw: keep scroll position and restore the last successfully saved state.
      const previous=model.packingChecks?.[date]?.[packingCheckKey(item)]===true;
      const js=`(()=>{const e=[...document.querySelectorAll('input[data-pack-url]')].find(e=>e.dataset.packUrl===${JSON.stringify(base)});if(e)e.checked=${previous};alert(${JSON.stringify(String(error.message||error))});})()`;
      Promise.resolve(view.evaluateJavaScript(js)).catch(()=>{});
    }
    return true;
  }
  return false;
}
async function searchAddress(address,city) {
  if(address.trim().length<3||city.trim().length<2)throw Error("Укажи город и улицу с номером дома.");
  const url="https://api.peatus.ee/geocoding/v1/search?text="+encodeURIComponent(city+" "+address)+"&size=40&boundary.country=EST&layers=address,venue";
  const result=JSON.parse(await loadRequest(url));
  if(!Array.isArray(result.features))throw Error("Сервис адресов не ответил. Можно сохранить текущую геопозицию.");
  const seen=new Set();return result.features.filter(f=>stopIsInCity(f,city)).flatMap(f=>{
    const [longitude,latitude]=f.geometry?.coordinates||[],label=f.properties?.label;
    if(f.geometry?.type!=="Point"||!validLocationAnchor({latitude,longitude})||typeof label!=="string"||!label||label.length>250)return [];
    const key=JSON.stringify([latitude,longitude]);if(seen.has(key))return [];seen.add(key);return [{latitude,longitude,address:label}];
  });
}
function anchorLabel(point) {return validLocationAnchor(point)?point.address||"Сохранённая точка":"не задана";}
async function editLocationAnchor(profile,side) {
  const name=placeName(side,profile),current=profile.locationAnchors?.[side]||null,main=profile.stops.find(s=>s.key===side);
  const actions=["address","current",...(validLocationAnchor(main)?["main"]:[]),...(current?["delete"]:[])];
  const labels=actions.map(x=>({address:"Найти по адресу",current:"Я сейчас здесь · сохранить геопозицию",main:"Использовать основную остановку",delete:"Удалить сохранённую точку"})[x]);
  const i=await setupChoice("Место · "+name,"Сейчас: "+anchorLabel(current)+". Используется для выбора остановок этого места.",labels);if(i<0)return false;
  let chosen=null;
  if(actions[i]==="address"){const v=await setupInput("Адрес · "+name,"Поиск через Peatus.ee. Укажи улицу и номер дома; координаты вводить не нужно.",[{label:"Город",value:profile.city},{label:"Улица и дом",value:""}]);if(!v)return false;
    const found=await searchAddress(v[1],v[0]);if(!found.length)throw Error("В этом городе адрес не найден. Уточни улицу и номер или выбери «Я сейчас здесь».");
    const n=await setupChoice("Выбери адрес","Проверь номер дома и город перед сохранением.",found.map(x=>x.address));if(n<0)return false;chosen=found[n];
  }else if(actions[i]==="current"){chosen={...await captureLocationPoint(),address:"Место, где я сохранил геопозицию"};}
  else if(actions[i]==="main"){chosen={latitude:main.latitude,longitude:main.longitude,address:main.name+" · "+main.direction};}
  profile.locationAnchors={...profile.locationAnchors,[side]:chosen};saveProfile(profile);return true;
}

async function editWidgetStops(profile) {
  const all=[...profile.stops,...profile.extraStops],byKey=new Map(all.map(s=>[s.key,s]));
  profile.widgetStopKeys=(profile.widgetStopKeys||[]).filter(k=>byKey.has(k));
  normalizeProfileWidgetOrders(profile);
  const commit=()=>{normalizeProfileWidgetOrders(profile);saveProfile(profile);};
  while(true) {
    const choice=await setupChoice("Остановки на виджете","Галочка сохраняется СРАЗУ. Снял галочку — этой остановки на виджете не будет. Можно снять все галочки и оставить блок автобусов пустым. Выбрано: "+profile.widgetStopKeys.length,
      ["✓ Готово","↕ Изменить порядок",...all.map(s=>(profile.widgetStopKeys.includes(s.key)?"☑ ":"☐ ")+s.name+" · "+s.direction)]);
    if(choice<0 || choice===0)break;
    if(choice===1) {
      if(profile.widgetStopKeys.length<2){await setupMessage("Порядок","Нужно выбрать хотя бы две остановки, чтобы менять их порядок.");continue;}
      const i=await setupChoice("Какую остановку передвинуть?","Текущий порядок — сверху вниз.",profile.widgetStopKeys.map((k,n)=>(n+1)+". "+(byKey.get(k)?.name||k)));if(i<0)continue;
      const move=await setupChoice(byKey.get(profile.widgetStopKeys[i])?.name||"Остановка","Куда передвинуть?",["В самый верх","На одну позицию выше","На одну позицию ниже","В самый низ"]);if(move<0)continue;
      const list=profile.widgetStopKeys,item=list.splice(i,1)[0];let to=move===0?0:move===1?Math.max(0,i-1):move===2?Math.min(list.length,i+1):list.length;list.splice(to,0,item);commit();continue;
    }
    const stop=all[choice-2];if(!stop)continue;
    if(profile.widgetStopKeys.includes(stop.key))profile.widgetStopKeys=profile.widgetStopKeys.filter(k=>k!==stop.key);
    else profile.widgetStopKeys.push(stop.key);
    commit();
  }
  normalizeProfileWidgetOrders(profile);
  return true;
}


async function editWidgetCustomText(profile) {
  const a=profile.appearance,commit=()=>saveProfile(profile);
  while(true) {
    const lines=profile.widgetCustomText||[];
    const labels=["✓ Готово","＋ Добавить строку",...lines.map((x,i)=>(i+1)+". "+(x.length>54?x.slice(0,53)+"…":x))];
    if(lines.length)labels.push("Очистить весь текст");
    const choice=await setupChoice("Свой текст на виджете","Каждое изменение сохраняется сразу. Можно добавить до 8 отдельных строк; блок можно переставить среди остальных блоков.",labels);
    if(choice<0||choice===0)break;
    if(choice===1) {
      if(lines.length>=8){await setupMessage("Лимит","Можно добавить максимум 8 строк.");continue;}
      const value=await setupInput("Новая строка","Напиши текст, который должен появиться на виджете.",[{label:"Текст",value:""}]);if(!value)continue;
      const text=value[0].trim();if(!text)continue;if(text.length>120)throw Error("Одна строка может содержать максимум 120 символов.");
      profile.widgetCustomText.push(text);if(!a.widgetSections.includes("custom"))a.widgetSections.push("custom");commit();continue;
    }
    const clearIndex=2+lines.length;
    if(lines.length && choice===clearIndex){
      const confirm=await setupChoice("Удалить свой текст?","Будут удалены все строки собственного текста.",["Удалить всё"]);if(confirm===0){profile.widgetCustomText=[];commit();}continue;
    }
    const index=choice-2;if(index<0||index>=lines.length)continue;
    const action=await setupChoice("Строка "+(index+1),lines[index],["Изменить","Удалить","Поднять выше","Опустить ниже"]);if(action<0)continue;
    if(action===0){const value=await setupInput("Изменить строку","",[{label:"Текст",value:lines[index]}]);if(!value)continue;const text=value[0].trim();if(!text)profile.widgetCustomText.splice(index,1);else {if(text.length>120)throw Error("Одна строка может содержать максимум 120 символов.");profile.widgetCustomText[index]=text;}commit();}
    else if(action===1){profile.widgetCustomText.splice(index,1);commit();}
    else if(action===2&&index>0){[profile.widgetCustomText[index-1],profile.widgetCustomText[index]]=[profile.widgetCustomText[index],profile.widgetCustomText[index-1]];commit();}
    else if(action===3&&index<profile.widgetCustomText.length-1){[profile.widgetCustomText[index+1],profile.widgetCustomText[index]]=[profile.widgetCustomText[index],profile.widgetCustomText[index+1]];commit();}
  }
  return true;
}

const WALLPAPER_LAYOUTS={
  "2796":{labels:{small:510,medium:1092,large:1146,left:98,right:681,top:252,middle:888,bottom:1524},largeIcons:{small:530,medium:1139,large:1136,left:75,right:684,top:252,middle:858,bottom:1464},legacy:{small:510,medium:1092,large:1146,left:99,right:681,top:282,middle:918,bottom:1554}},
  "2622":{labels:{small:486,medium:1032,large:1098,left:87,right:633,top:261,middle:872,bottom:1485},largeIcons:{small:495,medium:1037,large:1035,left:84,right:626,top:270,middle:810,bottom:1350}},
  "2556":{labels:{small:474,medium:1017,large:1062,left:81,right:624,top:240,middle:828,bottom:1416},largeIcons:{small:495,medium:1047,large:1047,left:66,right:618,top:243,middle:795,bottom:1347},legacy:{small:474,medium:1014,large:1062,left:82,right:622,top:270,middle:858,bottom:1446}},
  "2778":{legacy:{small:510,medium:1092,large:1146,left:96,right:678,top:246,middle:882,bottom:1518}},
  "2532":{legacy:{small:474,medium:1014,large:1062,left:78,right:618,top:231,middle:819,bottom:1407}},
  "2688":{legacy:{small:507,medium:1080,large:1137,left:81,right:654,top:228,middle:858,bottom:1488}},
  "1792":{legacy:{small:338,medium:720,large:758,left:55,right:437,top:159,middle:579,bottom:999}},
  "2436":{legacyX:{small:465,medium:987,large:1035,left:69,right:591,top:213,middle:783,bottom:1353},legacyMini:{small:465,medium:987,large:1035,left:69,right:591,top:231,middle:801,bottom:1371}},
  "2208":{legacy:{small:471,medium:1044,large:1071,left:99,right:672,top:114,middle:696,bottom:1278}},
  "1334":{labels:{small:296,medium:642,large:648,left:54,right:400,top:60,middle:412,bottom:764},largeIcons:{small:309,medium:667,large:667,left:41,right:399,top:67,middle:425,bottom:783},legacy:{small:296,medium:642,large:648,left:54,right:400,top:60,middle:412,bottom:764}},
  "1136":{legacy:{small:282,medium:584,large:622,left:30,right:332,top:59,middle:399,bottom:399}},
  "1624":{legacy:{small:310,medium:658,large:690,left:46,right:394,top:142,middle:522,bottom:902}},
  "2001":{legacy:{small:444,medium:963,large:972,left:81,right:600,top:90,middle:618,bottom:1146}}
};
function cropWallpaperImage(image,rect) {const draw=new DrawContext();draw.size=new Size(rect.width,rect.height);draw.drawImageAtPoint(image,new Point(-rect.x,-rect.y));return draw.getImage();}
async function manualWallpaperRect(image,family) {
  const defaultW=family==="small"?Math.round(image.size.width*.39):Math.round(image.size.width*.84),defaultH=family==="large"?Math.round(image.size.height*.42):Math.round(image.size.height*.19);
  const input=await setupInput("Ручная обрезка","Размер скриншота не найден в таблице. Введи координаты в пикселях. X/Y — левый верхний угол будущего виджета.",[{label:"X",value:"0"},{label:"Y",value:"0"},{label:"Ширина",value:String(defaultW)},{label:"Высота",value:String(defaultH)}]);if(!input)return null;
  const [x,y,width,height]=input.map(Number);if([x,y,width,height].some(v=>!Number.isInteger(v))||x<0||y<0||width<1||height<1||x+width>image.size.width||y+height>image.size.height)throw Error("Обрезка выходит за границы скриншота.");return {x,y,width,height,variant:"manual",position:"manual"};
}
async function setupWallpaperBackground(profile) {
  const familyIndex=await setupChoice("Размер виджета","Сделай отдельный фон для каждого размера, который используешь.",["Small","Medium","Large"]);if(familyIndex<0)return false;
  const family=["small","medium","large"][familyIndex];
  await setupMessage("Снимок главного экрана","На iPhone открой пустую страницу главного экрана с теми же обоями и расположением иконок и сделай скриншот. Для точного совпадения можно после обрезки задать поправку X/Y.");
  const source=await setupChoice("Как взять скриншот?","Если только что сделал скриншот, первый вариант быстрее.",["Использовать последний скриншот","Выбрать из Фото"]);if(source<0)return false;
  const image=source===0?await Photos.latestScreenshot():await Photos.fromLibrary(),height=String(Math.round(image.size.height));
  if(image.size.height<=image.size.width)throw Error("Нужен вертикальный скриншот главного экрана.");
  const variants=WALLPAPER_LAYOUTS[height];let rect;
  if(!variants)rect=await manualWallpaperRect(image,family);
  else {
    const available=Object.keys(variants),labels={labels:"Обычные иконки с подписями",largeIcons:"Крупные иконки без подписей",legacy:"Старые координаты (iOS 17 и ниже)",legacyX:"iPhone X / XS / 11 Pro · старые координаты",legacyMini:"iPhone 12/13 mini · старые координаты"};
    const vi=await setupChoice("Разметка главного экрана","Если после установки фон немного съедет, запусти настройку ещё раз и используй поправку X/Y.",available.map(k=>labels[k]||k));if(vi<0)return false;
    const variant=available[vi],phone=variants[variant];
    let x,y,position;
    if(family==="small") {const positions=[["Сверху слева","left","top"],["Сверху справа","right","top"],["Посередине слева","left","middle"],["Посередине справа","right","middle"],["Снизу слева","left","bottom"],["Снизу справа","right","bottom"]],pi=await setupChoice("Положение Small","Выбери точную ячейку виджета.",positions.map(x=>x[0]));if(pi<0)return false;position=positions[pi][0];x=phone[positions[pi][1]];y=phone[positions[pi][2]];rect={x,y,width:phone.small,height:phone.small,variant,position};}
    else if(family==="medium") {const positions=[["Сверху","top"],["Посередине","middle"],["Снизу","bottom"]],pi=await setupChoice("Положение Medium","Выбери строку виджета.",positions.map(x=>x[0]));if(pi<0)return false;position=positions[pi][0];rect={x:phone.left,y:phone[positions[pi][1]],width:phone.medium,height:phone.small,variant,position};}
    else {const positions=[["Сверху","top"],["Снизу","middle"]],pi=await setupChoice("Положение Large","Large снизу начинается со второй строки.",positions.map(x=>x[0]));if(pi<0)return false;position=positions[pi][0];rect={x:phone.left,y:phone[positions[pi][1]],width:phone.medium,height:phone.large,variant,position};}

  }
  if(!rect)return false;
  return adjustWallpaper(profile,family,image,rect);
}
async function backgroundSettings(profile) {
  const a=profile.appearance,names={solid:"Сплошной цвет",clear:"Прозрачный цвет (эксперимент)",wallpaper:"Под обои (визуально прозрачный)"};
  const choice=await setupChoice("Фон виджета","Настоящий визуально прозрачный Home Screen виджет делается снимком соответствующего участка обоев. Режим «прозрачный цвет» зависит от поведения iOS.",["Режим: "+names[a.widgetBackgroundMode],"Настроить фон под обои","Удалить сохранённые фоны","Сдвинуть / увеличить сохранённый фон"]);if(choice<0)return false;
  if(choice===1)return setupWallpaperBackground(profile);
  if(choice===3)return editSavedWallpaper(profile);
  if(choice===2) {a.wallpaperBackgrounds={};if(a.widgetBackgroundMode==="wallpaper")a.widgetBackgroundMode="solid";return true;}
  const modes=["solid","clear","wallpaper"],available=modes.filter(x=>x!=="wallpaper"||Object.keys(a.wallpaperBackgrounds||{}).length);
  const i=await setupChoice("Режим фона","Для режима под обои сначала должен быть сохранён хотя бы один crop.",available.map(x=>(a.widgetBackgroundMode===x?"✓ ":"")+names[x]));if(i<0)return false;a.widgetBackgroundMode=available[i];return true;
}
const SCREEN_SECTIONS=["header","weather","today","week","packing","buses","footer","countdown"];
const SCREEN_SECTION_NAMES={countdown:"Таймер перерыва",header:"Дата и время",weather:"Погода",today:"Сегодня",week:"Расписание недели",packing:"Взять с собой",buses:"Автобусы",footer:"Время обновления"};
function effectiveWidgetSections(family=widgetFamilyKey()) {return SETTINGS.appearance.familySections?.[family]??SETTINGS.appearance.widgetSections;}
async function visibilitySettings(profile,screen=false) {
  const a=profile.appearance,keys=screen?SCREEN_SECTIONS:WIDGET_SECTIONS,names=screen?SCREEN_SECTION_NAMES:WIDGET_SECTION_NAMES;
  let family=null;
  if(!screen){const n=await setupChoice("Блоки виджета","Можно настроить каждый размер отдельно.",["Общий набор","Small","Medium","Large"]);if(n<0)return false;family=[null,"small","medium","large"][n];}
  const get=()=>screen?a.screenSections:family?(a.familySections[family]??a.widgetSections):a.widgetSections;
  const put=list=>{if(screen)a.screenSections=list;else if(family)a.familySections[family]=list;else a.widgetSections=list;};
  let changed=false;
  while(true){const list=get(),n=await setupChoice(screen?"Блоки главного экрана":"Блоки · "+(family||"общие"),"Нажми на блок, чтобы скрыть или вернуть. Изменения сохраняются сразу. Настройки всегда доступны.",[
    "✓ Готово",...keys.map(k=>(list.includes(k)?"☑ ":"☐ ")+names[k]),"↕ Порядок видимых блоков",...(family?["Использовать общий набор"]:[])]);
    if(n<=0)return changed;
    if(n<=keys.length){const key=keys[n-1];put(list.includes(key)?list.filter(x=>x!==key):[...list,key]);}
    else if(family&&n===keys.length+2){a.familySections[family]=null;}
    else {if(list.length<2)continue;const i=await setupChoice("Передвинуть в начало","Выбери блок.",list.map(k=>names[k]));if(i<0)continue;put([list[i],...list.filter((_,j)=>i!==j)]);}
    saveProfile(profile);changed=true;
  }
}
async function numericAppearance(a,key,title,min=70,max=180) {
  const v=await setupInput(title,`От ${min} до ${max}%. Большие буквы уменьшают количество строк, помещающихся в виджете.`,[{label:"Проценты",value:String(a[key])}]);if(!v)return false;
  const n=Number(v[0]);if(!Number.isInteger(n)||n<min||n>max)throw Error(`Введи целое число от ${min} до ${max}.`);a[key]=n;return true;
}
async function screenTextSettings(a) {
  const i=await setupChoice("Экран · текст и карточки","Применяется к расписанию, вещам, табло и остановкам рейса.",[
    "Размер текста · "+a.screenScale+"%","Шрифт · "+fontLabel(a,"screenFont","screenCustomFont"),"Насыщенность текста","Отступы","Скругление карточек"]);if(i<0)return false;
  if(i===0)return numericAppearance(a,"screenScale","Размер текста экрана",70,180);
  if(i===1)return chooseFontSetting(a,"screenFont","screenCustomFont","Шрифт экрана");
  const values=i===2?[0,400,500,600,700,800]:i===3?["compact","normal","airy"]:[0,8,12,16,20,24,28,32];
  const labels=i===2?["По умолчанию","Обычный","Средний","Полужирный","Жирный","Очень жирный"]:i===3?["Компактные","Обычные","Свободные"]:values.map(x=>x+" pt");
  const k=await setupChoice("Оформление экрана","Выбери вариант.",labels);if(k<0)return false;a[i===2?"screenWeight":i===3?"screenDensity":"screenRadius"]=values[k];return true;
}
async function widgetTextSettings(a) {
  const i=await setupChoice("Виджет · текст и вместимость","Масштабы перемножаются. Когда места мало, второстепенные строки скрываются, а не уменьшают всё до нечитаемого текста.",[
    "Общий масштаб · "+a.widgetScale+"%","Масштаб отдельно для Small / Medium / Large","Шрифт заголовков","Размер заголовков · "+a.categoryScale+"%",
    "Шрифт содержимого","Размер содержимого · "+a.bodyScale+"%","Размер текущей пары · "+a.currentScale+"%","Размер следующей пары · "+a.nextScale+"%","Размер автобуса · "+a.busScale+"%",
    "Насыщенность текста","Отступы","Большой виджет · вместимость"]);if(i<0)return false;
  if(i===1){const k=await setupChoice("Размер виджета","Индивидуальная поправка к общему масштабу.",["Small","Medium","Large"]);if(k<0)return false;return numericAppearance(a.familyScales,["small","medium","large"][k],"Масштаб размера");}
  if(i===2||i===4)return chooseFontSetting(a,i===2?"categoryFont":"bodyFont",i===2?"categoryCustomFont":"bodyCustomFont",i===2?"Шрифт заголовков":"Шрифт содержимого");
  const numeric={0:"widgetScale",3:"categoryScale",5:"bodyScale",6:"currentScale",7:"nextScale",8:"busScale"};
  if(numeric[i])return numericAppearance(a,numeric[i],"Масштаб текста");
  const values=i===9?["auto","regular","bold","heavy"]:i===10?["compact","normal","airy"]:["auto","compact","expanded"];
  const labels=i===9?["По умолчанию","Обычный","Жирный","Очень жирный"]:i===10?["Компактные","Обычные","Свободные"]:["Авто · по размеру экрана","Только основное","Больше пар и рейсов · для большого экрана"];
  const k=await setupChoice("Виджет",i===11?"Физический размер остаётся Large. На Pro Max доступно больше места; Extra Large на iPhone отсутствует.":"Выбери вариант.",labels);if(k<0)return false;a[i===9?"widgetWeight":i===10?"widgetDensity":"largeLayout"]=values[k];return true;
}
async function previewWidget() {
  const i=await setupChoice("Предпросмотр виджета","Показывает текущие настройки и данные. Обновлением виджета на рабочем столе управляет iOS.",["Small","Medium","Large"]);if(i<0)return;
  const {model}=await main({skipSetup:true,returnModel:true,cacheOnly:true}),family=["small","medium","large"][i];
  if(SETTINGS.widgetNearbyStopFirst){const {fm,dir}=profileFiles();model.position=await locate(fm,fm.joinPath(dir,"location-zone.json"),new Date());}
  const storedWeather=model.weather&&!model.weather.missing?{weather:model.weather,saved:model.weatherSaved,observedAt:model.weatherSaved,stale:model.weatherStale}:null;
  const widget=buildLargeWidget({...model,family,storedWeather});await widget[["presentSmall","presentMedium","presentLarge"][i]]();
}
async function appearanceSettings() {
  const p=currentProfile(),a=p.appearance;
  const i=await setupChoice("Оформление","Цвета, шрифты и состав блоков настраиваются независимо.",[
    "Экран · шрифт, размер и карточки","Виджеты · шрифты, размеры и вместимость","Цвета · палитры или HEX","Фон виджета · цвет и обои",
    "Блоки виджетов · скрыть / показать / порядок","Блоки главного экрана · скрыть / показать","Свой текст виджета","Предпросмотр Small / Medium / Large","Сбросить оформление","Точная настройка · размеры блоков, времени, поля","Medium · две колонки / список"]);
  if(i<0)return false;
  if(i===10){if(!await mediumLayoutSettings(a))return false;}
  if(i===7){await previewWidget();return false;}
  if(i===0){if(!await screenTextSettings(a))return false;}
  if(i===1){if(!await widgetTextSettings(a))return false;}
  if(i===2){if(!await colorSettings(p))return false;}
  if(i===3){if(!await backgroundSettings(p))return false;}
  if(i===4)return visibilitySettings(p,false);
  if(i===5)return visibilitySettings(p,true);
  if(i===6){if(!await editWidgetCustomText(p))return false;}
  if(i===9){if(!await fineLayoutSettings(p))return false;}
  if(i===8){const n=await setupChoice("Сбросить оформление?","Цвета, шрифты и видимость блоков вернутся к исходным. Расписание, остановки и списки вещей сохранятся.",["Сбросить оформление"]);if(n<0)return false;p.appearance=appearanceDefaults();}
  saveProfile(p);return true;
}
async function profileSettingsMenu(date=new Date()) {
  const i=await setupChoice("Настройки UniDay","Выбери раздел. Профиль хранится отдельно от кода и сохраняется при обновлении.",[
    "Учёба · расписание, предметы и вещи","Транспорт · маршруты, остановки и геопозиция","Оформление · цвета, шрифты и блоки","Импорт настроек","Диагностика запуска"]);if(i<0)return false;
  if(i===4)return showLaunchDiagnostics();if(i===1)return transportSettings();if(i===2)return appearanceSettings();if(i===3)return importProfile();
  const k=await setupChoice("Учёба и вещи","Свои заметки редактируются кнопкой у занятия.",["Расписание и основные остановки","Вещи и формат по предметам","Что брать всегда","Категории вещей","Свои правки · вернуть скрытые занятия","Нумерация учебных недель","Обновить ссылку этого расписания","Настроить новые предметы"]);if(k<0)return false;
  const p=currentProfile();if(k===7){const {fm,dir}=profileFiles(),calendar=await loadCalendar(fm,fm.joinPath(dir,"calendar.json"),new Date());const courses=discoverNewCourses(calendar.events);if(!courses.length){await setupMessage("Новые предметы","Новых предметов для настройки пока нет.");return false;}return (await setupNewCourses(courses))>0;}if(k===6)return replaceCalendarLink();if(k===5)return studyWeekSettings(date);if(k===4)return restoreLessonEdits();if(k===0)return setupWizard(p);if(k===3)return packingCategorySettings();
  if(k===2){const v=await setupInput("Что брать всегда?","Перечисли через точку с запятой.",[{label:"Вещи",value:p.alwaysBring.join("; ")}]);if(!v)return false;p.alwaysBring=splitThings(v[0]);}
  else {const {fm,dir}=profileFiles(),calendar=await loadCalendar(fm,fm.joinPath(dir,"calendar.json"),new Date()),courses=setupCourses(calendar.events);
    const n=await setupChoice("Предмет","Названия остаются на языке календаря.",courses.map(courseTitle));if(n<0||!await setupOneCourse(p,courses[n]))return false;}
  saveProfile(p);return true;
}

function settingURLValue(url,key){const match=url.match(new RegExp("(?:[?&])"+key+"=([^&#]*)"));try{return match?decodeURIComponent(match[1]):"";}catch{return "";}}
function removeStopFromProfile(profile,key){
  profile.stops=profile.stops.filter(s=>s.key!==key);profile.extraStops=profile.extraStops.filter(s=>s.key!==key);
  profile.widgetStopKeys=profile.widgetStopKeys.filter(k=>k!==key);
  for(const side of ["home","uni"]){const selected=configuredPlaceStops(profile,side);if(selected!==null)setPlaceStops(profile,side,selected.filter(k=>k!==key));}
  for(const place of profile.extraPlaces)if(place.stopKeys!==null)place.stopKeys=place.stopKeys.filter(k=>k!==key);
  for(const chain of profile.travelChains)for(const leg of chain.legs)leg.stopKeys=leg.stopKeys.filter(k=>k!==key);
  delete profile.stopPriorities[key];delete profile.hiddenRoutes[key];delete profile.allowedRoutes[key];normalizeProfileWidgetOrders(profile);
}
function removePlaceFromProfile(profile,key){
  if(key==="home"||key==="uni"){
    profile.removedPlaces=[...new Set([...profile.removedPlaces,key])];profile.locationAnchors[key]=null;
    setPlaceStops(profile,key,null);setPlaceOrder(profile,key,[]);removeStopFromProfile(profile,key);
    profile.locationNames[key]=key==="home"?"Дом":"Универ";
  }else profile.extraPlaces=profile.extraPlaces.filter(x=>x.key!==key);
  profile.travelChains=profile.travelChains.filter(c=>!c.legs.some(l=>l.from===key||l.to===key));
  if(!profile.travelChains.some(c=>c.key===profile.activeTravelChain))profile.activeTravelChain=null;
  normalizeProfileWidgetOrders(profile);
}
async function settingsPalette(profile,target,custom=false){
  const a=profile.appearance,keys=["bg","card","ink","muted","accent"];
  let colors;if(custom){const base=target==="screen"?(a.screenColors||COLOR_PALETTES.forest):{bg:a.widgetBackground,card:a.widgetBackground,ink:a.widgetText,muted:a.widgetMuted,accent:a.widgetAccent};
    const fields=(target==="screen"?keys:keys.filter(k=>k!=="card")).map(k=>({label:{bg:"Фон",card:"Карточки",ink:"Основной текст",muted:"Вторичный текст",accent:"Акцент"}[k],value:base[k]}));
    const values=await setupInput("Свои цвета · "+(target==="screen"?"экран":"виджет"),"Формат #RRGGBB. Цвета виджета сохраняются независимо от режима обоев.",fields);if(!values)return false;
    if(values.some(x=>!/^#[0-9a-f]{6}$/i.test(x)))throw Error("Цвет должен быть в формате #RRGGBB.");colors={...base,...Object.fromEntries(fields.map((_,i)=>[(target==="screen"?keys:keys.filter(k=>k!=="card"))[i],values[i].toLowerCase()]))};
  }else{const options=Object.keys(COLOR_PALETTES),i=await setupChoice("Готовые гаммы · "+(target==="screen"?"экран":"виджет"),"Выбери цвета. Фон под обои останется включённым.",options.map(k=>COLOR_PALETTES[k].name));if(i<0)return false;colors=colorValues(COLOR_PALETTES[options[i]]);}
  if(target==="screen")a.screenColors=colors;
  else {a.widgetBackground=colors.bg;a.widgetText=colors.ink;a.widgetMuted=colors.muted;a.widgetAccent=colors.accent;}
  saveProfile(profile);return true;
}
async function editSettingBlock(profile,family,key,mode,screen=false){
  const map=screen?profile.appearance.screenBlocks:profile.appearance.widgetBlocks[family],names=screen?SCREEN_SECTION_NAMES:WIDGET_SECTION_NAMES,b={...blockDefaults(),...map[key]};
  if(mode==="reset"){delete map[key];saveProfile(profile);return true;}
  if(mode==="size"){
    const v=await setupInput("Текст · "+names[key],"50–300% от обычного размера текста.",[{label:"Размер, %",value:b.scale}]);if(!v)return false;
    Object.assign(b,parseBlockDimensions(v,BLOCK_DIMENSION_FIELDS.filter(([k])=>k==="scale")));
  }else if(mode==="geometry"){
    const v=await setupInput("Геометрия · "+names[key],"Высота 0 — по содержимому. Размеры ограничены физическим размером iPhone.",[{label:"Ширина, 30–100%",value:b.width},{label:"Минимальная высота, 0–1200 pt",value:b.height},{label:"Скругление, 0–40 pt",value:b.radius}]);if(!v)return false;
    Object.assign(b,parseBlockDimensions(v,BLOCK_DIMENSION_FIELDS.filter(([k])=>["width","height","radius"].includes(k))));
  }else if(mode==="spacing"){
    const v=await setupInput("Поля · "+names[key],"Строки текста от 1 до 4. При нехватке места iOS ограничит содержимое виджета.",[{label:"Поля, 0–40 pt",value:b.padding},{label:"Между строками, 0–24 pt",value:b.gap},{label:"Строк текста, 1–4",value:b.lines}]);if(!v)return false;
    Object.assign(b,parseBlockDimensions(v,BLOCK_DIMENSION_FIELDS.filter(([k])=>["padding","gap","lines"].includes(k))));
  }else if(mode==="colors"){
    const v=await setupInput("Цвета · "+names[key],"Пусто — прозрачный блок или текст общей темы. Для погоды можно также задать общий цвет на странице «Цвета и обои».",[{label:"Фон #RRGGBB",value:b.background},{label:"Текст #RRGGBB",value:b.color}]);if(!v)return false;
    if(v.some(x=>x&&!/^#[0-9a-f]{6}$/i.test(x)))throw Error("Цвет должен быть #RRGGBB.");[b.background,b.color]=v;
  }else return false;
  map[key]=b;saveProfile(profile);return true;
}
async function previewWidgetFamily(family){
  const {model}=await main({skipSetup:true,returnModel:true,cacheOnly:true});
  if(SETTINGS.widgetNearbyStopFirst){const {fm,dir}=profileFiles();model.position=await locate(fm,fm.joinPath(dir,"location-zone.json"),new Date());}
  const storedWeather=model.weather&&!model.weather.missing?{weather:model.weather,saved:model.weatherSaved,observedAt:model.weatherSaved,stale:model.weatherStale}:null;
  const widget=buildLargeWidget({...model,family,storedWeather});await widget[{small:"presentSmall",medium:"presentMedium",large:"presentLarge"}[family]]();
}
async function performSettingOperation(op,params={},model=null){
  const p=currentProfile(),a=p.appearance,key=params.key,family=params.family,section=params.section;
  const validFamily=["small","medium","large"].includes(family),validBlock=validFamily&&WIDGET_SECTIONS.includes(section);
  if(op==="calendar-link")return replaceCalendarLink();
  if(op==="study-weeks")return studyWeekSettings(model?.weekStart||new Date());
  if(op==="new-courses"){const {fm,dir}=profileFiles(),calendar=await loadCalendar(fm,fm.joinPath(dir,"calendar.json"),new Date()),courses=discoverNewCourses(calendar.events);if(!courses.length){await setupMessage("Новые предметы","Новых предметов для настройки пока нет.");return false;}return (await setupNewCourses(courses))>0;}
  if(op==="course-items"){const {fm,dir}=profileFiles(),calendar=await loadCalendar(fm,fm.joinPath(dir,"calendar.json"),new Date()),courses=setupCourses(calendar.events);const n=await setupChoice("Предмет","Названия остаются на языке календаря.",courses.map(courseTitle));if(n<0||!await setupOneCourse(p,courses[n]))return false;saveProfile(p);return true;}
  if(op==="always-bring"){const v=await setupInput("Что брать всегда?","Через точку с запятой.",[{label:"Вещи",value:p.alwaysBring.join("; ")}]);if(!v)return false;p.alwaysBring=splitThings(v[0]);saveProfile(p);return true;}
  if(op==="packing-categories")return packingCategorySettings();
  if(op==="restore-lessons")return restoreLessonEdits();
  if(op==="setup-wizard")return setupWizard(p);
  if(op==="toggle-auto"){p.widgetNearbyStopFirst=!p.widgetNearbyStopFirst;saveProfile(p);return true;}
  if(op==="departure-count"||op==="widget-departure-count"){
    const name=op==="departure-count"?"departureCount":"widgetDepartureCount",max=name==="departureCount"?10:8;
    const v=await setupInput("Количество рейсов","От 1 до "+max+" на остановку.",[{label:"Количество",value:p[name]}]);if(!v)return false;const n=Number(v[0]);if(!Number.isInteger(n)||n<1||n>max)throw Error("Введи число от 1 до "+max+".");p[name]=n;saveProfile(p);return true;
  }
  if(op==="general-stops")return editWidgetStops(p);
  if(op==="hidden-routes"){if(!await hiddenRoutesSettings(p))return false;saveProfile(p);return true;}
  if(op==="priority-routes"){const stops=[...p.stops,...p.extraStops],n=await setupChoice("Приоритетные номера","Выбери остановку.",stops.map(s=>s.name+" · "+s.direction));if(n<0||!await editStopPriorities(p,stops[n]))return false;saveProfile(p);return true;}
  if(op==="travel-chains")return travelChainSettings(p);
  if(op==="journey-planner")return journeyPlannerSettings(p);
  if(op==="location-diagnostic")return diagnoseWidgetLocation(p);
  if(op==="add-place"){
    if(p.extraPlaces.length>=8)throw Error("Уже добавлено 8 мест.");const v=await setupInput("Добавить место","Например, Работа или Спортзал.",[{label:"Название",value:""}]);if(!v)return false;if(!v[0]||v[0].length>40)throw Error("Название от 1 до 40 символов.");
    const point=await chooseAddressPoint(v[0],p.city);if(!point)return false;let n=1;while(placeKeys(p).includes("place_"+n))n++;p.extraPlaces.push({...point,key:"place_"+n,name:v[0],radiusMeters:500,stopKeys:null,stopOrder:[]});normalizeProfileWidgetOrders(p);saveProfile(p);return true;
  }
  if(op.startsWith("place-")||op==="clear-place-address"||op==="delete-place"||op==="restore-place"){
    const primary=key==="home"||key==="uni",extra=p.extraPlaces.find(x=>x.key===key);if(!primary&&!extra)throw Error("Место не найдено.");
    if(op==="restore-place"){
      if(!primary||!p.removedPlaces.includes(key))return false;const stop=await setupStop(key,null,p.city);if(!stop)return false;p.stops.push(stop);p.removedPlaces=p.removedPlaces.filter(k=>k!==key);p.stopPriorities[key]=[];p.widgetStopKeys=[...new Set([...p.widgetStopKeys,key])];normalizeProfileWidgetOrders(p);saveProfile(p);return true;
    }
    if(op==="delete-place"){
      const n=await setupChoice("Удалить «"+placeName(key,p)+"»?","Адрес и привязки остановок будут удалены. Расписание, заметки и другие места сохранятся.",["Удалить место"]);if(n<0)return false;removePlaceFromProfile(p,key);saveProfile(p);return true;
    }
    if(op==="clear-place-address"){
      if(!primary)throw Error("Дополнительное место требует адреса. Его можно заменить или удалить.");p.locationAnchors[key]=null;saveProfile(p);return true;
    }
    if(op==="place-address"){
      if(primary)return editLocationAnchor(p,key);
      const point=await chooseAddressPoint(extra.name,p.city,extra);if(!point)return false;Object.assign(extra,point);saveProfile(p);return true;
    }
    if(op==="place-name"){
      const v=await setupInput("Название места","Это имя будет в виджете и поездках.",[{label:"Название",value:placeName(key,p)}]);if(!v)return false;if(!v[0]||v[0].length>40)throw Error("Название от 1 до 40 символов.");if(primary)p.locationNames[key]=v[0];else extra.name=v[0];saveProfile(p);return true;
    }
    if(op==="place-radius"){
      const current=primary?p.locationRadii[key]:extra.radiusMeters,v=await setupInput("Радиус места","От 100 до 3000 метров.",[{label:"Радиус, м",value:current}]);if(!v)return false;const n=Number(v[0]);if(!Number.isInteger(n)||n<100||n>3000)throw Error("Радиус: 100–3000 м.");if(primary)p.locationRadii[key]=n;else extra.radiusMeters=n;saveProfile(p);return true;
    }
    if(op==="place-stops")return placeStopSettings(p,key);
    if(op==="place-order")return editZoneStopOrder(p,key);
  }
  if(op==="add-stop"||op==="restore-stop"){
    if(op==="restore-stop"&&(!["home","uni"].includes(key)||p.stops.some(s=>s.key===key)||p.removedPlaces.includes(key)))return false;
    if(op==="add-stop"&&p.extraStops.length>=6)throw Error("Уже добавлено 6 дополнительных остановок.");
    let stopKey=key;if(op==="add-stop"){let n=1;while([...p.stops,...p.extraStops].some(s=>s.key==="extra_"+n))n++;stopKey="extra_"+n;}
    const stop=await setupStop(stopKey,null,p.city);if(!stop)return false;
    if(op==="add-stop")p.extraStops.push(stop);else p.stops.push(stop);
    p.stopPriorities[stopKey]=[];p.widgetStopKeys=[...new Set([...p.widgetStopKeys,stopKey])];normalizeProfileWidgetOrders(p);saveProfile(p);return true;
  }
  if(["replace-stop","stop-priorities","stop-hidden","delete-stop"].includes(op)){
    const stop=[...p.stops,...p.extraStops].find(s=>s.key===key);if(!stop)throw Error("Остановка не найдена.");
    if(op==="delete-stop"){
      const n=await setupChoice("Удалить остановку?",stop.name+" · "+stop.direction+". Место и другие остановки останутся. Её можно добавить заново.",["Удалить остановку"]);if(n<0)return false;removeStopFromProfile(p,key);saveProfile(p);return true;
    }
    if(op==="replace-stop"){
      const replacement=await setupStop(key,stop,p.city);if(!replacement)return false;
      if(p.stops.some(s=>s.key===key))p.stops=p.stops.map(s=>s.key===key?replacement:s);else p.extraStops=p.extraStops.map(s=>s.key===key?replacement:s);
      if(replacement.id!==stop.id){p.stopPriorities[key]=[];p.hiddenRoutes[key]=[];delete p.allowedRoutes[key];}
      saveProfile(p);return true;
    }
    if(op==="stop-priorities"){if(!await editStopPriorities(p,stop))return false;saveProfile(p);return true;}
    if(op==="stop-hidden")return stopRoutesMenu(stop);
  }
  if(op==="preview-family"){if(!validFamily)return false;await previewWidgetFamily(family);return false;}
  if(op==="stop-limit"){
    if(!validFamily)return false;const cap={small:1,medium:2,large:4}[family],n=await setupChoice("Остановок · "+family,"Предел постоянный: свободное место после пар не добавит остановку само. Если включишь больше, некоторые второстепенные строки уступят им место.",Array.from({length:cap},(_,i)=>(a.widgetStopLimits[family]===i+1?"✓ ":"")+(i+1)));if(n<0)return false;a.widgetStopLimits[family]=n+1;saveProfile(p);return true;
  }
  if(op==="toggle-widget-block"){
    if(!validBlock)return false;const list=(a.familySections[family]??a.widgetSections).slice();a.familySections[family]=list.includes(section)?list.filter(k=>k!==section):[...list,section];saveProfile(p);return true;
  }
  if(op==="widget-order"){
    if(!validFamily)return false;const list=(a.familySections[family]??a.widgetSections).slice();if(list.length<2)return false;
    const i=await setupChoice("Порядок блоков · "+family,"Какой блок переместить в начало?",list.map(k=>WIDGET_SECTION_NAMES[k]));if(i<0)return false;
    a.familySections[family]=[list[i],...list.filter((_,n)=>n!==i)];saveProfile(p);return true;
  }
  if(op==="column-split"||op==="column-gap"){
    const field=op==="column-split"?"mediumColumnSplit":"mediumColumnGap",min=op==="column-split"?30:0,max=op==="column-split"?70:24;
    const v=await setupInput("Medium · "+(op==="column-split"?"ширина левой колонки":"промежуток"),"От "+min+" до "+max+(op==="column-split"?"%":" pt")+".",[{label:"Размер",value:a[field]}]);if(!v)return false;
    const n=Number(v[0]);if(!Number.isInteger(n)||n<min||n>max)throw Error("Введи число от "+min+" до "+max+".");a[field]=n;saveProfile(p);return true;
  }
  if(op==="column-lane"){
    if(!WIDGET_SECTIONS.includes(section))return false;a.mediumColumns[section]=a.mediumColumns[section]===0?1:0;saveProfile(p);return true;
  }
  if(op==="toggle-screen-block"){
    if(!SCREEN_SECTIONS.includes(section))return false;const list=a.screenSections.slice();a.screenSections=list.includes(section)?list.filter(k=>k!==section):[...list,section];saveProfile(p);return true;
  }
  if(op==="screen-order"){
    if(a.screenSections.length<2)return false;const i=await setupChoice("Первый блок","Выбери блок, который переместить в начало.",a.screenSections.map(k=>SCREEN_SECTION_NAMES[k]));if(i<0)return false;
    a.screenSections=[a.screenSections[i],...a.screenSections.filter((_,n)=>n!==i)];saveProfile(p);return true;
  }
  if(op.startsWith("screen-block-")){if(!SCREEN_SECTIONS.includes(section))return false;return editSettingBlock(p,null,section,op.slice(13),true);}
  if(op.startsWith("block-")){if(!validBlock)return false;return editSettingBlock(p,family,section,op.slice(6));}
  if(op==="family-scale"){if(!validFamily)return false;if(!await numericAppearance(a.familyScales,family,"Размер текста · "+family))return false;saveProfile(p);return true;}
  const numeric={"weather-scale":["weatherScale",50,300],"current-scale":["currentScale",70,180],"next-scale":["nextScale",70,180],"bus-scale":["busScale",70,180],"time-scale":["timeScale",50,300],"meta-scale":["metaScale",50,300],"category-scale":["categoryScale",70,180],"body-scale":["bodyScale",70,180],"screen-scale":["screenScale",70,180],"screen-time":["screenTimeScale",50,300],"screen-heading":["screenHeadingScale",50,300]};
  if(numeric[op]){const [field,min,max]=numeric[op];if(!await numericAppearance(a,field,"Размер · "+field,min,max))return false;saveProfile(p);return true;}
  if(op==="weather-color"){
    const v=await setupInput("Цвет погоды","HEX #RRGGBB. Пусто — общий акцент. Не влияет на режим прозрачных обоев.",[{label:"Цвет",value:a.weatherTextColor}]);if(!v)return false;if(v[0]&&!/^#[0-9a-f]{6}$/i.test(v[0]))throw Error("Нужен HEX #RRGGBB.");a.weatherTextColor=v[0].toLowerCase();saveProfile(p);return true;
  }
  if(op==="body-font"||op==="category-font"||op==="screen-font"){
    const stem=op==="body-font"?"body":op==="category-font"?"category":"screen";if(!await chooseFontSetting(a,stem+"Font",stem+"CustomFont","Шрифт · "+stem))return false;saveProfile(p);return true;
  }
  if(op==="custom-text"){if(!await editWidgetCustomText(p))return false;saveProfile(p);return true;}
  if(op==="class-progress"){a.widgetClassProgress=!a.widgetClassProgress;saveProfile(p);return true;}
  if(["medium-layout","large-layout","widget-weight","widget-density","widget-alignment"].includes(op)){
    const choices={"medium-layout":[["dashboard","columns","list"],["На всю ширину","Две колонки","Список"]],"large-layout":[["auto","compact","expanded"],["Обычно","Компактно","Больше деталей"]],"widget-weight":[["auto","regular","bold","heavy"],["Системная","Обычная","Жирная","Очень жирная"]],"widget-density":[["compact","normal","airy"],["Компактная","Обычная","Свободная"]],"widget-alignment":[["top","center","bottom"],["Вверху","По центру","Внизу"]]};
    const [values,labels]=choices[op],i=await setupChoice("Компоновка виджета","Выбери вариант.",labels);if(i<0)return false;
    a[{"medium-layout":"mediumLayout","large-layout":"largeLayout","widget-weight":"widgetWeight","widget-density":"widgetDensity","widget-alignment":"widgetAlignment"}[op]]=values[i];if(op==="medium-layout")a.mediumLayoutVersion=2;saveProfile(p);return true;
  }
  if(op==="widget-spacing"){
    const v=await setupInput("Поля виджета","Поля 0–32 pt, расстояние между блоками 0–24 pt.",[{label:"Поля, pt",value:a.widgetPadding},{label:"Между блоками, pt",value:a.widgetGap}]);if(!v)return false;
    const n=v.map(Number);if(!Number.isInteger(n[0])||n[0]<0||n[0]>32||!Number.isInteger(n[1])||n[1]<0||n[1]>24)throw Error("Проверь поля и расстояние.");[a.widgetPadding,a.widgetGap]=n;saveProfile(p);return true;
  }
  if(op==="screen-weight"||op==="screen-density"||op==="screen-radius"){
    const values=op==="screen-weight"?[0,400,500,600,700,800]:op==="screen-density"?["compact","normal","airy"]:[0,8,12,16,20,24,28,32];
    const labels=op==="screen-weight"?["По умолчанию","Обычный","Средний","Полужирный","Жирный","Очень жирный"]:op==="screen-density"?["Компактные","Обычные","Свободные"]:values.map(x=>x+" pt");
    const i=await setupChoice("Экран · "+(op==="screen-weight"?"насыщенность":op==="screen-density"?"плотность":"скругление"),"Выбери вариант.",labels);if(i<0)return false;a[op==="screen-weight"?"screenWeight":op==="screen-density"?"screenDensity":"screenRadius"]=values[i];saveProfile(p);return true;
  }
  if(op==="screen-visibility")return visibilitySettings(p,true);
  if(op==="screen-blocks")return blockEditor(p,true);
  if(op==="widget-palette"||op==="widget-hex"||op==="screen-palette"||op==="screen-hex")return settingsPalette(p,op.startsWith("screen")?"screen":"widget",op.endsWith("hex"));
  if(op==="screen-default"){a.screenColors=null;saveProfile(p);return true;}
  if(op==="widget-background"){if(!await backgroundSettings(p))return false;saveProfile(p);return true;}
  if(op==="import")return importProfile();
  if(op==="reset-appearance"){const n=await setupChoice("Сбросить оформление?","Заметки, расписание, вещи и транспорт останутся.",["Сбросить оформление"]);if(n<0)return false;p.appearance=appearanceDefaults();saveProfile(p);return true;}
  if(op==="launch-diagnostics")return showLaunchDiagnostics();
  return false;
}

async function editStopPriorities(profile,stop) {
  const current=(profile.stopPriorities[stop.key]||[]).join(", ");
  const values=await setupInput("Приоритетные автобусы · "+stop.name,"Можно несколько номеров через запятую, пробел или ;. Они будут показаны первыми только у этой остановки. Пусто = без приоритета.",[{label:"Например: 3, 6, 12",value:current}]);
  if(!values)return false;
  const routes=[...new Set(values[0].split(/[,;\s]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))];
  if(routes.some(x=>x.length>12||/[,;\s]/.test(x)))throw Error("Неверный номер маршрута.");
  profile.stopPriorities[stop.key]=routes;return true;
}
async function transportSettings() {
  const profile=currentProfile(),all=()=>[...profile.stops,...profile.extraStops];
  normalizeProfileWidgetOrders(profile);
  const selectedNames=()=>profile.widgetStopKeys.map(k=>all().find(s=>s.key===k)?.name).filter(Boolean);
  const choice=await setupChoice("Транспорт","Приоритет занимает примерно половину показанных рейсов: 1→1+0, 2→1+1, 3→2+1, 4→2+2, 5→3+2 и т.д. Сохранённые места переключают набор остановок только в виджете.",[
    "Рейсов в подробном экране: "+profile.departureCount,
    "Рейсов на остановку в виджете: "+profile.widgetDepartureCount,
    "Какие остановки показывать · "+selectedNames().length+" выбрано",
    "Приоритеты по остановкам",
    "Добавить / изменить остановки",
    "Места · адреса, остановки и порядок",
    "Поменять местами основные остановки",
    "Скрыть / вернуть номера автобусов",
    "Цепочки поездок · добавить и настроить"
  ]);if(choice<0)return false;
  if(choice<=1){const cfg=choice===0?["Сколько рейсов показывать?",1,10,"departureCount"]:["Сколько рейсов на остановку в виджете?",1,8,"widgetDepartureCount"];const values=await setupInput(cfg[0],`От ${cfg[1]} до ${cfg[2]}. При наличии и приоритетных, и обычных рейсов список делится примерно пополам.`,[{label:"Количество",value:String(profile[cfg[3]])}]);if(!values)return false;const n=Number(values[0]);if(!Number.isInteger(n)||n<cfg[1]||n>cfg[2])throw Error(`Введи число от ${cfg[1]} до ${cfg[2]}.`);profile[cfg[3]]=n;}
  else if(choice===2){if(!await editWidgetStops(profile))return false;}
  else if(choice===3){const items=all(),i=await setupChoice("Приоритеты","Выбери остановку.",items.map(s=>s.name+" · "+((profile.stopPriorities[s.key]||[]).join(", ")||"без приоритета")));if(i<0)return false;if(!await editStopPriorities(profile,items[i]))return false;}
  else if(choice===4){const items=all(),i=await setupChoice("Остановки","Новая остановка добавляется в общий список, но на виджет попадёт только если ты отметишь её в «Какие остановки показывать».",["＋ Добавить остановку",...items.map(s=>s.name+" · "+s.direction)]);if(i<0)return false;
    if(i===0){if(profile.extraStops.length>=6)throw Error("Уже добавлено шесть дополнительных остановок.");let n=1;while(items.some(s=>s.key==="extra_"+n))n++;const stop=await setupStop("extra_"+n);if(!stop)return false;profile.extraStops.push(stop);profile.stopPriorities[stop.key]=[];delete profile.hiddenRoutes[stop.key];delete profile.allowedRoutes[stop.key];}
    else {const stop=items[i-1],primary=profile.stops.some(s=>s.key===stop.key),acts=primary?["Заменить остановку","Настроить приоритеты"]:["Заменить остановку","Настроить приоритеты","Удалить"];
      const action=await setupChoice(stop.name,stop.direction,acts);if(action<0)return false;
      if(action===1){if(!await editStopPriorities(profile,stop))return false;}
      else if(action===2&&!primary){profile.extraStops=profile.extraStops.filter(s=>s.key!==stop.key);profile.widgetStopKeys=profile.widgetStopKeys.filter(k=>k!==stop.key);delete profile.stopPriorities[stop.key];delete profile.hiddenRoutes[stop.key];delete profile.allowedRoutes[stop.key];for(const c of profile.travelChains)for(const l of c.legs)l.stopKeys=l.stopKeys.filter(k=>k!==stop.key);}
      else {const replacement=await setupStop(stop.key,stop);if(!replacement)return false;if(primary)profile.stops=profile.stops.map(s=>s.key===stop.key?replacement:s);else profile.extraStops=profile.extraStops.map(s=>s.key===stop.key?replacement:s);}}
  } else if(choice===8){if(!await travelChainSettings(profile))return false;
  } else if(choice===7){if(!await hiddenRoutesSettings(profile))return false;
  } else if(choice===5){if(!await locationOrderSettings(profile))return false;
  } else {
    const home=profile.stops.find(s=>s.key==="home"),uni=profile.stops.find(s=>s.key==="uni");if(!home||!uni)throw Error("Основные остановки не найдены.");
    const newHome={...uni,key:"home",label:home.label},newUni={...home,key:"uni",label:uni.label},homePriority=profile.stopPriorities.home||[],uniPriority=profile.stopPriorities.uni||[];
    profile.stops=profile.stops.map(s=>s.key==="home"?newHome:s.key==="uni"?newUni:s);profile.stopPriorities.home=uniPriority;profile.stopPriorities.uni=homePriority;
    const allowedHome=profile.allowedRoutes.home,allowedUni=profile.allowedRoutes.uni;delete profile.allowedRoutes.home;delete profile.allowedRoutes.uni;if(allowedHome)profile.allowedRoutes.uni=allowedHome;if(allowedUni)profile.allowedRoutes.home=allowedUni;
    const hiddenHome=profile.hiddenRoutes.home||[];profile.hiddenRoutes.home=profile.hiddenRoutes.uni||[];profile.hiddenRoutes.uni=hiddenHome;
  }
  normalizeProfileWidgetOrders(profile);saveProfile(profile);return true;
}
function setupPlaceholder(message) {
  if(config.runsInWidget) {
    const w=new ListWidget();w.setPadding(14,14,14,14);w.url=URLScheme.forRunningScript();
    const title=w.addText("Настроить UniDay");title.font=Font.semiboldSystemFont(16);w.addSpacer(8);
    const detail=w.addText(message);detail.font=Font.systemFont(12);detail.lineLimit=5;Script.setWidget(w);
  } else Script.setShortcutOutput("<!doctype html><meta charset='utf-8'><p>"+escapeHTML(message)+"</p>");
}
async function bootstrapProfile() {
  const {fm,path}=profileFiles();let loaded=false,errorText="";
  SETTINGS.profileRecoveryWarning="";
  for(const candidate of [path,path+".last-good.json"]) {
    if(loaded||!fm.fileExists(candidate))continue;
    try {const serialized=fm.readString(candidate),saved=profileEnvelope(JSON.parse(serialized));applyProfile(saved.profile);SETTINGS.storageFolder=saved.dataFolder;loaded=true;
      if(candidate===path&&!fm.fileExists(path+".last-good.json"))try{fm.writeString(path+".last-good.json",serialized);}catch{}
      if(candidate!==path)SETTINGS.profileRecoveryWarning="Основной файл настроек повреждён. Загружена резервная копия; проверь последние изменения настроек.";
    }catch(error) {errorText=String(error.message||error);}
  }
  if(!config.runsInApp || config.runsInWidget) {
    if(!loaded) {setupPlaceholder(errorText?"Настройки не прочитаны. Нажми и настрой UniDay внутри Scriptable.":"Нажми и пройди первую настройку внутри Scriptable.");return false;}
    return true;
  }
  try {
    if(!loaded) {
      if(errorText)await setupMessage("Настройки не прочитаны",errorText+" Старый файл заменится только после подтверждения новой настройки.");
      return await firstSetup();
    }
    return true;
  } catch(error) {await setupMessage("Не удалось сохранить настройки",String(error.message||error));return loaded;}
}


async function main(options={}) {
  if(!options.skipSetup && !await bootstrapProfile())return;
  validateProfile();
  const fm=FileManager.local(),dir=fm.joinPath(fm.documentsDirectory(),SETTINGS.storageFolder);
  if(!fm.fileExists(dir)) fm.createDirectory(dir,true);
  let stopWarning="";try{await resolveProfileStops(fm,fm.joinPath(dir,"resolved-stops.json"),!!options.cacheOnly);}catch{stopWarning="Остановки не обновились. Расписание доступно отдельно.";}
  let now=new Date();
  const widgetMode=config.runsInWidget || args.queryParameters?.widget==="1";
  const personalPath=fm.joinPath(dir,"personal-event-ids.json");
  const packingPath=fm.joinPath(dir,"packing.json");
  const requestSignature=overviewSignature();
  if(config.runsInApp&&!widgetMode&&!options.returnModel&&!options.noFastStart&&[undefined,"","overview","settings","bus-trip"].includes(args.queryParameters?.action)) {
    const seed=await main({skipSetup:true,returnModel:true,cacheOnly:true});
    seed.model.loadingOverview=true;
    if(seed.model.weather.missing)seed.model.weather={temperature:"…",condition:"Загружаю погоду",icon:"◌",missing:true};
    seed.model.eventNotice=(SETTINGS.profileRecoveryWarning?SETTINGS.profileRecoveryWarning+" ":"")+(seed.model.calendarOK?"Сохранённые данные · обновляю расписание, автобусы и погоду…":"Обновляю расписание, автобусы и погоду…");
    if(!seed.model.calendarOK)seed.model.calendarWarning="Расписание загружается…";
    seed.model.buses=seed.model.buses.map(s=>s.error?{...s,error:false,loading:true}:s);
    if(args.queryParameters?.action==="settings"){seed.model.settingsPage="root";seed.model.eventNotice="";}
    await presentInteractiveOverview(seed.model,fm,personalPath,packingPath,seed.events,()=>main({skipSetup:true,returnModel:true}));
    return;
  }
  let focusDate=now,eventNotice=[SETTINGS.profileRecoveryWarning,stopWarning].filter(Boolean).join(" "),weekOpenDate=null;
  if(!options.returnModel && !widgetMode && args.queryParameters?.action==="week") {const m=String(args.queryParameters.date||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m){const d=fromWall(m.slice(1).map(Number));if(dayKey(d)===args.queryParameters.date)focusDate=d;}}
  if(!options.returnModel && !widgetMode && args.queryParameters?.action==="pick-week" && config.runsInApp) {
    try {const chosen=await chooseWeekDate(now);if(chosen){focusDate=chosen;weekOpenDate=chosen;eventNotice="Открыта выбранная учебная неделя.";}}
    catch(error){eventNotice="Неделя не открыта: "+String(error.message||error);}
  }
  if(!options.returnModel && !widgetMode && args.queryParameters?.action==="edit-note") {
    const match=String(args.queryParameters.date||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(match){const date=fromWall(match.slice(1).map(Number));if(dayKey(date)===args.queryParameters.date){focusDate=date;weekOpenDate=date;}}
  }
  if(!options.returnModel && !widgetMode && args.queryParameters?.action==="edit-pack") {
    try {
      const selectedDate=args.queryParameters.date||await choosePackingDate();
      const key=selectedDate?await editPacking(fm,packingPath,selectedDate):null;
      if(key)eventNotice="Список вещей сохранён на "+key+".";
    } catch(error) {eventNotice="Список не сохранён. "+String(error.message||error);}
  }
  if(!options.returnModel && !widgetMode && args.queryParameters?.action==="add-event") {
    try {
      const date=await createPersonalEvent(fm,personalPath);
      if(date) {focusDate=date;weekOpenDate=date;eventNotice="Событие добавлено в Календарь iPhone и расписание ниже. Открыта неделя события.";}
    } catch {
      eventNotice="Не удалось завершить добавление. Проверь доступ Scriptable к календарям. Если уже нажал Add, сначала проверь Календарь iPhone, чтобы не создать дубль.";
    }
    now=new Date();
  }
  const weekStart=weekBounds(focusDate)[0];
  const rangeStart=new Date(Math.min(+dayBounds(now)[0],+weekStart));
  const rangeEnd=new Date(Math.max(+shiftDay(now,14),+shiftDay(weekStart,14)));
  const weatherPath=fm.joinPath(dir,"weather-open-meteo.json");
  const cachePath=fm.joinPath(dir,"calendar.json");
  const locationPath=fm.joinPath(dir,"location-zone.json");
  // Top-level bus-trip links are intentionally ignored. Bus details are handled inside the
  // open UniDay WebView; an old Home Screen snapshot with a bus deep-link must still land here.
  let requestedTrip=null;
  const widgetSections=effectiveWidgetSections();
  const busStops=widgetMode?widgetTransitStops():transitStops(true);
  const needCalendar=!widgetMode||widgetSections.includes("header")||widgetSections.includes("classes")||widgetSections.includes("countdown");
  const needBuses=!widgetMode||widgetSections.includes("buses");
  const needWeather=!widgetMode||widgetSections.includes("weather");
  const needLocation=!options.cacheOnly&&(widgetMode?widgetSections.includes("location")||needBuses&&SETTINGS.widgetNearbyStopFirst:options.withLocation===true)&&widgetTransitStops().length>0;
  const busOptions={detailed:!widgetMode,stops:busStops,count:widgetMode?SETTINGS.widgetDepartureCount:Math.max(SETTINGS.departureCount,SETTINGS.widgetDepartureCount),cacheOnly:!!options.cacheOnly,offlineCoverage:!widgetMode};
  const results=await Promise.allSettled([
    needCalendar?loadCalendar(fm,cachePath,now,!!options.cacheOnly):Promise.resolve({events:[],warning:"",fresh:true,saved:null}),
    needBuses?loadBuses(fm,fm.joinPath(dir,widgetMode?"buses-widget.json":"buses.json"),now,busOptions):Promise.resolve({data:{},saved:null,detailed:!widgetMode}),
    widgetMode||options.cacheOnly?Promise.resolve():clearLegacyNotifications(fm,fm.joinPath(dir,"notification-migration-v3.txt")),
    needLocation?locate(fm,locationPath,now):Promise.resolve({side:null,saved:null,cached:false}),
    widgetMode||options.cacheOnly?Promise.resolve([]):personalEvents(fm,personalPath,rangeStart,rangeEnd),
    needWeather?loadWeather(fm,weatherPath,now,!!options.cacheOnly):Promise.resolve(null),
    requestedTrip?loadBusTrip(fm,fm.joinPath(dir,"bus-trip.json"),requestedTrip,now):Promise.resolve(null)
  ]);
  now=new Date();
  let upcoming=[],calendarOK=false,calendarWarning="";
  if(results[0].status==="fulfilled") {
    try {upcoming=expandCalendar(results[0].value.events,rangeStart,rangeEnd);calendarOK=true;calendarWarning=results[0].value.warning;}
    catch {calendarWarning="Не удалось прочитать расписание. Попробуй обновить его позже.";}
  } else calendarWarning=results[0].reason?.code==="EMPTY_CALENDAR"?results[0].reason.message:"Не удалось загрузить расписание. Проверь интернет и запусти снова.";
  let lessonEdits={};try{lessonEdits=readLessonEdits(fm);}catch(error){eventNotice=String(error.message||error);}
  const rawUpcoming=upcoming;upcoming=applyLessonEdits(rawUpcoming,lessonEdits);
  const personal=results[4].status==="fulfilled"?results[4].value:[];
  const rawWeekEvents=[...rawUpcoming,...personal];
  const weekEvents=applyLessonEdits(rawWeekEvents,lessonEdits);
  const [todayStart,todayEnd]=dayBounds(now);
  const lessons=weekEvents.filter(l=>l.start<todayEnd && l.end>todayStart);
  const storedWeather=results[5].status==="fulfilled"?results[5].value:null;
  let packing={},packingWarning="";
  try {packing=readPacking(fm,packingPath);} catch {packingWarning="Свои списки вещей не удалось прочитать; они не перезаписаны.";}
  let packingChecks={};
  if(!widgetMode)try {packingChecks=readPackingChecks(fm,fm.joinPath(dir,"packing-checks.json"));}catch(error){packingWarning+=" "+String(error.message||error);}
  const notesPath=fm.joinPath(dir,"lesson-notes.json");
  let annotations={},notesWarning="";
  if(!widgetMode)try {
    annotations=readLessonNotes(fm,notesPath);
    if(!options.returnModel && args.queryParameters?.action==="edit-note") {
      const matches=weekEvents.filter(l=>dayKey(l.start)===args.queryParameters.date && lessonNoteRef(l)===args.queryParameters.ref);
      if(matches.length!==1)throw Error("Занятие не найдено однозначно. Обнови расписание и открой заметку ещё раз.");
      if(await editLessonNote(fm,notesPath,matches[0])){annotations=readLessonNotes(fm,notesPath);eventNotice="Своя заметка сохранена.";}
    }
  } catch(error) {notesWarning=String(error.message||error);}
  const studyWeeks=studyWeekOptions(results[0].status==="fulfilled"?results[0].value.events:[],focusDate);
  let newCourses=[];if(!widgetMode&&!options.cacheOnly&&calendarOK&&results[0].value.fresh!==false)try{newCourses=discoverNewCourses(results[0].value.events,now);}catch{}
  const model={now,lessons,upcoming,weekEvents,rawUpcoming,rawWeekEvents,newCourses,personalUpcoming:personal,weekStart,weekOpenDate,studyWeeks,calendarOK,calendarWarning,eventNotice,
    packing,packingChecks,packingWarning,annotations,notesWarning,
    settingsURL:widgetMode?"":actionURL("settings"),
    packURL:widgetMode?"":actionURL("edit-pack"),
    packTodayURL:widgetMode?"":actionURL("edit-pack",{date:dayKey(now)}),
    packTomorrowURL:widgetMode?"":actionURL("edit-pack",{date:dayKey(shiftDay(now,1))}),
    personalWarning:results[4].status==="rejected"?"Свои события не удалось прочитать. Разреши Scriptable полный доступ к Календарю в Settings → Apps → Scriptable → Calendars.":"",
    addURL:widgetMode?"":actionURL("add-event"),
    position:results[3].status==="fulfilled"?results[3].value:{side:null},
    calendarSaved:results[0].status==="fulfilled"?results[0].value.saved:null,
    weather:storedWeather?.weather||missingWeather(),
    weatherSaved:storedWeather?.observedAt||null,weatherStale:storedWeather?.stale||false,
    busSaved:results[1].status==="fulfilled"?results[1].value.saved:null,
    busStale:results[1].status==="fulfilled"&&results[1].value.stale===true,
    buses:nearestBuses(results[1].status==="fulfilled"?results[1].value.data:null,now,busStops,widgetMode?SETTINGS.widgetDepartureCount:SETTINGS.departureCount,results[1].status==="fulfilled"&&results[1].value.stale===true),
    cleanupWarning:results[2].status==="rejected"?"Старые уведомления не удалось очистить. Если они продолжают приходить, отключи уведомления Scriptable в настройках iPhone.":""};
  if(!options.returnModel&&args.queryParameters?.action==="settings"&&config.runsInApp)model.settingsPage="root";
  if(options.returnModel)return {model,events:results[0].status==="fulfilled"?results[0].value.events:[],signature:requestSignature};
  if(requestedTrip) {
    model.tripSelection=requestedTrip;
    if(results[6].status==="fulfilled")model.tripData=results[6].value;
    else model.tripError="Не удалось загрузить остановки. "+String(results[6].reason?.message||results[6].reason);
  }
  if(widgetMode) {
    const widget=buildLargeWidget({...model,storedWeather});
    Script.setWidget(widget);
    if(!config.runsInWidget) await widget.presentLarge();
    return;
  }
  if(config.runsInApp) {
    await presentInteractiveOverview(model,fm,personalPath,packingPath,results[0].status==="fulfilled"?results[0].value.events:[]);
  } else {
    // Shortcuts owns the UI: Set Name (UniDay.html) → Show Web View.
    // No Scriptable preview or presentation call. Only the explicit Add link opens the app.
    Script.setShortcutOutput(renderHTML(model));
  }
  // Direct manual runs in Scriptable retain a preview for debugging.
}

SETTINGS.appearance={...appearanceDefaults(),...SETTINGS.appearance};
SETTINGS.packingCategories={};
SETTINGS.widgetStopKeysHome=null;SETTINGS.widgetStopKeysUni=null;SETTINGS.locationNames={home:"Дом",uni:"Универ"};SETTINGS.locationRadii={home:1200,uni:1200};SETTINGS.extraPlaces=[];

// Scriptable supports top-level await. Tests evaluate the functions above separately.
