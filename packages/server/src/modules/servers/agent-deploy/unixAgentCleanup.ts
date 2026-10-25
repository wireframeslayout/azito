/**
 * The POSIX sh the Unix agent install sends to the host to take an agent it started back off it. Each one is a single script, run in one
 * SSH call, that prints one answer line: the check ("is this folder / process mine?") and the action it allows are never apart.
 */

export const INSTALL_ID_FILE = '~/.azito/agent/install.id';
/** Where run.sh runs the bundle from: `$HOME/.azito/agent/current` (the logical path, as `cd; pwd` prints it), which is what `node` gets as its argument. */
const ENTRY_PATH = '$HOME/.azito/agent/current/azito-agent.cjs';

/** What a process reads as, for the check and the record: the same function in both, so that they compare the same form. */
export interface NohupProcess { pid: number; startedAt: string }

/**
 * `ident <pid>` sets `st` (GONE: the process does not exist, or is a zombie that has ended; OK: it was read; UNKNOWN: it exists or may exist but could not be read),
 * `start` (Linux: `starttime` of /proc/<pid>/stat, a number with no locale; elsewhere `ps -o lstart` under LC_ALL=C) and `agent` (1 when
 * the expected entry path is one whole argument of the command line: NUL-separated on Linux, split at spaces from `ps` elsewhere).
 */
const IDENT_FUNCTION = [
  `want="${ENTRY_PATH}"`,
  'ident() {',
  '  st=UNKNOWN; start=; agent=0',
  '  if [ -r /proc/self/stat ]; then',
  '    [ -e "/proc/$1" ] || { st=GONE; return 0; }',
  '    rest=$(sed \'s/.*) //\' "/proc/$1/stat" 2>/dev/null)',
  '    start=$(printf \'%s\\n\' "$rest" | awk \'{print $20}\')',
  '    case "$rest" in Z*) st=GONE; return 0;; esac',
  '    args=$(tr \'\\0\' \'\\n\' < "/proc/$1/cmdline" 2>/dev/null)',
  '    if [ -z "$start" ] || [ -z "$args" ]; then [ -e "/proc/$1" ] || st=GONE; return 0; fi',
  '    printf \'%s\\n\' "$args" | grep -Fxq -- "$want" && agent=1',
  '    st=OK',
  '  else',
  '    out=$(LC_ALL=C ps -o pid= -p "$1" 2>/dev/null); rc=$?',
  '    if [ "$rc" -eq 1 ] && [ -z "$out" ]; then st=GONE; return 0; fi',
  '    [ "$rc" -eq 0 ] || return 0',
  '    start=$(LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null)',
  '    args=$(LC_ALL=C ps -o args= -p "$1" 2>/dev/null)',
  '    [ -n "$start" ] && [ -n "$args" ] || return 0',
  '    printf \'%s\\n\' "$args" | tr \' \' \'\\n\' | grep -Fxq -- "$want" && agent=1',
  '    st=OK',
  '  fi',
  '  return 0',
  '}',
].join('\n');

/** Prints `OK|<pid>|<start>` for the process the pid file names when it is the agent (entry path matched), otherwise `NOT_RECORDED:<why>`. */
export function buildRecordProcessScript(): string {
  return [
    IDENT_FUNCTION,
    'record() {',
    '  p=$(cat ~/.azito/agent/agent.pid 2>/dev/null)',
    '  case "$p" in ""|*[!0-9]*) echo "NOT_RECORDED:no pid file"; return 0;; esac',
    '  ident "$p"',
    '  if [ "$st" != OK ]; then echo "NOT_RECORDED:process $p is $st"; return 0; fi',
    '  if [ "$agent" != 1 ]; then echo "NOT_RECORDED:process $p does not run $want"; return 0; fi',
    '  echo "OK|$p|$start"',
    '}',
    'record',
  ].join('\n');
}

export function parseRecordedProcess(stdout: string): NohupProcess | { error: string } {
  const line = stdout.trim().split('\n').pop() ?? '';
  const m = /^OK\|(\d+)\|([\w :]+)$/.exec(line);
  if (m) return { pid: Number(m[1]), startedAt: m[2]!.trim() };
  return { error: line.startsWith('NOT_RECORDED:') ? line.slice('NOT_RECORDED:'.length) : `unexpected answer "${line}"` };
}

export type CleanupOutcome =
  | { kind: 'removed' }
  /** Another install's id is in the folder: nothing was touched. */
  | { kind: 'not_owner'; found: string }
  /** The agent could not be stopped, or its state could not be read: it and the folder are left in place. */
  | { kind: 'not_stopped'; reason: string }
  /** The agent is stopped but something could not be removed. */
  | { kind: 'not_removed'; reason: string };

/**
 * One script: the id file must hold `installId` -> stop -> confirm stopped -> remove, with no step between the check and the removal
 * that another install could use. A systemd agent is stopped as a unit (no pid). A nohup agent is stopped only when the recorded pid
 * still has the recorded start time and the entry path as an argument; a process that is gone, or is another program now, is not
 * touched and counts as the end of this agent; one that cannot be read is `UNKNOWN`, which leaves everything in place.
 */
