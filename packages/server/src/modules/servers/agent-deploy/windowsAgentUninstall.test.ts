import { describe, expect, it } from 'vitest';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { HUB_SERVICE } from '../../system/serviceManager';
import { MISAO_SERVICE } from '../../system/misao/misaoPaths';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, MISAO_WINDOWS_TASK_NAME, type WindowsAgentOptions } from './windowsAgentConfig';
import { WindowsAgentDeployer, windowsAgentEnvFile, type WindowsSshExec } from './WindowsAgentDeployer';
import { FakeWindowsHost } from './testing/fakeWindowsHost';
import { WINDOWS_HUB_TASK_NAME, uninstallWindowsAgent, type UninstallStepId, type WindowsUninstallHost, type WindowsUninstallResult } from './windowsAgentUninstall';
import { exactProcessesScript, folderScript, parseFolderOutput, parseProcessesOutput } from './windowsAgentUninstallScripts';
import { agentProcessShape, expandShape, misaoProcessShape } from './windowsAgentTask';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { HUB_COMMAND_LINE_PATTERN, firewallScript, misaoGuardScript, parseFirewallOutput, parseMisaoGuardOutput } from './windowsAgentOwnership';

const HOME = 'C:\\Users\\dev';
const OPTIONS = DEFAULT_WINDOWS_AGENT_OPTIONS;
const BIND = '100.64.0.7';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

/** The task definition the install registers (the same builder), for the settings file of `home`. */
function agentTaskXml(envFile = windowsAgentEnvFile(HOME, OPTIONS), node = NODE, description = 'AZITO Agent: started at logon by the AZITO hub'): string {
  return buildTaskXml({
    userId: 'PC\\dev', description, executable: 'C:\\Windows\\System32\\conhost.exe',
    args: ['--headless', node, `--env-file=${envFile}`, `${HOME}\\.azito\\agent\\abc123abc123\\azito-agent.cjs`],
    workingDirectory: `${HOME}\\.azito\\agent\\abc123abc123`, restartOnFailure: { intervalMinutes: 1, count: 999 },
  });
}

const AGENT_XML = agentTaskXml();

function misaoXml(root: string, taskName = MISAO_WINDOWS_TASK_NAME): string {
  return buildMisaoTaskXml({
    userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME,
    layout: misaoWindowsLayout({ misaoRoot: root }, '0.3.0', taskName), pipe: windowsMisaoPipe(root, 'dev'),
  });
}

const MISAO_XML = misaoXml(`${HOME}\\.azito\\misao`);

/** The task the hub registers: a launcher script that holds `$hubRoot = '<prefix>\hub'`. */
function hubTaskXml(prefix: string): string {
  const script = [`$hubRoot = '${prefix}\\hub'`, '$base = 5'].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `<Task><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>--headless powershell.exe -NoProfile -EncodedCommand ${encoded}</Arguments></Exec></Actions></Task>`;
}

interface TaskInit {
  xml: string;
  running?: boolean;
}

/** A host that keeps the registered tasks and answers each script by what it is for. */
class FakeUninstallHost {
  readonly log: string[] = [];
  readonly tasks: Map<string, TaskInit & { running: boolean }>;
  /** What a script answers, by the start of its `what`; an Error is thrown. */
  answers: Record<string, string | Error> = {
    'Ending the agent processes': 'ENDED 1',
    'Removing the Windows Firewall rule': 'REMOVED',
    'Checking who runs the misao': 'CLEAR',
    'Ending the misao processes': 'ENDED 1',
    'Removing C:': 'DONE',
  };
  endTaskError: Error | undefined;
  queryError: { task: string; error: Error } | undefined;
  readonly bodies: Array<{ what: string; body: string }> = [];

  constructor(tasks: Record<string, TaskInit>) {
    this.tasks = new Map(Object.entries(tasks).map(([name, t]) => [name, { ...t, running: t.running ?? false }]));
  }

  readonly taskClient: WindowsUninstallHost['tasks'] = {
    query: async (name) => {
      if (this.queryError?.task === name) throw this.queryError.error;
      const t = this.tasks.get(name);
      this.log.push(`query ${name}`);
      return t ? { exists: true, running: t.running, failed: false, lastResult: 0 } : { exists: false };
    },
    exportXml: async (name) => {
      this.log.push(`export ${name}`);
      return this.tasks.get(name)!.xml;
    },
    delete: async (name) => {
      this.log.push(`delete ${name}`);
      this.tasks.delete(name);
    },
  };

  endTask = async (name: string): Promise<void> => {
    this.log.push(`end ${name}`);
    if (this.endTaskError) throw this.endTaskError;
    const t = this.tasks.get(name);
    if (t) t.running = false;
  };

  script = async (what: string, body: string): Promise<string> => {
    this.log.push(`script ${what}`);
    this.bodies.push({ what, body });
    const key = Object.keys(this.answers).find((k) => what.startsWith(k));
    const answer = key === undefined ? '' : this.answers[key]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };

  asHost(): WindowsUninstallHost {
    return { tasks: this.taskClient, endTask: this.endTask, script: this.script };
  }

  bodyOf(what: string): string {
    return this.bodies.find((b) => b.what.startsWith(what))!.body;
  }
}

const factsOf = (home: string, nodePath: string | null, bindAddress: string | undefined = BIND) => ({ home, systemRoot: 'C:\\Windows', nodePath, userId: 'PC\\dev', bindAddress });
const outcomes = (result: WindowsUninstallResult): Record<string, string> => Object.fromEntries(result.steps.map((s) => [s.id, s.outcome]));
const detail = (result: WindowsUninstallResult, id: UninstallStepId): string => result.steps.find((s) => s.id === id)?.detail ?? '';
const run = (host: FakeUninstallHost, removeMisao = false, options: WindowsAgentOptions = OPTIONS, hostNode: string | null = NODE): Promise<WindowsUninstallResult> => uninstallWindowsAgent(host.asHost(), factsOf(HOME, hostNode), options, { removeMisao });

