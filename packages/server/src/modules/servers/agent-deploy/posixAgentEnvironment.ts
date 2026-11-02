/** Fixed probe run in the target user's login shell. Banners outside the markers are ignored. */
export const POSIX_ENVIRONMENT_COMMAND = `"$SHELL" -lc '
printf "\\nAZITO_ENV_BEGIN\\n"
printf "NODE_VERSION=%s\\n" "$(node --version 2>/dev/null || true)"
printf "NODE_HOST=%s\\n" "$(node -p "process.platform.concat(String.fromCharCode(32),process.arch)" 2>/dev/null || true)"
printf "TMUX=%s\\n" "$(tmux -V 2>/dev/null || true)"
if command -v tailscale >/dev/null 2>&1; then ts=$(tailscale ip -4 2>/dev/null | head -n 1); elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then ts=$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null | head -n 1); else ts=; fi
printf "TAILSCALE=%s\\n" "$ts"
printf "\\nAZITO_ENV_END\\n"
'`;

export interface PosixAgentEnvironment {
  nodeVersion: string;
  nodeHost: string;
  tmuxVersion: string;
  tailscaleIp: string;
}

export function parsePosixAgentEnvironment(output: string): PosixAgentEnvironment {
  const match = /(?:^|\n)AZITO_ENV_BEGIN\r?\n([\s\S]*?)\nAZITO_ENV_END(?:\r?\n|$)/.exec(output);
  if (!match) throw new Error('Login shell did not return the agent environment; check $SHELL and its startup files.');
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`Login shell returned duplicate ${key} in the agent environment.`);
    values.set(key, line.slice(separator + 1));
  }
  for (const key of ['NODE_VERSION', 'NODE_HOST', 'TMUX', 'TAILSCALE']) {
    if (!values.has(key)) throw new Error(`Login shell did not return ${key} in the agent environment.`);
  }
  return { nodeVersion: values.get('NODE_VERSION')!, nodeHost: values.get('NODE_HOST')!, tmuxVersion: values.get('TMUX')!, tailscaleIp: values.get('TAILSCALE')! };
}
