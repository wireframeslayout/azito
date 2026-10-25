/**
 * The POSIX sh the Unix agent install sends to the host to take an agent it started back off it, and the text it gives the operator when
 * it does not.
 *
 * Only an agent started as a systemd unit is stopped and removed automatically: a unit is named, so it can be stopped by name with
 * nothing to identify. A nohup agent (a host without a systemd user instance, or macOS) is a bare process behind a pid file, and a pid
 * is not an identity (it is reused once the process ends). Checking it would take per-OS process inspection (/proc, `ps` and its
 * output formats) that this change cannot test everywhere, so it is not stopped and not removed: it is reported, with what was seen
 * when it started, for the operator to stop and check by hand.
 */

export const INSTALL_ID_FILE = '~/.azito/agent/install.id';
/** The entry the agent runs (run.sh `exec`s node on it), as it appears among the process's arguments. */
export const AGENT_ENTRY_PATH = '$HOME/.azito/agent/current/azito-agent.cjs';

/** Longest the cleanup script may take: `systemctl --user stop` waits for the unit's own stop timeout (90s by default). */
export const CLEANUP_TIMEOUT_MS = 120_000;

/**
 * The mark a running cleanup keeps on the host: a directory holding the script's pid. It lives outside `~/.azito/agent` (which the
 * cleanup removes) and is the exclusion that outlasts the SSH connection: when a call times out or drops, the script may still be
 * running on the host, and the hub, which has lost sight of it, must not let another install start until the mark is gone.
 */
export const CLEANUP_LOCK_DIR = '~/.azito/agent-cleanup.lock';

export type CleanupOutcome =
  | { kind: 'removed' }
  /** Another cleanup holds the mark (or the mark could not be made): nothing was touched. */
  | { kind: 'busy' }
  /** Another install's id is in the folder: nothing was touched. */
  | { kind: 'not_owner'; found: string }
  /** The unit could not be stopped: it and the folder are left in place. */
  | { kind: 'not_stopped'; reason: string }
  /** The unit is stopped but something could not be removed. */
  | { kind: 'not_removed'; reason: string };

/**
 * One script: the folder must hold `installId` -> stop the unit -> confirm it is not running -> remove, with nothing between the check
 * and the removal for another install to use. It is safe to run under `sh -e`: every command whose failure is an answer is tested.
 * (`systemctl is-active` exits non-zero, 3, for `inactive`: that is the answer being looked for, not a failure.)
 */
export function buildCleanupScript(installId: string): string {
  return [
    'cleanup() {',
    // The mark first: if it cannot be made, nothing else is done. It is removed however the script ends (a signal included).
    `  if ! mkdir ${CLEANUP_LOCK_DIR} 2>/dev/null; then echo BUSY; return 0; fi`,
    `  trap 'rm -rf ${CLEANUP_LOCK_DIR}' EXIT`,
    "  trap 'exit 1' HUP INT TERM",
    `  echo $$ > ${CLEANUP_LOCK_DIR}/pid`,
    `  id=$(cat ${INSTALL_ID_FILE} 2>/dev/null || true)`,
    `  if [ "$id" != '${installId}' ]; then echo "NOT_OWNER:$id"; return 0; fi`,
    '  if ! systemctl --user stop azito-agent; then echo "NOT_STOPPED:systemctl --user stop azito-agent failed"; return 0; fi',
    '  a=',
    '  if a=$(systemctl --user is-active azito-agent 2>/dev/null); then :; fi',
    '  case "$a" in inactive|failed) ;; *) echo "NOT_STOPPED:the unit is still ${a:-in an unknown state} after it was stopped"; return 0;; esac',
    '  systemctl --user disable azito-agent 2>/dev/null || true',
    '  if ! rm -f ~/.config/systemd/user/azito-agent.service; then echo "NOT_REMOVED:the systemd unit file"; return 0; fi',
    '  systemctl --user daemon-reload 2>/dev/null || true',
    '  rm -rf ~/.azito/agent || true',
    '  if [ -e ~/.azito/agent ]; then echo "NOT_REMOVED:~/.azito/agent"; return 0; fi',
    '  echo REMOVED',
    '}',
    'cleanup',
  ].join('\n');
}

export function parseCleanupOutcome(stdout: string): CleanupOutcome {
  const line = stdout.trim().split('\n').pop() ?? '';
  if (line === 'REMOVED') return { kind: 'removed' };
  if (line === 'BUSY') return { kind: 'busy' };
  if (line.startsWith('NOT_OWNER:')) return { kind: 'not_owner', found: line.slice('NOT_OWNER:'.length) };
  if (line.startsWith('NOT_STOPPED:')) return { kind: 'not_stopped', reason: line.slice('NOT_STOPPED:'.length) };
  if (line.startsWith('NOT_REMOVED:')) return { kind: 'not_removed', reason: line.slice('NOT_REMOVED:'.length) };
  return { kind: 'not_stopped', reason: `the host gave an unexpected answer "${line}"` };
}

/**
 * Looks at the cleanup mark and prints one line: `AZITO_CLEANUP_MARK:<pid>:<alive|ended|unknown>` when the mark exists, otherwise (with
 * `thenPrint`, the shell that follows prints its own answer; without it the line is `AZITO_CLEANUP_IDLE`). A mark stops the caller
 * whether its pid is alive or not, and is never removed here: a dead pid does not prove the script finished its work (the pid may be
 * a different process, and the reading and the removal would be two steps another cleanup can slip between), so a person looks and
 * removes it. `unknown`: the mark has no pid yet.
 */
