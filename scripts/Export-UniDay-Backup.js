// One-time local migration from Scriptable UniDay 7.9.0. Never upload the result.
const fm = FileManager.local();
const base = fm.documentsDirectory();
const profilePath = fm.joinPath(fm.joinPath(base, 'UniDay-Personal'), 'profile.json');
if (!fm.fileExists(profilePath)) throw Error('Сначала открой UniDay 7.9.0 и сохрани профиль.');
const envelope = JSON.parse(fm.readString(profilePath));
const folder = envelope.dataFolder || 'UniDay-Personal';
if (typeof folder !== 'string' || folder.includes('..') || /[\\/]/.test(folder)) throw Error('Неверная папка данных');
const files = {}, directories = new Set(['/documents']);
function copyFolder(name) {
  const source = fm.joinPath(base, name);
  if (!fm.fileExists(source)) return;
  function walk(path, virtual) {
    directories.add(virtual);
    for (const entry of fm.listContents(path)) {
      const child = fm.joinPath(path, entry), key = virtual + '/' + entry;
      if (fm.isDirectory(child)) walk(child, key);
      else if (/\.(png|jpg|jpeg)$/i.test(entry)) {
        const image = fm.readImage(child), data = fm.read(child);
        files[key] = {kind:'image',dataURL:'data:image/'+(/png$/i.test(entry)?'png':'jpeg')+';base64,'+data.toBase64String(),width:image.size.width,height:image.size.height};
      } else { files[key] = {kind:'text',value:fm.readString(child)}; }
    }
  }
  walk(source, '/documents/' + name);
}
copyFolder('UniDay-Personal');
if (folder !== 'UniDay-Personal') copyFolder(folder);
const backup = {format:'UniDay-backup',backupVersion:1,exportedAt:new Date().toISOString(),state:{schemaVersion:1,revision:0,files,directories:[...directories],updatedAt:new Date().toISOString()}};
await DocumentPicker.exportString(JSON.stringify(backup,null,2),'UniDay-backup.json');
Script.complete();
