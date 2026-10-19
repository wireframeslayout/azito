import type { HarnessInstallOptions } from './HarnessInstaller';
import type { ServerConfig } from '../Server';

interface HarnessInstallContext {
  webhookToken: string;
  uiToken: string;
  harnessPrefix?: string;
}

export function buildHarnessInstallOptions(
  srv: ServerConfig,
  ctx: HarnessInstallContext,
  overrides?: { azitoUrl?: string; version?: string },
): HarnessInstallOptions {
  return {
    azitoUrl: overrides?.azitoUrl,
    webhookToken: ctx.webhookToken,
    uiToken: ctx.uiToken,
    serverName: srv.name,
    prefix: ctx.harnessPrefix,
    isolationIntent: srv.isolationIntent,
    version: overrides?.version,
  };
}
