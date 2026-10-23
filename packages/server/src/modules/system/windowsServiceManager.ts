import fs from 'fs';
import path from 'path';
import type { MisaoServiceState } from '@azito/shared';
import type { HostEnv } from '../../shared/os/hostEnv';
import { decodeTaskXml, encodeTaskXml } from '../../shared/os/taskScheduler/taskDefinition';
import { SchtasksClient, type CommandSpecRunner } from '../../shared/os/taskScheduler/schtasks';
import type { LaunchdDomain, ServiceInspection, ServiceManager, ServiceSpec } from './serviceManager';

/** How long a stop gets to take effect, and how often it is checked (`/End` returns before the process is gone). */
export interface TaskSchedulerTiming {
  stopTimeoutMs: number;
  pollIntervalMs: number;
}

export const DEFAULT_TASK_SCHEDULER_TIMING: TaskSchedulerTiming = { stopTimeoutMs: 15_000, pollIntervalMs: 250 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The service of this host on Windows: one Task Scheduler task that starts at the user's logon (see `buildTaskXml`).
 *
 * `install(content)` takes the task XML. A copy of it is kept at `<home>\.azito\service\<task>.xml` (UTF-16, as schtasks
 * reads it) because `readDefinition()` is synchronous and `schtasks /Query /XML` is not; the registered task is replaced from
 * the XML, and when that fails the previous copy is put back, so a failed update leaves the old definition as it was.
 * Starting a task that is running, and stopping one that is not, do nothing (like systemctl).
 */
export class TaskSchedulerServiceManager implements ServiceManager {
  readonly kind = 'taskscheduler' as const;
  readonly templateName = undefined;
  private readonly taskName: string;
  private readonly definitionPath: string;

  constructor(private readonly client: SchtasksClient, spec: ServiceSpec, homeDir: string, private readonly timing: TaskSchedulerTiming) {
    this.taskName = spec.windowsTaskName;
    this.definitionPath = path.join(homeDir, '.azito', 'service', `${this.taskName}.xml`);
  }

  isInstalled(): boolean {
    return fs.existsSync(this.definitionPath);
  }

  readDefinition(): string | undefined {
    return fs.existsSync(this.definitionPath) ? decodeTaskXml(fs.readFileSync(this.definitionPath)) : undefined;
  }

  async install(content: string): Promise<void> {
    const previous = fs.existsSync(this.definitionPath) ? fs.readFileSync(this.definitionPath) : undefined;
    fs.mkdirSync(path.dirname(this.definitionPath), { recursive: true });
    fs.writeFileSync(this.definitionPath, encodeTaskXml(content));
    try {
      await this.client.register(this.taskName, content);
    } catch (err) {
      if (previous === undefined) fs.rmSync(this.definitionPath, { force: true });
      else fs.writeFileSync(this.definitionPath, previous);
      throw err;
    }
  }

  private async isRunning(): Promise<boolean> {
    const state = await this.client.query(this.taskName);
    return state.exists && state.running;
  }

  async start(): Promise<void> {
    if (await this.isRunning()) return;
    await this.client.start(this.taskName);
  }

  async stop(): Promise<void> {
    if (!(await this.isRunning())) return;
    await this.client.stop(this.taskName);
    const deadline = Date.now() + this.timing.stopTimeoutMs;
    while (await this.isRunning()) {
      if (Date.now() >= deadline) throw new Error(`The task "${this.taskName}" was still running ${this.timing.stopTimeoutMs}ms after /End`);
      await sleep(this.timing.pollIntervalMs);
    }
  }

  /** Stops a running task (and waits for it to be gone, since `/Run` is ignored while an instance runs), then starts it. */
  async restart(): Promise<void> {
    await this.stop();
    await this.client.start(this.taskName);
  }

  /** The registered task is already the installed definition (`install` replaces it), so making it current is a restart. */
  async reload(): Promise<void> {
    await this.restart();
  }

  async inspect(): Promise<ServiceInspection> {
    const state = await this.client.query(this.taskName);
    let result: MisaoServiceState = 'inactive';
    if (state.exists) result = state.running ? 'active' : state.failed ? 'failed' : 'inactive';
    return { state: result, domains: [] };
  }

  async state(): Promise<MisaoServiceState> {
    return (await this.inspect()).state;
  }

  async loadedDomain(): Promise<LaunchdDomain | undefined> {
    return undefined;
  }
}

/**
 * The Task Scheduler implementation of {@link ServiceManager}. Not returned by `createServiceManager` yet: Windows stays
 * `unsupported_os` there until the hub and misao are wired to it (#380 B3).
 */
export function createWindowsServiceManager(
  host: Pick<HostEnv, 'homeDir' | 'tmpDir' | 'systemRoot'>,
  spec: ServiceSpec,
  run: CommandSpecRunner,
  timing: TaskSchedulerTiming,
): ServiceManager {
  return new TaskSchedulerServiceManager(new SchtasksClient(run, host), spec, host.homeDir, timing);
}
