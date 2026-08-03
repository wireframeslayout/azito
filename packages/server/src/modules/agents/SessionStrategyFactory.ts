import type { ISessionStrategy, ISessionStrategyFactory } from './SessionStrategy';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { AgentRegistry } from './registry';
import { NullSessionStrategy } from './NullSessionStrategy';

export class SessionStrategyFactory implements ISessionStrategyFactory {
  constructor(
    private registry: AgentRegistry,
    private transportFactory: TransportFactory,
  ) {}

  create(workerType: string | null): ISessionStrategy {
    if (workerType === null) return new NullSessionStrategy(null);
    const provider = this.registry.tryGet(workerType);
    if (!provider) return new NullSessionStrategy(workerType);
    return provider.createSessionStrategy({ transportFactory: this.transportFactory }) ?? new NullSessionStrategy(workerType);
  }
}
