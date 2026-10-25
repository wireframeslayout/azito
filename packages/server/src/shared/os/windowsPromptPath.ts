/**
 * A path as a worker on Windows is told it: forward slashes, so that neither Git Bash nor PowerShell reads a backslash as an escape.
 * Used wherever a path is written into a worker's prompt (task files, node / azitoctl.mjs, the sidekick directory) on a Windows host.
 */
export function windowsPromptPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

// What a double-quoted word of Git Bash or PowerShell would read as more than text.
const UNSAFE_IN_DOUBLE_QUOTES = /["$`]/;

/**
 * The path as the word the prompt puts in double quotes (forward slashes), refused when a double quote, `$` or a backtick in it would be read by
 * the worker's shell. `what` names the path in the message.
 */
export function checkedWindowsPromptPath(filePath: string, what = 'The path'): string {
  const converted = windowsPromptPath(filePath);
  if (UNSAFE_IN_DOUBLE_QUOTES.test(converted)) {
    throw new Error(`${what} ${JSON.stringify(converted)} contains a double quote, $ or a backtick, which Git Bash and PowerShell read inside double quotes; use a directory without them.`);
  }
  return converted;
}
