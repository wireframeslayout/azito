import fs from 'fs';
import * as path from 'path';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import type { SchtasksClient } from '../../shared/os/taskScheduler/schtasks';
import { buildTaskXml } from '../../shared/os/taskScheduler/taskDefinition';
import { joinWindowsArgs } from '../../shared/os/taskScheduler/windowsCommandLine';
import { MAX_COMMAND_LINE, samePrefix, singleExec, windowsPowershell } from './windowsHubService';

/**
 * The in-app update of a Windows hub runs as its own Task Scheduler task (#381 U2), registered and started by the hub and deleted by the
 * update itself when it is over.
 *
 * Why a task of its own and not a child of the hub: the update has to stop the hub (`/End` of `AzitoHub`) and start it again, and a process
 * the hub spawns lives in the hub task's job, where Node's `detached` is no way out (no breakaway). A task the Task Scheduler starts is
 * independent of `AzitoHub`: measured on a real Task Scheduler, a task registered and started by a process inside another task keeps
 * running after that other task is ended, and it can delete its own task while it runs.
 *
 * A task's action cannot carry environment variables, so what the update needs from the hub's environment (the bind address and port for
 * the health check) goes in its arguments, and the GitHub token (a secret: a command line is readable by every process of the machine)
 * goes in an owner-only file that the update reads and deletes first thing.
 */

export const HUB_UPDATE_TASK = 'AzitoHubUpdate';

/** The Task Scheduler stops an update that has not finished by then (a hung download); well over what a download, extract and two restarts take. */
const UPDATE_TIME_LIMIT = 'PT1H';
/** A previous update that is still ending when the next one is asked for gets this long before it is ended. */
const LEFTOVER_GRACE_MS = 15_000;
const LEFTOVER_POLL_MS = 500;

const MARKER = '# azito-hub-update hubDir=';
const MARKER_LINE = new RegExp(`^${MARKER}(.*?)\\r?$`, 'm');

export interface HubUpdateTaskInput {
  /** `DOMAIN\user` the task runs as. */
  userId: string;
  systemRoot: string;
  /** `<prefix>\hub`. The task's working directory, and what marks the task as this install's. */
  hubDir: string;
  /** The `node.exe` of the version that runs now (the new version is not extracted yet). */
  nodePath: string;
  /** The `azito-hub.cjs` of the version that runs now. */
  bundlePath: string;
  /** The arguments after `update-run`. */
  updateArgs: readonly string[];
  /** Where the update's own stdout and stderr go (a task has nowhere to send them): what failed before the update could write its state. */
  outputLog: string;
}

/**
 * The script the task runs. The paths are in the script and not in the task's command line: `conhost.exe` re-reads a command line
 * with spaces or parentheses in it wrongly (the same reason the hub's launcher is a script, `windowsHubService.ts`).
 */
export function buildHubUpdateScript(input: HubUpdateTaskInput): string {
  const q = powershellDialect.quote;
  const args = [input.nodePath, input.bundlePath, 'update-run', ...input.updateArgs].map(q).join(' ');
  return [
    `${MARKER}${input.hubDir}`,
    // Native stderr lines are not errors here: the update reports its failures in its state file and exit code.
    "$ErrorActionPreference = 'Continue'",
    `& ${args} 2>&1 | Out-File -LiteralPath ${q(input.outputLog)} -Encoding utf8`,
  ].join('\n');
}

function updateTaskExec(systemRoot: string, script: string): { command: string; argumentsLine: string } {
  const exec = {
    command: path.win32.join(systemRoot, 'System32', 'conhost.exe'),
    argumentsLine: joinWindowsArgs(['--headless', windowsPowershell(systemRoot), ...powershellEncodedArgs(script)]),
  };
  const length = exec.command.length + 1 + exec.argumentsLine.length;
  if (length > MAX_COMMAND_LINE) throw new Error(`The update task's command line would be ${length} characters, over the ${MAX_COMMAND_LINE} a task can run: the install prefix or the download URL is too long`);
  return exec;
}

/**
 * The task: no trigger (it runs only when the hub calls `/Run`, and a task left behind never starts again at a logon), as the hub's
 * user with least privilege, under `conhost.exe --headless` so that no console window appears, ended by the Task Scheduler after
 * {@link UPDATE_TIME_LIMIT}.
 */