describe('uninstallWindowsAgent', () => {
  it('stops the running task, unregisters it, ends its processes, removes the firewall rule and the folder, in that order', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
    const result = await run(host);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'done', folder: 'done' });
    expect(host.log).toEqual([
      'query AzitoAgent', 'export AzitoAgent', 'end AzitoAgent', 'delete AzitoAgent', 'query AzitoAgent',
      'script Ending the agent processes', 'script Removing the Windows Firewall rule', `script Removing ${HOME}\\.azito\\agent`,
    ]);
    expect(host.tasks.has('AzitoAgent')).toBe(false);
  });

  it('ends only the node.exe of this install\'s settings file', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    await run(host);
    const sweep = host.bodyOf('Ending the agent processes');
    expect(sweep).toContain("Name = 'node.exe'");
    expect(sweep).toContain('function Shaped');
    // The release folder is the task's: the shape names it.
    expect(sweep).toContain('abc123abc123');
  });

  it('reports "absent" for what is not there: no task, no process, no rule, no folder', async () => {
    const host = new FakeUninstallHost({});
    host.answers = { 'Ending the agent processes': 'ENDED 0', 'Removing the Windows Firewall rule': 'ABSENT', 'Removing C:': 'ABSENT' };
    const result = await run(host);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toEqual({ task: 'absent', processes: 'absent', firewall: 'absent', folder: 'absent' });
  });

  it('still ends stray processes of an install whose task is gone', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    expect(host.log).toContain('script Ending the agent processes');
  });

  describe('whose task it is (only a task that is exactly what the install writes)', () => {
    const envFile = windowsAgentEnvFile(HOME, OPTIONS);
    const entry = `${HOME}\\.azito\\agent\\abc123abc123\\azito-agent.cjs`;
    const conhost = 'C:\\Windows\\System32\\conhost.exe';
    /** A task with the program and the arguments line given as they are written. */
    const taskWith = (argumentsLine: string, executable = conhost): string => buildTaskXml({
      userId: 'PC\\dev', description: 'x', executable, argumentsLine, workingDirectory: HOME, restartOnFailure: { intervalMinutes: 1, count: 1 },
    });
    const exact = `--headless "${NODE}" --env-file=${envFile} ${entry}`;

    it('takes the task the install writes (the same builder), and a hand-written line that is character for character the same', async () => {
      expect(outcomes(await run(new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } }))).task).toBe('done');
      expect(outcomes(await run(new FakeUninstallHost({ AzitoAgent: { xml: taskWith(exact) } }))).task).toBe('done');
    });

    it.each([
      ['a path that only starts like it (agent.env.other)', agentTaskXml(`${envFile}.other`)],
      ['another install\'s settings file', agentTaskXml('D:\\other\\agent.env')],
      ['an install nested below it', agentTaskXml(`${HOME}\\.azito\\agent\\sub\\agent.env`)],
      ['the settings file in another case', agentTaskXml(envFile.toUpperCase())],
    ])('leaves a task that runs %s, with the processes, the folder and the firewall rule', async (_label, xml) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml, running: true } });
      const result = await run(host);
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'skipped', folder: 'skipped' });
      expect(detail(result, 'task')).toContain('left alone');
      expect(detail(result, 'firewall')).toContain('another install');
      expect(host.log).toEqual(['query AzitoAgent', 'export AzitoAgent']);
      expect(host.tasks.has('AzitoAgent')).toBe(true);
    });

    it('does not take the file mentioned only in the description (or any text that is not the program action) as the task\'s own', async () => {
      const xml = agentTaskXml('D:\\other\\agent.env', NODE, `AZITO Agent --env-file=${envFile}`);
      const host = new FakeUninstallHost({ AzitoAgent: { xml } });
      expect(outcomes(await run(host)).task).toBe('failed');
      expect(host.tasks.has('AzitoAgent')).toBe(true);
    });

    it.each([
      ['the settings file as a part of another argument', `--headless "${NODE}" --note=--env-file=${envFile} a.cjs`],
      ['quotes the install does not write around the settings file', `--headless "${NODE}" "--env-file=${envFile}" ${entry}`],
      ['a quote doubled at the end of the settings file', `--headless "${NODE}" "--env-file=${envFile}""" ${entry}`],
      ['quotes in a row inside the settings file path (the input that once read as the file)', `--headless "${NODE}" "--env-file=C:\\""Users\\dev\\.azito\\agent\\agent.env" ${entry}`],
      ['an extra argument at the end', `${exact} --extra`],
      ['an extra argument at the front', `--x ${exact}`],
      ['a missing --headless', `"${NODE}" --env-file=${envFile} ${entry}`],
      ['two spaces between the arguments', `--headless "${NODE}"  --env-file=${envFile} ${entry}`],
      ['a node.exe quoted in a form the install does not write', `--headless "C:\\node.exe\\" --env-file=${envFile} ${entry}`],
      ['an entry in another folder', `--headless "${NODE}" --env-file=${envFile} D:\\x\\abc123abc123\\azito-agent.cjs`],
      ['an entry that is not a release folder\'s azito-agent.cjs', `--headless "${NODE}" --env-file=${envFile} ${HOME}\\.azito\\agent\\evil.cjs`],
      ['an entry below the release folder', `--headless "${NODE}" --env-file=${envFile} ${HOME}\\.azito\\agent\\a\\b\\azito-agent.cjs`],
    ])('leaves a task with %s', async (_label, line) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(line), running: true } });
      const result = await run(host);
      expect(outcomes(result)).toMatchObject({ task: 'failed', processes: 'skipped', firewall: 'skipped', folder: 'skipped' });
      expect(host.tasks.has('AzitoAgent')).toBe(true);
    });

    it('leaves a task that runs another program, or runs more than one', async () => {
      const other = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(exact, 'C:\\Windows\\System32\\cmd.exe') } });
      expect(outcomes(await run(other)).task).toBe('failed');
      const two = taskWith(exact).replace('</Exec>', `</Exec><Exec><Command>C:\\x.exe</Command></Exec>`);
      expect(outcomes(await run(new FakeUninstallHost({ AzitoAgent: { xml: two } }))).task).toBe('failed');
    });

    it('takes a node.exe path with a space in it, and a home folder with a space in it (the same quoting as the install)', async () => {
      const spaced = 'C:\\Users\\Dev User';
      const file = windowsAgentEnvFile(spaced, OPTIONS);
      const xml = buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable: conhost, args: ['--headless', NODE, `--env-file=${file}`, `${spaced}\\.azito\\agent\\abc123abc123\\azito-agent.cjs`],
        workingDirectory: spaced, restartOnFailure: { intervalMinutes: 1, count: 1 },
      });
      const host = new FakeUninstallHost({ AzitoAgent: { xml } });
      const result = await uninstallWindowsAgent(host.asHost(), factsOf(spaced, NODE), OPTIONS, { removeMisao: false });
      expect(outcomes(result).task).toBe('done');
    });
  });

  it('does not delete the folder under a task that would not stop, and says so', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
    host.endTaskError = new Error('The task "AzitoAgent" is still running 20s after it was stopped');
    const result = await run(host);
    expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'done', folder: 'skipped' });
    expect(detail(result, 'task')).toContain('still running');
    expect(host.tasks.has('AzitoAgent')).toBe(true);
  });

  it('a task that cannot be looked at (access denied) is a failure, not "absent"', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    host.queryError = { task: 'AzitoAgent', error: new Error('Access is denied') };
    const result = await run(host);
    expect(outcomes(result)).toMatchObject({ task: 'failed', processes: 'skipped', folder: 'skipped' });
    expect(detail(result, 'task')).toContain('Access is denied');
  });

  it('does not delete the folder while a process of the agent is left', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    host.answers['Ending the agent processes'] = new Error('Ending the agent processes failed on the Windows host (exit 1): An agent process did not end: 4242');
    const result = await run(host);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'failed', firewall: 'done', folder: 'skipped' });
    expect(detail(result, 'processes')).toContain('4242');
  });

  it('a process step that does not say how many it found is a failure, not "done"', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Ending the agent processes'] = '';
    expect(outcomes(await run(host)).processes).toBe('failed');
  });

  it('a folder that cannot be looked at (access denied) is a failure, not "absent"', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = new Error('Removing C:\\Users\\dev\\.azito\\agent failed on the Windows host (exit 1): Access to the path is denied.');
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('denied');
  });

  it('reports what could not be deleted from the folder', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = 'FAILED 1 item(s) could not be removed (a file in use?): C:\\Users\\dev\\.azito\\agent\\agent.log: used by another process';
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('agent.log');
  });

  it('refuses a folder answer it cannot read instead of calling it done', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = 'something else';
    expect(outcomes(await run(host)).folder).toBe('failed');
  });

  describe('the firewall rule', () => {
    it('is looked for by what the install adds: the name, the port, the program of the task and the one found on the host', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: agentTaskXml(undefined, 'C:\\Old\\node.exe') } });
      await run(host, false, OPTIONS, NODE);
      const script = host.bodyOf('Removing the Windows Firewall rule');
      expect(script).toContain("$name = 'AZITO Agent (TCP 3002)'");
      expect(script).toContain("$port = '3002'");
      expect(script).toContain("$programs = @('C:\\Old\\node.exe', 'C:\\Program Files\\nodejs\\node.exe')");
      expect(script).toContain('Get-NetFirewallApplicationFilter');
      expect(script).toContain('Get-NetFirewallPortFilter');
    });

    it('checks every condition the install sets, and that every filter the install leaves open is open', async () => {
      const host = new FakeUninstallHost({});
      await run(host);
      const script = host.bodyOf('Removing the Windows Firewall rule');
      expect(script).toContain("$localAddress = '100.64.0.7'");
      for (const condition of [
        "$rule.Action)\" -eq 'Allow'", "$rule.Profile)\" -eq 'Any'", "$rule.EdgeTraversalPolicy)\" -eq 'Block'", "$ports.Protocol)\" -match '^(TCP|6)$'", '$ports.LocalPort)" -eq $port',
        "$ports.RemotePort)\" -eq 'Any'", '(Join-All $address.LocalAddress) -eq $localAddress', '(Join-All $address.RemoteAddress) -match', '$app.Package)', '$service.Service)',
        "$interface.InterfaceType)\" -eq 'Any'", '$resolved -and @($candidates', 'Get-NetFirewallRule -Direction Inbound',
      ]) expect(script, condition).toContain(condition.replace('\\"', '"'));
      // One that cannot be read is a false in the list, and a false anywhere leaves the rule.
      expect(script).toContain('if ($checks -contains $false) { Write-Output (\'KEPT \'');
    });

    it('without the address the agent was installed to listen on, no rule can be shown to be ours', async () => {
      const host = new FakeUninstallHost({});
      await uninstallWindowsAgent(host.asHost(), { ...factsOf(HOME, NODE), bindAddress: undefined }, OPTIONS, { removeMisao: false });
      expect(host.bodyOf('Removing the Windows Firewall rule')).toContain("$localAddress = ''");
    });

    it('with no node.exe known (no task, none on the host), no rule can be shown to be ours', async () => {
      const host = new FakeUninstallHost({});
      await run(host, false, OPTIONS, null);
      expect(host.bodyOf('Removing the Windows Firewall rule')).toContain('$programs = @()');
    });

    it('a rule of that name that is not the install\'s is left, with its program, and is not a failure', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Removing the Windows Firewall rule'] = 'KEPT D:\\other\\node.exe';
      const result = await run(host);
      expect(result.ok).toBe(true);
      expect(outcomes(result).firewall).toBe('skipped');
      expect(detail(result, 'firewall')).toContain('D:\\other\\node.exe');
    });

    it('removes its own rule and says that another of the same name was left', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Removing the Windows Firewall rule'] = 'REMOVED\nKEPT D:\\other\\node.exe';
      const result = await run(host);
      expect(outcomes(result).firewall).toBe('done');
      expect(detail(result, 'firewall')).toContain('D:\\other\\node.exe');
    });

    it('fails with the command to run when the session is not elevated, and still removes the folder', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
      host.answers['Removing the Windows Firewall rule'] = 'FAILED|{1111-AAAA}|0|Access is denied.';
      const result = await run(host);
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'failed', folder: 'done' });
      const text = detail(result, 'firewall');
      expect(text).toContain('not elevated');
      // By the rule's own Name: a command by display name would also reach a rule of that name that was left on purpose.
      expect(text).toContain("Remove-NetFirewallRule -Name '{1111-AAAA}'");
      expect(text).not.toContain('Remove-NetFirewallRule -DisplayName');
    });

    it('a rule that cannot be looked at (the query fails) is a failure, not "absent"', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Removing the Windows Firewall rule'] = new Error('Removing the Windows Firewall rule failed on the Windows host (exit 1): Access is denied');
      expect(outcomes(await run(host)).firewall).toBe('failed');
    });
  });

  it('leaves the misao alone when it was not asked for', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoMisao: { xml: MISAO_XML } });
    const result = await run(host);
    expect(result.steps.map((s) => s.id)).toEqual(['task', 'processes', 'firewall', 'folder']);
    expect(host.tasks.has('AzitoMisao')).toBe(true);
    expect(host.log.filter((l) => l.includes('Misao') || l.includes('misao'))).toEqual([]);
  });

  describe('with the misao', () => {
    it('removes its task, its processes (found by their --data folder) and its folder', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoMisao: { xml: MISAO_XML, running: true } });
      const result = await run(host, true);
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'done', folder: 'done', misaoTask: 'done', misaoProcesses: 'done', misaoFolder: 'done' });
      expect(host.tasks.has('AzitoMisao')).toBe(false);
      const sweep = host.bodyOf('Ending the misao processes');
      expect(sweep).toContain("Name = 'misao.exe'");
      expect(sweep).toContain('0\\.3\\.0');
      expect(host.bodies.some((b) => b.what === `Removing ${HOME}\\.azito\\misao`)).toBe(true);
    });

    describe('a hub on the host', () => {
      it('hands the hub\'s folder to the host to compare with the folder to remove, whatever the names the agent was given', async () => {
        const trial: WindowsAgentOptions = { ...OPTIONS, misaoTaskName: 'w806-Misao', misaoDir: 'w851\\misao' };
        const host = new FakeUninstallHost({
          AzitoAgent: { xml: AGENT_XML }, AzitoHub: { xml: hubTaskXml(`${HOME}\\w851`) }, 'w806-Misao': { xml: misaoXml(`${HOME}\\w851\\misao`, 'w806-Misao'), running: true },
        });
        host.answers['Checking who runs the misao'] = 'SAMEHUB';
        const result = await run(host, true, trial);
        expect(outcomes(result)).toMatchObject({ task: 'done', misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('AzitoHub');
        expect(host.tasks.has('w806-Misao')).toBe(true);
        expect(host.log).not.toContain('end w806-Misao');
        const guard = host.bodyOf('Checking who runs the misao');
        expect(guard).toContain(`$hubRoot = '${HOME}\\w851\\misao'`);
        expect(guard).toContain(`$root = '${HOME}\\w851\\misao'`);
        // Both are put in their long form on the host before they are compared (8.3 names, case).
        expect(guard).toContain('function Resolve-Long');
        expect(guard).toContain('-ieq $hub');
      });

      it('leaves the default misao when the hub has the default prefix', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: hubTaskXml(`${HOME}\\.azito`) }, AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = 'SAMEHUB';
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('leaves the misao when the host cannot resolve the hub\'s folder (the two may be one)', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: hubTaskXml(`${HOME}\\.azito`) }, AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = 'MAYBEHUB';
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('may be the same');
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('removes a misao of another folder than the hub\'s (the hub is another install)', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: hubTaskXml(`${HOME}\\w851`) }, AzitoMisao: { xml: MISAO_XML } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'done', misaoFolder: 'done' });
        // The hub is a task here, so its process is not looked for as a taskless hub.
        expect(host.bodyOf('Checking who runs the misao')).not.toContain('$hubPattern');
      });

      it('leaves the misao when the hub task is registered but its folder cannot be read', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: '<Task><Actions><Exec><Command>x.exe</Command><Arguments>a</Arguments></Exec></Actions></Task>' }, AzitoMisao: { xml: MISAO_XML } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
        expect(host.log).not.toContain('script Checking who runs the misao');
      });

      it('leaves the misao when it cannot tell whether a hub is registered', async () => {
        const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoMisao: { xml: MISAO_XML } });
        host.queryError = { task: 'AzitoHub', error: new Error('Access is denied') };
        const result = await run(host, true);
        expect(result.ok).toBe(false);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('Access is denied');
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });
    });

    describe('no hub task (a hub started from source runs without one)', () => {
      it('looks for a hub process and for a misao that no task started', async () => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } });
        await run(host, true);
        const guard = host.bodyOf('Checking who runs the misao');
        expect(guard).toContain('$hubPattern');
        expect(guard).toContain("Name = 'misao.exe'");
        expect(guard).toContain('--headless');
      });

      it('leaves the misao when a hub process is running', async () => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = 'HUB 4321';
        const result = await run(host, true);
        expect(result.ok).toBe(true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('4321');
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('leaves the misao when one of its processes was not started by a task', async () => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = 'FOREIGN 77';
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('77');
      });

      it('leaves the misao when the owner of a process cannot be read (it is neither mine nor someone else\'s)', async () => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = 'UNKNOWN 88';
        const result = await run(host, true);
        expect(result.ok).toBe(true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('88');
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('leaves the misao when the check cannot be read', async () => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } });
        host.answers['Checking who runs the misao'] = new Error('Checking who runs the misao failed on the Windows host (exit 1): boom');
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });
    });

    it('works the same with names of its own (a trial) when no hub is involved', async () => {
      const trial: WindowsAgentOptions = { ...OPTIONS, misaoTaskName: 'TrialMisao', misaoDir: '.trial\\misao' };
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, TrialMisao: { xml: misaoXml(`${HOME}\\.trial\\misao`, 'TrialMisao') } });
      const result = await run(host, true, trial);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'done', misaoFolder: 'done' });
      expect(host.log).toContain('query AzitoHub');
    });

    describe('whose misao task it is (only a task that is exactly what the install writes)', () => {
      const root = `${HOME}\\.azito\\misao`;
      const conhost = 'C:\\Windows\\System32\\conhost.exe';
      const taskWith = (argumentsLine: string, executable = conhost): string => buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable, argumentsLine, workingDirectory: HOME, restartOnFailure: { intervalMinutes: 1, count: 1 },
      });
      const exact = buildMisaoTaskXml({
        userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME, layout: misaoWindowsLayout({ misaoRoot: root }, '0.3.0', MISAO_WINDOWS_TASK_NAME), pipe: windowsMisaoPipe(root, 'dev'),
      });
      const exactLine = /<Arguments>([^<]*)<\/Arguments>/.exec(exact)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

      it('takes the task the install writes (the plain form, and the launcher form for a folder with a space), whatever release it runs', async () => {
        expect(outcomes(await run(new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } }), true)).misaoTask).toBe('done');
        const spaced = 'C:\\Users\\Dev User';
        const spacedRoot = `${spaced}\\.azito\\misao`;
        const xml = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: spaced, layout: misaoWindowsLayout({ misaoRoot: spacedRoot }, '0.4.1', MISAO_WINDOWS_TASK_NAME), pipe: windowsMisaoPipe(spacedRoot, 'dev') });
        const host = new FakeUninstallHost({ AzitoMisao: { xml } });
        const result = await uninstallWindowsAgent(host.asHost(), factsOf(spaced, NODE), OPTIONS, { removeMisao: true });
        expect(outcomes(result).misaoTask).toBe('done');
        // The release folder of the task (0.4.1) is the one the processes are matched against.
        expect(host.bodyOf('Ending the misao processes')).toContain('0\\.4\\.1');
      });

      it.each([
        ['an unrelated program that has the --data folder inside one of its arguments', 'C:\\Tools\\backup.exe', `--note=--data "${root}" --keep`],
        ['the plain line with something appended', conhost, `${exactLine} --extra`],
        ['the plain line with another pipe', conhost, exactLine.replace(/\\\\\.\\pipe\\[^"]+/, '\\\\.\\pipe\\other')],
        ['the plain line with another log', conhost, exactLine.replace('misao.log', 'other.log')],
        ['the plain line run by another program', 'C:\\Windows\\System32\\cmd.exe', exactLine],
        ['the plain line for another folder', conhost, exactLine.split(root).join('D:\\elsewhere\\misao')],
        ['the plain line with the release folder replaced', conhost, exactLine.replace('\\0.3.0\\', '\\..\\x\\')],
      ])('leaves %s', async (_label, executable, line) => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: taskWith(line, executable) } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('leaves a task with two actions', async () => {
        const two = MISAO_XML.replace('</Exec>', '</Exec><Exec><Command>C:\\x.exe</Command></Exec>');
        const host = new FakeUninstallHost({ AzitoMisao: { xml: two } });
        expect(outcomes(await run(host, true)).misaoTask).toBe('failed');
      });

      it('leaves a task made for another account (the pipe is made from the account name)', async () => {
        const other = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME, layout: misaoWindowsLayout({ misaoRoot: root }, '0.3.0', MISAO_WINDOWS_TASK_NAME), pipe: windowsMisaoPipe(root, 'someone') });
        const host = new FakeUninstallHost({ AzitoMisao: { xml: other } });
        expect(outcomes(await run(host, true)).misaoTask).toBe('failed');
      });
    });

    it('leaves a task that starts another folder\'s misao, and its folder', async () => {
      const host = new FakeUninstallHost({ AzitoMisao: { xml: misaoXml('D:\\elsewhere\\misao') } });
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
      expect(host.tasks.has('AzitoMisao')).toBe(true);
    });

    it('keeps the misao folder when a misao process is left', async () => {
      const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } });
      host.answers['Ending the misao processes'] = new Error('Ending the misao processes failed on the Windows host (exit 1): A misao process did not end: 7');
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'failed', misaoFolder: 'skipped' });
    });

    it('still removes the misao when the agent\'s task is another install\'s, and the agent\'s failure does not stop it', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: agentTaskXml('D:\\other\\agent.env') }, AzitoMisao: { xml: MISAO_XML } });
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ task: 'failed', misaoTask: 'done', misaoFolder: 'done' });
      expect(result.ok).toBe(false);
    });
  });
});

