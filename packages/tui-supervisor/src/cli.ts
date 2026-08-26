export interface CliArgs {
  server: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
  command: string;
  /** Issue #28 Phase C launch binding (design v3 §8) — both optional, absent for a manual `azs`. */
  launchId: string | null;
  bootstrapToken: string | null;
}

const USAGE =
  'Usage: tui-supervisor --server <name> --target <target> [--task-id <n>] [--unit-id <n>] ' +
  '[--launch-id <id> --bootstrap-token <token>] -- <command...>\n' +
  '  (launch binding is now normally passed via AZITO_SUPERVISOR_LAUNCH_ID/AZITO_SUPERVISOR_BOOTSTRAP ' +
  'env vars; the flags above remain accepted for backward compatibility)';

/**
 * Parses argv into supervisor options + the wrapped command. Everything after
 * `--` is joined back into a single shell command string (so `-lc <cmd>` keeps
 * quoting/pipes/etc. intact when PtyProxy spawns it).
 */
export function parseArgs(argv: string[]): CliArgs {
  const sepIndex = argv.indexOf('--');
  if (sepIndex === -1 || sepIndex === argv.length - 1) {
    fail('missing "-- <command...>"');
  }

  const flagArgs = argv.slice(0, sepIndex);
  const command = argv.slice(sepIndex + 1).join(' ');

  let server: string | undefined;
  let target: string | undefined;
  let taskId: number | null = null;
  let unitId: number | null = null;
  let launchId: string | null = null;
  let bootstrapToken: string | null = null;

  for (let i = 0; i < flagArgs.length; i += 1) {
    const flag = flagArgs[i];
    const value = flagArgs[i + 1];
    switch (flag) {
      case '--server':
        server = value;
        i += 1;
        break;
      case '--target':
        target = value;
        i += 1;
        break;
      case '--task-id':
        taskId = parseNumericFlag(flag, value);
        i += 1;
        break;
      case '--unit-id':
        unitId = parseNumericFlag(flag, value);
        i += 1;
        break;
      case '--launch-id':
        if (value === undefined) fail(`${flag} requires a value`);
        launchId = value;
        i += 1;
        break;
      case '--bootstrap-token':
        if (value === undefined) fail(`${flag} requires a value`);
        bootstrapToken = value;
        i += 1;
        break;
      default:
        fail(`unknown flag: ${flag}`);
    }
  }

  if (!server) fail('missing --server');
  if (!target) fail('missing --target');
  if (!command) fail('empty command after --');

  return { server: server!, target: target!, taskId, unitId, command, launchId, bootstrapToken };
}

/**
 * Resolves the launch binding (launchId + bootstrapToken), preferring the
 * `AZITO_SUPERVISOR_LAUNCH_ID`/`AZITO_SUPERVISOR_BOOTSTRAP` env vars over the
 * legacy `--launch-id`/`--bootstrap-token` argv flags.
 *
 * The hub (`wrapWithSupervisor()` in packages/server/src/modules/supervisors/
 * SupervisorLaunch.ts) now emits the binding as env vars prefixed onto the
 * command line, not as flags — a pre-Issue-#28 supervisor binary's strict
 * argv parser dies on any unrecognized flag, so `--launch-id`/
 * `--bootstrap-token` could brick every agent window launch during a
 * hub-ahead-of-supervisor update window. The flags are still parsed above
 * and read here as a fallback, purely for the reverse direction: an
 * already-typed command from a hub that has not yet picked up this change.
 * Both sources are never mixed — env wins outright when both of its vars are
 * present.
 */
export function resolveLaunchBinding(
  args: Pick<CliArgs, 'launchId' | 'bootstrapToken'>,
  env: NodeJS.ProcessEnv = process.env,
): { launchId: string | null; bootstrapToken: string | null } {
  const envLaunchId = env.AZITO_SUPERVISOR_LAUNCH_ID;
  const envBootstrapToken = env.AZITO_SUPERVISOR_BOOTSTRAP;
  if (envLaunchId !== undefined && envBootstrapToken !== undefined) {
    return { launchId: envLaunchId, bootstrapToken: envBootstrapToken };
  }
  return { launchId: args.launchId, bootstrapToken: args.bootstrapToken };
}

function parseNumericFlag(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isInteger(n)) {
    fail(`${flag} requires an integer value`);
  }
  return n;
}

function fail(reason: string): never {
  process.stderr.write(`tui-supervisor: ${reason}\n${USAGE}\n`);
  process.exit(2);
}
