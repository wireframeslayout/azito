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
  { labelKey: 'projects:sidebar.sidekicks', icon: 'sidekicks', path: paths.sidekicks() },
  { labelKey: 'projects:sidebar.units', icon: 'units', path: paths.units() },
];

/**
 * AZITO設定はデスクトップのレールでは Azito メニュー配下の独立ボタンだが、SP の M1 メニューでは
 * グローバル節の4項目目として並ぶ（モック S6/M1 準拠）ため、単独の定数としても供給する。
 */
export const SETTINGS_NAV_ITEM: GlobalNavItem = {
  labelKey: 'common:navigation.settings',
  icon: 'settings',
  path: paths.settings(),
};