export function buildHubUpdateTaskXml(input: HubUpdateTaskInput): string {
  const exec = updateTaskExec(input.systemRoot, buildHubUpdateScript(input));
  return buildTaskXml({
    userId: input.userId,
    description: 'AZITO Hub Update: runs once, started by the hub (safe to delete)',
    executable: exec.command,
    argumentsLine: exec.argumentsLine,
    workingDirectory: input.hubDir,
    restartOnFailure: { intervalMinutes: 1, count: 1 },
    trigger: 'on-demand',
    executionTimeLimit: UPDATE_TIME_LIMIT,
  });
}

/**
 * Which install a REGISTERED task named `AzitoHubUpdate` (the XML the Task Scheduler gives back) belongs to: the folder named in the
 * script's first line, and only when the task's single action is `conhost.exe --headless powershell.exe -EncodedCommand <that script>`.
 * `undefined`: not a task this code registered, so it is never touched.
 */
export function inspectHubUpdateTask(xml: string, systemRoot: string): { hubDir: string } | undefined {
  const exec = singleExec(xml);
  if (exec === undefined) return undefined;
  if (exec.command.toLowerCase() !== path.win32.join(systemRoot, 'System32', 'conhost.exe').toLowerCase()) return undefined;
  const encoded = /^--headless (?:"[^"]*"|\S+) -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(exec.argumentsLine)?.[1];
  if (encoded === undefined) return undefined;
  const hubDir = MARKER_LINE.exec(Buffer.from(encoded, 'base64').toString('utf16le'))?.[1];
  return hubDir === undefined || hubDir === '' ? undefined : { hubDir };
}

export interface HubUpdateLauncher {
  client: SchtasksClient;
  guard: SecretFileGuard;
}

export interface HubUpdateLaunch {
  task: HubUpdateTaskInput;
  /** Where the token file is written (the update reads and deletes it). Ignored without a token. */
  tokenFile: string;
  /** The GitHub token, when the release repository needs one (never an empty string). */
  token: string | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A task named `AzitoHubUpdate` that is still there is the leftover of an earlier update (the update deletes its own task when it
 * ends; a crash or a stop does not). It is replaced only when it is recognised as this code's: another name's owner is never guessed,
 * and an update of ANOTHER install that is running is not stopped. One of this install that is still running (a hung update, or one
 * that is ending) is given a moment, then ended.
 */
async function clearLeftover(launcher: HubUpdateLauncher, launch: HubUpdateLaunch): Promise<void> {
  const { client } = launcher;
  const state = await client.query(HUB_UPDATE_TASK);
  if (!state.exists) return;
  const owner = inspectHubUpdateTask(await client.exportXml(HUB_UPDATE_TASK), launch.task.systemRoot);
  if (owner === undefined) {
    throw new Error(`A task named ${HUB_UPDATE_TASK} exists that AZITO did not register, so it is not replaced. Delete it (schtasks /Delete /TN ${HUB_UPDATE_TASK}) and try again`);
  }
  if (state.running) {
    if (!samePrefix(owner.hubDir, launch.task.hubDir)) {
      throw new Error(`An update of another install (${owner.hubDir}) is running; wait for it to finish`);
    }
    const deadline = Date.now() + LEFTOVER_GRACE_MS;
    const stillRunning = async (): Promise<boolean> => {
      const now = await client.query(HUB_UPDATE_TASK);
      return now.exists && now.running;
    };
    while (Date.now() < deadline && (await stillRunning())) await sleep(LEFTOVER_POLL_MS);
    if (await stillRunning()) await client.stop(HUB_UPDATE_TASK);
  }
  await client.delete(HUB_UPDATE_TASK);
}

/**
 * Registers `AzitoHubUpdate` and starts it. The token (when there is one) is written to its file BEFORE the task is registered and
 * removed again if the task cannot be registered or started; once the update runs, it deletes the file itself.
 */
export async function launchHubUpdateTask(launcher: HubUpdateLauncher, launch: HubUpdateLaunch): Promise<void> {
  await clearLeftover(launcher, launch);
  const { token } = launch;
  if (token !== undefined) launcher.guard.writeSecretFile(launch.tokenFile, token);
  try {
    await launcher.client.register(HUB_UPDATE_TASK, buildHubUpdateTaskXml(launch.task));
    await launcher.client.start(HUB_UPDATE_TASK);
  } catch (err) {
    if (token !== undefined) fs.rmSync(launch.tokenFile, { force: true });
    try {
      await launcher.client.delete(HUB_UPDATE_TASK);
    } catch {
      // Nothing was registered (that is what failed), or it is gone: the reason to report is the original one.
    }
    throw err;
  }
}
