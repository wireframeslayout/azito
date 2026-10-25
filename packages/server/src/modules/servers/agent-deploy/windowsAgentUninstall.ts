import * as path from 'path';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';
import { unescapeTaskXml, taskMisaoRoot } from '../../../shared/os/taskScheduler/taskXmlRead';
import type { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { buildEndProcessesScript } from '../../../shared/os/windowsProcessSweep';
import { firewallRuleName } from './windowsFirewall';
import { MISAO_WINDOWS_DIR, MISAO_WINDOWS_TASK_NAME, type WindowsAgentOptions } from './windowsAgentConfig';

/** The Task Scheduler task of a Windows hub (`HUB_SERVICE.windowsTaskName`; a test keeps the two in step). */
export const WINDOWS_HUB_TASK_NAME = 'AzitoHub';

export type UninstallStepId = 'task' | 'processes' | 'firewall' | 'folder' | 'misaoTask' | 'misaoProcesses' | 'misaoFolder';

/**
 * - `done`: it was there and is gone now (for the processes: none is left).
 * - `absent`: there was nothing to remove.
 * - `failed`: it could not be removed; `detail` says why and what to do.
 * - `skipped`: not attempted; `detail` says why.
 */
export type UninstallOutcome = 'done' | 'absent' | 'failed' | 'skipped';

export interface UninstallStep {
  id: UninstallStepId;
  outcome: UninstallOutcome;
  detail?: string;
}

export interface WindowsUninstallResult {
  /** No step failed. A skipped step (misao not asked for, a hub on the host) is not a failure. */
  ok: boolean;
  steps: UninstallStep[];
}

export interface WindowsUninstallChoice {
  /** Also remove the misao task and folder (every pane of the host closes). */
  removeMisao: boolean;
}

/** What the uninstall needs of the host; the deployer supplies it from its own SSH session. */
export interface WindowsUninstallHost {
  tasks: Pick<SchtasksClient, 'query' | 'exportXml' | 'delete'>;
  /** Ends the running instance of a task and waits until it is not running; throws when it still is. */
  endTask(taskName: string): Promise<void>;
  /** Runs a PowerShell script on the host and returns its output; a non-zero exit throws with the script's own message. */
  script(what: string, body: string, timeoutMs?: number): Promise<string>;
}

const QUICK_MS = 60_000;
const FOLDER_MS = 300_000;

const failed = (id: UninstallStepId, err: unknown): UninstallStep => ({ id, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) });
const skipped = (id: UninstallStepId, detail: string): UninstallStep => ({ id, outcome: 'skipped', detail });

/**
 * Takes the Windows agent off its host: the task, the agent's processes, the firewall rule and the agent folder; with
 * `removeMisao`, also the misao task, its processes and its folder. It never stops at a failure: each step reports what it did, and a step
 * that depends on an earlier one (the folder needs the task gone and the processes ended; otherwise something would start the agent
 * again, or hold files open) is skipped with the reason. The steps that do not depend on each other (the firewall rule, misao) still run.
 * The hub's server row is not touched: that is `DELETE /api/servers/:name`.
 *
 * Everything is looked up by what AZITO created: the task is removed only if its definition runs this install's settings file
 * (`--env-file=<home>\<dir>\agent.env`), the processes are the ones that have that exact argument, the folders are not entered through
 * a link. Harness files and hooks are not touched.
 */
export async function uninstallWindowsAgent(host: WindowsUninstallHost, home: string, options: WindowsAgentOptions, choice: WindowsUninstallChoice): Promise<WindowsUninstallResult> {
  const steps: UninstallStep[] = [];
  const agentRoot = path.win32.join(home, options.dir);
  const envFile = path.win32.join(agentRoot, 'agent.env');

  const task = await step('task', () => removeTask(host, options.taskName, (xml) => unescapeTaskXml(xml).toLowerCase().includes(`--env-file=${envFile}`.toLowerCase()), `runs the agent of ${agentRoot}`));
  steps.push(task);
  steps.push(task.outcome === 'failed'
    ? skipped('processes', 'the task is still registered, so it would start the agent again')
    : await step('processes', () => run(host, 'Ending the agent processes', buildEndProcessesScript({ image: 'node.exe', argument: `--env-file=${envFile}`, label: 'agent', endParentConhost: true }), QUICK_MS, 'done')));
  steps.push(await step('firewall', () => removeFirewallRule(host, options.port)));
  const stopped = steps.every((s) => s.id === 'firewall' || s.outcome !== 'failed');
  steps.push(stopped
    ? await step('folder', () => removeFolder(host, home, agentRoot))
    : skipped('folder', 'the agent may still be running or registered: the folder is left so that nothing breaks underneath it'));

  if (choice.removeMisao) steps.push(...await removeMisao(host, home, options));
  return { ok: steps.every((s) => s.outcome !== 'failed'), steps };
}

async function step(id: UninstallStepId, action: () => Promise<Omit<UninstallStep, 'id'>>): Promise<UninstallStep> {
  try {
    return { id, ...(await action()) };
  } catch (err) {
    return failed(id, err);
  }
}

