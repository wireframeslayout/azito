import type { IconName } from '../ui/Icon';

export type SettingsSectionId = 'appearance' | 'providers' | 'storage' | 'resources' | 'notifications' | 'security' | 'system';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  labelKey: string;
  icon: IconName;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: 'appearance', labelKey: 'settings:sections.appearance', icon: 'palette' },
  { id: 'providers', labelKey: 'settings:sections.providers', icon: 'chip' },
  { id: 'storage', labelKey: 'settings:sections.storage', icon: 'storage' },
  { id: 'resources', labelKey: 'settings:sections.resources', icon: 'servers' },
  { id: 'notifications', labelKey: 'settings:sections.notifications', icon: 'bell' },
  { id: 'security', labelKey: 'settings:sections.security', icon: 'lock' },
  { id: 'system', labelKey: 'settings:sections.system', icon: 'settings' },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'providers';

/**
 * 永続化されたタブや旧 URL に現存しないセクション（例: 削除済みの 'phase-prompts'）が
 * 残っていても空白画面にならないよう、既知のセクション ID に正規化する。
 */
export function normalizeSettingsSection(section: string | undefined): SettingsSectionId {
  const match = SETTINGS_SECTIONS.find((s) => s.id === section);
  return match ? match.id : DEFAULT_SETTINGS_SECTION;
}
