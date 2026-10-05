import { paths } from '../../paths';
import type { TFunction } from 'i18next';
import type { ServerStatus } from '../../hooks/useServerManagement';

export type { ServerStatus } from '../../hooks/useServerManagement';

export type ServerSectionId = 'overview' | 'setup' | 'windows' | 'danger';

export interface ServerSection {
  id: ServerSectionId;
  labelKey: string;
  icon: string;
  danger?: boolean;
}

export const SERVER_SECTIONS: ServerSection[] = [
  { id: 'overview', labelKey: 'servers:sections.overview', icon: '▦' },
  { id: 'setup', labelKey: 'servers:sections.setup', icon: '⚙' },
  { id: 'windows', labelKey: 'servers:sections.windows', icon: '❯_' },
  { id: 'danger', labelKey: 'servers:sections.danger', icon: '⚠', danger: true },
];

export const DEFAULT_SECTION: ServerSectionId = 'overview';

export function serverSectionPath(name: string, section: ServerSectionId): string {
  return paths.server(name, section);
}

export interface InstallStatusItem {
  installed: boolean;
  version?: string;
  detail?: string;
  /** The server does not need this component (e.g. tmux on a server whose default mux is misao). */
  optional?: boolean;
  /** misao only: the daemon's release version (`version` is its protocol version). */
  daemonVersion?: string;
}

export interface InstallStatusResponse {
  /** Present for tmux servers; misao servers report `misao` instead. */
  tmux?: InstallStatusItem;
  misao?: InstallStatusItem;
  node: InstallStatusItem;
  aztHarness: InstallStatusItem;
  tailscale?: InstallStatusItem;
  agent?: InstallStatusItem & { versionMatch?: boolean };
  chromium?: InstallStatusItem;
}

const MISAO_DETAIL_KEYS: Record<string, string> = {
  daemon_unreachable: 'overview.misaoUnreachable',
  protocol_incompatible: 'overview.misaoIncompatible',
  driver_not_registered: 'overview.misaoDriverNotRegistered',
};

/** Turns the server's machine-readable misao status into what StepRow prints (protocol label, readable detail). */
export function describeMisaoItem(item: InstallStatusItem, t: TFunction): InstallStatusItem {
  const detailKey = item.detail ? MISAO_DETAIL_KEYS[item.detail] : undefined;
  return {
    ...item,
    version: [item.daemonVersion, item.version ? t('setup.misaoProtocol', { version: item.version }) : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' · ') || undefined,
    detail: detailKey ? t(detailKey) : item.detail,
  };
}

export interface SectionSummary {
  text: string;
  textParams?: Record<string, string | number>;
  tone: 'green' | 'dim' | 'orange' | 'red';
}

export function getOverviewSummary(status: ServerStatus | null): SectionSummary {
  if (!status) return { text: 'servers:status.checking', tone: 'dim' };
  if (status.status === 'online') return { text: 'servers:status.online', tone: 'green' };
  if (status.status === 'offline') return { text: 'servers:status.offline', tone: 'dim' };
  return { text: 'servers:status.error', tone: 'orange' };
}

export function getSetupSummary(installStatus: InstallStatusResponse | null, installStatusError: 'offline' | 'failed' | null = null): SectionSummary {
  if (!installStatus && installStatusError === 'offline') return { text: 'servers:setup.offline', tone: 'orange' };
  if (!installStatus && installStatusError === 'failed') return { text: 'servers:setup.checkFailed', tone: 'red' };
  if (!installStatus) return { text: 'servers:status.checking', tone: 'dim' };
  const items = [
    installStatus.tmux,
    installStatus.misao,
    installStatus.node,
    installStatus.aztHarness,
    installStatus.tailscale,
    installStatus.agent,
    installStatus.chromium,
  ].filter(Boolean);
  const missing = items.filter((i) => !i!.installed && !i!.optional).length;
  if (missing === 0) return { text: 'servers:setup.allInstalled', tone: 'green' };
  return { text: 'servers:setup.missingCount', textParams: { count: missing }, tone: 'orange' };
}

export function getWindowsSummary(sessionCount: number, windowCount: number): SectionSummary {
  return { text: 'servers:windows.windowCountSummary', textParams: { windowCount, sessionCount }, tone: 'dim' };
}
