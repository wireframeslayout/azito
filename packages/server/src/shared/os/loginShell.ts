import os from 'os';

/**
 * The default shell of the host this process runs on: `$SHELL`, else the login shell in the passwd database (the order tmux's
 * default-shell uses). Null when neither exists (e.g. a bare container with no passwd row for the user, or Windows). It never
 * invents `/bin/sh`: the caller decides what no shell means.
 * `readPasswdShell` is injected so the lookup (which throws when the user has no passwd row) can be tested.
 */
export function resolveLoginShell(
  env: NodeJS.ProcessEnv,
  readPasswdShell: () => string | null = () => os.userInfo().shell,
): string | null {
  if (env.SHELL) return env.SHELL;
  try {
    return readPasswdShell() || null;
  } catch {
    // os.userInfo() throws when the user's uid has no passwd entry: that is "no login shell", not a failure of the caller.
    return null;
  }
}
