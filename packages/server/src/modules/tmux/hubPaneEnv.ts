import type { ServerConfig } from '../servers/Server';
import { ISOLATION_MASKED_ENV } from '../../shared/auth/isolationMaskedEnv';

/** Hub endpoint and credential every new pane is given, resolved once at startup (the boundary). */
export interface HubPaneEnvConfig {
  /** URL remote servers use to reach the hub. */
  publicUrl: string;
  /** Loopback URL of this hub (`http://127.0.0.1:<port>`). */
  localUrl: string;
  webhookToken: string;
}

/**
 * URL that panes on `server` should use to reach the hub.
 *
 * Panes on the hub's own machine get the loopback URL: a host does not
 * necessarily reach itself through its public address. With `tailscale serve`
 * on WSL2, for instance, the MagicDNS name resolves but the connection to the
 * host's own Tailscale IP never completes, so supervisors launched there could
 * never register and every supervised window timed out. Remote servers keep
 * the public URL, which is the only address that works for them.
 */
export function hubUrlForServer(config: HubPaneEnvConfig, server: Pick<ServerConfig, 'type'>): string {
  return server.type === 'local' ? config.localUrl : config.publicUrl;
}

/**
 * Env every new pane receives, whatever the mux driver. Isolated servers must NOT receive hub secrets
 * (isolationDoctor checks for their absence), so AZITO_WEBHOOK_TOKEN is only passed to non-isolated ones.
 * Driver-independent so that tmux (`-e`) and misao (`env` / `ephemeralEnv`) follow exactly the same rule.
 * A misao pane does not get the hub's env (only what is passed here), but it does inherit the misao daemon's own env.
 */
export function hubPaneEnv(config: HubPaneEnvConfig, server: Pick<ServerConfig, 'type' | 'isolationIntent'>): Record<string, string> {
  const env: Record<string, string> = { AZITO_URL: hubUrlForServer(config, server) };
  if (!server.isolationIntent) env.AZITO_WEBHOOK_TOKEN = config.webhookToken;
  return env;
}

/**
 * The env a new pane is created with: the hub env, then the caller's env on top, then — for an isolated server —
 * the credential mask last, so that neither a caller nor an inherited value (the daemon's or the tmux session's
 * env) can put a hub credential into an isolated pane.
 */
export function composePaneEnv(
  config: HubPaneEnvConfig,
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  return { ...hubPaneEnv(config, server), ...extra, ...(server.isolationIntent ? ISOLATION_MASKED_ENV : {}) };
}
