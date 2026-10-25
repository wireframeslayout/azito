/**
 * The Windows command line that the Task Scheduler `<Arguments>` element holds is ONE string; the program splits it
 * with CommandLineToArgvW rules (what the MSVC runtime and Node follow). This is the only place that builds that string.
 * Quoting cannot protect `%VAR%`, which the Task Scheduler expands itself: `buildTaskXml` refuses a `%`.
 */

/** One argument as it must appear inside a Windows command line so that CommandLineToArgvW gives back exactly `arg`. */
export function quoteWindowsArg(arg: string): string {
  if (arg.includes('\0')) throw new Error('A command-line argument must not contain a NUL byte');
  if (arg !== '' && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      // Backslashes before a quote are doubled, then the quote itself is escaped.
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  // Backslashes before the closing quote are doubled so that they do not escape it.
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

export function joinWindowsArgs(args: readonly string[]): string {
  return args.map(quoteWindowsArg).join(' ');
}