describe('what the scripts answer', () => {
  it('folder: DONE, ABSENT and FAILED are read; anything else is an error, never "done"', () => {
    expect(parseFolderOutput('DONE\r\n')).toEqual({ outcome: 'done' });
    expect(parseFolderOutput('ABSENT')).toEqual({ outcome: 'absent' });
    expect(parseFolderOutput('FAILED 2 item(s)')).toMatchObject({ outcome: 'failed' });
    expect(() => parseFolderOutput('')).toThrow(/could not be read/);
  });

  it('processes: the count decides between "absent" and "done"', () => {
    expect(parseProcessesOutput('ENDED 0\r\n')).toEqual({ outcome: 'absent' });
    expect(parseProcessesOutput('ENDED 2')).toMatchObject({ outcome: 'done' });
    expect(() => parseProcessesOutput('')).toThrow(/could not be read/);
  });

  it('firewall: a rule removed, left, or both; a failure wins', () => {
    expect(parseFirewallOutput('ABSENT', 'R')).toEqual({ outcome: 'absent' });
    expect(parseFirewallOutput('REMOVED', 'R')).toEqual({ outcome: 'done' });
    expect(parseFirewallOutput('KEPT C:\\x.exe', 'R')).toMatchObject({ outcome: 'skipped' });
    expect(parseFirewallOutput('REMOVED\nKEPT C:\\x.exe', 'R')).toMatchObject({ outcome: 'done', detail: expect.stringContaining('C:\\x.exe') });
    expect(parseFirewallOutput('REMOVED\nFAILED|{G}|1|boom', 'R')).toMatchObject({ outcome: 'failed', detail: expect.stringContaining("-Name '{G}'") });
    expect(() => parseFirewallOutput('', 'R')).toThrow(/could not be read/);
  });

  it('misao guard: clear, same hub, maybe the hub, hub, foreign, unknown owner', () => {
    expect(parseMisaoGuardOutput('CLEAR')).toEqual({ kind: 'clear' });
    expect(parseMisaoGuardOutput('SAMEHUB')).toEqual({ kind: 'sameHub' });
    expect(parseMisaoGuardOutput('MAYBEHUB')).toEqual({ kind: 'maybeHub' });
    expect(parseMisaoGuardOutput('UNKNOWN 3')).toEqual({ kind: 'unknown', pid: '3' });
    expect(parseMisaoGuardOutput('HUB 5')).toEqual({ kind: 'hub', pid: '5' });
    expect(parseMisaoGuardOutput('FOREIGN 9')).toEqual({ kind: 'foreign', pid: '9' });
    expect(() => parseMisaoGuardOutput('what')).toThrow(/could not be read/);
  });
});

