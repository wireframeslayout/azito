import { parseArgs, resolveLaunchBinding } from './cli';
import { ActivityTracker } from './ActivityTracker';
import { resolveHubEnv, resolveMuxPaneRef } from './env';
import { HubClient } from './HubClient';
import { PtyProxy, type PtyExitInfo } from './PtyProxy';
import { ReadinessGate } from './ReadinessGate';
import { ScreenStateTracker } from './ScreenStateTracker';
import { TitleStateTracker } from './TitleStateTracker';
import type { ActivityState, AgentStatus, ActivityDecidedBy } from './protocol';

const args = parseArgs(process.argv.slice(2));
const launchBinding = resolveLaunchBinding(args);

// Which rule set the screen/title trackers apply. Derived from the child
// command; a generic TUI gets no screen tracker and is decided by S2/S3 only.
const agentKind = /\bclaude\b/.test(args.command) ? 'claude' as const
  : /\bcodex\b/.test(args.command) ? 'codex' as const : null;

const hubEnv = resolveHubEnv();
// With a hub attached, delay process exit slightly so the child_exit message
// can flush over the WebSocket before the process dies.
const proxy = new PtyProxy({ exitGraceMs: hubEnv ? 150 : 0 });
const tracker = new ActivityTracker();
const titleTracker = new TitleStateTracker(agentKind ?? 'claude');
const readiness = new ReadinessGate();

const screenTracker = agentKind
  ? new ScreenStateTracker(agentKind, process.stdout.columns || 80, process.stdout.rows || 24)
  : null;

proxy.on('data', (bytes: number, data: string) => {
  tracker.record(bytes);
  // The pane title (OSC 0/2) and the screen content both flow through this
  // stream verbatim — scan the title inline (S2) and feed the headless
  // terminal (S1); either classified state takes over from the byte-volume
  // heuristic (S3), which misreads keystroke echo as activity.
  titleTracker.push(data);
  tracker.setTitleState(titleTracker.getState());
  screenTracker?.push(data);
  readiness.notifyOutput(bytes);
});
proxy.on('resize', (cols: number, rows: number) => {
  tracker.notifyResize();
  screenTracker?.resize(cols, rows);
});
// Keystrokes (and hub-injected input) make the agent repaint its input box;
// that output is echo, not work — see ActivityTracker.inputGraceMs.
proxy.on('input', () => {
  tracker.notifyInput();
});

screenTracker?.onChange((s) => tracker.setScreenState(s));

const muxPaneRef = resolveMuxPaneRef();

if (hubEnv) {
  const hub = new HubClient({
    url: hubEnv.url,
    token: hubEnv.token,
    register: {
      serverName: args.server,
      target: args.target,
      taskId: args.taskId ?? null,
      unitId: args.unitId ?? null,
      pid: process.pid,
      childCommand: args.command,
      ...(launchBinding.launchId !== null ? { launchId: launchBinding.launchId } : {}),
      ...(launchBinding.bootstrapToken !== null ? { bootstrapToken: launchBinding.bootstrapToken } : {}),
      ...(muxPaneRef ? { muxPaneRef } : {}),
    },
    write: (data) => proxy.write(data),
    readiness,
    activitySnapshot: () => tracker.getSnapshot(),
  });
  tracker.on('transition', (state: ActivityState, bytesInWindow: number, status?: AgentStatus, decidedBy?: ActivityDecidedBy) => {
    hub.sendActivity(state, bytesInWindow, status, decidedBy);
  });
  proxy.on('exit', (info: PtyExitInfo) => {
    hub.sendChildExit(info.exitCode, info.signal);
  });
  readiness.onReady(() => hub.sendReady());
  hub.connect();
} else {
  process.stderr.write(
    'tui-supervisor: AZITO_URL/AZITO_WEBHOOK_TOKEN not resolved; running pass-through without hub connection\n',
  );
}

tracker.start();
proxy.start(args.command);
