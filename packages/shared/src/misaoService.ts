/** State of the `azito-misao` service (systemd user unit / launchd agent) as its manager reports it. */
export type MisaoServiceState = 'active' | 'inactive' | 'failed' | 'unknown';

/** Why this hub cannot install or update misao itself. */
export type MisaoUnmanagedReason =
  /** A source checkout (`npm run dev`): it connects to MISAO_SOCKET / the default socket and never installs a service. */
  | 'source_install'
  /** A release without a bundled misao. */
  | 'no_bundled_misao'
  /** A host without systemd or launchd. */
  | 'unsupported_platform'
  /** The install prefix cannot host the daemon's socket (the path is too long for a unix socket). */
  | 'invalid_prefix';

/** How the hub's `.env` points MISAO_SOCKET relative to the managed socket. */
export type MisaoSocketSetting = 'unset' | 'managed' | 'custom';

/** The daemon as the hub (or the CLI) sees it right now. */
export interface MisaoDaemonInfo {
  reachable: boolean;
  /** The daemon's release version (`server.info` `version`); absent from a daemon that predates the field. */
  version?: string;
  protocolVersion?: string;
  /** Why it is not usable: `daemon_unreachable`, `protocol_incompatible`, or an error message. */
  detail?: string;
}

/** What `GET /api/system/misao` reports: the managed misao service, the bundled release and the running daemon. */
export interface MisaoServiceStatus {
  /** True when this hub can install and update the service (a release with a bundled misao on systemd / launchd). */
  managed: boolean;
  unmanagedReason?: MisaoUnmanagedReason;
  /** The concrete error behind `unmanagedReason` when there is one (`invalid_prefix`). */
  unmanagedDetail?: string;
  serviceManager?: 'systemd' | 'launchd';
  /** The unit / plist file exists. */
  serviceInstalled: boolean;
  serviceState?: MisaoServiceState;
  /** The misao release bundled with this hub. */
  bundledVersion?: string;
  /** The version `misao/current` points at; absent when nothing is installed. */
  installedVersion?: string;
  daemon: MisaoDaemonInfo;
  /** The socket the managed service listens on. */
  socketPath?: string;
  socketSetting: MisaoSocketSetting;
  /** The managed service is installed and the hub's `.env` names its socket, but this hub process still uses another one. */
  needsHubRestart: boolean;
  /** The running daemon is not the bundled release (older, newer or incompatible): an explicit update would switch it. */
  updateAvailable: boolean;
}
