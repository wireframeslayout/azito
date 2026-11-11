import { decodedTaskScript } from '../../../../shared/os/taskScheduler/taskLauncher';
import { gunzipSync } from 'node:zlib';
import type { ExecResult } from '../../transport/ServerTransport';
import * as path from 'path';
import { decodeTaskXml, escapeXml } from '../../../../shared/os/taskScheduler/taskDefinition';
import { joinWindowsArgs } from '../../../../shared/os/taskScheduler/windowsCommandLine';
import { legacyAgentTaskAction } from '../windowsAgentTask';

/** The script inside a `powershell.exe ... -EncodedCommand <base64>` line (what `powershellDialect.wrapScript` makes). */
export function decodeEncodedCommand(line: string): string {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  if (!match) throw new Error(`not an EncodedCommand line: ${line}`);
  const script = decodedTaskScript(match[1]!) ?? '';
  const packed = /\$packed = \[Convert\]::FromBase64String\('([^']+)'\)/.exec(script);
  return packed ? gunzipSync(Buffer.from(packed[1]!, 'base64')).toString('utf8') : script;
}

/** The release the fake's pre-existing task runs, when a test does not register one of its own. */
export const FAKE_PREVIOUS_VERSION = '0123456789ab';

/** A task definition of the earlier (pre-launcher) form, as an older install registered it for `version` of the default layout. */
export function legacyAgentTaskXml(version: string, host: { home?: string; systemRoot?: string; userId?: string; nodePath?: string } = {}): string {
  const home = host.home ?? 'C:\\Users\\dev';
  const systemRoot = host.systemRoot ?? 'C:\\Windows';
  const root = path.win32.join(home, '.azito', 'agent');
  const action = legacyAgentTaskAction(systemRoot, host.nodePath ?? 'C:\\Program Files\\nodejs\\node.exe', path.win32.join(root, 'agent.env'), path.win32.join(root, version, 'azito-agent.cjs'));
  // Only the parts the deploy reads (the principal and the one Exec action), so that any home a test uses can be written.
  return `<Task><Principals><Principal id="Author"><UserId>${escapeXml(host.userId ?? 'PC\\dev')}</UserId></Principal></Principals>`
    + `<Actions Context="Author"><Exec><Command>${escapeXml(action.executable)}</Command><Arguments>${escapeXml(joinWindowsArgs(action.args))}</Arguments></Exec></Actions></Task>`;

}

export interface FakeWindowsHostOptions {
  home?: string;
  systemRoot?: string;
  userId?: string;
  nodePath?: string;
  tailscaleIp?: string;
  taskName?: string;
  /** The hash Get-FileHash answers (default: the one the test expects). */
  sha256: string;
  firewall?: { ruleFound: boolean | null; elevated: boolean; created: boolean; problem: string | null; blockedBy?: string[] };
  previousFirewallProgram?: string;
  /** `null` = the build number could not be read. */
  buildNumber?: string | null;
  /** The task is already registered (and running) before the install. */
  existingTask?: 'running' | 'stopped';
  /** `/Run` leaves the task not running with this last result (the user is not logged on). */
  runResult?: number;
  /** A script containing this text fails with this stderr. */
  failScript?: { containing: string; stderr: string };
  /** A script containing this text prints this on stdout (and succeeds). */
  scriptOutput?: { containing: string; stdout: string };
  /** Simulate another task appearing exactly when a non-replacing Create is attempted. */
  raceTaskOnCreate?: string;
}

export interface RecordedCall {
  kind: 'os-probe' | 'preflight' | 'firewall' | 'schtasks' | 'script';
  /** The PowerShell script, or the command line for the OS probe. */
  text: string;
  /** For schtasks: the arguments of the call. */
  schtasksArgs?: string[];
}

