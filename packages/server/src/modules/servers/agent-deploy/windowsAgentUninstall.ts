import * as path from 'path';
import type { SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { hubRootOfScript, soleExecAction, taskExecActions } from '../../../shared/os/taskScheduler/taskXmlRead';
import { firewallRuleName } from './windowsFirewall';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { agentTaskIdentity, misaoTaskVersion, type AgentTaskIdentity } from './windowsAgentTask';
import type { WindowsAgentOptions } from './windowsAgentConfig';
import { decideMisaoStop, decidePathChains, folderScript, leftoverProcessesScript, misaoHolderScript, misaoStopScript, parseFolderOutput, parseLeftoverOutput, parseMisaoHolderOutput, parsePathChainOutput, pathChainScript, type ScriptOutcome, type UninstallOutcome } from './windowsAgentUninstallScripts';
import { firewallInspectScript, misaoDaemonScript, misaoHubScript, parseFirewallOutput, parseMisaoGuardOutput, parseSameFileOutput, sameFileScript } from './windowsAgentOwnership';

/*
 * The threat this removal is built against, and the one it is not.
 *
 * It guards against taking away, or stopping, what is not this install's by mistake: another install's task, a hub's misao, a program
 * that happens to look like the agent. Every deletion needs the thing to be shown to be the install's; what cannot be shown is left, with the
 * reason. It does NOT guard against a malicious process running as the SAME user (one that swaps the daemon between the check and the stop,
 * or spells a path in a mix of forms on purpose to be missed): that user can delete everything this removes by himself, so nothing is
 * crossed. Three limits follow from that, and are accepted:
 * - the check that a daemon is the install's and the request to stop it are two connections, and the daemon can be replaced between them;
 * - a process that uses the folder under a name that mixes the long and the 8.3 forms of its parts (beyond the folder's own spellings and
 *   the part below the home) is not found by the look for what is left;
 * - a process of the user's own that hides its program and command line and is not in the list of names that can hold an AZITO folder
 *   (a protected process, which has no way to run a script from an AZITO folder) is named in the result but not counted.
 */

/** The Task Scheduler task of a Windows hub (`HUB_SERVICE.windowsTaskName`, fixed: there is no setting for it; a test keeps the two in step). */
export const WINDOWS_HUB_TASK_NAME = 'AzitoHub';

export type UninstallStepId = 'task' | 'processes' | 'firewall' | 'folder' | 'misaoTask' | 'misaoProcesses' | 'misaoFolder';

export type { UninstallOutcome };

export interface UninstallStep {
  id: UninstallStepId;
  outcome: UninstallOutcome;
  detail?: string;
}

export interface WindowsUninstallResult {
  /** No step failed. A skipped step (misao not asked for, a hub owns it, a rule that is not this install's) is not a failure. */
  ok: boolean;
  steps: UninstallStep[];
}

/**
 * What the host reports of itself (the SSH preflight): the user's home, `%SystemRoot%`, the node.exe found now (null: none) and the
 * account (`DOMAIN\user`).
 */
export interface HostFacts {
  home: string;
  systemRoot: string;
  nodePath: string | null;
  userId: string;
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

async function step(id: UninstallStepId, action: () => Promise<ScriptOutcome>): Promise<UninstallStep> {
  try {
    return { id, ...(await action()) };
  } catch (err) {
    return failed(id, err);
  }
}

/**
 * The node.exe and release folder the agent's task runs, when the task has ONE action, an Exec equal to what `agentTaskAction` makes (see
 * `agentTaskIdentity`); undefined when it is not known to be the install's. A task with any other action beside it (a COM handler, a
 * message) is not the install's.
 */
function agentTaskOf(xml: string, facts: HostFacts, root: string, envFile: string): AgentTaskIdentity | undefined {
  const action = soleExecAction(xml);
  return action === undefined ? undefined : agentTaskIdentity(action, facts.systemRoot, root, envFile);
}

/** The release folder the misao task runs, when the task has ONE action, an Exec equal to what the install writes for the misao in `root` (see `misaoTaskVersion`). */
function misaoTaskOf(xml: string, facts: HostFacts, root: string): string | undefined {
  const action = soleExecAction(xml);
  return action === undefined ? undefined : misaoTaskVersion(action, facts.systemRoot, root, userNameOf(facts.userId));
}

/** `DOMAIN\user` -> `user`: the account name the misao pipe is made from. */
const userNameOf = (userId: string): string => userId.slice(userId.lastIndexOf('\\') + 1);

type TaskRemoval = { step: ScriptOutcome; foreign: boolean };

/** Ends and unregisters a task, if `isOurs` says its definition is the install's. Another definition under the same name is left alone and reported (`foreign`). */
async function removeTask(host: WindowsUninstallHost, taskName: string, isOurs: (xml: string) => boolean | Promise<boolean>, whose: string): Promise<TaskRemoval> {
  const state = await host.tasks.query(taskName);
  if (!state.exists) return { step: { outcome: 'absent' }, foreign: false };
  const xml = await host.tasks.exportXml(taskName);
  if (!(await isOurs(xml))) {
    return {
      foreign: true,
      step: { outcome: 'failed', detail: `The task "${taskName}" does not look like the one AZITO registered (its action does not ${whose}), so it was left alone. If it is not needed, delete it by hand: schtasks /Delete /TN ${taskName} /F` },
    };
  }
  await host.endTask(taskName);
  await host.tasks.delete(taskName);
  if ((await host.tasks.query(taskName)).exists) throw new Error(`The task "${taskName}" is still registered after it was deleted`);
  return { step: { outcome: 'done' }, foreign: false };
}

/**
 * Takes the Windows agent off its host: the task, the agent folder, and with `removeMisao` the misao task and folder. AZITO ends no process
 * itself: it ends the task (`/End`, which ends what the Task Scheduler started), and then only LOOKS for a process still running from the
 * folder; one that is there stops the deletion, with its pid and path, for the person to deal with. A firewall rule is only REPORTED (its
 * Name and what it allows), with the command to remove it once checked. Each step reports what it did; a step that depends on an earlier one
 * (the folder needs the task gone and nothing running from it) is skipped with the reason, and what does not depend on it still runs.
 * The hub's server row is not touched: that is `DELETE /api/servers/:name`.
 *
 * A task is removed only when it has ONE action and that action is exactly what the install writes (`agentTaskAction`), with a node.exe that
 * is the same file as the one found on the host now; anything else is left. The folders are not entered through a link (every folder up to
 * the drive's root must be a real one). Harness files and hooks are not touched.
 */
export async function uninstallWindowsAgent(host: WindowsUninstallHost, facts: HostFacts, options: WindowsAgentOptions, choice: WindowsUninstallChoice): Promise<WindowsUninstallResult> {
  const { home } = facts;
  const steps: UninstallStep[] = [];
  const agentRoot = path.win32.join(home, options.dir);
  const envFile = path.win32.join(agentRoot, 'agent.env');

  let removal: TaskRemoval;
  try {
    removal = await removeTask(host, options.taskName, async (xml) => {
      const identity = agentTaskOf(xml, facts, agentRoot, envFile);
      return identity !== undefined && await isHostNode(host, identity.nodePath, facts.nodePath);
    }, `have the form the AZITO install writes for ${envFile}, with this host's node.exe`);
  } catch (err) {
    removal = { step: { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) }, foreign: false };
  }
  steps.push({ id: 'task', ...removal.step });

  steps.push(removal.step.outcome === 'failed'
    ? skipped('processes', 'the task is still registered, so it would start the agent again')
    : await step('processes', async () => parseLeftoverOutput(await host.script('Looking for processes still running from the agent folder', leftoverProcessesScript(agentRoot, home), QUICK_MS), agentRoot)));

  if (removal.foreign) {
    steps.push(skipped('firewall', 'the task belongs to another install, so its firewall rule was not looked at'));
  } else {
    const name = firewallRuleName(options.port);
    steps.push(await step('firewall', async () => parseFirewallOutput(await host.script('Looking for the Windows Firewall rule', firewallInspectScript(name), QUICK_MS), name)));
  }

  const stopped = steps.every((s) => s.id === 'firewall' || s.outcome !== 'failed');
  steps.push(stopped
    ? await step('folder', async () => parseFolderOutput(await host.script(`Removing ${agentRoot}`, folderScript(home, agentRoot), FOLDER_MS)))
    : skipped('folder', 'the agent may still be running or registered: the folder is left so that nothing breaks underneath it'));

  if (choice.removeMisao) steps.push(...await removeMisao(host, facts, options));
  return { ok: steps.every((s) => s.outcome !== 'failed'), steps };
}

/**
 * The node.exe a recognised task runs is accepted only when it is the same file (each put in its long form on the host, no junction on the
 * way) as the node.exe found on the host now. A host with no node.exe, or paths that cannot be resolved, accepts nothing.
 */
async function isHostNode(host: WindowsUninstallHost, taskNode: string, hostNode: string | null): Promise<boolean> {
  if (hostNode === null) return false;
  return parseSameFileOutput(await host.script('Comparing the node.exe of the task with the one of the host', sameFileScript(taskNode, hostNode), QUICK_MS)) === 'same';
}

/** The misao beside the agent: its task, its processes, its folder. A misao that belongs to a hub of this host, or that cannot be shown to be the agent's, is left in place. */
async function removeMisao(host: WindowsUninstallHost, facts: HostFacts, options: WindowsAgentOptions): Promise<UninstallStep[]> {
  const { home } = facts;
  const root = path.win32.join(home, options.misaoDir);
  const guard = await step('misaoTask', () => misaoOwner(host, root, home));
  if (guard.outcome !== 'absent') {
    const why = guard.outcome === 'failed' ? 'the owner of the misao could not be determined' : 'misao was left in place';
    return [guard, skipped('misaoProcesses', why), skipped('misaoFolder', why)];
  }
  let version: string | undefined;
  const task = await step('misaoTask', async () => {
    const removal = await removeTask(host, options.misaoTaskName, (xml) => {
      version = misaoTaskOf(xml, facts, root);
      return version !== undefined;
    }, `have the form the AZITO install writes for the misao of ${root}`);
    return removal.step;
  });
  if (task.outcome === 'failed') {
    const why = 'the misao task is still registered, so it would start the daemon again';
    return [task, skipped('misaoProcesses', why), skipped('misaoFolder', why)];
  }
  // The task is ended, and ending it does not end the daemon. The daemon is asked to stop, through its own pipe, only once Windows has said that
  // the process serving that pipe is a misao.exe of the user's own under this folder; otherwise nothing is stopped and the look says what is left.
  const pipe = windowsMisaoPipe(root, userNameOf(facts.userId));
  const stopNote = version === undefined ? 'the misao task was not there to say which release to ask' : await askToStop(host, root, pipe, path.win32.join(root, version as string, 'misao.exe'));
  const processes = await step('misaoProcesses', async () => parseLeftoverOutput(await host.script('Looking for processes still running from the misao folder', leftoverProcessesScript(root, home), QUICK_MS), root, misaoAdvice(root, pipe, version as string | undefined, stopNote)));
  const folder = processes.outcome === 'failed'
    ? skipped('misaoFolder', 'the misao daemon may still be running: its folder is left so that nothing breaks underneath it')
    : await step('misaoFolder', async () => parseFolderOutput(await host.script(`Removing ${root}`, folderScript(home, root), FOLDER_MS)));
  return [task, processes, folder];
}

/**
 * Asks the daemon behind `pipe` to stop (its own `stop`; every window it holds closes) when, and only when, Windows says the process serving
 * that pipe is a `misao.exe` of the user's own under `root` (see `decideMisaoStop`). Returns why it did not ask, or '' when it did (what is
 * still running afterwards is for the look to find, not this). A host that cannot be asked is a reason not to ask, never a failure of its own.
 */
async function askToStop(host: WindowsUninstallHost, root: string, pipe: string, exe: string): Promise<string> {
  try {
    const holder = parseMisaoHolderOutput(await host.script('Asking Windows which process serves the misao pipe', misaoHolderScript(root, pipe), QUICK_MS));
    const decision = decideMisaoStop(root, holder);
    if (!decision.stop) return holder.kind === 'nopipe' ? '' : decision.reason;
    // Both paths a stop relies on are walked to the drive's root, as the deletion of a folder does, before anything is asked of the daemon.
    if (holder.kind === 'holder') {
      const chains = decidePathChains(parsePathChainOutput(await host.script('Checking the paths a stop relies on', pathChainScript(holder.exe, exe), QUICK_MS)), holder.exe, exe);
      if (!chains.stop) return chains.reason;
    }
    await host.script('Asking the misao daemon to stop', misaoStopScript(exe, pipe), 60_000);
    return '';
  } catch (err) {
    return `the daemon could not be asked (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** What to tell the person when a misao daemon is still running after the task was ended (and the daemon was, or was not, asked to stop: `stopNote` says why not). */
function misaoAdvice(root: string, pipe: string, version: string | undefined, stopNote: string): string {
  const exe = version === undefined ? '<the misao.exe of the daemon>' : path.win32.join(root, version, 'misao.exe');
  const why = stopNote === '' ? 'The daemon was asked to stop and is still there.' : `The daemon was not asked to stop, because ${stopNote}.`;
  return `Ending the task does not end a misao daemon. ${why} If it is the daemon of this install, stop it cleanly (every window it holds closes), in PowerShell: $env:MISAO_SOCKET = '${pipe}'; & '${exe}' stop`;
}

/** The hub's misao folder, from the hub task's launcher script (`$hubRoot = '<prefix>\hub'`; the hub keeps its misao in `<prefix>\misao`). */
function hubMisaoRootOf(xml: string): string | undefined {
  for (const action of taskExecActions(xml)) {
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(action.argumentsLine)?.[1];
    const hubRoot = encoded === undefined ? undefined : hubRootOfScript(Buffer.from(encoded, 'base64').toString('utf16le'));
    if (hubRoot !== undefined) return path.win32.join(path.win32.dirname(hubRoot), 'misao');
  }
  return undefined;
}

/**
 * `absent` = nothing says this misao is someone else's, so it may be removed. A misao is left (`skipped`, with the reason) when
 * - the hub's task `AzitoHub` is registered and keeps its misao in this very folder (the hub's own misao; a hub of another prefix has another folder), or its folder cannot be read, or the two folders cannot be compared on the host (so they may be one);
 * - no hub task is registered but a hub process runs on the host (a hub started from a source checkout or by hand has no task to ask), since its misao cannot be told from the agent's;
 * - a `misao.exe` of this folder is running that no task started;
 * - the owner of a process that matters cannot be read (it is then neither "mine" nor "someone else's").
 * A hub that is started in a way none of these can see is not recognised; that is the limit of what can be known from outside.
 */
async function misaoOwner(host: WindowsUninstallHost, root: string, home: string): Promise<ScriptOutcome> {
  const hub = await host.tasks.query(WINDOWS_HUB_TASK_NAME);
  let hubRoot: string | undefined;
  if (hub.exists) {
    hubRoot = hubMisaoRootOf(await host.tasks.exportXml(WINDOWS_HUB_TASK_NAME));
    if (hubRoot === undefined) {
      return { outcome: 'skipped', detail: `A Windows hub is registered on this host (the task "${WINDOWS_HUB_TASK_NAME}") but the folder of its misao cannot be read from the task, so this misao was left in place. Remove it by hand if it is not the hub's.` };
    }
  }
  let answer = parseMisaoGuardOutput(await host.script('Checking the hub of the misao', misaoHubScript({ root, hubRoot, looksForHub: !hub.exists }), QUICK_MS));
  // Nothing says it is a hub's: look at the daemons of the folder themselves.
  if (answer.kind === 'clear') answer = parseMisaoGuardOutput(await host.script('Checking who runs the misao', misaoDaemonScript(root, home), QUICK_MS));
  switch (answer.kind) {
    case 'sameHub':
      return { outcome: 'skipped', detail: `This misao (${root}) is the one of the Windows hub registered on this host (the task "${WINDOWS_HUB_TASK_NAME}"; the folders are the same once their names are resolved on the host), so it was left in place. Remove it with the hub.` };
    case 'maybeHub':
      return { outcome: 'skipped', detail: `A Windows hub is registered on this host (the task "${WINDOWS_HUB_TASK_NAME}") and its misao folder (${hubRoot}) could not be resolved on the host to compare with ${root}, so they may be the same and this misao was left in place.` };
    case 'hub':
      return { outcome: 'skipped', detail: `An AZITO hub is running on this host without the task "${WINDOWS_HUB_TASK_NAME}" (process ${answer.pid}), and its misao cannot be told from the agent's, so this misao was left in place.` };
    case 'foreign':
      return { outcome: 'skipped', detail: `A misao of ${root} is running (process ${answer.pid}) that no scheduled task started, so it is not known to be the agent's and was left in place.` };
    case 'unknown':
      return { outcome: 'skipped', detail: `The owner of the process ${answer.pid} could not be read, so it is not known whether it uses the misao of ${root}; this misao was left in place.` };
    case 'clear':
      return { outcome: 'absent' };
  }
}
