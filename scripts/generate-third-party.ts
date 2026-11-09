import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageNames = [
  '@corbe30/fortune-excel', '@fortune-sheet/react', '@fortune-sheet/core', '@fortune-sheet/formula-parser',
  '@formulajs/formulajs', '@types/papaparse', '@jvmr/pptx-to-html', 'bessel', 'exceljs', 'file-saver',
  'immer', 'jstat', 'lodash', 'numeral', 'regenerator-runtime', 'tiny-emitter', 'uuid', 'docx-preview',
  'papaparse', 'jszip', 'crc-32', 'readdir-glob',
];
interface PackageJson { name: string; version: string; license?: string; dependencies?: Record<string, string>; author?: string | { name?: string } }
interface Vendored { version: string; license?: string; licenses: Array<{ name: string; text: string }> }
const vendored = JSON.parse(fs.readFileSync(path.join(root, 'scripts/licenses/exceljs-4.4.0-bundled.json'), 'utf8')) as Record<string, Vendored>;
const seen = new Set<string>();
const sections: string[] = [];
const notices: string[] = [];
function locate(name: string, from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`Missing dependency: ${name}`);
  }
}
function add(name: string, from: string, includeDependencies: boolean): void {
  const dir = locate(name, from);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) return;
  seen.add(id);
  const licenseFile = fs.readdirSync(dir).find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
  const fallback = name === '@fortune-sheet/react' || name === '@fortune-sheet/core' ? path.join(root, 'scripts/licenses/fortune-sheet.txt') : name === 'isarray' ? path.join(dir, 'README.md') : null;
  if (!licenseFile && !fallback) throw new Error(`Missing license text: ${id}`);
  let text = fs.readFileSync(licenseFile ? path.join(dir, licenseFile) : fallback!, 'utf8');
  if (name === 'isarray' && !licenseFile) text = text.slice(text.search(/^## License/im));
  if (name === 'jszip') text = text.split('\nGPL version 3')[0];
  sections.push(`## ${id} — ${name === 'jszip' ? 'MIT (selected from MIT OR GPL-3.0-or-later)' : pkg.license}\n\n${text.trim()}\n`);
  for (const file of fs.readdirSync(dir).filter((name) => /^NOTICE(?:\.|$)/i.test(name))) notices.push(`${id}:\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`);
  if (includeDependencies) for (const dependency of Object.keys(pkg.dependencies ?? {})) add(dependency, dir, true);
}
for (const name of packageNames) add(name, root, name === 'jszip');
for (const [name, pkg] of Object.entries(vendored).sort(([a], [b]) => a.localeCompare(b))) {
  const id = `${name}@${pkg.version}`;
  if (seen.has(id)) continue;
  if (!pkg.license || !pkg.licenses.length) throw new Error(`Missing bundled license: ${id}`);
  seen.add(id);
  for (const file of pkg.licenses) {
    const text = name === 'jszip' ? file.text.split('\nGPL version 3')[0] : file.text;
    if (/^NOTICE(?:\.|$)/i.test(file.name)) notices.push(`${id}:\n${text.trim()}\n`);
    else sections.push(`## ${id} — ${name === 'jszip' ? 'MIT (selected)' : pkg.license}\n\n${text.trim()}\n`);
  }
}
fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.txt'), `Third-party licenses for Office preview dependencies and their bundled code.\n\n${sections.join('\n')}`);
fs.writeFileSync(path.join(root, 'NOTICE'), `Third-party notices for AZITO Office preview\n\nJSZip: MIT license selected. Copyright 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso.\ncrc-32: Copyright 2014-present SheetJS.\nreaddir-glob: authored by Yann Armelin.\ndocx-preview: Copyright Volodymyr Baydalka.\n\n${notices.join('\n')}`);
