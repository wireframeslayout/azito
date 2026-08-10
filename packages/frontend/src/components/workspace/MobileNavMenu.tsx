import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../ui/Icon';
import { HealthDot, type DotLevel } from '../statusbar/HealthDot';
import { GLOBAL_NAV_ITEMS, SETTINGS_NAV_ITEM } from './globalNavItems';
import type { SidebarMode } from '../../pages/workspace/types';

interface ProjectModeRow {
  mode: SidebarMode;
  icon: IconName;
  labelKey: string;
}

const PROJECT_MODE_ROWS: ProjectModeRow[] = [
  { mode: 'windows', icon: 'windows', labelKey: 'workspace:menu.windows' },
  { mode: 'tasks', icon: 'tasks', labelKey: 'workspace:menu.tasks' },
  { mode: 'files', icon: 'files', labelKey: 'workspace:menu.files' },
  { mode: 'repos', icon: 'repos', labelKey: 'workspace:menu.repositories' },
  { mode: 'storage', icon: 'storage', labelKey: 'workspace:menu.storage' },
];

interface MobileNavMenuProps {
  /** 「オブジェクト」行の右端メタ（総件数）。モック S6/M1 準拠。 */
  objectsCount: number;
  onSelectMode: (mode: SidebarMode) => void;
  onNavigateGlobal: (path: string) => void;
  /**
   * 稼働ペイン一覧（暫定行）。旧 ≡ ドロワーには無かった導線だが、下部 MobileMenuBar の
   * 「その他」シート（MobileGlobalMenuSheet）が T6 まで残る間、M1 メニューからも同機能へ
   * 迷わず到達できるようにする一時的な追加。ServerHealthSheet（T6）実装後に見直す。
   * connectPane/openTask が揃わない呼び出し元では行自体を出さない。
   */
  onOpenActiveWindows?: () => void;
  activeWindowsCount?: number;
  activeWindowsBlockedCount?: number;
  /**
   * サーバーヘルス（暫定行）。T6 で ServerHealthSheet に置き換わるまでの間、既存の
   * ResourceDropdownContent ベースの簡易シートを MobileNavSheet 側で開く。
   */
  onOpenServerHealth: () => void;
  serverHealth?: DotLevel;
}

// モック（S6/M1）は行高36〜40px・節間の余白も詰まっている。タップターゲットは本来44pxが
// 望ましいが、行間に空き（margin/gap）を足す形では確保していない（=詰めても失われるものが
// ないため）ので、モックの視覚密度に合わせて 40px を採用する。
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  minHeight: 40,
  padding: '0 12px',
  border: 'none',
  background: 'none',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
  color: 'var(--text)',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 'var(--font-md)',
};

const rowIconStyle: CSSProperties = { color: 'var(--text-dim)' };

const sectionLabelStyle: CSSProperties = {
  fontSize: 'var(--font-2xs)',
  color: 'var(--text-dim)',
  padding: '10px 12px 2px',
  fontWeight: 600,
};

const rowLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowMetaStyle: CSSProperties = { color: 'var(--text-dim)', fontSize: 'var(--font-xs)', flexShrink: 0 };

/**
 * SP の ≡ メニュー本体（M1 リスト、Issue #69 T1）。プロジェクト／グローバル／ユーティリティの
 * 3節。行タップの遷移（モード内容へ push・プロジェクト切替へ push・実体ナビゲーション）は
 * 呼び出し元（MobileNavSheet）のスタック管理に委ねる — このコンポーネント自体は状態を持たない。
 */
export function MobileNavMenu({
  objectsCount,
  onSelectMode,
  onNavigateGlobal,
  onOpenActiveWindows,
  activeWindowsCount,
  activeWindowsBlockedCount,
  onOpenServerHealth,
  serverHealth,
}: MobileNavMenuProps) {
  const { t } = useTranslation(['workspace', 'projects', 'common']);

  return (
    <div style={{ padding: '0 4px 16px' }}>
      <div style={sectionLabelStyle}>{t('workspace:mobileNav.sectionProject')}</div>
      {PROJECT_MODE_ROWS.map((row) => (
        <button key={row.mode} type="button" onClick={() => onSelectMode(row.mode)} style={rowStyle} className="glass-popover-item">
          <Icon name={row.icon} size={16} style={rowIconStyle} />
          <span style={rowLabelStyle}>{t(row.labelKey)}</span>
          {row.mode === 'windows' && <span style={rowMetaStyle}>{objectsCount}</span>}
        </button>
      ))}

      <div style={sectionLabelStyle}>{t('workspace:mobileNav.sectionGlobal')}</div>
      {[...GLOBAL_NAV_ITEMS, SETTINGS_NAV_ITEM].map((item) => (
        <button key={item.path} type="button" onClick={() => onNavigateGlobal(item.path)} style={rowStyle} className="glass-popover-item">
          <Icon name={item.icon} size={16} style={rowIconStyle} />
          <span style={rowLabelStyle}>{t(item.labelKey)}</span>
        </button>
      ))}

      <>
          <div style={sectionLabelStyle}>{t('workspace:mobileNav.sectionUtility')}</div>
          {onOpenActiveWindows && (
            <button
              type="button"
              onClick={onOpenActiveWindows}
              style={rowStyle}
              className="glass-popover-item"
              aria-label={(activeWindowsCount ?? 0) > 0
                ? t('workspace:activeWindows.titleWithCount', { count: activeWindowsCount })
                : t('workspace:mobileNav.activePanesRow')}
            >
              {/* 「オブジェクト」行（grid アイコン）と見分けがつくよう、稼働状況を示す
                  activity（波形）系アイコンを使う。 */}
              <Icon name="operations" size={16} style={rowIconStyle} />
              <span style={rowLabelStyle}>{t('workspace:mobileNav.activePanesRow')}</span>
              {(activeWindowsCount ?? 0) > 0 && <span style={rowMetaStyle}>{activeWindowsCount}</span>}
              {(activeWindowsBlockedCount ?? 0) > 0 && (
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: 'var(--danger)', flexShrink: 0 }}
                />
              )}
            </button>
          )}
          <button type="button" onClick={onOpenServerHealth} style={rowStyle} className="glass-popover-item">
            {/* アイコン枠には常に同一の activity 系アイコンを置き、健康状態の色ドットは右端メタ
                位置へ分離する（アイコン列にドットのみが混ざると他行と不揃いになるため）。 */}
            <Icon name="chip" size={16} style={rowIconStyle} />
            <span style={rowLabelStyle}>{t('workspace:mobile.serverHealth')}</span>
            {serverHealth && <HealthDot level={serverHealth} size={10} />}
          </button>
      </>
    </div>
  );
}
