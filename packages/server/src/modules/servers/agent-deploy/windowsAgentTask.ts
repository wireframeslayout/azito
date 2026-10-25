import * as path from 'path';
import { misaoTaskArgumentsOf } from '../../../shared/os/taskScheduler/misaoTaskArguments';
import type { TaskExecAction } from '../../../shared/os/taskScheduler/taskXmlRead';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';
import { windowsMisaoPipe } from '../transport/agentMisaoSocket';

/** A release folder's name: what `windowsAgentLayout` accepts as a version. */
export const RELEASE_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const AGENT_VERSION_IN_ENTRY = new RegExp(`\\\\(${RELEASE_NAME})\\\\azito-agent\\.cjs"?$`);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `conhost.exe` both tasks run under (`--headless` gives the program a console without a window). */
function conhostOf(systemRoot: string): string {
  return path.win32.join(systemRoot, 'System32', 'conhost.exe');
}

/**
 * The program and the arguments of the agent's logon task. The ONE definition: the install writes the task from it, and the removal
 * recognises the install's task by building the same text again and comparing, not by parsing whatever is registered.
 */
export function agentTaskAction(systemRoot: string, nodePath: string, envFile: string, entry: string): { executable: string; args: string[] } {
  return { executable: conhostOf(systemRoot), args: ['--headless', nodePath, `--env-file=${envFile}`, entry] };
}

/** What the removal learns from a task it has recognised as the install's. */
export interface AgentTaskIdentity {
  nodePath: string;
  /** The release folder the task runs the agent from. */
  version: string;
}

/**
 * The node.exe and the release folder the task runs when `action` is exactly what the install writes for the install in `root` (settings
 * file `envFile`): the same program, and an arguments line equal, character for character, to the one {@link agentTaskAction} makes for that
 * node.exe and a release folder of this install. Anything else (an extra or missing argument, quotes or backslashes in another form,
 * another folder, a hand-edited line) is undefined: it is not known to be the install's, so it is left alone.
 *
 * The node.exe and the release folder are the two parts the removal cannot know in advance. The node.exe has to be one token that is
 * quoted exactly as `joinWindowsArgs` quotes that path; the release folder has to be a plain version name; the rest is compared whole.
 */
export function agentTaskIdentity(action: TaskExecAction, systemRoot: string, root: string, envFile: string): AgentTaskIdentity | undefined {
  const head = `${joinWindowsArgs(['--headless'])} `;
  if (action.command.toLowerCase() !== conhostOf(systemRoot).toLowerCase()) return undefined;
  if (!action.argumentsLine.startsWith(head)) return undefined;
  const split = /^("[^"]+"|[^"\s]+) ([\s\S]+)$/.exec(action.argumentsLine.slice(head.length));
  if (!split) return undefined;
  const [, nodeToken, tail] = split as unknown as [string, string, string];
  const nodePath = nodeToken.startsWith('"') ? nodeToken.slice(1, -1) : nodeToken;
  if (joinWindowsArgs([nodePath]) !== nodeToken) return undefined;
  const version = AGENT_VERSION_IN_ENTRY.exec(tail)?.[1];
  if (version === undefined) return undefined;
  const expected = agentTaskAction(systemRoot, nodePath, envFile, path.win32.join(root, version, 'azito-agent.cjs'));
  return tail === joinWindowsArgs(expected.args.slice(2)) ? { nodePath, version } : undefined;
}

/**
 * The release folder the misao task runs when `action` is exactly what the install writes for the misao in `root`: one program,
 * `conhost.exe`, and an arguments line equal to `misaoTaskArgumentsOf` (the very function that writes it) for `<root>\<version>\misao.exe`,
 * the log in `root` and the pipe made from `root` and the user. The version is the one part not known in advance: it is looked for in the
 * line (or in the launcher script it carries), and only a candidate that rebuilds the line exactly counts. Undefined = not known to be the
 * install's. `userName` is the account name without its domain (`os.userInfo().username` on the host), which the pipe name is made from.
 */
export function misaoTaskVersion(action: TaskExecAction, systemRoot: string, root: string, userName: string): string | undefined {
  if (action.command.toLowerCase() !== conhostOf(systemRoot).toLowerCase()) return undefined;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(action.argumentsLine)?.[1];
  const searched = `${action.argumentsLine}\n${encoded === undefined ? '' : Buffer.from(encoded, 'base64').toString('utf16le')}`;
  const found = new RegExp(`${escapeRegExp(root)}\\\\(${RELEASE_NAME})\\\\misao\\.exe`, 'gi');
  for (const match of searched.matchAll(found)) {
    const version = match[1]!;
    try {
      const expected = misaoTaskArgumentsOf({
        systemRoot, exe: path.win32.join(root, version, 'misao.exe'), root, logFile: path.win32.join(root, 'misao.log'), pipe: windowsMisaoPipe(root, userName),
      });
      if (expected === action.argumentsLine) return version;
    } catch {
      // A value that cannot be written to a misao task is not the install's.
    }
  }
  return undefined;
}

// ─── The processes the tasks start ───

/** Where the install's folder goes in the patterns of a {@link ProcessShape}: the host puts it in once (escaped), so a long path costs the script once. */
export const ROOT_TOKEN = '{ROOT}';

/**
 * What a process has to look like to be the one the install's task starts: regular expressions (as the host reads them) with
 * {@link ROOT_TOKEN} for the install's folder `root`.
 */
export interface ProcessShape {
  root: string;
  /** For `ExecutablePath`, as a whole. */
  exe: string;
  /** For the command line with its quotes removed and its leading `<ExecutablePath> ` taken off, as a whole. */
  tail: string;
}

/** The patterns of a shape with the folder put in, as the host does it (for the tests, and for whoever reads them). */
export function expandShape(shape: ProcessShape): { exe: string; tail: string } {
  const put = (pattern: string): string => pattern.split(ROOT_TOKEN).join(escapeRegExp(shape.root));
  return { exe: put(shape.exe), tail: put(shape.tail) };
}

/**
 * The agent: `node.exe --env-file=<root>\agent.env <root>\<version>\azito-agent.cjs`, which is what `conhost.exe --headless <that line>`
 * starts. The version is the task's when the task was recognised, any release folder of the install otherwise.
 */
export function agentProcessShape(root: string, version: string | undefined): ProcessShape {
  return {
    root,
    exe: '^.+\\\\node\\.exe$',
    tail: `--env-file=${ROOT_TOKEN}\\\\agent\\.env ${ROOT_TOKEN}\\\\${version === undefined ? RELEASE_NAME : escapeRegExp(version)}\\\\azito-agent\\.cjs`,
  };
}

/** The misao daemon: `<root>\<version>\misao.exe serve --socket <pipe> --data <root>` (what cmd.exe makes of the task's line). */
export function misaoProcessShape(root: string, userName: string, version: string | undefined): ProcessShape {
  return {
    root,
    exe: `^${ROOT_TOKEN}\\\\${version === undefined ? RELEASE_NAME : escapeRegExp(version)}\\\\misao\\.exe$`,
    tail: `serve --socket ${escapeRegExp(windowsMisaoPipe(root, userName))} --data ${ROOT_TOKEN}`,
  };
}