describe('the processes it ends: the whole command line of what the install\'s task starts', () => {
  const agentRoot = `${HOME}\\.azito\\agent`;
  const envFile = `${agentRoot}\\agent.env`;
  const entry = `${agentRoot}\\abc123abc123\\azito-agent.cjs`;
  /** What the host matches: the command line with its quotes taken out and its own executable path taken off the front. */
  const matches = (shape: ReturnType<typeof agentProcessShape>, exe: string, line: string): boolean => {
    const { exe: exePattern, tail } = expandShape(shape);
    const stripped = line.replace(/"/g, '').replace(/\s+/g, ' ').trim();
    return new RegExp(exePattern, 'i').test(exe) && stripped.toLowerCase().startsWith(`${exe.toLowerCase()} `) && new RegExp(`^(?:${tail})$`, 'i').test(stripped.slice(exe.length + 1));
  };
  const agent = agentProcessShape(agentRoot, 'abc123abc123');

  it('the agent started by the task, and by hand with the same line', () => {
    expect(matches(agent, NODE, `"${NODE}" --env-file=${envFile} ${entry}`)).toBe(true);
    expect(matches(agent, 'C:\\nodejs\\node.exe', `C:\\nodejs\\node.exe --env-file=${envFile} ${entry}`)).toBe(true);
  });

  it.each([
    ['another program that has the install\'s file inside one argument (the input that once matched)', `"${NODE}" other.cjs "--env-file=${envFile} extra"`],
    ['an extra argument', `"${NODE}" --env-file=${envFile} ${entry} --extra`],
    ['an extra argument first', `"${NODE}" --inspect --env-file=${envFile} ${entry}`],
    ['another script', `"${NODE}" --env-file=${envFile} ${agentRoot}\\abc123abc123\\other.cjs`],
    ['another release folder than the task\'s', `"${NODE}" --env-file=${envFile} ${agentRoot}\\ffffffffffff\\azito-agent.cjs`],
    ['another settings file', `"${NODE}" --env-file=${envFile}.other ${entry}`],
    ['another install', `"${NODE}" --env-file=D:\\x\\agent.env D:\\x\\abc123abc123\\azito-agent.cjs`],
  ])('does not take %s for the agent', (_label, line) => {
    expect(matches(agent, NODE, line)).toBe(false);
  });

  it('does not take a command line whose first word is not the program itself', () => {
    expect(matches(agent, NODE, `evil.exe "${NODE}" --env-file=${envFile} ${entry}`)).toBe(false);
  });

  it('without a task to learn the release from, any release folder of the install, and nothing else', () => {
    const any = agentProcessShape(agentRoot, undefined);
    expect(matches(any, NODE, `"${NODE}" --env-file=${envFile} ${agentRoot}\\0123456789ab\\azito-agent.cjs`)).toBe(true);
    expect(matches(any, NODE, `"${NODE}" --env-file=${envFile} ${agentRoot}\\a\\b\\azito-agent.cjs`)).toBe(false);
  });

  describe('the misao', () => {
    const root = `${HOME}\\.azito\\misao`;
    const exe = `${root}\\0.3.0\\misao.exe`;
    const pipe = windowsMisaoPipe(root, 'dev');
    const shape = misaoProcessShape(root, 'dev', '0.3.0');
    const matchesMisao = (path: string, line: string, which = shape): boolean => matches(which, path, line);

    it('takes the daemon the task starts (cmd.exe expands the line; its redirects are not part of it)', () => {
      expect(matchesMisao(exe, `"${exe}" serve --socket "${pipe}" --data "${root}"`)).toBe(true);
    });

    it('takes the line as a real daemon had it on a Windows runner: no quotes, two blanks after the program, one at the end', () => {
      expect(matchesMisao(exe, `${exe}  serve --socket ${pipe} --data ${root} `)).toBe(true);
    });

    it.each([
      ['the folder only as the value of another argument', `"${exe}" serve --socket "${pipe}" --note --data "${root}"`],
      ['the folder inside another argument', `"${exe}" serve --socket "${pipe}" "--data ${root}" --keep`],
      ['another pipe', `"${exe}" serve --socket "\\\\.\\pipe\\other" --data "${root}"`],
      ['another command', `"${exe}" stop --socket "${pipe}" --data "${root}"`],
      ['an extra argument', `"${exe}" serve --socket "${pipe}" --data "${root}" --extra`],
    ])('does not take %s', (_label, line) => {
      expect(matchesMisao(exe, line)).toBe(false);
    });

    it('does not take a misao.exe from another folder or another release', () => {
      const other = 'D:\\x\\0.3.0\\misao.exe';
      expect(matchesMisao(other, `"${other}" serve --socket "${pipe}" --data "${root}"`)).toBe(false);
      const old = `${root}\\0.2.0\\misao.exe`;
      expect(matchesMisao(old, `"${old}" serve --socket "${pipe}" --data "${root}"`)).toBe(false);
      expect(matchesMisao(old, `"${old}" serve --socket "${pipe}" --data "${root}"`, misaoProcessShape(root, 'dev', undefined))).toBe(true);
    });
  });

  it('a process whose owner cannot be read stops the step instead of being passed over', () => {
    const script = exactProcessesScript({ image: 'node.exe', shape: agent, label: 'agent', endParentConhost: true });
    expect(script.match(/if \(\$o -eq 'unknown'\) \{[^}]*throw/g)?.length).toBe(2);
    // Not "mine" and not "someone else's": the unreadable case is its own answer and never falls into the branch that is skipped.
    expect(script).not.toContain('catch { $false }');
    expect(script).toContain("catch { return 'unknown' }");
  });

  it('the parent conhost is taken only when its command line ends with the child\'s line after --headless', () => {
    const script = exactProcessesScript({ image: 'node.exe', shape: agent, label: 'agent', endParentConhost: true });
    expect(script).toContain("EndsWith(' --headless ' + (Line $p)");
    expect(script).toContain('$c.CreationDate -le $p.CreationDate');
  });
});

describe('the folder script', () => {
  it('checks every folder from the one to remove up to the drive\'s root, and refuses one that is a link or cannot be looked at', () => {
    const script = folderScript(HOME, `${HOME}\\.azito\\agent`);
    expect(script).toContain('[System.IO.Path]::GetPathRoot($root)');
    expect(script).toContain('$walk.TrimEnd([char]92) -ne $driveRoot.TrimEnd([char]92)');
    expect(script).toContain('cannot be looked at');
    expect(script).toContain('is a link (junction or symbolic link)');
    // It no longer stops at the home folder: the home folder is only a bound the folder must lie below.
    expect(script).not.toContain('-ne $homeDir');
  });
});

describe('what looks like a hub process', () => {
  const hub = new RegExp(HUB_COMMAND_LINE_PATTERN, 'i');

  it.each([
    // `npm run dev` in packages/server: tsx watch with the entry given relative to the working directory.
    ['node.exe C:\\repo\\node_modules\\tsx\\dist\\cli.mjs watch --env-file-if-exists=.env src/main.ts'],
    ['node.exe --require C:\\repo\\node_modules\\tsx\\dist\\preflight.cjs --import file:///C:/repo/node_modules/tsx/dist/loader.mjs src/main.ts'],
    ['node.exe C:\\repo\\packages\\server\\src\\main.ts'],
    ['node.exe packages/server/dist/main.js'],
    ['node.exe dist\\main.js'],
    ['"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\.azito\\hub\\v0.12.0\\azito-hub.cjs"'],
  ])('%s', (line) => {
    expect(hub.test(line)).toBe(true);
  });

  it.each([
    ['node.exe C:\\Users\\dev\\.azito\\agent\\abc123abc123\\azito-agent.cjs'],
    ['node.exe C:\\repo\\node_modules\\tsx\\dist\\cli.mjs C:\\repo\\packages\\server\\src\\agent\\main.ts'],
    ['node.exe src/agent/main.ts'],
    ['node.exe C:\\tools\\domain.ts'],
    ['node.exe C:\\repo\\node_modules\\vitest\\vitest.mjs run'],
  ])('is not a hub: %s', (line) => {
    expect(hub.test(line)).toBe(false);
  });
});

describe('the task names the uninstall relies on', () => {
  it('the hub\'s task and the misao\'s task are the ones the hub registers', () => {
    expect(WINDOWS_HUB_TASK_NAME).toBe(HUB_SERVICE.windowsTaskName);
    expect(MISAO_WINDOWS_TASK_NAME).toBe(MISAO_SERVICE.windowsTaskName);
  });
});

describe('the scripts it sends', () => {
  it('each fits one command line (8191 characters once encoded) for a long user folder', async () => {
    const home = `C:\\Users\\${'a-very-long-user-name-'.repeat(4)}`;
    const long = new FakeUninstallHost({});
    await uninstallWindowsAgent(long.asHost(), factsOf(home, `${home}\\a\\very\\long\\path\\to\\node.exe`), OPTIONS, { removeMisao: true });
    expect(long.bodies.length).toBeGreaterThanOrEqual(6);
    for (const { what, body } of long.bodies) {
      expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`), what).not.toThrow();
    }
  });

  it('the largest forms of the guard and of the firewall script fit too (a hub folder and a hub process check; two long node.exe paths)', () => {
    const long = `C:\\Users\\${'a-very-long-user-name-'.repeat(4)}`;
    const scripts = [
      misaoGuardScript({ root: `${long}\\.azito\\misao`, hubRoot: `${long}\\.azito\\misao`, looksForHub: true }),
      firewallScript('AZITO Agent (TCP 3002)', 3002, [`${long}\\a\\b\\node.exe`, `${long}\\c\\d\\node.exe`], '100.64.0.7'),
      exactProcessesScript({ image: 'node.exe', shape: agentProcessShape(`${long}\\.azito\\agent`, undefined), label: 'agent', endParentConhost: true }),
      exactProcessesScript({ image: 'misao.exe', shape: misaoProcessShape(`${long}\\.azito\\misao`, 'a-very-long-user-name', undefined), label: 'misao', endParentConhost: false }),
    ];
    for (const body of scripts) expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`)).not.toThrow();
  });

  it('the folder script treats only a missing folder as absent, refuses a link on the way to the home folder, and removes a link inside as a link (it never enters it)', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    const script = host.bodyOf('Removing C:');
    expect(script).toContain("-ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { Write-Output 'ABSENT'; exit 0 } else { throw } }");
    expect(script).not.toContain('SilentlyContinue');
    expect(script).toContain('is a link (junction or symbolic link)');
    expect(script).toContain('[System.IO.FileAttributes]::ReparsePoint');
    expect(script).toMatch(/ReparsePoint\)\) \{\s*if \(\$isDirectory\) \{ \[System\.IO\.Directory\]::Delete\(\$entry\) \}/);
    expect(script).not.toContain('-Recurse');
  });

  it('a path with a junction or symbolic link on the way is not resolved, and a folder that is there but cannot be resolved may be the hub\'s', () => {
    const guard = misaoGuardScript({ root: 'C:\\h\\m', hubRoot: 'C:\\h\\m', looksForHub: false });
    expect(guard).toContain('[System.IO.FileAttributes]::ReparsePoint');
    expect(guard).toContain('Test-Path -LiteralPath $root');
    expect(guard).toContain("Write-Output 'MAYBEHUB'");
    expect(firewallScript('R', 1, ['C:\\n.exe'], '100.64.0.7')).toContain('[System.IO.FileAttributes]::ReparsePoint');
  });

  it('the firewall script lists the rules without hiding a failure (an error stops it)', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    const script = host.bodyOf('Removing the Windows Firewall rule');
    expect(script).toContain('Get-NetFirewallRule -Direction Inbound -ErrorAction Stop');
    expect(script).not.toContain('SilentlyContinue');
  });
});

