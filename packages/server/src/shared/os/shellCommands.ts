/**
 * Interactive shells of every host OS (POSIX, and Windows's cmd.exe / Windows PowerShell / PowerShell 7). A pane whose foreground
 * command is one of these has no program of its own running in it. Windows names are case-insensitive.
 */
const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'zsh', 'sh', 'fish', 'dash',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
]);

/** True when `command` (a foreground command name as a mux reports it) is a bare shell. */
export function isBareShellCommand(command: string): boolean {
  return SHELL_COMMANDS.has(command.toLowerCase());
}

/**
 * The file name of a program path of any OS: both `/` and `\` separate, whatever OS the hub runs on (a POSIX hub reads a path from a
 * Windows agent). A path that ends in a separator has no file name and gives `''`.
 */
export function programFileName(programPath: string): string {
  return programPath.slice(Math.max(programPath.lastIndexOf('/'), programPath.lastIndexOf('\\')) + 1);
}
