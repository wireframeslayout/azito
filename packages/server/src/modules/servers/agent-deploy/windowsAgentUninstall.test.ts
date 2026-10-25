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
import { parseFirewallOutput, parseFolderOutput, parseMisaoGuardOutput, parseProcessesOutput } from './windowsAgentUninstallScripts';

const HOME = 'C:\\Users\\dev';
const OPTIONS = DEFAULT_WINDOWS_AGENT_OPTIONS;
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
    layout: misaoWindowsLayout({ misaoRoot: root }, '0.3.0', taskName), pipe: '\\\\.\\pipe\\misao-dev-0123456789ab',
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

const outcomes = (result: WindowsUninstallResult): Record<string, string> => Object.fromEntries(result.steps.map((s) => [s.id, s.outcome]));
const detail = (result: WindowsUninstallResult, id: UninstallStepId): string => result.steps.find((s) => s.id === id)?.detail ?? '';
const run = (host: FakeUninstallHost, removeMisao = false, options: WindowsAgentOptions = OPTIONS, hostNode: string | null = NODE): Promise<WindowsUninstallResult> => uninstallWindowsAgent(host.asHost(), HOME, options, { removeMisao }, hostNode);

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
    const host = new FakeUninstallHost({});
    await run(host);
    const sweep = host.bodyOf('Ending the agent processes');
    expect(sweep).toContain(`'--env-file=${HOME}\\.azito\\agent\\agent.env'`);
    expect(sweep).toContain("Name = 'node.exe'");
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

  describe('whose task it is (the program action\'s --env-file argument, as a whole)', () => {
    const envFile = windowsAgentEnvFile(HOME, OPTIONS);

    it.each([
      ['a path that only starts like it (agent.env.other)', agentTaskXml(`${envFile}.other`)],
      ['another install\'s settings file', agentTaskXml('D:\\other\\agent.env')],
      ['an install nested below it', agentTaskXml(`${HOME}\\.azito\\agent\\sub\\agent.env`)],
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

    it('does not take the file as a part of another argument', async () => {
      const xml = buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable: 'C:\\Windows\\System32\\conhost.exe',
        args: ['--headless', NODE, `--note=--env-file=${envFile}`, 'a.cjs'], workingDirectory: HOME, restartOnFailure: { intervalMinutes: 1, count: 1 },
      });
      const host = new FakeUninstallHost({ AzitoAgent: { xml } });
      expect(outcomes(await run(host)).task).toBe('failed');
    });

    it('takes it whatever the case of the path, and for a folder with a space in it', async () => {
      const spaced = 'C:\\Users\\Dev User';
      const file = windowsAgentEnvFile(spaced, OPTIONS);
      const host = new FakeUninstallHost({ AzitoAgent: { xml: agentTaskXml(file.toUpperCase()) } });
      const result = await uninstallWindowsAgent(host.asHost(), spaced, OPTIONS, { removeMisao: false }, NODE);
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
      host.answers['Removing the Windows Firewall rule'] = 'FAILED NOTELEVATED Access is denied.';
      const result = await run(host);
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'failed', folder: 'done' });
      const text = detail(result, 'firewall');
      expect(text).toContain('not elevated');
      expect(text).toContain('Remove-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)"');
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
      expect(sweep).toContain(`'${HOME}\\.azito\\misao'`);
      expect(sweep).toContain("Name = 'misao.exe'");
      expect(host.bodies.some((b) => b.what === `Removing ${HOME}\\.azito\\misao`)).toBe(true);
    });

    describe('a hub on the host', () => {
      it('leaves the misao that is the hub\'s own folder, whatever the names the agent was given', async () => {
        const trial: WindowsAgentOptions = { ...OPTIONS, misaoTaskName: 'w806-Misao', misaoDir: 'w851\\misao' };
        const host = new FakeUninstallHost({
          AzitoAgent: { xml: AGENT_XML }, AzitoHub: { xml: hubTaskXml(`${HOME}\\w851`) }, 'w806-Misao': { xml: misaoXml(`${HOME}\\w851\\misao`, 'w806-Misao'), running: true },
        });
        const result = await run(host, true, trial);
        expect(outcomes(result)).toMatchObject({ task: 'done', misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain('AzitoHub');
        expect(host.tasks.has('w806-Misao')).toBe(true);
        expect(host.log).not.toContain('end w806-Misao');
      });

      it('leaves the default misao when the hub has the default prefix', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: hubTaskXml(`${HOME}\\.azito`) }, AzitoMisao: { xml: MISAO_XML, running: true } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
      });

      it('removes a misao of another folder than the hub\'s (the hub is another install)', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: hubTaskXml(`${HOME}\\w851`) }, AzitoMisao: { xml: MISAO_XML } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'done', misaoFolder: 'done' });
        // The hub is a task here, so its process is not looked for as a taskless hub.
        expect(host.bodyOf('Checking who runs the misao')).not.toContain('azito-hub');
      });

      it('leaves the misao when the hub task is registered but its folder cannot be read', async () => {
        const host = new FakeUninstallHost({ AzitoHub: { xml: '<Task><Actions><Exec><Command>x.exe</Command><Arguments>a</Arguments></Exec></Actions></Task>' }, AzitoMisao: { xml: MISAO_XML } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
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
        expect(guard).toContain('azito-hub');
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
    expect(parseFirewallOutput('REMOVED\nFAILED boom', 'R')).toMatchObject({ outcome: 'failed' });
    expect(() => parseFirewallOutput('', 'R')).toThrow(/could not be read/);
  });

  it('misao guard: clear, hub, foreign', () => {
    expect(parseMisaoGuardOutput('CLEAR')).toEqual({ kind: 'clear' });
    expect(parseMisaoGuardOutput('HUB 5')).toEqual({ kind: 'hub', pid: '5' });
    expect(parseMisaoGuardOutput('FOREIGN 9')).toEqual({ kind: 'foreign', pid: '9' });
    expect(() => parseMisaoGuardOutput('what')).toThrow(/could not be read/);
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
    await uninstallWindowsAgent(long.asHost(), home, OPTIONS, { removeMisao: true }, `${home}\\a\\very\\long\\path\\to\\node.exe`);
    expect(long.bodies.length).toBeGreaterThanOrEqual(6);
    for (const { what, body } of long.bodies) {
      expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`), what).not.toThrow();
    }
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

  it('the firewall script lists the rules without hiding a failure (an error stops it)', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    const script = host.bodyOf('Removing the Windows Firewall rule');
    expect(script).toContain('Get-NetFirewallRule -Direction Inbound -ErrorAction Stop');
    expect(script).not.toContain('SilentlyContinue');
  });
});

describe('WindowsAgentDeployer.uninstall', () => {
  const info = { home: HOME, systemRoot: 'C:\\Windows', nodePath: NODE };

  it('runs the steps through the SSH session, the task through schtasks, and leaves the other task alone', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'running' });
    fake.registeredXml = AGENT_XML;
    const exec: WindowsSshExec = async (h, command, timeoutMs) => {
      const result = await fake.exec(h, command);
      const last = fake.calls[fake.calls.length - 1];
      if (last?.kind === 'script' && last.text.includes('Remove-Tree')) return { ...result, stdout: 'DONE\r\n' };
      if (last?.kind === 'script' && last.text.includes('Remove-NetFirewallRule')) return { ...result, stdout: 'ABSENT\r\n' };
      if (last?.kind === 'script' && last.text.includes('Get-AgentNodes')) return { ...result, stdout: 'ENDED 0\r\n' };
      void timeoutMs;
      return result;
    };
    const deployer = new WindowsAgentDeployer(exec, { putFile: async () => undefined, putBuffer: async () => undefined }, OPTIONS);
    const result = await deployer.uninstall('h', info, { removeMisao: false });
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'absent', firewall: 'absent', folder: 'done' });
    expect(fake.taskState).toBe('absent');
    const verbs = fake.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
    expect(verbs).toContain('/End');
    expect(verbs).toContain('/Delete');
    expect(fake.calls.filter((c) => c.kind === 'schtasks').every((c) => !c.schtasksArgs!.includes('AzitoMisao'))).toBe(true);
  });
});
