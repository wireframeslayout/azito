import type { WorkerRuntime } from '../../../units/Unit';
import type { IWorkerRuntime } from './IWorkerRuntime';

export class WorkerRuntimeRegistry {
  private runtimes = new Map<string, IWorkerRuntime>();

  register(runtime: WorkerRuntime, impl: IWorkerRuntime): void {
    this.runtimes.set(runtime, impl);
  }

  get(runtime: WorkerRuntime): IWorkerRuntime {
    const impl = this.runtimes.get(runtime);
    if (impl) return impl;
    if (runtime === 'headless' || runtime === 'api') {
      throw new Error(`WorkerRuntime "${runtime}" is not implemented yet`);
    }
    throw new Error(`Unknown worker runtime: "${runtime}"`);
  }
}