async function run(host: WindowsUninstallHost, what: string, body: string, timeoutMs: number, outcome: UninstallOutcome): Promise<Omit<UninstallStep, 'id'>> {
  await host.script(what, body, timeoutMs);
  return { outcome };
}

/** Ends and unregisters a task, if it is one of ours (`isOurs` reads its definition). Another definition under the same name is left alone and reported. */
async function removeTask(host: WindowsUninstallHost, taskName: string, isOurs: (xml: string) => boolean, whose: string): Promise<Omit<UninstallStep, 'id'>> {
  const state = await host.tasks.query(taskName);
  if (!state.exists) return { outcome: 'absent' };
  const xml = await host.tasks.exportXml(taskName);
  if (!isOurs(xml)) {
    return { outcome: 'failed', detail: `The task "${taskName}" does not look like the one AZITO registered (it does not ${whose}), so it was left alone. If it is not needed, delete it by hand: schtasks /Delete /TN ${taskName} /F` };
  }
  await host.endTask(taskName);
  await host.tasks.delete(taskName);
  if ((await host.tasks.query(taskName)).exists) throw new Error(`The task "${taskName}" is still registered after it was deleted`);
  return { outcome: 'done' };
}

/** One line of a script's output: `DONE`, `ABSENT` or `FAILED <reason>`. */
function parseOutcome(output: string): Omit<UninstallStep, 'id'> {
  const line = output.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
  if (line === 'DONE') return { outcome: 'done' };
  if (line === 'ABSENT') return { outcome: 'absent' };
  const reason = /^FAILED (.*)$/.exec(line)?.[1];
  if (reason !== undefined) return { outcome: 'failed', detail: redactSecretText(reason).slice(0, 600) };
  throw new Error(`The host's answer could not be read: ${redactSecretText(output.trim()).slice(0, 300) || 'nothing'}`);
}

/**
 * Deletes the folder tree below `root` without following a link: the folder and every folder up to the home must be real folders, and
 * a link inside is removed as a link (its target is not entered). A file that cannot be deleted (in use) is reported; the rest goes.
 * The same race as the old-version prune remains and is accepted: a folder can be swapped for a link between the check and the delete,
 * which only the owner of the owner-only folder or an administrator can do, and either can already delete what the link reaches.
 */
function folderScript(home: string, root: string): string {
  const q = powershellDialect.quote;
  return [
    `$homeDir = ${q(home)}`,
    `$root = ${q(root)}`,
    'function Test-Link($path) { return [bool]((Get-Item -LiteralPath $path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) }',
    'if ($null -eq (Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue)) { Write-Output \'ABSENT\'; exit 0 }',
    '$walk = $root',
    'while ($walk.TrimEnd([char]92) -ne $homeDir.TrimEnd([char]92)) {',
    '  if (Test-Link $walk) { throw ("Refusing to remove anything: " + $walk + " is a link (junction or symbolic link), and removing below it could delete files outside the home folder") }',
    '  $parent = [System.IO.Path]::GetDirectoryName($walk)',
    '  if ($null -eq $parent -or $parent -eq $walk) { throw ("The folder " + $root + " is not below the home folder " + $homeDir) }',
    '  $walk = $parent',
    '}',
    '$problems = New-Object System.Collections.ArrayList',
    'function Remove-Tree([string]$dir) {',
    '  foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($dir)) {',
    '    try {',
    '      $attributes = [System.IO.File]::GetAttributes($entry)',
    '      $isDirectory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)',
    '      if ([bool]($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {',
    '        if ($isDirectory) { [System.IO.Directory]::Delete($entry) } else { [System.IO.File]::Delete($entry) }',
    '      } elseif ($isDirectory) {',
    '        Remove-Tree $entry',
    '      } else {',
    '        [System.IO.File]::SetAttributes($entry, [System.IO.FileAttributes]::Normal)',
    '        [System.IO.File]::Delete($entry)',
    '      }',
    '    } catch { [void]$problems.Add($entry + ": " + $_.Exception.Message) }',
    '  }',
    '  try { [System.IO.File]::SetAttributes($dir, [System.IO.FileAttributes]::Directory); [System.IO.Directory]::Delete($dir) } catch { [void]$problems.Add($dir + ": " + $_.Exception.Message) }',
    '}',
    'Remove-Tree $root',
    'if ($problems.Count -gt 0) { Write-Output (\'FAILED \' + $problems.Count + \' item(s) could not be removed (a file in use? end the program that holds it, then delete the folder by hand): \' + ((@($problems | Select-Object -First 3) -join \'; \') -replace \'[\\r\\n]+\', \' \')) } else { Write-Output \'DONE\' }',
  ].join('\n');
}

async function removeFolder(host: WindowsUninstallHost, home: string, root: string): Promise<Omit<UninstallStep, 'id'>> {
  return parseOutcome(await host.script(`Removing ${root}`, folderScript(home, root), FOLDER_MS));
}