function bytesOf(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * An SSH target that is a Windows host with a cmd.exe login shell: it answers each kind of script the install sends (read from
 * the EncodedCommand), keeps the state of one Task Scheduler task, and records every call. Files go through the SFTP fakes of the test.
 */
export class FakeWindowsHost {
  readonly calls: RecordedCall[] = [];
  /** The XML of the registered task, as the host would have read it. */
  registeredXml: string | undefined;
  taskState: 'absent' | 'stopped' | 'running';
  private lastResult = 0;
  readonly options: Required<Pick<FakeWindowsHostOptions, 'home' | 'systemRoot' | 'userId' | 'nodePath' | 'tailscaleIp' | 'taskName'>> & FakeWindowsHostOptions;
  /** The files the test's SFTP fake received: remote relative path -> bytes. */
  readonly uploaded = new Map<string, Buffer>();

  constructor(options: FakeWindowsHostOptions) {
    this.options = { home: 'C:\\Users\\dev', systemRoot: 'C:\\Windows', userId: 'PC\\dev', nodePath: 'C:\\Program Files\\nodejs\\node.exe', tailscaleIp: '100.64.0.9', taskName: 'AzitoAgent', ...options };
    this.taskState = options.existingTask === undefined ? 'absent' : options.existingTask;
    if (options.existingTask === 'running') this.lastResult = 0x41301;
    if (options.existingTask !== undefined) this.registeredXml = legacyAgentTaskXml(FAKE_PREVIOUS_VERSION, this.options);
  }

  /** The task is running, as the Task Scheduler reports it (a test that starts the program itself calls this). */
  markRunning(): void {
    this.taskState = 'running';
    this.lastResult = 0x41301;
  }

  /** The task's run ended (stopped by the Task Scheduler's End, or the program exited): not running, with this last result (default: terminated). */
  markEnded(lastResult = 0x41306): void {
    this.taskState = 'stopped';
    this.lastResult = lastResult;
  }

  readonly exec = async (_host: string, command: string): Promise<ExecResult> => {
    if (!command.includes('-EncodedCommand')) {
      this.calls.push({ kind: 'os-probe', text: command });
      return { stdout: 'AZITO_OS:Windows_NT:$?\r\n', stderr: '', code: 0 };
    }
    const unpacked = decodeEncodedCommand(command);
    const staged = /\$file = '([^']+\\(\.azito-script-[^']+))'/.exec(unpacked);
    const script = staged && this.uploaded.has(staged[2]!) ? this.uploaded.get(staged[2]!)!.toString('utf8') : unpacked;
    const failing = this.options.failScript;
    if (failing && script.includes(failing.containing)) {
      this.calls.push({ kind: 'script', text: script });
      return { stdout: '', stderr: failing.stderr, code: 1 };
    }
    const scripted = this.options.scriptOutput;
    if (scripted && script.includes(scripted.containing)) {
      this.calls.push({ kind: 'script', text: script });
      return { stdout: scripted.stdout, stderr: '', code: 0 };
    }
    if (script.includes('AZITO_PREFLIGHT_BEGIN')) {
      this.calls.push({ kind: 'preflight', text: script });
      const info = {
        nodePath: this.options.nodePath, nodeVersion: 'v24.14.0', arch: 'AMD64', windowsCaption: 'Microsoft Windows 11 Pro', buildNumber: this.options.buildNumber === undefined ? '22631' : this.options.buildNumber,
        tailscaleIp: this.options.tailscaleIp, tailscaleCli: 'ok', tailscaleDetail: null, networkStatus: 'not_checked', networkDetail: null, home: this.options.home, systemRoot: this.options.systemRoot, userId: this.options.userId,
      };
      return { stdout: `<<AZITO_PREFLIGHT_BEGIN>>\r\n${JSON.stringify(info)}\r\n<<AZITO_PREFLIGHT_END>>\r\n`, stderr: '', code: 0 };
    }
    if (script.includes('AZITO_FIREWALL_DUMP_BEGIN')) {
      this.calls.push({ kind: 'firewall', text: script });
      const fw = { blockedBy: [] as string[], ...(this.options.firewall ?? { ruleFound: true, elevated: false, created: false, problem: null }) };
      const rule = (action: string, displayName: string) => ({ name: displayName, displayName, action, profile: 'Any', package: '', owner: '', service: 'Any', protocol: 'TCP', localPort: ['Any'], program: 'Any', remoteAddress: ['Any'], localAddress: ['Any'], interfaceAlias: ['Any'], interfaceType: ['Any'] });
      const rules = [...(fw.ruleFound ? [rule('Allow', 'an allow rule')] : []), ...fw.blockedBy.map((n) => rule('Block', n))];
      if (this.options.previousFirewallProgram) rules.push({ ...rule('Allow', 'AZITO Agent (TCP 3002)'), program: this.options.previousFirewallProgram });
      const dump = { elevated: fw.elevated, networkCategory: fw.elevated ? 'Private' : null, store: fw.elevated ? 'ActiveStore' : 'Registry', problem: fw.ruleFound === null ? 'reading the rules failed' : null, profiles: [{ name: 'Private', enabled: 'True', defaultInboundAction: 'Block', allowInboundRules: 'True' }], rules: fw.ruleFound === null ? [] : rules };
      return { stdout: `<<AZITO_FIREWALL_DUMP_BEGIN>>\r\n${JSON.stringify(dump)}\r\n<<AZITO_FIREWALL_DUMP_END>>\r\n`, stderr: '', code: 0 };
    }
    if (script.includes('AZITO_FIREWALL_ADD_BEGIN')) {
      this.calls.push({ kind: 'firewall', text: script });
      const fw = this.options.firewall ?? { created: false, problem: null };
      return { stdout: `<<AZITO_FIREWALL_ADD_BEGIN>>\r\n${JSON.stringify({ created: fw.created, problem: fw.problem })}\r\n<<AZITO_FIREWALL_ADD_END>>\r\n`, stderr: '', code: 0 };
    }
    if (script.includes('AZITO_RUN_BEGIN')) return this.schtasks(script);
    this.calls.push({ kind: 'script', text: script });
    if (script.includes('ComputeHash')) return { stdout: `${this.options.sha256}\r\n`, stderr: '', code: 0 };
    if (script.includes('ConvertTo-Json -Depth 4')) {
      const sid = 'S-1-5-21-1-2-3-1001';
      return { stdout: JSON.stringify({ currentSid: sid, ownerSid: sid, entries: [{ sid, name: 'PC\\dev', type: 'Allow', inherited: false }] }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  private schtasks(script: string): ExecResult {
    const argsText = /\$psi\.Arguments = '((?:[^']|'')*)'/.exec(script)![1]!.replace(/''/g, "'");
    const args = (argsText.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''));
    this.calls.push({ kind: 'schtasks', text: script, schtasksArgs: args });
    const ok = (stdout = ''): ExecResult => ({ stdout: runOutput(0, stdout, ''), stderr: '', code: 0 });
    const fail = (stderr: string): ExecResult => ({ stdout: runOutput(1, '', stderr), stderr: '', code: 0 });
    const tnIndex = args.indexOf('/TN');
    const name = tnIndex >= 0 ? args[tnIndex + 1] : undefined;
    if (args[0] === '/Query' && args.includes('/XML')) {
      return this.taskState === 'absent' || this.registeredXml === undefined ? fail('ERROR: The system cannot find the file specified.') : ok(this.registeredXml);
    }
    switch (args[0]) {
      case '/Create': {
        if (this.options.raceTaskOnCreate !== undefined) {
          this.registeredXml = this.options.raceTaskOnCreate;
          this.taskState = 'stopped';
          this.options.raceTaskOnCreate = undefined;
        }
        if (this.taskState !== 'absent' && !args.includes('/F')) return fail('ERROR: The task already exists.');
        // The XML is the file the SFTP fake received.
        const file = args[args.indexOf('/XML') + 1]!;
        const bytes = [...this.uploaded.entries()].find(([rel]) => file.endsWith(rel.replace(/\//g, '\\')))?.[1];
        if (!bytes) return fail(`ERROR: no such file ${file}`);
        this.registeredXml = decodeTaskXml(bytes);
        this.taskState = 'stopped';
        return ok('SUCCESS');
      }
      case '/Run':
        if (this.taskState === 'absent') return fail('ERROR: The system cannot find the file specified.');
        if (this.options.runResult !== undefined) {
          this.lastResult = this.options.runResult;
          this.taskState = 'stopped';
        } else {
          this.taskState = 'running';
          this.lastResult = 0x41301;
        }
        return ok('SUCCESS');
      case '/Delete':
        if (this.taskState === 'absent') return fail('ERROR: The system cannot find the file specified.');
        this.taskState = 'absent';
        this.registeredXml = undefined;
        return ok('SUCCESS');
      case '/End':
        if (this.taskState !== 'running') return fail('ERROR: There is no running instance of the task.');
        this.taskState = 'stopped';
        this.lastResult = 0x41306;
        return ok('SUCCESS');
      case '/Query':
        if (name === undefined) return ok(this.taskState === 'absent' ? '' : `"\\${this.options.taskName}","N/A","Ready"\r\n`);
        if (this.taskState === 'absent') return fail('ERROR: The system cannot find the file specified.');
        return ok(`"PC","\\${this.options.taskName}","N/A","Ready","Interactive","N/A","${this.lastResult}"\r\n`);
      default:
        return fail(`unexpected schtasks call ${args.join(' ')}`);
    }
  }
}

function runOutput(exitCode: number, stdout: string, stderr: string): string {
  return `<<AZITO_RUN_BEGIN>>\r\n${JSON.stringify({ exitCode, stdout: bytesOf(stdout), stderr: bytesOf(stderr) })}\r\n<<AZITO_RUN_END>>\r\n`;
}
