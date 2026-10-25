import { describe, expect, it } from 'vitest';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { buildMisaoTaskXml, misaoWindowsLayout } from '../../system/misao/misaoWindowsTask';
import { HUB_SERVICE } from '../../system/serviceManager';
import { MISAO_SERVICE } from '../../system/misao/misaoPaths';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, MISAO_WINDOWS_TASK_NAME, type WindowsAgentOptions } from './windowsAgentConfig';
import { WindowsAgentDeployer, windowsAgentEnvFile, type WindowsSshExec } from './WindowsAgentDeployer';
import { FakeWindowsHost } from './testing/fakeWindowsHost';
import { WINDOWS_HUB_TASK_NAME, uninstallWindowsAgent, type UninstallStepId, type WindowsUninstallHost, type WindowsUninstallResult } from './windowsAgentUninstall';
import { folderScript, leftoverProcessesScript, misaoStopScript, parseFolderOutput, parseLeftoverOutput } from './windowsAgentUninstallScripts';
import { HUB_COMMAND_LINE_PATTERN, firewallInspectScript, misaoGuardScript, parseFirewallOutput, parseMisaoGuardOutput, parseSameFileOutput, sameFileScript } from './windowsAgentOwnership';

const HOME = 'C:\\Users\\dev';
const OPTIONS = DEFAULT_WINDOWS_AGENT_OPTIONS;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const AGENT_ROOT = `${HOME}\\.azito\\agent`;

/** The task definition the install registers (the same builder), for the settings file of `home`. */
function agentTaskXml(envFile = windowsAgentEnvFile(HOME, OPTIONS), node = NODE, description = 'AZITO Agent: started at logon by the AZITO hub'): string {
  return buildTaskXml({
    userId: 'PC\\dev', description, executable: 'C:\\Windows\\System32\\conhost.exe',
    args: ['--headless', node, `--env-file=${envFile}`, `${AGENT_ROOT}\\abc123abc123\\azito-agent.cjs`],
    workingDirectory: `${AGENT_ROOT}\\abc123abc123`, restartOnFailure: { intervalMinutes: 1, count: 999 },
  });
}

const AGENT_XML = agentTaskXml();

function misaoXml(root: string, taskName = MISAO_WINDOWS_TASK_NAME, version = '0.3.0'): string {
  return buildMisaoTaskXml({
    userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME,
    layout: misaoWindowsLayout({ misaoRoot: root }, version, taskName), pipe: windowsMisaoPipe(root, 'dev'),
  });
}

const MISAO_ROOT = `${HOME}\\.azito\\misao`;
const MISAO_XML = misaoXml(MISAO_ROOT);

/** The task the hub registers: a launcher script that holds `$hubRoot = '<prefix>\hub'`. */
function hubTaskXml(prefix: string): string {
  const script = [`$hubRoot = '${prefix}\\hub'`, '$base = 5'].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `<Task><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>--headless powershell.exe -NoProfile -EncodedCommand ${encoded}</Arguments></Exec></Actions></Task>`;
}

/** The same task with a second action beside the first (a COM handler, which a real definition can hold with an Exec). */
const withComHandler = (xml: string): string => xml.replace('</Actions>', '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler></Actions>');

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
    'Comparing the node.exe': 'SAME',
    'Looking for processes still running from the agent folder': 'CLEAR',
    'Looking for the Windows Firewall rule': 'ABSENT',
    'Checking who runs the misao': 'CLEAR',
    'Asking the misao daemon to stop': 'DONE',
    'Looking for processes still running from the misao folder': 'CLEAR',
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

  ran(what: string): boolean {
    return this.bodies.some((b) => b.what.startsWith(what));
  }
}

const factsOf = (home: string, nodePath: string | null) => ({ home, systemRoot: 'C:\\Windows', nodePath, userId: 'PC\\dev' });
const outcomes = (result: WindowsUninstallResult): Record<string, string> => Object.fromEntries(result.steps.map((s) => [s.id, s.outcome]));
const detail = (result: WindowsUninstallResult, id: UninstallStepId): string => result.steps.find((s) => s.id === id)?.detail ?? '';
const run = (host: FakeUninstallHost, removeMisao = false, options: WindowsAgentOptions = OPTIONS, hostNode: string | null = NODE): Promise<WindowsUninstallResult> => uninstallWindowsAgent(host.asHost(), factsOf(HOME, hostNode), options, { removeMisao });

