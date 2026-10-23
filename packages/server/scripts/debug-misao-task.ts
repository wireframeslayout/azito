import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../src/modules/system/misao/misaoWindowsTask';
import { windowsMisaoPipe } from '../src/modules/servers/transport/agentMisaoSocket';
import { encodeTaskXml } from '../src/shared/os/taskScheduler/taskDefinition';

// TEMPORARY diagnosis (removed before merge): which root makes the misao task start or not.
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');
const TASK = 'AzitoDbgMisao';
const exeSource = process.env.MISAO_CLI ?? '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 60_000 });
  return `${r.status} ${r.stdout}${r.stderr}`.trim();
}

async function variant(label: string, root: string): Promise<void> {
  console.log(`\n=== ${label}: ${root}`);
  const layout = misaoWindowsLayout({ misaoRoot: root }, '0.3.0', TASK);
  fs.mkdirSync(layout.versionDir, { recursive: true });
  fs.copyFileSync(exeSource, layout.exe);
  const pipe = windowsMisaoPipe(root, os.userInfo().username);
  const userId = run('whoami', []).replace(/^0 /, '');
  const xml = buildMisaoTaskXml({ userId, systemRoot: SYSTEM_ROOT, homeDir: os.homedir(), layout, pipe });
  const xmlFile = path.join(os.tmpdir(), 'azdbg-task.xml');
  fs.writeFileSync(xmlFile, encodeTaskXml(xml));
  console.log('create:', run(SCHTASKS, ['/Create', '/XML', xmlFile, '/TN', TASK, '/F']));
  console.log('run:', run(SCHTASKS, ['/Run', '/TN', TASK]));
  await sleep(8000);
  console.log('log exists:', fs.existsSync(layout.logFile), fs.existsSync(layout.logFile) ? fs.readFileSync(layout.logFile, 'utf-8').slice(0, 400) : '');
  console.log('state:', run(SCHTASKS, ['/Query', '/TN', TASK, '/V', '/FO', 'LIST']).split(/\r?\n/).filter((l) => /Status|Last Result|Task To Run|Start In/.test(l)).join(' | '));
  console.log('processes:', run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='misao.exe'\" | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }"]));
  console.log('xml arguments:', (/<Arguments>([^<]*)<\/Arguments>/.exec(xml) ?? [])[1]);
  console.log('end:', run(SCHTASKS, ['/End', '/TN', TASK]));
  run(layout.exe, ['stop']);
  await sleep(1500);
  console.log('delete:', run(SCHTASKS, ['/Delete', '/TN', TASK, '/F']));
  run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='misao.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

async function main(): Promise<void> {
  if (!fs.existsSync(exeSource)) throw new Error('MISAO_CLI is not set');
  const home = os.homedir();
  await variant('clean under home', path.join(home, 'azdbg-1', 'misao'));
  await variant('8.3 temp, clean', path.join(os.tmpdir(), 'azdbg-2', 'misao'));
  await variant('spaces+parens under home', path.join(home, 'Foo Bar (Work)', '.azito', 'misao'));
  await variant('8.3 temp + spaces+parens', path.join(os.tmpdir(), 'Foo Bar (Work)', '.azito', 'misao'));
}

main().catch((err) => { console.error(err); process.exit(1); });
