import type { HarnessInstallOptions } from './HarnessInstaller';
import type { ServerConfig } from '../Server';
import type { HostProfile } from '../../../shared/os/hostProfile';

interface HarnessInstallContext {
  webhookToken: string;
  uiToken: string;
  harnessPrefix: string;
}

export function buildHarnessInstallOptions(
  srv: ServerConfig,
  hostProfile: HostProfile | null,
  ctx: HarnessInstallContext,
  overrides: { azitoUrl: string; version?: string },
): HarnessInstallOptions {
  return {
    hostProfile,
    azitoUrl: overrides.azitoUrl,
    webhookToken: ctx.webhookToken,
    uiToken: ctx.uiToken,
    serverName: srv.name,
    prefix: ctx.harnessPrefix,
    isolationIntent: srv.isolationIntent,
    version: overrides.version,
  };
}