const LEFT_AGENT = `LEFT|4242|node.exe|C:\\Program Files\\nodejs\\node.exe`;

describe('uninstallWindowsAgent', () => {
  it('ends the task, unregisters it, looks for what still runs from the folder, reports the firewall rule and removes the folder, in that order', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
    const result = await run(host);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toEqual({ task: 'done', processes: 'absent', firewall: 'absent', folder: 'done' });
    expect(host.log).toEqual([
      'query AzitoAgent', 'export AzitoAgent', 'script Comparing the node.exe of the task with the one of the host', 'end AzitoAgent', 'delete AzitoAgent', 'query AzitoAgent',
      'script Looking for processes still running from the agent folder', 'script Looking for the Windows Firewall rule', `script Removing ${AGENT_ROOT}`,
    ]);
    expect(host.tasks.has('AzitoAgent')).toBe(false);
  });

  it('ends no process itself and removes no firewall rule: only the task is ended, the rest is looking', async () => {
    const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
    await run(host);
    for (const { what, body } of host.bodies) {
      expect(body, what).not.toMatch(/Stop-Process|taskkill|Remove-NetFirewallRule|\.Kill\(/i);
    }
    const left = host.bodyOf('Looking for processes still running from the agent folder');
    expect(left).toContain(`'${AGENT_ROOT}'`);
    expect(left).toContain('ExecutablePath.StartsWith($prefix');
    expect(left).toContain('CommandLine.IndexOf($prefix');
  });

  it('reports "absent" for what is not there: no task, nothing running, no rule, no folder', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = 'ABSENT';
    const result = await run(host);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toEqual({ task: 'absent', processes: 'absent', firewall: 'absent', folder: 'absent' });
  });

  it('still looks for processes of an install whose task is gone', async () => {
    const host = new FakeUninstallHost({});
    await run(host);
    expect(host.ran('Looking for processes still running from the agent folder')).toBe(true);
  });

  describe('whose task it is (one action, exactly what the install writes, with this host\'s node.exe)', () => {
    const envFile = windowsAgentEnvFile(HOME, OPTIONS);
    const entry = `${AGENT_ROOT}\\abc123abc123\\azito-agent.cjs`;
    const conhost = 'C:\\Windows\\System32\\conhost.exe';
    /** A task with the program and the arguments line given as they are written. */
    const taskWith = (argumentsLine: string, executable = conhost): string => buildTaskXml({
      userId: 'PC\\dev', description: 'x', executable, argumentsLine, workingDirectory: HOME, restartOnFailure: { intervalMinutes: 1, count: 1 },
    });
    const exact = `--headless "${NODE}" --env-file=${envFile} ${entry}`;
    const leftAlone = (result: WindowsUninstallResult, host: FakeUninstallHost): void => {
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'skipped', folder: 'skipped' });
      expect(detail(result, 'task')).toContain('left alone');
      expect(host.tasks.has('AzitoAgent')).toBe(true);
      expect(host.log).not.toContain('end AzitoAgent');
      expect(host.log).not.toContain('delete AzitoAgent');
    };

    it('takes the task the install writes (the same builder), and a hand-written line that is character for character the same', async () => {
      expect(outcomes(await run(new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } }))).task).toBe('done');
      expect(outcomes(await run(new FakeUninstallHost({ AzitoAgent: { xml: taskWith(exact) } }))).task).toBe('done');
    });

    it.each([
      ['a path that only starts like it (agent.env.other)', agentTaskXml(`${envFile}.other`)],
      ['another install\'s settings file', agentTaskXml('D:\\other\\agent.env')],
      ['an install nested below it', agentTaskXml(`${AGENT_ROOT}\\sub\\agent.env`)],
      ['the settings file in another case', agentTaskXml(envFile.toUpperCase())],
    ])('leaves a task that runs %s, and does not look further', async (_label, xml) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml, running: true } });
      const result = await run(host);
      leftAlone(result, host);
      expect(detail(result, 'firewall')).toContain('another install');
      expect(host.ran('Looking for')).toBe(false);
    });

    it('does not take the file mentioned only in the description (or any text that is not the program action) as the task\'s own', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: agentTaskXml('D:\\other\\agent.env', NODE, `AZITO Agent --env-file=${envFile}`) } });
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
      ['an entry that is not a release folder\'s azito-agent.cjs', `--headless "${NODE}" --env-file=${envFile} ${AGENT_ROOT}\\evil.cjs`],
      ['an entry below the release folder', `--headless "${NODE}" --env-file=${envFile} ${AGENT_ROOT}\\a\\b\\azito-agent.cjs`],
    ])('leaves a task with %s', async (_label, line) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(line), running: true } });
      leftAlone(await run(host), host);
    });

    it.each([
      ['a program that is not node.exe', `--headless C:\\Tools\\backup.exe --env-file=${envFile} ${entry}`],
      ['a node.exe that is not an absolute path', `--headless node.exe --env-file=${envFile} ${entry}`],
      ['a node.exe on a network path', `--headless \\\\server\\share\\node.exe --env-file=${envFile} ${entry}`],
    ])('leaves a task that runs %s, even with the settings file and the entry right, and never asks the host about it', async (_label, line) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(line), running: true } });
      leftAlone(await run(host), host);
      expect(host.ran('Comparing the node.exe')).toBe(false);
    });

    it.each([
      ['not the same file as the node.exe of the host', 'DIFFERENT'],
      ['a node.exe that cannot be resolved (missing, or behind a junction)', 'UNKNOWN'],
    ])('leaves a task whose node.exe is %s', async (_label, answer) => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
      host.answers['Comparing the node.exe'] = answer;
      leftAlone(await run(host), host);
    });

    it('leaves a task when the host has no node.exe to compare with, without asking', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML, running: true } });
      leftAlone(await run(host, false, OPTIONS, null), host);
      expect(host.ran('Comparing the node.exe')).toBe(false);
    });

    it('asks the host to compare the task\'s node.exe with the host\'s, each in its long form', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
      await run(host);
      const script = host.bodyOf('Comparing the node.exe');
      expect(script).toContain(`Resolve-Long '${NODE}'`);
      expect(script).toContain('[System.IO.FileAttributes]::ReparsePoint');
    });

    it('leaves a task that has another action beside the right one (a COM handler), and one with two Exec actions', async () => {
      const com = new FakeUninstallHost({ AzitoAgent: { xml: withComHandler(AGENT_XML), running: true } });
      leftAlone(await run(com), com);
      const two = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(exact).replace('</Exec>', '</Exec><Exec><Command>C:\\x.exe</Command></Exec>'), running: true } });
      leftAlone(await run(two), two);
    });

    it('leaves a task that runs another program', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: taskWith(exact, 'C:\\Windows\\System32\\cmd.exe'), running: true } });
      leftAlone(await run(host), host);
    });

    it('takes a home folder with a space in it (the same quoting as the install)', async () => {
      const spaced = 'C:\\Users\\Dev User';
      const xml = buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable: conhost, args: ['--headless', NODE, `--env-file=${windowsAgentEnvFile(spaced, OPTIONS)}`, `${spaced}\\.azito\\agent\\abc123abc123\\azito-agent.cjs`],
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
    expect(outcomes(result)).toEqual({ task: 'failed', processes: 'skipped', firewall: 'absent', folder: 'skipped' });
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

  describe('what still runs from the folder after the task is ended', () => {
    it('stops the deletion of the folder, with the pid and the path, and touches nothing', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
      host.answers['Looking for processes still running from the agent folder'] = LEFT_AGENT;
      const result = await run(host);
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'failed', firewall: 'absent', folder: 'skipped' });
      expect(detail(result, 'processes')).toContain('4242');
      expect(detail(result, 'processes')).toContain('C:\\Program Files\\nodejs\\node.exe');
      expect(detail(result, 'processes')).toContain('stop it yourself');
      expect(host.ran(`Removing ${AGENT_ROOT}`)).toBe(false);
    });

    it('a list of processes that cannot be read stops the deletion too', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
      host.answers['Looking for processes still running from the agent folder'] = new Error('Looking for processes failed on the Windows host (exit 1): Access denied');
      expect(outcomes(await run(host))).toMatchObject({ processes: 'failed', folder: 'skipped' });
    });

    it('an answer it cannot read is a failure, not "nothing is left"', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Looking for processes still running from the agent folder'] = '';
      expect(outcomes(await run(host))).toMatchObject({ processes: 'failed', folder: 'skipped' });
    });
  });

  it('a folder that cannot be looked at (access denied) is a failure, not "absent"', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = new Error(`Removing ${AGENT_ROOT} failed on the Windows host (exit 1): Access to the path is denied.`);
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('denied');
  });

  it('reports what could not be deleted from the folder', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = `FAILED 1 item(s) could not be removed (a file in use?): ${AGENT_ROOT}\\agent.log: used by another process`;
    const result = await run(host);
    expect(outcomes(result).folder).toBe('failed');
    expect(detail(result, 'folder')).toContain('agent.log');
  });

  it('refuses a folder answer it cannot read instead of calling it done', async () => {
    const host = new FakeUninstallHost({});
    host.answers['Removing C:'] = 'something else';
    expect(outcomes(await run(host)).folder).toBe('failed');
  });

  describe('the firewall rule (reported, never removed)', () => {
    const RULE = 'RULE|{1111-AAAA}|Allow|Any|C:\\Program Files\\nodejs\\node.exe|TCP|3002|100.64.0.7|100.64.0.0/255.192.0.0';

    it('lists a rule of the install\'s name with its Name and what it allows, leaves it, and tells how to remove it; the run is not a failure', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML } });
      host.answers['Looking for the Windows Firewall rule'] = RULE;
      const result = await run(host);
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'absent', firewall: 'skipped', folder: 'done' });
      const text = detail(result, 'firewall');
      expect(text).toContain('does not remove firewall rules by itself');
      expect(text).toContain('{1111-AAAA}');
      expect(text).toContain('port 3002');
      expect(text).toContain("Remove-NetFirewallRule -Name '{1111-AAAA}'");
      expect(text).not.toContain('-DisplayName');
    });

    it('lists every rule of that name, each with its own command', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Looking for the Windows Firewall rule'] = `${RULE}\nRULE|{2222-BBBB}|Allow|Public|D:\\x\\node.exe|TCP|3002|Any|Any`;
      const text = detail(await run(host), 'firewall');
      expect(text).toContain("Remove-NetFirewallRule -Name '{1111-AAAA}'");
      expect(text).toContain("Remove-NetFirewallRule -Name '{2222-BBBB}'");
    });

    it('looks for the rule by the name the install gives it, among the inbound rules, and does not hide a failure', async () => {
      const host = new FakeUninstallHost({});
      await run(host);
      const script = host.bodyOf('Looking for the Windows Firewall rule');
      expect(script).toContain("$name = 'AZITO Agent (TCP 3002)'");
      expect(script).toContain('Get-NetFirewallRule -Direction Inbound -ErrorAction Stop');
      expect(script).not.toContain('SilentlyContinue');
    });

    it('a list that cannot be read is a failure, not "no rule", and the folder is still removed', async () => {
      const host = new FakeUninstallHost({});
      host.answers['Looking for the Windows Firewall rule'] = new Error('Looking for the Windows Firewall rule failed on the Windows host (exit 1): Access is denied');
      const result = await run(host);
      expect(outcomes(result)).toMatchObject({ firewall: 'failed', folder: 'done' });
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
    it('ends its task, asks the daemon to stop through its own pipe, looks for what is left, and removes its folder', async () => {
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, AzitoMisao: { xml: MISAO_XML, running: true } });
      const result = await run(host, true);
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual({ task: 'done', processes: 'absent', firewall: 'absent', folder: 'done', misaoTask: 'done', misaoProcesses: 'absent', misaoFolder: 'done' });
      expect(host.tasks.has('AzitoMisao')).toBe(false);
      const order = host.log.filter((l) => /AzitoMisao|misao/.test(l));
      expect(order.indexOf('end AzitoMisao')).toBeLessThan(order.indexOf('script Asking the misao daemon to stop'));
      expect(order.indexOf('script Asking the misao daemon to stop')).toBeLessThan(order.indexOf('script Looking for processes still running from the misao folder'));
      const stop = host.bodyOf('Asking the misao daemon to stop');
      expect(stop).toContain(`'${MISAO_ROOT}\\0.3.0\\misao.exe'`);
      expect(stop).toContain(windowsMisaoPipe(MISAO_ROOT, 'dev'));
      expect(host.bodyOf('Looking for processes still running from the misao folder')).toContain(`'${MISAO_ROOT}'`);
    });

    it('does not ask for a stop when the task is not there to say which misao.exe it runs, but still looks', async () => {
      const host = new FakeUninstallHost({});
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'absent', misaoProcesses: 'absent', misaoFolder: 'done' });
      expect(host.ran('Asking the misao daemon to stop')).toBe(false);
      expect(host.ran('Looking for processes still running from the misao folder')).toBe(true);
    });

    it('keeps the misao folder, and says which process is left, when the daemon did not go', async () => {
      const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } });
      host.answers['Looking for processes still running from the misao folder'] = `LEFT|7|misao.exe|${MISAO_ROOT}\\0.3.0\\misao.exe`;
      const result = await run(host, true);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'failed', misaoFolder: 'skipped' });
      expect(detail(result, 'misaoProcesses')).toContain('process 7');
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
        expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'absent', misaoFolder: 'done' });
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

      it.each([
        ['a hub process is running', 'HUB 4321', '4321'],
        ['one of its processes was not started by a task', 'FOREIGN 77', '77'],
        ['the owner of a process cannot be read (it is neither mine nor someone else\'s)', 'UNKNOWN 88', '88'],
      ])('leaves the misao when %s', async (_label, answer, pid) => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML, running: true } });
        host.answers['Checking who runs the misao'] = answer;
        const result = await run(host, true);
        expect(result.ok).toBe(true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'skipped', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(detail(result, 'misaoTask')).toContain(pid);
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

    describe('whose misao task it is (one action, exactly what the install writes)', () => {
      const conhost = 'C:\\Windows\\System32\\conhost.exe';
      const taskWith = (argumentsLine: string, executable = conhost): string => buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable, argumentsLine, workingDirectory: HOME, restartOnFailure: { intervalMinutes: 1, count: 1 },
      });
      const exactLine = /<Arguments>([^<]*)<\/Arguments>/.exec(MISAO_XML)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

      it('takes the task the install writes (the plain form, and the launcher form for a folder with a space), whatever release it runs', async () => {
        expect(outcomes(await run(new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML } }), true)).misaoTask).toBe('done');
        const spaced = 'C:\\Users\\Dev User';
        const spacedRoot = `${spaced}\\.azito\\misao`;
        const xml = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: spaced, layout: misaoWindowsLayout({ misaoRoot: spacedRoot }, '0.4.1', MISAO_WINDOWS_TASK_NAME), pipe: windowsMisaoPipe(spacedRoot, 'dev') });
        const host = new FakeUninstallHost({ AzitoMisao: { xml } });
        const result = await uninstallWindowsAgent(host.asHost(), factsOf(spaced, NODE), OPTIONS, { removeMisao: true });
        expect(outcomes(result).misaoTask).toBe('done');
        // The release folder of the task (0.4.1) is the misao.exe that is asked to stop.
        expect(host.bodyOf('Asking the misao daemon to stop')).toContain('\\0.4.1\\misao.exe');
      });

      it.each([
        ['an unrelated program that has the --data folder inside one of its arguments', 'C:\\Tools\\backup.exe', `--note=--data "${MISAO_ROOT}" --keep`],
        ['the plain line with something appended', conhost, `${exactLine} --extra`],
        ['the plain line with another pipe', conhost, exactLine.replace(/\\\\\.\\pipe\\[^"]+/, '\\\\.\\pipe\\other')],
        ['the plain line with another log', conhost, exactLine.replace('misao.log', 'other.log')],
        ['the plain line run by another program', 'C:\\Windows\\System32\\cmd.exe', exactLine],
        ['the plain line for another folder', conhost, exactLine.split(MISAO_ROOT).join('D:\\elsewhere\\misao')],
        ['the plain line with the release folder replaced', conhost, exactLine.replace('\\0.3.0\\', '\\..\\x\\')],
      ])('leaves %s', async (_label, executable, line) => {
        const host = new FakeUninstallHost({ AzitoMisao: { xml: taskWith(line, executable) } });
        const result = await run(host, true);
        expect(outcomes(result)).toMatchObject({ misaoTask: 'failed', misaoProcesses: 'skipped', misaoFolder: 'skipped' });
        expect(host.tasks.has('AzitoMisao')).toBe(true);
        expect(host.ran('Asking the misao daemon to stop')).toBe(false);
      });

      it('leaves a task with another action beside the right one, and a task with two Exec actions', async () => {
        const com = new FakeUninstallHost({ AzitoMisao: { xml: withComHandler(MISAO_XML) } });
        expect(outcomes(await run(com, true)).misaoTask).toBe('failed');
        expect(com.tasks.has('AzitoMisao')).toBe(true);
        const two = new FakeUninstallHost({ AzitoMisao: { xml: MISAO_XML.replace('</Exec>', '</Exec><Exec><Command>C:\\x.exe</Command></Exec>') } });
        expect(outcomes(await run(two, true)).misaoTask).toBe('failed');
      });

      it('leaves a task made for another account (the pipe is made from the account name)', async () => {
        const other = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: HOME, layout: misaoWindowsLayout({ misaoRoot: MISAO_ROOT }, '0.3.0', MISAO_WINDOWS_TASK_NAME), pipe: windowsMisaoPipe(MISAO_ROOT, 'someone') });
        const host = new FakeUninstallHost({ AzitoMisao: { xml: other } });
        expect(outcomes(await run(host, true)).misaoTask).toBe('failed');
      });
    });

    it('works the same with names of its own (a trial) when no hub is involved', async () => {
      const trial: WindowsAgentOptions = { ...OPTIONS, misaoTaskName: 'TrialMisao', misaoDir: '.trial\\misao' };
      const host = new FakeUninstallHost({ AzitoAgent: { xml: AGENT_XML }, TrialMisao: { xml: misaoXml(`${HOME}\\.trial\\misao`, 'TrialMisao') } });
      const result = await run(host, true, trial);
      expect(outcomes(result)).toMatchObject({ misaoTask: 'done', misaoProcesses: 'absent', misaoFolder: 'done' });
      expect(host.log).toContain('query AzitoHub');
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

  it('what is left running: CLEAR is "absent", LEFT lines are a failure with the pids and paths, anything else is an error', () => {
    expect(parseLeftoverOutput('CLEAR\r\n', 'C:\\r')).toEqual({ outcome: 'absent' });
    const left = parseLeftoverOutput('LEFT|10|node.exe|C:\\n\\node.exe\nLEFT|11|misao.exe|', 'C:\\r');
    expect(left.outcome).toBe('failed');
    expect(left.detail).toContain('process 10, C:\\n\\node.exe');
    expect(left.detail).toContain('process 11');
    expect(left.detail).toContain('2 processes are');
    expect(() => parseLeftoverOutput('', 'C:\\r')).toThrow(/could not be read/);
    expect(() => parseLeftoverOutput('CLEAR\nLEFT', 'C:\\r')).toThrow(/could not be read/);
  });

  it('firewall: no rule, or the rules found (never a removal)', () => {
    expect(parseFirewallOutput('ABSENT', 'R')).toEqual({ outcome: 'absent' });
    const found = parseFirewallOutput("RULE|{G}|Allow|Any|C:\\x.exe|TCP|3002|1.2.3.4|Any\nRULE|{O'Q}|Block|Any||TCP|3002||", 'R');
    expect(found.outcome).toBe('skipped');
    expect(found.detail).toContain("Remove-NetFirewallRule -Name '{G}'");
    expect(found.detail).toContain("Remove-NetFirewallRule -Name '{O''Q}'");
    expect(() => parseFirewallOutput('', 'R')).toThrow(/could not be read/);
    expect(() => parseFirewallOutput('what', 'R')).toThrow(/could not be read/);
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

  it('same file: SAME, DIFFERENT, UNKNOWN', () => {
    expect(parseSameFileOutput('SAME')).toBe('same');
    expect(parseSameFileOutput('DIFFERENT')).toBe('different');
    expect(parseSameFileOutput('UNKNOWN')).toBe('unknown');
    expect(() => parseSameFileOutput('')).toThrow(/could not be read/);
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
    const long = new FakeUninstallHost({
      AzitoAgent: { xml: buildTaskXml({
        userId: 'PC\\dev', description: 'x', executable: 'C:\\Windows\\System32\\conhost.exe',
        args: ['--headless', NODE, `--env-file=${windowsAgentEnvFile(home, OPTIONS)}`, `${home}\\.azito\\agent\\abc123abc123\\azito-agent.cjs`], workingDirectory: home, restartOnFailure: { intervalMinutes: 1, count: 1 },
      }) },
    });
    await uninstallWindowsAgent(long.asHost(), factsOf(home, NODE), OPTIONS, { removeMisao: true });
    expect(long.bodies.length).toBeGreaterThanOrEqual(6);
    for (const { what, body } of long.bodies) {
      expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`), what).not.toThrow();
    }
  });

  it('the largest forms fit too (a hub folder and a hub process check; the stop; the leftover look; the firewall list; the comparison)', () => {
    const long = `C:\\Users\\${'a-very-long-user-name-'.repeat(4)}`;
    const scripts = [
      misaoGuardScript({ root: `${long}\\.azito\\misao`, hubRoot: `${long}\\.azito\\misao`, looksForHub: true }),
      misaoStopScript(`${long}\\.azito\\misao\\0.3.0\\misao.exe`, '\\\\.\\pipe\\misao-a-very-long-user-name-0123456789abcdef'),
      leftoverProcessesScript(`${long}\\.azito\\misao`),
      firewallInspectScript('AZITO Agent (TCP 3002)'),
      sameFileScript(`${long}\\a\\b\\node.exe`, `${long}\\c\\d\\node.exe`),
    ];
    for (const body of scripts) expect(() => powershellDialect.wrapScript(`$ProgressPreference = 'SilentlyContinue'\n${body}`)).not.toThrow();
  });

  it('a path with a junction or symbolic link on the way is not resolved, and a folder that is there but cannot be resolved may be the hub\'s', () => {
    const guard = misaoGuardScript({ root: 'C:\\h\\m', hubRoot: 'C:\\h\\m', looksForHub: false });
    expect(guard).toContain('[System.IO.FileAttributes]::ReparsePoint');
    expect(guard).toContain('Test-Path -LiteralPath $root');
    expect(guard).toContain("Write-Output 'MAYBEHUB'");
    expect(sameFileScript('C:\\a.exe', 'C:\\b.exe')).toContain('[System.IO.FileAttributes]::ReparsePoint');
  });

  it('the folder script checks every folder from the one to remove up to the drive\'s root, and refuses one that is a link or cannot be looked at', () => {
    const script = folderScript(HOME, AGENT_ROOT);
    expect(script).toContain('[System.IO.Path]::GetPathRoot($root)');
    expect(script).toContain('$walk.TrimEnd([char]92) -ne $driveRoot.TrimEnd([char]92)');
    expect(script).toContain('cannot be looked at');
    expect(script).toContain('is a link (junction or symbolic link)');
    expect(script).not.toContain('-ne $homeDir');
  });

  it('the folder script treats only a missing folder as absent, and removes a link inside as a link (it never enters it)', () => {
    const script = folderScript(HOME, AGENT_ROOT);
    expect(script).toContain("-ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { Write-Output 'ABSENT'; exit 0 } else { throw } }");
    expect(script).not.toContain('SilentlyContinue');
    expect(script).toMatch(/ReparsePoint\)\) \{\s*if \(\$isDirectory\) \{ \[System\.IO\.Directory\]::Delete\(\$entry\) \}/);
    expect(script).not.toContain('-Recurse');
  });

  it('the leftover look touches nothing and fails on a list it cannot read', () => {
    const script = leftoverProcessesScript(AGENT_ROOT);
    expect(script).not.toMatch(/Stop-Process|Kill|taskkill/i);
    expect(script).toContain('Get-CimInstance Win32_Process -ErrorAction Stop');
  });
});

describe('WindowsAgentDeployer.uninstall', () => {
  const info = { home: HOME, systemRoot: 'C:\\Windows', nodePath: NODE, userId: 'PC\\dev' };

  it('runs the steps through the SSH session, the task through schtasks, and leaves the other task alone', async () => {
    const fake = new FakeWindowsHost({ sha256: 'a'.repeat(64), existingTask: 'running' });
    fake.registeredXml = AGENT_XML;
    const exec: WindowsSshExec = async (h, command) => {
      const result = await fake.exec(h, command);
      const last = fake.calls[fake.calls.length - 1];
      if (last?.kind !== 'script') return result;
      if (last.text.includes('Remove-Tree')) return { ...result, stdout: 'DONE\r\n' };
      if (last.text.includes('Get-NetFirewallRule')) return { ...result, stdout: 'ABSENT\r\n' };
      if (last.text.includes('Find-Left')) return { ...result, stdout: 'CLEAR\r\n' };
      if (last.text.includes('$a = Resolve-Long')) return { ...result, stdout: 'SAME\r\n' };
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
