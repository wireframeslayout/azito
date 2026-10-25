import * as path from 'path';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';
import type { TaskExecAction } from '../../../shared/os/taskScheduler/taskXmlRead';

/** The version folder of an agent release: what `windowsAgentLayout` accepts as a version, and what `azito-agent.cjs` sits in. */
const VERSION_IN_ENTRY = /\\([A-Za-z0-9][A-Za-z0-9._-]*)\\azito-agent\.cjs"?$/;

/**
 * The program and the arguments of the agent's logon task. The ONE definition: the install writes the task from it, and the removal
 * recognises the install's task by building the same text again and comparing, not by parsing whatever is registered.
 */
export function agentTaskAction(systemRoot: string, nodePath: string, envFile: string, entry: string): { executable: string; args: string[] } {
  return {
    executable: path.win32.join(systemRoot, 'System32', 'conhost.exe'),
    args: ['--headless', nodePath, `--env-file=${envFile}`, entry],
  };
}

/**
 * The node.exe the task runs when `action` is exactly what the install writes for the install in `root` (settings file `envFile`):
 * the same program, and an arguments line equal, character for character, to the one {@link agentTaskAction} makes for that node.exe and
 * a release folder of this install. Anything else (an extra or missing argument, quotes or backslashes in another form, another folder,
 * a hand-edited line) is undefined: it is not known to be the install's, so it is left alone.
 *
 * The node.exe and the release folder are the two parts the removal cannot know in advance. The node.exe has to be one token that is
 * quoted exactly as `joinWindowsArgs` quotes that path; the release folder has to be a plain version name; the rest is compared whole.
 */
export function nodeOfAgentTask(action: TaskExecAction, systemRoot: string, root: string, envFile: string): string | undefined {
  const head = `${joinWindowsArgs(['--headless'])} `;
  if (action.command.toLowerCase() !== agentTaskAction(systemRoot, 'node.exe', envFile, 'x').executable.toLowerCase()) return undefined;
  if (!action.argumentsLine.startsWith(head)) return undefined;
  const afterHead = action.argumentsLine.slice(head.length);
  const split = /^("[^"]+"|[^"\s]+) ([\s\S]+)$/.exec(afterHead);
  if (!split) return undefined;
  const [, nodeToken, tail] = split as unknown as [string, string, string];
  const node = nodeToken.startsWith('"') ? nodeToken.slice(1, -1) : nodeToken;
  if (joinWindowsArgs([node]) !== nodeToken) return undefined;
  const version = VERSION_IN_ENTRY.exec(tail)?.[1];
  if (version === undefined) return undefined;
  const expected = agentTaskAction(systemRoot, node, envFile, path.win32.join(root, version, 'azito-agent.cjs'));
  return tail === joinWindowsArgs(expected.args.slice(2)) ? node : undefined;
}