export function buildCleanupScript(input: { installId: string; startMethod: 'systemd' | 'nohup'; process?: NohupProcess }): string {
  const removeFolder = [
    '  rm -rf ~/.azito/agent',
    '  if [ -e ~/.azito/agent ]; then echo "NOT_REMOVED:~/.azito/agent"; return 0; fi',
    '  echo REMOVED',
  ];
  const systemd = [
    '  systemctl --user stop azito-agent || { echo "NOT_STOPPED:systemctl --user stop azito-agent failed"; return 0; }',
    '  a=$(systemctl --user is-active azito-agent 2>/dev/null)',
    '  case "$a" in inactive|failed) ;; *) echo "NOT_STOPPED:the unit is still ${a:-in an unknown state} after it was stopped"; return 0;; esac',
    '  systemctl --user disable azito-agent 2>/dev/null',
    '  rm -f ~/.config/systemd/user/azito-agent.service || { echo "NOT_REMOVED:the systemd unit file"; return 0; }',
    '  systemctl --user daemon-reload 2>/dev/null',
  ];
  const nohup = input.process ? [
    `  p=${input.process.pid}; rec='${input.process.startedAt}'`,
    '  ident "$p"',
    '  case "$st" in',
    '    GONE) ;;',
    '    UNKNOWN) echo "NOT_STOPPED:process $p could not be read, so it is not stopped on a guess"; return 0;;',
    '    OK)',
    '      if [ "$start" = "$rec" ] && [ "$agent" = 1 ]; then',
    '        kill "$p" 2>/dev/null',
    '        i=0',
    '        while [ "$i" -lt 20 ]; do',
    '          ident "$p"',
    '          [ "$st" = OK ] && [ "$start" = "$rec" ] && [ "$agent" = 1 ] || break',
    '          sleep 1; i=$((i+1))',
    '        done',
    '        if [ "$st" = UNKNOWN ]; then echo "NOT_STOPPED:process $p could not be read after it was asked to stop"; return 0; fi',
    '        if [ "$st" = OK ] && [ "$start" = "$rec" ] && [ "$agent" = 1 ]; then echo "NOT_STOPPED:process $p is still running 20s after it was asked to stop"; return 0; fi',
    '      fi;;',
    '  esac',
  ] : ['  echo "NOT_STOPPED:the agent process could not be identified when it started, so it is not stopped on a guess"; return 0'];

  return [
    IDENT_FUNCTION,
    'cleanup() {',
    `  id=$(cat ${INSTALL_ID_FILE} 2>/dev/null)`,
    `  if [ "$id" != '${input.installId}' ]; then echo "NOT_OWNER:$id"; return 0; fi`,
    ...(input.startMethod === 'systemd' ? systemd : nohup),
    ...removeFolder,
    '}',
    'cleanup',
  ].join('\n');
}

export function parseCleanupOutcome(stdout: string): CleanupOutcome {
  const line = stdout.trim().split('\n').pop() ?? '';
  if (line === 'REMOVED') return { kind: 'removed' };
  if (line.startsWith('NOT_OWNER:')) return { kind: 'not_owner', found: line.slice('NOT_OWNER:'.length) };
  if (line.startsWith('NOT_STOPPED:')) return { kind: 'not_stopped', reason: line.slice('NOT_STOPPED:'.length) };
  if (line.startsWith('NOT_REMOVED:')) return { kind: 'not_removed', reason: line.slice('NOT_REMOVED:'.length) };
  return { kind: 'not_stopped', reason: `the host gave an unexpected answer "${line}"` };
}

/** The steps to stop and remove an agent by hand, for an error: what to run depends on how it was started. */
export function manualCleanupSteps(startMethod: 'systemd' | 'nohup', process?: NohupProcess): string {
  if (startMethod === 'systemd') {
    return 'systemctl --user stop azito-agent; systemctl --user is-active azito-agent (it must print inactive); systemctl --user disable azito-agent; rm -f ~/.config/systemd/user/azito-agent.service; rm -rf ~/.azito/agent';
  }
  return nohupManualSteps(process?.pid);
}

/** For an agent that was already on the host (how it was started is not known): both ways. */
export const MANUAL_STEPS_ANY_START = `If it runs as a systemd unit: systemctl --user stop azito-agent, check systemctl --user is-active azito-agent prints inactive, then systemctl --user disable azito-agent; rm -f ~/.config/systemd/user/azito-agent.service. If it was started with nohup: ${nohupManualSteps(undefined)}. Then: rm -rf ~/.azito/agent`;

function nohupManualSteps(pid: number | undefined): string {
  return `read the pid with cat ~/.azito/agent/agent.pid${pid ? ` (this install saw ${pid})` : ''}, check that the process is the agent (ps -o args= -p <pid> shows $HOME/.azito/agent/current/azito-agent.cjs as an argument), kill <pid>, check with ps -p <pid> that it is gone, then rm -rf ~/.azito/agent`;
}
