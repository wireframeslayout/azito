import { parseArgs, resolveLaunchBinding } from './cli';
import { ActivityTracker } from './ActivityTracker';
import { resolveHubEnv } from './env';
import { HubClient } from './HubClient';
import { PtyProxy, type PtyExitInfo } from './PtyProxy';
import { ReadinessGate } from './ReadinessGate';
import { TitleStateTracker } from './TitleStateTracker';
import type { ActivityState, AgentStatus } from './protocol';

const args = parseArgs(process.argv.slice(2));
const launchBinding = resolveLaunchBinding(args);

const hubEnv = resolveHubEnv();
// With a hub attached, delay process exit slightly so the child_exit message
// can flush over the WebSocket before the process dies.
const proxy = new PtyProxy({ exitGraceMs: hubEnv ? 150 : 0 });
const tracker = new ActivityTracker();
const titleTracker = new TitleStateTracker();
const readiness = new ReadinessGate();
proxy.on('data', (bytes: number, data: string) => {
  tracker.record(bytes);
  // The pane title (OSC 0/2) flows through this stream verbatim — scan it
  // inline and let a classified title state take over from the byte-volume
  // heuristic (which misreads keystroke echo as activity).
  titleTracker.push(data);
  tracker.setTitleState(titleTracker.getState());
  readiness.notifyOutput(bytes);
});
proxy.on('resize', () => {
  tracker.notifyResize();
});

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
      // Issue #28 Phase C launch binding (design v3 §8) — both null for a
      // manual `azs` invocation (no launch env vars/flags), in which case
      // the hub registers this connection as unbound. Resolved via
      // `resolveLaunchBinding()`: env vars (current hub shape) take
      // precedence over the legacy `--launch-id`/`--bootstrap-token` flags.
      ...(launchBinding.launchId !== null ? { launchId: launchBinding.launchId } : {}),
      ...(launchBinding.bootstrapToken !== null ? { bootstrapToken: launchBinding.bootstrapToken } : {}),
    },
    write: (data) => proxy.write(data),
    readiness,
    activitySnapshot: () => tracker.getSnapshot(),
  });
  tracker.on('transition', (state: ActivityState, bytesInWindow: number, status?: AgentStatus) => {
    hub.sendActivity(state, bytesInWindow, status);
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
