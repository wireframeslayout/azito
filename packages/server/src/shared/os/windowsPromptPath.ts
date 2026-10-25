/**
 * A path as a worker on Windows is told it: forward slashes, so that neither Git Bash nor PowerShell reads a backslash as an escape.
 * Used wherever a path is written into a worker's prompt (task files, azitoctl.mjs, the sidekick directory) on a Windows host.
 */
export function windowsPromptPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
