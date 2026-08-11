import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../ui/Icon';
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

interface MobileNavMenuProject {
  id: number;
  name: string;
  color?: string | null;
}

interface MobileNavMenuProps {
  /** カード内 選択行に出す現在プロジェクト（色ドット・名前）。Issue #338 T11 G1: カード封筒化。 */
  project: MobileNavMenuProject | null;
  /** 選択行「切替 ⌄」タップ時。従来通り MobileNavSheet 側の projectSwitch スタックへ push する。 */
  onOpenProjectSwitch: () => void;
  /** 「オブジェクト」行の右端メタ（総件数）。モック S6/M1 準拠。 */
  objectsCount: number;
  onSelectMode: (mode: SidebarMode) => void;
  onNavigateGlobal: (path: string) => void;
  /**
   * 稼働ペイン一覧。旧 ≡ ドロワーには無かった導線で、既存 MobileActiveWindowsPanel を
   * MobileNavSheet 側で直接開く（Issue #69 T1）。connectPane/openTask が揃わない
   * 呼び出し元では行自体を出さない。
   */
  onOpenActiveWindows?: () => void;
  activeWindowsCount?: number;
  activeWindowsBlockedCount?: number;
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

// プロジェクトカード（Issue #338 T11 G1: mock-s910-00 準拠）。カード面は --bg-card、内側最上段の
// 選択行は --input-bg で一段明るくして押下可能であることを示す。
const projectCardStyle: CSSProperties = {
  background: 'var(--bg-card)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-2)',
  marginBottom: 4,
};

const selectionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 40,
  padding: '0 10px',
  marginBottom: 4,
  border: 'none',
  background: 'var(--input-bg)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
  color: 'var(--text)',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 'var(--font-md)',
};

const selectionNameStyle: CSSProperties = {
  fontWeight: 600,
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const switchLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  flexShrink: 0,
  color: 'var(--text-dim)',
  fontSize: 'var(--font-xs)',
};

function selectionDotStyle(color?: string | null): CSSProperties {
  // 既存のプロジェクト色解決（WorkspaceLayout のプロジェクトアバター等）と同じく project.color を
  // そのまま使う。色未定義時は --border だと --input-bg 面でほぼ見えないため、視認できる
  // --text-dim にフォールバックする（Issue #338 T11 オーケストレーター照合フィードバック）。
  return { width: 8, height: 8, borderRadius: 'var(--radius-full)', background: color || 'var(--text-dim)', flexShrink: 0 };
}

/**
 * SP の ≡ メニュー本体（Issue #338 T11 G1: プロジェクトカード封筒化）。カード（プロジェクト内の
 * 選択行＋モード行）と AZITO 全体（サーバー/ユニット/サイドキック/稼働ペイン一覧/AZITO設定）の
 * 2区画構成。サーバーヘルス行は削除済み（P1 でフローティングピルに同梱、ServerHealthSheet 自体は
 * 起動元がピルに変わるだけで存置）。行タップの遷移（モード内容へ push・プロジェクト切替へ push・
 * 実体ナビゲーション）は呼び出し元（MobileNavSheet）のスタック管理に委ねる — このコンポーネント
 * 自体は状態を持たない。
 */
export function MobileNavMenu({
  project,
  onOpenProjectSwitch,
  objectsCount,
  onSelectMode,
  onNavigateGlobal,
  onOpenActiveWindows,
  activeWindowsCount,
  activeWindowsBlockedCount,
}: MobileNavMenuProps) {
  const { t } = useTranslation(['workspace', 'projects', 'common']);

  return (
    <div style={{ padding: '0 4px 16px' }}>
      <div style={projectCardStyle}>
        <button type="button" onClick={onOpenProjectSwitch} style={selectionRowStyle} className="glass-popover-item">
          <span aria-hidden="true" style={selectionDotStyle(project?.color)} />
          <span style={selectionNameStyle}>{project?.name || ''}</span>
          <span style={switchLabelStyle}>
            {t('workspace:mobileNav.switchLabel')}
            <Icon name="chevron-down" size={14} />
          </span>
        </button>

        {/* プロジェクト切替時、カード内容をフェードで差し替える（key で強制remountしてCSS
            アニメーションを再生。prefers-reduced-motion では global.css 側で無効化）。 */}
        <div key={project?.id ?? 'none'} className="mobile-nav-card-body">
          {PROJECT_MODE_ROWS.map((row) => (
            <button key={row.mode} type="button" onClick={() => onSelectMode(row.mode)} style={rowStyle} className="glass-popover-item">
              <Icon name={row.icon} size={16} style={rowIconStyle} />
              <span style={rowLabelStyle}>{t(row.labelKey)}</span>
              {row.mode === 'windows' && <span style={rowMetaStyle}>{objectsCount}</span>}
            </button>
          ))}
          <button type="button" onClick={() => onSelectMode('settings')} style={rowStyle} className="glass-popover-item">
            <Icon name="settings" size={16} style={rowIconStyle} />
            <span style={rowLabelStyle}>{t('workspace:sidebar.projectSettings')}</span>
          </button>
        </div>
      </div>

      <div style={sectionLabelStyle}>{t('workspace:mobileNav.sectionGlobal')}</div>
      {GLOBAL_NAV_ITEMS.map((item) => (
        <button key={item.path} type="button" onClick={() => onNavigateGlobal(item.path)} style={rowStyle} className="glass-popover-item">
          <Icon name={item.icon} size={16} style={rowIconStyle} />
          <span style={rowLabelStyle}>{t(item.labelKey)}</span>
        </button>
      ))}
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
      <button key={SETTINGS_NAV_ITEM.path} type="button" onClick={() => onNavigateGlobal(SETTINGS_NAV_ITEM.path)} style={rowStyle} className="glass-popover-item">
        <Icon name={SETTINGS_NAV_ITEM.icon} size={16} style={rowIconStyle} />
        <span style={rowLabelStyle}>{t(SETTINGS_NAV_ITEM.labelKey)}</span>
      </button>
    </div>
  );
}