describe('WindowsAgentDeployer.uninstall', () => {
  const info = { home: HOME, systemRoot: 'C:\\Windows', nodePath: NODE, userId: 'PC\\dev' };

  it('runs the steps through the SSH session, the task through schtasks, and leaves the other task alone', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'running' });
    fake.registeredXml = AGENT_XML;
    const exec: WindowsSshExec = async (h, command, timeoutMs) => {
      const result = await fake.exec(h, command);
      const last = fake.calls[fake.calls.length - 1];
      if (last?.kind === 'script' && last.text.includes('Remove-Tree')) return { ...result, stdout: 'DONE\r\n' };
      if (last?.kind === 'script' && last.text.includes('Remove-NetFirewallRule')) return { ...result, stdout: 'ABSENT\r\n' };
      if (last?.kind === 'script' && last.text.includes('function Shaped')) return { ...result, stdout: 'ENDED 0\r\n' };
      void timeoutMs;
      return result;
    };
    const deployer = new WindowsAgentDeployer(exec, { putFile: async () => undefined, putBuffer: async () => undefined }, OPTIONS);
    const result = await deployer.uninstall('h', info, { removeMisao: false }, BIND);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'absent', firewall: 'absent', folder: 'done' });
    expect(fake.taskState).toBe('absent');
    const verbs = fake.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
    expect(verbs).toContain('/End');
    expect(verbs).toContain('/Delete');
    expect(fake.calls.filter((c) => c.kind === 'schtasks').every((c) => !c.schtasksArgs!.includes('AzitoMisao'))).toBe(true);
  });
});
