import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { LogType } from '../ExecutionLog';
import type { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { windowsPromptPath } from '../../../shared/os/windowsPromptPath';

/**
 * Letters and digits of any script, space, and `_ . / : + , = ~ @ -`. Nothing a POSIX shell, cmd.exe or PowerShell reads as more than
 * text (no quote, `$`, backtick, `;`, `&`, `|`, `<`, `>`, parenthesis, `*`, `?`, `!`, `#`, `%`, `\`, brace, newline). A `~` is only
 * special at the start of a word, and a Windows short name (`JUNZO~1`) has one inside.
 */
const HARMLESS_LINE = /^[\p{L}\p{N} _./:+,=~@-]+$/u;

/**
 * The one line typed into the worker's pane instead of the prompt (Issue #532). The prompt itself is a file on the worker's host and
 * never goes through the pane, so a worker that ends while it is typed cannot leave the rest of the prompt to the shell under it.
 * If the shell does get this line, it runs the command `AZITO` (not found) with words as arguments: nothing happens. The path is last,
 * so the end of the line is the end of the path whatever it contains (a space in a Windows user name).
 * Throws if the line holds anything but harmless characters (a task temp folder with a quote, `$`, ...): it is refused, never typed.
 */
export function buildPromptFileInstruction(promptFilePath: string): string {
  const line = `AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: ${promptFilePath}`;
  if (!HARMLESS_LINE.test(line)) {
    throw new Error(`The prompt file path ${JSON.stringify(promptFilePath)} contains characters a shell could read as more than text; use a temp directory without quotes, $, backticks, ; & | < > ( ) * ? ! # % or backslashes`);
  }
  return line;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The bytes of the prompt file. On a Windows host with a byte order mark: PowerShell 5.1's `Get-Content` (what codex reads a file with)
 * takes a file without one as the ANSI code page and garbles every non-ASCII character of the task's text, and the BOM is what makes it,
 * and Claude's Read, take the file as UTF-8. A POSIX host reads UTF-8 as it is.
 */
export function promptFileBytes(prompt: string, platform: string): Buffer {
  const body = Buffer.from(prompt, 'utf8');
  return platform === 'win32' ? Buffer.concat([UTF8_BOM, body]) : body;
}

type AppendLog = (taskId: number, unitId: number, type: LogType, content: unknown) => void;

/**
 * Puts a prompt on the worker's host as a task temp file and returns the one line to type into the pane. The file is written through the
 * host's file operations (`transport.files()`), where the task's other temp files live; its path is recorded in the execution log so that
 * cleanup finds it on an agent host too.
 */
export class PromptFileDelivery {
  constructor(
    private transportFactory: TransportFactory,
    private taskTempFiles: TaskTempFiles,
    private appendLog: AppendLog,
  ) {}

  async stage(server: ServerConfig, taskId: number, unitId: number, prompt: string): Promise<string> {
    const tempServer = await this.transportFactory.taskTempServer(server);
    const files = this.transportFactory.getFileOps(server);
    const filePath = this.taskTempFiles.promptFile(tempServer, taskId, randomBytes(8).toString('hex'));
    // The path the worker is told: forward slashes on a Windows host (the file itself is written under its own spelling).
    const told = files.platform === 'win32' ? windowsPromptPath(filePath) : filePath;
    const instruction = buildPromptFileInstruction(told);
    // Owner-only from the moment it exists: the prompt holds the task's text (an agent that cannot do this refuses the write).
    await files.write(filePath, promptFileBytes(prompt, files.platform), { ownerOnly: true });
    this.appendLog(taskId, unitId, 'command', { type: 'prompt_file', promptFilePath: filePath });
    return instruction;
  }
}
