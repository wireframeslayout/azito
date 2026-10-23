import * as fs from 'fs';
import type { ServiceManager } from '../modules/system/serviceManager';
import type { ServiceHost } from '../modules/system/createServiceManager';
import {
  HUB_GRACE_MS, buildHubTaskXml, endHubProcesses, findHubProcesses, hubWindowsLayout, inspectRegisteredHub, resolveWindowsUserId, samePrefix,
  type HubWindowsLayout, type SpecRunner,
} from '../modules/system/windowsHubService';
import { resolveInstallPrefix } from '../modules/system/misao/misaoPaths';
import { runCommandSpec, runHostOf, type RunCommandOptions } from '../shared/exec/runCommandSpec';
import { SchtasksClient, rawRunnerOf } from '../shared/os/taskScheduler/schtasks';
import { HUB_SERVICE } from '../modules/system/serviceManager';
import type { ServiceCommandContext } from './serviceCommandContext';

/** Where the Windows hub of this bundle lives, and everything its operations need, resolved once. */
export interface WindowsHub {
  layout: HubWindowsLayout;
  /** `<prefix>\hub` as given and as the real path (junctions and 8.3 names make them differ): the hub's command line has either. */
  hubRoots: string[];
  systemRoot: string;
  client: SchtasksClient;
  runHost: RunCommandOptions;
}

export function resolveWindowsHub(host: ServiceHost, context: ServiceCommandContext): WindowsHub {
  if (!context.bundleRoot) throw new Error('This is not a release install (a source checkout has no service): there is no AZITO prefix to register.');
  if (!host.systemRoot) throw new Error('%SystemRoot% is not set, so schtasks.exe and PowerShell cannot be found');
  const prefix = resolveInstallPrefix(context.bundleRoot);
  if (!prefix) throw new Error(`The bundle ${context.bundleRoot} is not inside <prefix>\\hub\\<version>, so the install prefix cannot be told.`);
  const layout = hubWindowsLayout(prefix);
  const hubRoots = [layout.hubRoot];
  const real = fs.realpathSync.native(layout.hubRoot);
  if (!samePrefix(real, layout.hubRoot)) hubRoots.push(real);
  const runHost = runHostOf(host);
  const client = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHost, rawOutput: true })), host);
  return { layout, hubRoots, systemRoot: host.systemRoot, client, runHost };
}

/** The task as the Task Scheduler has it (the manager's definition copy can outlive a task that was deleted by hand). */
export async function taskExists(hub: WindowsHub): Promise<boolean> {
  return (await hub.client.query(HUB_SERVICE.windowsTaskName)).exists;
}

/** Whether `other` (a prefix read from a definition) is this install, by spelling or by real path. */
function isThisPrefix(other: string, hub: WindowsHub): boolean {
  if (samePrefix(other, hub.layout.prefix)) return true;
  try {
    return samePrefix(fs.realpathSync.native(other), fs.realpathSync.native(hub.layout.prefix));
  } catch {
    return false;
  }
}

/** Which install the REGISTERED task (asked of the Task Scheduler, not read from our copy) belongs to; undefined when it is not a hub task this version recognises. */
async function registeredOwner(hub: WindowsHub): Promise<{ prefix: string } | undefined> {
  return inspectRegisteredHub(await hub.client.exportXml(HUB_SERVICE.windowsTaskName), hub.systemRoot);
}

/**
 * The task name is fixed (`AzitoHub`), so a task registered for another prefix of the same user would be operated from here by
 * mistake. The definition copy can disagree with the task (it is only ours), so the task itself is asked: it must exist, be
 * recognised as a hub task, and belong to this install. Otherwise the operation is refused, saying where the task belongs.
 */
export async function requireOwnTask(manager: ServiceManager, hub: WindowsHub): Promise<void> {
  if (!(await taskExists(hub))) {
    if (manager.readDefinition() === undefined) throw new Error('The AZITO service is not installed (no Task Scheduler task). Run `azito service install`, or install.ps1 without -NoService.');
    throw new Error('The task AzitoHub is not registered any more (it was deleted). Run `azito service install` to register it again.');
  }
  const owner = await registeredOwner(hub);
  if (owner === undefined) throw new Error('The registered AzitoHub task is not one this version of AZITO recognises (its action was changed, or it is from another version). Run `azito service install --yes` to replace it.');
  if (!isThisPrefix(owner.prefix, hub)) {
    throw new Error(`The task AzitoHub belongs to another install (${owner.prefix}), not this one (${hub.layout.prefix}). Operate it with that install's \`azito\`, or register this one with \`azito service install --yes\` (that replaces it).`);
  }
}

/**
 * Registers the task. The definition is generated here (`buildHubTaskXml`), so install.ps1 never writes XML.
 * - A task that exists is judged from the task itself, whatever the definition copy says:
 *   - this install's, with the definition we would register: nothing to do (a missing or different copy is written again);
 *   - running: never replaced;
 *   - another install's, or one this version does not recognise: replaced only with `--yes`.
 * - No task (a copy left behind after a delete by hand, or nothing): registered.
 */
export async function installWindowsTask(manager: ServiceManager, hub: WindowsHub, context: ServiceCommandContext, yes: boolean): Promise<void> {
  const xml = buildHubTaskXml({ userId: resolveWindowsUserId(context.env), systemRoot: hub.systemRoot, layout: hub.layout });
  if (await taskExists(hub)) {
    const owner = await registeredOwner(hub);
    const own = owner !== undefined && isThisPrefix(owner.prefix, hub);
    if (own && manager.readDefinition() === xml) {
      console.log('service install: the task is already registered with this definition');
      return;
    }
    const whose = owner === undefined ? 'with a definition this version of AZITO does not recognise' : `for ${owner.prefix}`;
    if ((await manager.state()) === 'active') {
      throw new Error(`The AZITO task is registered ${whose} (not with the definition to install) and is running. Stop it first (\`azito stop\` of the install it belongs to), then install again.`);
    }
    if (!own && !yes) {
      throw new Error(`The task AzitoHub is registered ${whose}. Installing here replaces it, and that install's \`azito start\` would then start this one. Run \`azito service install --yes\` to replace it.`);
    }
    if (!own) console.log(`service install: replacing the task registered ${whose}`);
  }
  await manager.install(xml);
}

/** start / stop / restart / reload of the registered task. Stopping waits for the hub to end by itself, then ends what is left. */
export async function runOnWindows(command: 'start' | 'stop' | 'restart' | 'reload', manager: ServiceManager, hub: WindowsHub, context: ServiceCommandContext): Promise<void> {
  await requireOwnTask(manager, hub);
  if (command === 'start') {
    await manager.start();
    return;
  }
  // Found BEFORE the task is ended, and of any version folder: a restart after `current.txt` was switched must wait for the old version.
  const run: SpecRunner = (spec) => runCommandSpec(spec, hub.runHost);
  const targets = await findHubProcesses(run, hub.systemRoot, hub.hubRoots, context.pid);
  await manager.stop();
  const forced = await endHubProcesses(run, hub.systemRoot, targets, HUB_GRACE_MS);
  if (forced.length > 0) console.warn(`azito service: the hub did not end within ${HUB_GRACE_MS / 1000}s of the task being ended, so it was ended forcibly (process ${forced.join(', ')})`);
  // restart and reload are the same here: the registered task is the installed definition, so making it current is a restart.
  if (command !== 'stop') await manager.start();
}
