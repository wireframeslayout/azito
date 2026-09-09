export const HOOK_EVENTS = [
  'window-linked',
  'window-unlinked',
  'after-rename-window',
  'after-kill-pane',
  'session-window-changed',
  'session-closed',
  'after-select-pane',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export const HOOK_INDEX = 42;

/** Build a tmux set-hook value string. Hub includes auth token + server param; agent omits both. */
export function buildHookValue(
  baseUrl: string,
  event: HookEvent,
  opts?: { token?: string; serverName?: string },
): string {
  const tokenHeader = opts?.token ? ` -H 'Authorization: Bearer ${opts.token}'` : '';
  const serverParam = opts?.serverName ? `&server=${encodeURIComponent(opts.serverName)}` : '';
  return `run-shell "curl -sf -o /dev/null -X POST${tokenHeader} '${baseUrl}?event=${event}${serverParam}&session=#{hook_session_name}' 2>/dev/null &"`;
}

export function buildHookSetArgs(event: HookEvent, hookValue: string): string[] {
  return ['set-hook', '-g', `${event}[${HOOK_INDEX}]`, hookValue];
}

export function buildHookUnsetArgs(event: HookEvent): string[] {
  return ['set-hook', '-gu', `${event}[${HOOK_INDEX}]`];
}
