import { paths } from '../../paths';
import type { IconName } from '../ui/Icon';

export interface GlobalNavItem {
  labelKey: string;
  icon: IconName;
  path: string;
}

/**
 * グローバル項目（サーバー/サイドキック/ユニット）の定義。デスクトップの `ProjectSidebar`
 * レール（アイコンのみ、ツールチップに labelKey を使用）と SP の `MobileNavMenu`（M1 メニュー、
 * Issue #69 T1）が同じ配列を共有する（重複定義禁止）。
 */
export const GLOBAL_NAV_ITEMS: GlobalNavItem[] = [
  { labelKey: 'projects:sidebar.servers', icon: 'servers', path: paths.servers() },
  { labelKey: 'projects:sidebar.units', icon: 'units', path: paths.units() },
  { labelKey: 'projects:sidebar.sidekicks', icon: 'sidekicks', path: paths.sidekicks() },
];

/**
 * AZITO設定はデスクトップのレールでは Azito メニュー配下の独立ボタンだが、SP の M1 メニューでは
 * グローバル節の4項目目として並ぶ（モック S6/M1 準拠）ため、単独の定数としても供給する。
 * ラベルはデスクトップの `common:navigation.settings`（「設定」）と共有せず、モック文言
 * 「AZITO設定」専用のキーを使う（SETTINGS_NAV_ITEM は SP 専用コンポーネントからのみ参照される
 * ため、デスクトップの「設定」表記には影響しない）。
 */
export const SETTINGS_NAV_ITEM: GlobalNavItem = {
  labelKey: 'workspace:mobileNav.settingsRow',
  icon: 'settings',
  path: paths.settings(),
};
