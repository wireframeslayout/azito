import { paths } from '../../paths';
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
}

export interface InstallStatusResponse {
  tmux: InstallStatusItem;
  node: InstallStatusItem;
  aztHarness: InstallStatusItem;
  tailscale?: InstallStatusItem;
  agent?: InstallStatusItem & { versionMatch?: boolean };
  chromium?: InstallStatusItem;
}

export interface SectionSummary {
  text: string;
  textParams?: Record<string, string | number>;
  tone: 'green' | 'dim' | 'orange';
}

export function getOverviewSummary(status: ServerStatus | null): SectionSummary {
  if (!status) return { text: 'servers:status.checking', tone: 'dim' };
  if (status.status === 'online') return { text: 'servers:status.online', tone: 'green' };
  if (status.status === 'offline') return { text: 'servers:status.offline', tone: 'dim' };
  return { text: 'servers:status.error', tone: 'orange' };
}

export function getSetupSummary(installStatus: InstallStatusResponse | null): SectionSummary {
  if (!installStatus) return { text: 'servers:status.checking', tone: 'dim' };
  const items = [
    installStatus.tmux,
    installStatus.node,
    installStatus.aztHarness,
    installStatus.tailscale,
    installStatus.agent,
    installStatus.chromium,
  ].filter(Boolean);
  const missing = items.filter((i) => !i!.installed).length;
  if (missing === 0) return { text: 'servers:setup.allInstalled', tone: 'green' };
  return { text: 'servers:setup.missingCount', textParams: { count: missing }, tone: 'orange' };
}

export function getWindowsSummary(sessionCount: number, windowCount: number): SectionSummary {
  return { text: 'servers:windows.windowCountSummary', textParams: { windowCount, sessionCount }, tone: 'dim' };
}
