import { describe, expect, it } from 'vitest';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { HUB_SERVICE } from '../../system/serviceManager';
import { MISAO_SERVICE } from '../../system/misao/misaoPaths';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, MISAO_WINDOWS_TASK_NAME, type WindowsAgentOptions } from './windowsAgentConfig';
import { WindowsAgentDeployer, windowsAgentEnvFile, type WindowsSshExec } from './WindowsAgentDeployer';
import { FakeWindowsHost } from './testing/fakeWindowsHost';
import { WINDOWS_HUB_TASK_NAME, uninstallWindowsAgent, type UninstallStepId, type WindowsUninstallHost, type WindowsUninstallResult } from './windowsAgentUninstall';

const HOME = 'C:\\Users\\dev';
const OPTIONS = DEFAULT_WINDOWS_AGENT_OPTIONS;
const AGENT_XML = `<Task><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>--headless "C:\\node.exe" --env-file=${windowsAgentEnvFile(HOME, OPTIONS)} ${HOME}\\.azito\\agent\\abc\\azito-agent.cjs</Arguments></Exec></Actions></Task>`;
const MISAO_XML = buildMisaoTaskXml({
  userId: 'PC\\dev',
  systemRoot: 'C:\\Windows',
  homeDir: HOME,
  layout: misaoWindowsLayout({ misaoRoot: `${HOME}\\.azito\\misao` }, '0.3.0', MISAO_WINDOWS_TASK_NAME),
  pipe: '\\\\.\\pipe\\misao-dev-0123456789ab',
});

interface TaskInit {
  xml: string;
  running?: boolean;
}

/** A host that keeps the registered tasks and answers each script by what it is for. */
class FakeUninstallHost {
  readonly log: string[] = [];
  readonly tasks: Map<string, TaskInit & { running: boolean }>;
  /** What a script answers, by the start of its `what`; a function throws. */
  answers: Record<string, string | Error> = { 'Removing the Windows Firewall rule': 'DONE', 'Removing C:': 'DONE' };
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
}

