import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';

export class MuxDriverRegistry {
  private driver: IMuxClient;

  constructor(driver: IMuxClient) {
    this.driver = driver;
  }

  resolve(_server: Pick<ServerConfig, 'muxRuntime'>): IMuxClient {
    return this.driver;
  }
}
