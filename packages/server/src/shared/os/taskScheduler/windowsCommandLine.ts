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

/**
 * The inverse of {@link joinWindowsArgs}: a command line split into arguments with the CommandLineToArgvW rules (2n backslashes
 * before a quote are n backslashes and the quote toggles quoting, 2n+1 are n backslashes and a literal quote; backslashes elsewhere
 * are literal; two quotes in a row inside quotes are one literal quote). Used to read what a task definition runs, so that an argument is compared as a whole, never as part of a longer text.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      let count = 0;
      while (line[i] === '\\') { count++; i++; }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"'; else quoted = !quoted;
      } else {
        current += '\\'.repeat(count);
        i--;
      }
      started = true;
    } else if (ch === '"') {
      // Inside quotes, two quotes in a row are ONE literal quote and quoting goes on (the rule of the C runtime since 2008): a quoted
      // `a""b` is `a"b`, and a quoted `a"""` is `a"` with the quote still open. A reader that closed the quote here would see `a` and
      // take a longer text for it.
      if (quoted && line[i + 1] === '"') { current += '"'; i++; } else { quoted = !quoted; }
      started = true;
    } else if (!quoted && /[ \t\n\v]/.test(ch)) {
      if (started) { args.push(current); current = ''; started = false; }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