const outcomes = (result: WindowsUninstallResult): Record<string, string> => Object.fromEntries(result.steps.map((s) => [s.id, s.outcome]));
const detail = (result: WindowsUninstallResult, id: UninstallStepId): string => result.steps.find((s) => s.id === id)?.detail ?? '';
const run = (host: FakeUninstallHost, removeMisao = false, options: WindowsAgentOptions = OPTIONS): Promise<WindowsUninstallResult> => uninstallWindowsAgent(host.asHost(), HOME, options, { removeMisao });

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
    const sweep = host.bodies.find((b) => b.what === 'Ending the agent processes')!.body;
    expect(sweep).toContain(`'--env-file=${HOME}\\.azito\\agent\\agent.env'`);
    expect(sweep).toContain("Name = 'node.exe'");
  });

  it('reports "absent" for what is not there, and still ends stray processes of an install whose task is gone', async () => {
    const host = new FakeUninstallHost({});
    host.answers = { 'Removing the Windows Firewall rule': 'ABSENT', 'Removing C:': 'ABSENT' };
    const result = await run(host);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toEqual({ task: 'absent', processes: 'done', firewall: 'absent', folder: 'absent' });
  });

  it('leaves a task of that name that does not run this install\'s settings file, and with it the processes and the folder, but still removes the firewall rule', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: '<Task><Arguments>--env-file=D:\\other\\agent.env</Arguments></Task>', running: true } });
    const result = await run(host);
    expect(result.ok).toBe(false);
    expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'done', folder: 'skipped' });
    expect(detail(result, 'task')).toContain('left alone');
    expect(host.log).not.toContain('end AzitoAgent');
    expect(host.log).not.toContain('delete AzitoAgent');
    expect(host.log).not.toContain('script Ending the agent processes');
  });

  it('does not delete the folder under a task that would not stop', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
    host.endTaskError = new Error('The task "AzitoAgent" is still running 20s after it was stopped');
    const result = await run(host);
    expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'done', folder: 'skipped' });
    expect(detail(result, 'task')).toContain('still running');
    expect(host.tasks.has('AzitoAgent')).toBe(true);
  });

  it('does not delete the folder while a process of the agent is left', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    host.answers['Ending the agent processes'] = new Error('Ending the agent processes failed on the Windows host (exit 1): An agent process did not end: 4242');
    const result = await run(host);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'failed', firewall: 'done', folder: 'skipped' });
    expect(detail(result, 'processes')).toContain('4242');
  });

  it('fails the firewall step with the command to run when the session is not elevated, and still removes the folder', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    host.answers['Removing the Windows Firewall rule'] = 'FAILED NOTELEVATED Access is denied.';
    const result = await run(host);
    expect(result.ok).toBe(false);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'failed', folder: 'done' });
    const text = detail(result, 'firewall');
    expect(text).toContain('not elevated');
    expect(text).toContain('Remove-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)"');
  });

  it('reports what could not be deleted from the folder', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    host.answers['Removing C:'] = 'FAILED 1 item(s) could not be removed (a file in use?): C:\\Users\\dev\\.azito\\agent\\agent.log: used by another process';
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('agent.log');
  });

  it('reports a failing script as that step\'s failure, with the script\'s own message', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = new Error('Refusing to remove anything: C:\\Users\\dev\\.azito is a link');
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('is a link');
  });

  it('refuses an answer it cannot read instead of calling it done', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = 'something else';
    expect(outcomes(await run(host)).folder).toBe('failed');
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
      const sweep = host.bodies.find((b) => b.what === 'Ending the misao processes')!.body;
      expect(sweep).toContain(`'${HOME}\\.azito\\misao'`);
      expect(sweep).toContain("Name = 'misao.exe'");
      expect(host.bodies.some((b) => b.what === `Removing ${HOME}\\.azito\\misao`)).toBe(true);
    });

    it('leaves it when a Windows hub is registered on the host (the hub\'s own misao), and says why', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoHub: { xml: '<Task/>' }, AzitoMisao: { xml: MISAO_XML, running: true } });
      const result = await run(host, true);
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toMatchObject({ task: 'done', folder: 'done', misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
      expect(detail(result, 'misaoTask')).toContain('AzitoHub');
      expect(host.tasks.has('AzitoMisao')).toBe(true);
      expect(host.log).not.toContain('end AzitoMisao');
    });

    it('leaves it when it cannot tell whether a hub is registered', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoMisao: { xml: MISAO_XML } });
      host.queryError = { task: 'AzitoHub', error: new Error('Access is denied') };
      const result = await run(host, true);
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
      expect(detail(result, 'misaoTask')).toContain('Access is denied');
      expect(host.tasks.has('AzitoMisao')).toBe(true);
    });

    it('does not look for a hub when the misao has names of its own (a trial)', async () => {
      const trial: WindowsAgentOptions = { ...OPTIONS, misaoTaskName: 'TrialMisao', misaoDir: '.trial\\misao' };
      const xml = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME, layout: misaoWindowsLayout({ misaoRoot: `${HOME}\\.trial\\misao` }, '0.3.0', 'TrialMisao'), pipe: '\\\\.\\pipe\\misao-dev-0123456789ab' });
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoHub: { xml: '<Task/>' }, TrialMisao: { xml } });
      const result = await run(host, true, trial);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'done', misaoFolder: 'done' });
      expect(host.log).not.toContain('query AzitoHub');
    });

    it('leaves a task that starts another folder\'s misao, and its folder', async () => {
      const other = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME, layout: misaoWindowsLayout({ misaoRoot: 'D:\\elsewhere\\misao' }, '0.3.0', MISAO_WINDOWS_TASK_NAME), pipe: '\\\\.\\pipe\\misao-dev-0123456789ab' });
      const host = new FakeUninstallHost({ AzitoMisao: { xml: other } });
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

    it('still removes the agent when the misao part fails, and the agent\'s failure does not stop the misao', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: '<Task>other</Task>' }, AzitoMisao: { xml: MISAO_XML } });
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ task: 'failed', misaoTask: 'done', misaoFolder: 'done' });
      expect(result.ok).toBe(false);
    });
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
    await uninstallWindowsAgent(long.asHost(), home, OPTIONS, { removeMisao: true });
    expect(long.bodies.length).toBeGreaterThanOrEqual(5);
    for (const { what, body } of long.bodies) {
      expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`), what).not.toThrow();
    }
  });

  it('the folder script refuses a link on the way to the home folder and removes a link inside as a link (it never enters it)', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    const script = host.bodies.find((b) => b.what.startsWith('Removing C:'))!.body;
    expect(script).toContain('is a link (junction or symbolic link)');
    expect(script).toContain('[System.IO.FileAttributes]::ReparsePoint');
    // A link is deleted as an entry; the recursion is only into entries that are not links.
    expect(script).toMatch(/ReparsePoint\)\) \{\s*if \(\$isDirectory\) \{ \[System\.IO\.Directory\]::Delete\(\$entry\) \}/);
    expect(script).not.toContain('-Recurse');
  });
});

describe('WindowsAgentDeployer.uninstall', () => {
  const info = { home: HOME, systemRoot: 'C:\\Windows' };

  it('runs the steps through the SSH session, the task through schtasks, and leaves the other task alone', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'running' });
    fake.registeredXml = AGENT_XML;
    const exec: WindowsSshExec = async (h, command, timeoutMs) => {
      const result = await fake.exec(h, command);
      const last = fake.calls[fake.calls.length - 1];
      if (last?.kind === 'script' && last.text.includes('Remove-Tree')) return { ...result, stdout: 'DONE\r\n' };
      if (last?.kind === 'script' && last.text.includes('Remove-NetFirewallRule')) return { ...result, stdout: 'ABSENT\r\n' };
      return result;
    };
    const deployer = new WindowsAgentDeployer(exec, { putFile: async () => undefined, putBuffer: async () => undefined }, OPTIONS);
    const result = await deployer.uninstall('h', info, { removeMisao: false });
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'done', firewall: 'absent', folder: 'done' });
    expect(fake.taskState).toBe('absent');
    const verbs = fake.calls.filter((c) => c.kind === 'schtasks').map((c) => c.schtasksArgs![0]);
    expect(verbs).toContain('/End');
    expect(verbs).toContain('/Delete');
    expect(fake.calls.filter((c) => c.kind === 'schtasks').every((c) => !c.schtasksArgs!.includes('AzitoMisao'))).toBe(true);
  });
});
