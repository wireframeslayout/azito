import { gzipSync } from 'node:zlib';
import { powershellDialect } from '../../../shared/os/shellDialect';
import type { ScriptOutcome } from './windowsAgentUninstallScripts';

/** Runs on the host, where both the registration and the target file can be resolved. */
const HOST_SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [kind, home, expected] = process.argv.slice(1);
function result(outcome, detail) { console.log(JSON.stringify({ outcome, detail })); }
function owned(entry) {
  if (!entry || entry.command !== 'node' || !Array.isArray(entry.args) || entry.args.length !== 1 || typeof entry.args[0] !== 'string') return 'registration has a different command or arguments';
  if (!path.isAbsolute(entry.args[0])) return 'registration path is not absolute';
  try {
    const a = fs.realpathSync.native(entry.args[0]);
    const b = fs.realpathSync.native(expected);
    return a.toLowerCase() === b.toLowerCase() ? null : 'registration points to a different harness';
  } catch { return 'registration or harness file cannot be resolved'; }
}
function claude() {
  const file = path.join(home, '.claude', 'settings.json');
  let original;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return result('skipped', 'Claude settings is a link and was left in place');
    original = fs.readFileSync(file, 'utf8');
  }
  catch (error) { if (error.code === 'ENOENT') return result('absent'); throw error; }
  const config = JSON.parse(original);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('invalid settings');
  if (config.mcpServers === undefined) return result('absent');
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) throw Error('invalid MCP settings');
  if (!Object.prototype.hasOwnProperty.call(config.mcpServers, 'azt-mcp')) return result('absent');
  const reason = owned(config.mcpServers['azt-mcp']);
  if (reason) return result('skipped', reason);
  delete config.mcpServers['azt-mcp'];
  const temp = file + '.' + process.pid + '.' + require('crypto').randomBytes(8).toString('hex') + '.tmp';
  let created = false;
  try {
    fs.copyFileSync(file, temp, fs.constants.COPYFILE_EXCL);
    created = true;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
    if (fs.readFileSync(file, 'utf8') !== original) return result('skipped', 'settings changed during inspection');
    fs.renameSync(temp, file);
  } finally { if (created) { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }
  result('done');
}
function codexCommand() {
  const dirs = (process.env.PATH || process.env.Path || '').split(';').filter(Boolean);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const file = path.join(dir, 'codex' + ext);
    try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
    const suffix = path.extname(file).toLowerCase();
    if (suffix === '.exe' || suffix === '.com') return [file];
    if (suffix !== '.cmd' && suffix !== '.bat') throw Error('unsupported CLI');
    const match = /"%dp0%\\([^"\r\n]+\.(?:c|m)?js)"/i.exec(fs.readFileSync(file, 'utf8'));
    if (!match) throw Error('unrecognized CLI shim');
    const node = path.join(dir, 'node.exe');
    return [fs.existsSync(node) ? node : process.execPath, path.join(dir, match[1])];
  }
  throw Error('CLI unavailable');
}
function codex() {
  let command;
  try { command = codexCommand(); } catch { return result('skipped', 'Codex CLI could not be resolved on PATH'); }
  const run = args => execFileSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  let entry;
  try { entry = JSON.parse(run(['mcp', 'get', 'azt-mcp', '--json'])); }
  catch (error) {
    if (error.status !== null && /no mcp server named/i.test(String(error.stderr))) return result('absent');
    return result('skipped', 'Codex registration could not be inspected; check it manually');
  }
  const reason = owned(entry.transport);
  if (reason) return result('skipped', reason);
  let again;
  try { again = JSON.parse(run(['mcp', 'get', 'azt-mcp', '--json'])); } catch { return result('skipped', 'Codex registration changed or could not be inspected'); }
  if (owned(again.transport)) return result('skipped', 'Codex registration changed during inspection');
  run(['mcp', 'remove', 'azt-mcp']);
  result('done');
}
try { if (kind === 'claude') claude(); else codex(); }
catch { result('failed', kind === 'claude' ? 'Claude settings could not be read or updated' : 'Codex registration could not be removed'); }
`;

export function harnessMcpScript(kind: 'claude' | 'codex', node: string, home: string, expected: string): string {
  const q = powershellDialect.quote;
  const encoded = gzipSync(Buffer.from(JSON.stringify({ source: HOST_SCRIPT, args: [kind, home, expected] }), 'utf8')).toString('base64');
  const launcher = 'const p=JSON.parse(require(`zlib`).gunzipSync(Buffer.from(process.env.AZITO_MCP_SRC,`base64`)));process.argv=[process.execPath,...p.args];eval(p.source)';
  return `$env:AZITO_MCP_SRC = ${q(encoded)}\n& ${q(node)} -e ${q(launcher)}\nif ($LASTEXITCODE -ne 0) { throw 'MCP inspection failed' }`;
}

export function parseHarnessMcpOutput(output: string): ScriptOutcome {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (typeof value === 'object' && value !== null && 'outcome' in value && ['done', 'absent', 'skipped', 'failed'].includes(String(value.outcome))) {
      const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : undefined;
      return { outcome: value.outcome as ScriptOutcome['outcome'], ...(detail ? { detail } : {}) };
    }
  } catch { /* invalid host response */ }
  throw new Error('MCP inspection returned an invalid response');
}