/**
 * The inbound rule the install added (`firewallRuleName(port)`). Windows lets only an administrator remove it: a session that is not
 * elevated gets the command to run instead, and the step is a failure (the rule stays open for a program that is gone).
 */
async function removeFirewallRule(host: WindowsUninstallHost, port: number): Promise<Omit<UninstallStep, 'id'>> {
  const q = powershellDialect.quote;
  const name = firewallRuleName(port);
  const out = await host.script('Removing the Windows Firewall rule', [
    `$name = ${q(name)}`,
    '$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '$rules = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq \'Inbound\' })',
    'if ($rules.Count -eq 0) { Write-Output \'ABSENT\'; exit 0 }',
    'try {',
    '  $rules | Remove-NetFirewallRule -ErrorAction Stop',
    '  Write-Output \'DONE\'',
    '} catch {',
    '  $reason = ($_.Exception.Message -replace \'[\\r\\n]+\', \' \')',
    '  if ($elevated) { Write-Output (\'FAILED \' + $reason) } else { Write-Output (\'FAILED NOTELEVATED \' + $reason) }',
    '}',
  ].join('\n'), QUICK_MS);
  const result = parseOutcome(out);
  if (result.outcome !== 'failed') return result;
  const reason = (result.detail ?? '').replace(/^NOTELEVATED /, '');
  const how = (result.detail ?? '').startsWith('NOTELEVATED ')
    ? 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot remove it.'
    : 'The host refused.';
  return { outcome: 'failed', detail: `The Windows Firewall rule "${name}" was not removed (${reason}). ${how} Run this once in an Administrator PowerShell on the host: Remove-NetFirewallRule -DisplayName "${name}"` };
}

/** The misao beside the agent: its task, its processes, its folder. A misao that belongs to a Windows hub on the same host is not ours to remove. */
async function removeMisao(host: WindowsUninstallHost, home: string, options: WindowsAgentOptions): Promise<UninstallStep[]> {
  const root = path.win32.join(home, options.misaoDir);
  const hub = await step('misaoTask', () => hubOwnsMisao(host, options));
  if (hub.outcome === 'failed') {
    const detail = `Could not tell whether a Windows hub on this host owns this misao, so it was left alone (${hub.detail})`;
    return [{ ...hub, detail }, skipped('misaoProcesses', 'misao was left alone'), skipped('misaoFolder', 'misao was left alone')];
  }
  if (hub.outcome === 'skipped') return [hub, skipped('misaoProcesses', 'the hub owns this misao'), skipped('misaoFolder', 'the hub owns this misao')];
  const task = await step('misaoTask', () => removeTask(host, options.misaoTaskName, (xml) => {
    const taskRoot = taskMisaoRoot(xml);
    return taskRoot !== undefined && path.win32.normalize(taskRoot).toLowerCase() === path.win32.normalize(root).toLowerCase();
  }, `start the misao of ${root}`));
  if (task.outcome === 'failed') {
    const why = 'the misao task is still registered, so it would start the daemon again';
    return [task, skipped('misaoProcesses', why), skipped('misaoFolder', why)];
  }
  // The daemon is found by its `--data <root>` argument, which is how the task starts it.
  const processes = await step('misaoProcesses', () => run(host, 'Ending the misao processes', buildEndProcessesScript({ image: 'misao.exe', argument: root, label: 'misao', endParentConhost: false }), QUICK_MS, 'done'));
  const folder = processes.outcome === 'failed'
    ? skipped('misaoFolder', 'the misao daemon may still be running: its folder is left so that nothing breaks underneath it')
    : await step('misaoFolder', () => removeFolder(host, home, root));
  return [task, processes, folder];
}

/**
 * `absent` = this misao is not a hub's and may be removed. The Windows hub (task `AzitoHub`) runs its misao as the task `AzitoMisao`
 * in `~\.azito\misao`, the same names an agent's misao has by default: with a hub registered on the host the two cannot be told apart
 * by name, and removing it would close the hub's windows. A misao with names of its own (a trial) cannot be the hub's.
 */
async function hubOwnsMisao(host: WindowsUninstallHost, options: WindowsAgentOptions): Promise<Omit<UninstallStep, 'id'>> {
  const sharesNames = options.misaoTaskName.toLowerCase() === MISAO_WINDOWS_TASK_NAME.toLowerCase() || options.misaoDir.toLowerCase() === MISAO_WINDOWS_DIR.toLowerCase();
  if (!sharesNames) return { outcome: 'absent' };
  const hub = await host.tasks.query(WINDOWS_HUB_TASK_NAME);
  if (!hub.exists) return { outcome: 'absent' };
  return { outcome: 'skipped', detail: `A Windows hub is registered on this host (the task "${WINDOWS_HUB_TASK_NAME}"), and this misao is the hub's: it was left in place. Remove it with the hub, or stop the hub and delete the task "${options.misaoTaskName}" and the folder ~\\${options.misaoDir} by hand.` };
}
