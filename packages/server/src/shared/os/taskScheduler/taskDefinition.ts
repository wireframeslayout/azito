import { joinWindowsArgs } from './windowsCommandLine';

/** Task Scheduler's minimum restart interval is 1 minute. */
export const MIN_RESTART_INTERVAL_MINUTES = 1;
/** The schema's upper bound of RestartOnFailure/Interval: 31 days. */
export const MAX_RESTART_INTERVAL_MINUTES = 31 * 24 * 60;
export const MAX_RESTART_COUNT = 999;

export interface TaskDefinitionInput {
  /** The user whose logon starts the task and who runs it, `DOMAIN\user` (or `COMPUTER\user`). Resolved at the entry point. */
  userId: string;
  description: string;
  /** Absolute Windows path of the program. */
  executable: string;
  args: readonly string[];
  /** Absolute Windows path. */
  workingDirectory: string;
  restartOnFailure: { intervalMinutes: number; count: number };
}

// There is deliberately no environment input: a Task Scheduler action cannot carry environment variables. The launcher the
// action starts (the `run.ps1` of #380, or the program itself) sets them before it runs the service.

/** Characters XML 1.0 cannot carry at all (not even escaped). Tab, LF and CR are allowed. */
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** A high surrogate without a low one after it, or a low one without a high one before it (not a character at all in XML). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The one XML escape. Every value lands in element text (never an attribute), where `&`, `<`, `>` and CR need it. Throws for a character that XML 1.0 cannot represent. */
export function escapeXml(value: string): string {
  if (XML_FORBIDDEN.test(value)) throw new Error('The value contains a control character that cannot be written in the task XML');
  if (LONE_SURROGATE.test(value)) throw new Error('The value contains an unpaired surrogate, which is not a character in XML');
  // A raw CR is read back as LF (XML end-of-line handling); a character reference survives.
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

/** `C:\dir` / `C:/dir` or a UNC path. A rooted path without a drive (`\dir`) depends on the current drive, so it is refused. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/;

/** `%NAME%`: the form the Task Scheduler expands. A lone `%` (`C:\\100%\\x.exe`, `100%`) is left as it is. */
const ENV_REFERENCE = /%[^%\r\n]+%/;

/**
 * The Task Scheduler expands `%VAR%` in the Command, Arguments and WorkingDirectory of an action when it runs, and no quoting
 * protects it. A value containing one would turn into something else, so it is refused instead of silently changed.
 */
function assertNoEnvExpansion(value: string, what: string): void {
  if (ENV_REFERENCE.test(value)) throw new Error(`${what} must not contain a %NAME% reference: the Task Scheduler would expand it (got "${value}")`);
}

function assertWindowsAbsolutePath(value: string, what: string): void {
  if (!WINDOWS_ABSOLUTE_PATH.test(value)) throw new Error(`${what} must be an absolute Windows path (got "${value}")`);
  if (value.includes('"')) throw new Error(`${what} must not contain a double quote (got "${value}")`);
}

/**
 * The Task Scheduler task (schema 1.2, Windows 7 and later) that starts a program when `userId` logs on:
 * - runs as that user with the logon session's token (`InteractiveToken`): no password is stored, no admin rights asked (`LeastPrivilege`);
 * - restarts after a failure, never stops for a time limit, never starts a second copy, is not held back by battery or idleness.
 */
export function buildTaskXml(input: TaskDefinitionInput): string {
  const { restartOnFailure } = input;
  if (input.userId.trim() === '') throw new Error('userId must not be empty');
  assertWindowsAbsolutePath(input.executable, 'executable');
  assertWindowsAbsolutePath(input.workingDirectory, 'workingDirectory');
  if (!Number.isInteger(restartOnFailure.intervalMinutes) || restartOnFailure.intervalMinutes < MIN_RESTART_INTERVAL_MINUTES || restartOnFailure.intervalMinutes > MAX_RESTART_INTERVAL_MINUTES) {
    throw new Error(`restartOnFailure.intervalMinutes must be a whole number from ${MIN_RESTART_INTERVAL_MINUTES} to ${MAX_RESTART_INTERVAL_MINUTES}`);
  }
  if (!Number.isInteger(restartOnFailure.count) || restartOnFailure.count < 1 || restartOnFailure.count > MAX_RESTART_COUNT) {
    throw new Error(`restartOnFailure.count must be a whole number from 1 to ${MAX_RESTART_COUNT}`);
  }
  assertNoEnvExpansion(input.executable, 'executable');
  assertNoEnvExpansion(input.workingDirectory, 'workingDirectory');
  const argumentsLine = joinWindowsArgs(input.args);
  assertNoEnvExpansion(argumentsLine, 'args');
  const user = escapeXml(input.userId);
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(input.description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    // 4-6 is NORMAL. 7 (the Task Scheduler default) is BELOW_NORMAL, and the class is inherited: the service's children (pane shells, agents, builds) would all run below the user's foreground apps.
    '    <Priority>5</Priority>',
    '    <RestartOnFailure>',
    `      <Interval>PT${restartOnFailure.intervalMinutes}M</Interval>`,
    `      <Count>${restartOnFailure.count}</Count>`,
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(input.executable)}</Command>`,
    `      <Arguments>${escapeXml(argumentsLine)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(input.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * schtasks `/XML` reads the file by its XML declaration, and the declaration the Task Scheduler itself writes is UTF-16.
 * UTF-16 LE with a BOM is what it exports and takes back for any character (a Japanese user name or path included).
 */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** The inverse of {@link encodeTaskXml}. A file without the UTF-16 LE BOM is refused rather than guessed at. */
export function decodeTaskXml(bytes: Buffer): string {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error('The task XML is not UTF-16 LE with a byte order mark');
  return bytes.subarray(2).toString('utf16le');
}
