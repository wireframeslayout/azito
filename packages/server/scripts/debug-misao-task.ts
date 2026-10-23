import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { misaoWindowsLayout, misaoTaskArguments } from '../src/modules/system/misao/misaoWindowsTask';
import { windowsMisaoPipe } from '../src/modules/servers/transport/agentMisaoSocket';
import { buildTaskXml, encodeTaskXml } from '../src/shared/os/taskScheduler/taskDefinition';

// TEMPORARY diagnosis (removed before merge): which form of the misao task survives a root with spaces / parentheses.
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const SCHTASKS = path.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');
const TASK = 'AzitoDbgMisao';
const exeSource = process.env.MISAO_CLI ?? '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 60_000 });
  return `${r.status} ${r.stdout}${r.stderr}`.trim();
}

type Rewrite = (args: string) => string;

async function variant(label: string, root: string, rewrite: Rewrite): Promise<void> {
  console.log(`\n=== ${label}: ${root}`);
  const layout = misaoWindowsLayout({ misaoRoot: root }, '0.3.0', TASK);
  fs.mkdirSync(layout.versionDir, { recursive: true });
  fs.copyFileSync(exeSource, layout.exe);
  const pipe = windowsMisaoPipe(root, os.userInfo().username);
  const userId = run('whoami', []).replace(/^0 /, '');
  const argumentsLine = rewrite(misaoTaskArguments({ systemRoot: SYSTEM_ROOT, layout, pipe }));
  const xml = buildTaskXml({ userId, description: 'dbg', executable: path.win32.join(SYSTEM_ROOT, 'System32', 'conhost.exe'), argumentsLine, workingDirectory: os.homedir(), restartOnFailure: { intervalMinutes: 1, count: 3 } });
  const xmlFile = path.join(os.tmpdir(), 'azdbg-task.xml');
  fs.writeFileSync(xmlFile, encodeTaskXml(xml));
  console.log('create:', run(SCHTASKS, ['/Create', '/XML', xmlFile, '/TN', TASK, '/F']).split('\n')[0]);
  console.log('arguments:', argumentsLine);
  run(SCHTASKS, ['/Run', '/TN', TASK]);
  await sleep(6000);
  console.log('RESULT log exists:', fs.existsSync(layout.logFile), '| processes:', run('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='misao.exe'\" | Measure-Object).Count"]).replace(/^0 /, ''));
  run(SCHTASKS, ['/End', '/TN', TASK]);
  run(layout.exe, ['stop']);
  await sleep(1000);
  run(SCHTASKS, ['/Delete', '/TN', TASK, '/F']);
  run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='misao.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

async function main(): Promise<void> {
  if (!fs.existsSync(exeSource)) throw new Error('MISAO_CLI is not set');
  const home = os.homedir();
  const same: Rewrite = (a) => a;
  await variant('A spaces+parens (launcher form)', path.join(home, 'Foo Bar (Work)', 'misao'), same);
  await variant('B odd characters (launcher form)', path.join(home, "A&B (100%) it's ok!", 'misao'), same);
  await variant('C 8.3 temp + spaces+parens', path.join(os.tmpdir(), 'Foo Bar (Work)', '.azito', 'misao'), same);
}

main().catch((err) => { console.error(err); process.exit(1); });