export function buildCleanupGuardScript(thenPrint?: string): string {
  return [
    `l=${CLEANUP_LOCK_DIR}`,
    'if [ -d "$l" ]; then',
    '  p=$(cat "$l/pid" 2>/dev/null || true)',
    '  s=unknown',
    '  if [ -n "$p" ]; then if kill -0 "$p" 2>/dev/null; then s=alive; else s=ended; fi; fi',
    '  echo "AZITO_CLEANUP_MARK:${p:-none}:$s"',
    thenPrint ? `else ${thenPrint}` : 'else echo AZITO_CLEANUP_IDLE',
    'fi',
  ].join('\n');
}

export interface CleanupMark { pid: string; state: 'alive' | 'ended' | 'unknown' }

/** Parses the guard's line: the mark that is on the host, or undefined when there is none; an unexpected answer throws. */
export function parseCleanupGuard(stdout: string, idle: (line: string) => boolean): CleanupMark | undefined {
  const line = stdout.trim().split('\n').pop() ?? '';
  const m = /^AZITO_CLEANUP_MARK:(\S+):(alive|ended|unknown)$/.exec(line);
  if (m) return { pid: m[1]!, state: m[2] as CleanupMark['state'] };
  if (idle(line)) return undefined;
  throw new Error(`the host gave an unexpected answer "${line}" when asked whether a cleanup is running`);
}

export function cleanupMarkMessage(host: string, mark: CleanupMark): string {
  const seen = mark.state === 'alive' ? `its pid ${mark.pid} is alive: a cleanup is still running`
    : mark.state === 'ended' ? `its pid ${mark.pid} has ended: the cleanup stopped, but may not have finished its work`
      : 'it holds no pid yet';
  // Without a pid the cleanup may be paused between making the mark and writing its pid: removing the mark then lets it resume
  // over a newer install. So the operator first makes sure no cleanup script is left on the host, whatever the pid says.
  const check = mark.state === 'unknown'
    ? `read ${CLEANUP_LOCK_DIR}/pid again (the cleanup writes it right after making the mark) and check it with kill -0; if there is still no pid, make sure no cleanup script of the agent is left running on ${host} (for example: pgrep -u "$(id -u)" -f agent-cleanup.lock prints nothing) before going on`
    : `check with kill -0 ${mark.pid} that it has ended`;
  return `The mark ${CLEANUP_LOCK_DIR} of a previous cleanup of the agent on ${host} is still there (${seen}), so nothing was changed. Do not remove the mark or retry until that cleanup has ended: on ${host}, ${check}, look at ~/.azito/agent and the azito-agent unit if you need to, then remove the mark: rm -rf ${CLEANUP_LOCK_DIR}`;
}

/** What a nohup agent looked like right after it started. Information for the operator: nothing is decided on it. */
export interface NohupSighting { pid: string; startedAt: string }

/** Prints `<pid>|<start>` of the process the pid file names (the start time as `ps` prints it, or empty), or nothing. */
export function buildNohupSightingScript(): string {
  return [
    'p=$(cat ~/.azito/agent/agent.pid 2>/dev/null || true)',
    'case "$p" in ""|*[!0-9]*) exit 0;; esac',
    's=$(LC_ALL=C ps -o lstart= -p "$p" 2>/dev/null || true)',
    'echo "$p|$s"',
  ].join('\n');
}

export function parseNohupSighting(stdout: string): NohupSighting | undefined {
  const m = /^(\d+)\|(.*)$/.exec(stdout.trim().split('\n').pop() ?? '');
  return m ? { pid: m[1]!, startedAt: m[2]!.trim() } : undefined;
}

const NOHUP_CHECK_AND_STOP = `The pid file is ~/.azito/agent/agent.pid, but a pid can be reused: check that the process is the agent (ps -o args= -p <pid> shows ${AGENT_ENTRY_PATH} as an argument, and ps -o lstart= -p <pid> matches the start time if you have one), then kill <pid> and check with ps -p <pid> that it is gone`;


/** The steps to stop and remove a nohup agent by hand (it is never stopped automatically), with what was seen when it started. */
export function nohupManualSteps(sighting: NohupSighting | undefined): string {
  const seen = sighting
    ? `when it started the pid was ${sighting.pid}${sighting.startedAt ? ` and the process started at "${sighting.startedAt}"` : ''}`
    : 'its pid could not be read when it started';
  return `${seen}. ${NOHUP_CHECK_AND_STOP}, then rm -rf ~/.azito/agent`;
}


/** The steps for the systemd unit, when the script could not finish. */
export const SYSTEMD_MANUAL_STEPS = 'systemctl --user stop azito-agent; systemctl --user is-active azito-agent (it must print inactive); systemctl --user disable azito-agent; rm -f ~/.config/systemd/user/azito-agent.service; rm -rf ~/.azito/agent';

/** For an agent that was already on the host (how it was started is not known): both ways. */
export const MANUAL_STEPS_ANY_START = `If it runs as a systemd unit: systemctl --user stop azito-agent, check systemctl --user is-active azito-agent prints inactive, then systemctl --user disable azito-agent; rm -f ~/.config/systemd/user/azito-agent.service. If it was started with nohup: ${NOHUP_CHECK_AND_STOP}. Then: rm -rf ~/.azito/agent`;
