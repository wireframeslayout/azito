import * as path from 'path';
import { MISAO_RELEASE_FILE_NAMES, misaoFileNameOn, MISAO_WINDOWS_CURRENT_FILE, type AgentMisaoWindowsHost, type MisaoReleaseFile } from '../../servers/transport/agentMisaoSocket';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { quoteWindowsArg } from '../../../shared/os/taskScheduler/windowsCommandLine';

const win32 = path.win32;

/** A failed misao stays down for a minute before the Task Scheduler starts it again (its smallest interval), as the hub's systemd unit would after `RestartSec`. */
const RESTART_INTERVAL_MINUTES = 1;
const RESTART_COUNT = 999;

/** Where everything of one Windows misao install lives on the host. */
export interface MisaoWindowsLayout {
  /** `<home>\<AZITO_MISAO_DIR>` (owner-only): the daemon's `--data` directory, the versions, the log. */
  root: string;
  /** The folder of the release the layout is for. */
  versionDir: string;
  /** The release's `misao.exe`. */
  exe: string;
  /** Where an upload of this release is staged until it is moved to `versionDir`. */
  stageDir: string;
  /** Which release the task starts (the Windows counterpart of the `current` link). */
  currentFile: string;
  /** The daemon's stdout and stderr, appended by `cmd.exe`. */
  logFile: string;
  /** The task definition, written beside the install while it is being registered. */
  taskXmlFile: string;
}

export function misaoWindowsLayout(windows: Pick<AgentMisaoWindowsHost, 'misaoRoot'>, version: string, taskName: string): MisaoWindowsLayout {
  const root = windows.misaoRoot;
  const versionDir = win32.join(root, version);
  return {
    root,
    versionDir,
    exe: win32.join(versionDir, misaoFileNameOn('win32', 'misao')),
    stageDir: win32.join(root, `${version}.upload`),
    currentFile: win32.join(root, MISAO_WINDOWS_CURRENT_FILE),
    logFile: win32.join(root, 'misao.log'),
    taskXmlFile: win32.join(root, `${taskName}.task.xml`),
  };
}

/** The path of one release file in `versionDir` (`misao` is `misao.exe`). */
export function misaoWindowsReleaseFile(versionDir: string, name: MisaoReleaseFile): string {
  return win32.join(versionDir, misaoFileNameOn('win32', name));
}

/** The release files of a version folder, in the order the sha256 check lists them. */
export function misaoWindowsReleasePaths(versionDir: string): string[] {
  return MISAO_RELEASE_FILE_NAMES.map((name) => misaoWindowsReleaseFile(versionDir, name));
}

/**
 * Text that lands inside double quotes in a `cmd.exe /c` line. Inside quotes cmd.exe still expands `%NAME%`, and a quote ends the
 * quoting, so a value with one is refused instead of escaped (a home folder with a `%` or a `"` in its name cannot be a misao install).
 */
function assertCmdQuotable(value: string, what: string): string {
  if (/["%!\r\n\0]/.test(value)) throw new Error(`${what} cannot be written to the misao task (it contains a quote, "%", "!" or a line break): ${value}`);
  return `"${value}"`;
}

/**
 * The command line of the misao task: `conhost.exe --headless cmd.exe /d /c ""<misao.exe>" serve --socket "<pipe>" --data "<root>"
 * >> "<log>" 2>&1"`. `--headless` gives the daemon a console without a window; `cmd.exe` appends its stdout and stderr to the log
 * (misao writes its log there, and has no option of its own for a file): the form misao's own `deploy/windows/misao-task.xml` uses.
 * The pipe is named explicitly so that the daemon, the agent's relay and `misao stop` all use the one the hub chose.
 */
export function misaoTaskArguments(input: { systemRoot: string; layout: MisaoWindowsLayout; pipe: string }): string {
  const { layout, pipe } = input;
  const cmd = win32.join(input.systemRoot, 'System32', 'cmd.exe');
  const inner = `${assertCmdQuotable(layout.exe, 'The misao.exe path')} serve --socket ${assertCmdQuotable(pipe, 'The misao pipe name')} --data ${assertCmdQuotable(layout.root, 'The misao folder')} >> ${assertCmdQuotable(layout.logFile, 'The misao log path')} 2>&1`;
  return `--headless ${quoteWindowsArg(cmd)} /d /c "${inner}"`;
}

export interface MisaoTaskInput {
  /** `DOMAIN\user` (or `COMPUTER\user`) the task starts for at logon. */
  userId: string;
  systemRoot: string;
  /** The user's home folder: the daemon's own working directory, so that no pane starts inside (and so locks) a release folder. */
  homeDir: string;
  layout: MisaoWindowsLayout;
  pipe: string;
}

/** The Task Scheduler definition of the misao daemon: started at the user's logon, restarted after a failure (not after a clean `misao stop`). */
export function buildMisaoTaskXml(input: MisaoTaskInput): string {
  return buildTaskXml({
    userId: input.userId,
    description: 'AZITO misao: started at logon by the AZITO hub',
    executable: win32.join(input.systemRoot, 'System32', 'conhost.exe'),
    argumentsLine: misaoTaskArguments(input),
    workingDirectory: input.homeDir,
    restartOnFailure: { intervalMinutes: RESTART_INTERVAL_MINUTES, count: RESTART_COUNT },
  });
}
