// This is a local, reviewable import. CI builds the checked-in generated source.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/extract-legacy.mjs <UniDay_v7.9.0.js>');
const bytes = await readFile(input);
const original = bytes.toString('utf8');
const settingsText = original.slice(original.indexOf('const SETTINGS = {') + 17, original.indexOf('\n};') + 2).trim();
const settings = JSON.parse(settingsText);
for (const field of ['calendarURL', 'universityLabel', 'city']) {
  if (settings[field] !== '') throw new Error(`Private default ${field}: import refused. Remove private values locally first.`);
}
for (const field of ['stops', 'extraStops', 'alwaysBring', 'travelChains']) {
  if (settings[field].length) throw new Error(`Private default ${field}: import refused.`);
}
if (settings.locationAnchors.home !== null || settings.locationAnchors.uni !== null) throw new Error('Private location defaults: import refused.');
const footer = /await main\(\);\r?\nScript\.complete\(\);\s*$/;
if (!footer.test(original)) throw new Error('Unexpected entry point; do not silently alter new source.');
const source = original.replace(footer, '');
const sha = value => createHash('sha256').update(value).digest('hex');
const declarations = [...source.matchAll(/^(?:async )?function (\w+)\s*\(/gm)];
const functions = declarations.map((match, i) => ({
  name: match[1], line: source.slice(0, match.index).split('\n').length,
  // Hash each contiguous declaration segment; together these cover all legacy functions.
  sha256: sha(source.slice(match.index, declarations[i + 1]?.index ?? source.length))
}));
const resources = resolve(root, 'App/Resources');
await mkdir(resources, { recursive: true });
await writeFile(resolve(resources, 'legacy.js'), source);
await writeFile(resolve(root, 'docs/legacy-manifest.json'), JSON.stringify({
  sourceVersion: '7.9.0', originalSHA256: sha(bytes), generatedSHA256: sha(source),
  originalLines: original.split('\n').length, transformation: 'Remove only await main(); and Script.complete(); at EOF.',
  privateDefaultsChecked: true, topLevelFunctions: functions.length, functions
}, null, 2) + '\n');
console.log(`Preserved ${functions.length} top-level functions. SHA-256 ${sha(source)}`);
