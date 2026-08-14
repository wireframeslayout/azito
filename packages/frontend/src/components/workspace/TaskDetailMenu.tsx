import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Icon } from '../ui/Icon';
import { AgentIcon } from '../ui/AgentIcons';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import { isSameWindowTarget } from '../../utils/tmuxTarget';
import StatusDropdown from '../task/StatusDropdown';
import type { Task, Window } from '../../pages/workspace/types';

export interface TaskDetailMenuAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** 「その他の操作」サブビューの「取り扱い注意」節へ回す（未指定＝先頭の通常項目群）。
   * T1 ハブ&スポーク再設計（Issue #338）: 実行/停止は onExecute/onStop に分離済みのため、
   * この配列は編集・アーカイブ/復元・削除の3項目のみを想定する。 */
  caution?: boolean;
}

interface TaskDetailMenuProps {
  open: boolean;
  onClose: () => void;
  task: Task;
  unitName?: string | null;
  hasUnit: boolean;
  /** 「その他の操作」サブビューに並ぶタスク全体アクション（編集・アーカイブ/復元・削除）。
   * 実行・停止は onExecute/onStop（プライマリアクション行）へ分離済み。 */
  actions: TaskDetailMenuAction[];
  /** プライマリアクション行「実行」。呼び出し元で hasUnit/unit/status を判定し、無効時は
   * canExecute=false のうえで no-op な onExecute を渡す（Issue #338 T1）。 */
  onExecute: () => void;
  canExecute: boolean;
  /** プライマリアクション行「停止」。onExecute と同様の契約。 */
  onStop: () => void;
  canStop: boolean;
  /** コミット履歴/差分の件数取得先（Task Git タブ・DiffViewer と同じサーバー/パス解決）。
   * どちらか欠けている場合、行自体を表示しない（既存の availableFixedViews と同じ条件）。 */
  diffPath?: string | null;
  diffServerName?: string;
  browserCount: number;
  /** ブラウザが1つだけのときの行タイトル（URL/ページタイトル由来、TaskPanel の browserLabel と
   * 同じ解決）。複数ブラウザ時はブラウザ数の簡易表示にフォールバックする。 */
  browserTabLabel?: string | null;
  onStatusChange: (status: string) => void;
  onOpenDescription: () => void;
  onOpenUnit: () => void;
  onOpenCommits: () => void;
  onOpenDiff: () => void;
  onOpenBrowser: () => void;
  /** ブラウザ削除（Issue #338 T10 #2）。ブラウザが1つだけのときに行の右端へ削除アイコンを
   * 出す「薄い」実装 — 複数ある場合はこの行から「ブラウザ」フルスクリーン表示へ遷移し、
   * その中の一覧（MobileBrowserContentHeader、各行 ✕ 実装済み）から個別に削除させる。
   * 省略時は count===1 でも削除アイコンを出さない。 */
  onDeleteBrowser?: () => void;
  isPinned: boolean;
  onTogglePin: () => void;
  onCloseTab: () => void;
  /** タスクの全ウィンドウ（Issue #69 T8a）。「ウィンドウとブラウザ」節が空なら描かない。 */
  windows: Window[];
  /** 現在コンテンツ表示中（または最終アクティブ）のウィンドウ — 該当行に ✓ を出す。 */
  focusedWindowTarget: { serverName: string; target: string } | null;
  /** 行タップ: メニューを閉じ、そのウィンドウのコンテンツ（端末/チャットは localStorage 記憶
   * モード）を表示する。実際の表示切替は呼び出し元（TaskPanel の handleMobileSelect）が担う。 */
  onSelectWindow: (serverName: string, target: string) => void;
  /** 行の長押し（500ms）: デスクトップと同じウィンドウ操作コンテキストメニューをタッチ座標に
   * 表示する（Issue #338 T10）。省略時は長押しを効かせない。 */
  onLongPressWindow?: (x: number, y: number, w: Window) => void;
  /** 行右端の削除アイコン（44px タップ域・danger）: 長押しを知らないユーザーでも削除できる
   * 明示的な導線（Issue #338 T10）。呼び出し元が確認ダイアログ込みの既存削除フローを担う。
   * 省略時は削除アイコンを出さない。 */
  onDeleteWindow?: (w: Window) => void;
  /** ＋「ウィンドウを追加」チップ（既存 AddWindow 導線）。省略時はチップ自体を出さない。 */
  onOpenAddWindow?: () => void;
  /** ＋「ブラウザを追加」チップ（Issue #338 T9 #3）。タスク配下に新規ブラウザインスタンスを作成し、
   * メニューを閉じてそのブラウザへ切り替える（実際の作成/切替は呼び出し元が担う）。省略時
   * （サーバーを解決できない等）はチップ自体を出さない。 */
  onAddBrowser?: () => void;
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 48,
  padding: '0 8px 0 16px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const sectionLabelStyle: CSSProperties = {
  padding: '16px 16px 4px',
  fontSize: 'var(--font-2xs)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-dim)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  minHeight: 46,
  padding: '0 16px',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  color: 'var(--text)',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 'var(--font-md)',
};

const iconBtnStyle: CSSProperties = {
  width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'none', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
};

// 淡色ドット（非稼働ウィンドウの既定グリフ）。BlockedDot（琥珀=承認待ち）と紛れないよう
// 別トークン（--text-dim）を使う — 稼働中は windowIndicator が 'blocked' を返せば呼び出し側で
// BrailleSpinner に切り替える（承認待ちも「動いている」表現として尊重、Issue #69 T8a）。
function IdleDot() {
  return (
    <span
      aria-hidden="true"
      style={{ width: 6, height: 6, borderRadius: 'var(--radius-full)', background: 'var(--text-dim)', flexShrink: 0, opacity: 0.6 }}
    />
  );
}

function WindowMenuRow({ w, isCurrent, onSelect, onLongPress, onDelete }: {
  w: Window;
  isCurrent: boolean;
  onSelect: () => void;
  /** 長押し（タッチ座標）: デスクトップと同じコンテキストメニューを開く。省略時は長押し無効。 */
  onLongPress?: (x: number, y: number) => void;
  /** 右端の削除アイコン。省略時はアイコン自体を出さない。 */
  onDelete?: () => void;
}) {
  const { t } = useTranslation('workspace');
  // windowIndicator は「現在フォーカス中のウィンドウの表示抑制」+ activityKey の完全一致照合の
  // ため、表示中の稼働ウィンドウが待機ドットに誤判定される（Issue #338 レビュー指摘）。この節は
  // 抑制不要な単純な稼働状態表示なので、抑制なし・pane サフィックス正規化済みの activityStatus
  // を使う。
  const { activityStatus } = useAgentActivity();
  const status = activityStatus(w.serverName, w.tmuxTarget);
  const isWorking = status === 'working' || status === 'blocked';
  const bindLongPress = useLongPress();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`row-hover${isWorking ? ' aw-row-working' : ''}`}
      style={{ ...rowStyle, justifyContent: 'flex-start', gap: 10, cursor: 'pointer', ...(onLongPress ? longPressStyle : {}) }}
      {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y)) : {})}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, flexShrink: 0 }}>
        {isWorking ? <BrailleSpinner /> : <IdleDot />}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
        <AgentIcon workerType={w.workerType} windowType={w.windowType} size={15} />
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {w.label || w.tmuxTarget}
        </span>
        {w.workerType && (
          <span style={{
            fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--input-bg)',
            padding: '2px 6px', borderRadius: 'var(--radius-sm)', flexShrink: 0,
          }}>
            {w.workerType}
          </span>
        )}
      </span>
      {isCurrent && (
        <span aria-label={t('taskDetailMenu.currentWindow')} style={{ display: 'inline-flex', color: 'var(--accent)', flexShrink: 0 }}>
          <Icon name="check" size={16} />
        </span>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label={t('windows.deleteWindow')}
          title={t('windows.deleteWindow')}
          className="icon-btn"
          style={{
            width: 44, height: 44, marginRight: -14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'none', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
          }}
        >
          <Icon name="trash" size={16} />
        </button>
      )}
    </div>
  );
}

function BrowserMenuRow({ title, onSelect, onDelete }: { title: string; onSelect: () => void; onDelete?: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className="row-hover"
      style={{ ...rowStyle, justifyContent: 'flex-start', gap: 10, cursor: 'pointer' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
        <Icon name="browser" size={16} />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </span>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label={t('objects.closeGroupAction')}
          title={t('objects.closeGroupAction')}
          className="icon-btn"
          style={{
            width: 44, height: 44, marginRight: -14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'none', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
          }}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

function AddChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="row-hover"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', background: 'var(--input-bg)', color: 'var(--text)',
        border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-sm)', cursor: 'pointer',
      }}
    >
      <Icon name="plus" size={14} />
      {label}
    </button>
  );
}

const gridCardStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
  padding: '12px 14px', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)',
  border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%', boxSizing: 'border-box',
};

function GridCard({ label, value, onClick }: { label: string; value: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="row-hover" style={gridCardStyle}>
      <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-base)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
        {value}
      </span>
    </button>
  );
}

function ActionRow({ icon, label, value, onClick, danger }: {
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="row-hover"
      style={{ ...rowStyle, color: danger ? 'var(--danger)' : rowStyle.color }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', color: danger ? 'var(--danger)' : 'var(--text-dim)' }}>{icon}</span>
        <span>{label}</span>
      </span>
      {value !== undefined && (
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{value}</span>
      )}
    </button>
  );
}

/**
 * SP タスク詳細 ⋯ フルサイズメニュー（Issue #338 T1「ハブ&スポーク」再設計）。MobileNavSheet と
 * 同文法の全画面シート — メイン画面（ステータスチップ／実行・停止／ウィンドウとブラウザ／表示
 * グリッド／その他の操作の入口）と、「その他の操作」サブビュー（編集・ピン・タブを閉じる・
 * 取り扱い注意＝アーカイブ/削除）の2ビューをこのコンポーネント内の view state でスタック遷移する。
 * 表示節の各カードはコンテンツ直置きを禁止し、すべてフルスクリーン表示への遷移（onOpen*）にする。
 * 件数（コミット履歴 N件・差分 +X -Y）はこのメニューが開いているときだけ軽量に取得する
 * （常時ポーリングはしない — 開くたび最新化されれば十分）。
 */
export default function TaskDetailMenu({
  open, onClose, task, unitName, hasUnit, actions, onExecute, canExecute, onStop, canStop,
  diffPath, diffServerName, browserCount, browserTabLabel,
  onStatusChange, onOpenDescription, onOpenUnit, onOpenCommits, onOpenDiff, onOpenBrowser, onDeleteBrowser,
  isPinned, onTogglePin, onCloseTab, windows, focusedWindowTarget, onSelectWindow, onLongPressWindow, onDeleteWindow, onOpenAddWindow, onAddBrowser,
}: TaskDetailMenuProps) {
  const { t } = useTranslation(['tasks', 'workspace', 'common']);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [diffStat, setDiffStat] = useState<{ add: number; del: number } | null>(null);
  const [view, setView] = useState<'main' | 'more'>('main');

  const canShowGit = hasUnit && !!diffPath && !!diffServerName;

  useEffect(() => {
    if (!open) setView('main');
  }, [open]);

  useEffect(() => {
    if (!open || !canShowGit || !diffServerName || !diffPath) return;
    let cancelled = false;
    const commitParams = new URLSearchParams({ path: diffPath });
    if (task.baseBranch) commitParams.set('base', task.baseBranch);
    api<Array<unknown> & { error?: string }>(`/servers/${diffServerName}/git/commits?${commitParams.toString()}`)
      .then((res) => { if (!cancelled && Array.isArray(res)) setCommitCount(res.length); })
      .catch(() => {});

    const diffParams = new URLSearchParams({ path: diffPath });
    if (task.baseBranch) {
      diffParams.set('base', task.baseBranch);
      diffParams.set('scope', 'base');
      diffParams.set('includeUncommitted', 'true');
    } else {
      diffParams.set('scope', 'uncommitted');
    }
    api<{ files?: { additions: number; deletions: number }[]; error?: string }>(`/servers/${diffServerName}/git/diff?${diffParams.toString()}`)
      .then((res) => {
        if (cancelled || !Array.isArray(res.files)) return;
        setDiffStat({
          add: res.files.reduce((s, f) => s + f.additions, 0),
          del: res.files.reduce((s, f) => s + f.deletions, 0),
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, canShowGit, diffServerName, diffPath, task.baseBranch]);

  if (!open) return null;

  const topActions = actions.filter((a) => !a.caution);
  const cautionActions = actions.filter((a) => a.caution);
  const hasWindowsSection = windows.length > 0 || browserCount > 0 || !!onOpenAddWindow || !!onAddBrowser;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 49 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('workspace:taskDetailMenu.title')}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'var(--bg-solid)', zIndex: 50,
          boxShadow: 'var(--shadow-3)',
        }}
      >
        {view === 'main' ? (
          <div style={headerStyle}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.title}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common:actions.close')}
              className="icon-btn"
              style={iconBtnStyle}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        ) : (
          <div style={headerStyle}>
            <button
              type="button"
              onClick={() => setView('main')}
              aria-label={t('common:actions.back')}
              className="icon-btn"
              style={{ ...iconBtnStyle, marginLeft: -8 }}
            >
              <Icon name="chevron-left" size={20} />
            </button>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('workspace:taskDetailMenu.moreActions')}
            </span>
          </div>
        )}

        {view === 'main' ? (
          <div className="mobile-scroll-inset" style={{ flex: 1, overflow: 'auto' }}>
            <div style={{ padding: '12px 16px 4px' }}>
              <StatusDropdown status={task.status} onChange={onStatusChange} showDot />
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', padding: '8px 16px 4px' }}>
              <button
                type="button"
                onClick={() => { onClose(); onExecute(); }}
                disabled={!canExecute}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '12px', borderRadius: 'var(--radius-md)', border: 'none',
                  background: 'var(--accent-a15)', color: 'var(--accent)',
                  fontSize: 'var(--font-base)', fontWeight: 600,
                  cursor: canExecute ? 'pointer' : 'default', opacity: canExecute ? 1 : 0.45,
                }}
              >
                <Icon name="play" size={16} />
                {t('actions.execute')}
              </button>
              <button
                type="button"
                onClick={() => { onClose(); onStop(); }}
                disabled={!canStop}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '12px', borderRadius: 'var(--radius-md)', border: 'none',
                  background: 'var(--bg-card)', color: 'var(--text-dim)',
                  fontSize: 'var(--font-base)', fontWeight: 600,
                  cursor: canStop ? 'pointer' : 'default', opacity: canStop ? 1 : 0.45,
                }}
              >
                <Icon name="stop" size={16} />
                {t('actions.stop')}
              </button>
            </div>

            {hasWindowsSection && (
              <>
                <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.windowsAndBrowser')}</div>
                <div style={{ paddingBottom: 4 }}>
                  {windows.map((w) => {
                    const isCurrent = !!focusedWindowTarget
                      && focusedWindowTarget.serverName === w.serverName
                      && isSameWindowTarget(focusedWindowTarget.target, w.tmuxTarget);
                    return (
                      <WindowMenuRow
                        key={w.id}
                        w={w}
                        isCurrent={isCurrent}
                        onSelect={() => { onSelectWindow(w.serverName, w.tmuxTarget); onClose(); }}
                        onLongPress={onLongPressWindow ? (x, y) => onLongPressWindow(x, y, w) : undefined}
                        onDelete={onDeleteWindow ? () => onDeleteWindow(w) : undefined}
                      />
                    );
                  })}
                  {browserCount === 1 && (
                    <BrowserMenuRow
                      title={browserTabLabel ?? t('common:labels.browser')}
                      onSelect={() => { onOpenBrowser(); onClose(); }}
                      onDelete={onDeleteBrowser ? () => { onDeleteBrowser(); onClose(); } : undefined}
                    />
                  )}
                  {browserCount > 1 && (
                    <BrowserMenuRow
                      title={`${t('common:labels.browser')} (${browserCount})`}
                      onSelect={() => { onOpenBrowser(); onClose(); }}
                    />
                  )}
                  {(onOpenAddWindow || onAddBrowser) && (
                    <div style={{ display: 'flex', gap: 8, padding: '8px 16px 4px' }}>
                      {onOpenAddWindow && (
                        <AddChip label={t('workspace:taskDetailMenu.addWindowChip')} onClick={() => { onOpenAddWindow(); onClose(); }} />
                      )}
                      {onAddBrowser && (
                        <AddChip label={t('workspace:taskDetailMenu.addBrowserChip')} onClick={() => { onAddBrowser(); onClose(); }} />
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.display')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', padding: '4px 16px 8px' }}>
              <GridCard
                label={t('workspace:viewLabels.description')}
                value={t('workspace:taskDetailMenu.showFull')}
                onClick={() => { onOpenDescription(); onClose(); }}
              />
              <GridCard
                label={t('workspace:taskDetailMenu.unitAndExecution')}
                value={hasUnit ? (unitName ?? t('workspace:taskDetailMenu.unassigned')) : t('workspace:taskDetailMenu.unassigned')}
                onClick={() => { onOpenUnit(); onClose(); }}
              />
              {canShowGit && (
                <>
                  <GridCard
                    label={t('workspace:viewLabels.commits')}
                    value={commitCount !== null ? t('workspace:taskDetailMenu.commitCount', { count: commitCount }) : '—'}
                    onClick={() => { onOpenCommits(); onClose(); }}
                  />
                  <GridCard
                    label={t('workspace:viewLabels.diff')}
                    value={diffStat ? (
                      <>
                        <span style={{ color: 'var(--success)' }}>+{diffStat.add}</span>
                        {' '}
                        <span style={{ color: 'var(--danger)' }}>-{diffStat.del}</span>
                      </>
                    ) : '—'}
                    onClick={() => { onOpenDiff(); onClose(); }}
                  />
                </>
              )}
            </div>

            <div style={{ paddingTop: 4, paddingBottom: 8, borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => setView('more')}
                className="row-hover"
                style={rowStyle}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="more" size={16} />
                  <span>{t('workspace:taskDetailMenu.moreActions')}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>
                  {t('workspace:taskDetailMenu.moreActionsHint')}
                  <Icon name="chevron-right" size={14} />
                </span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mobile-scroll-inset" style={{ flex: 1, overflow: 'auto' }}>
            <div style={{ paddingTop: 4, paddingBottom: 4 }}>
              {topActions.map((a) => (
                <ActionRow
                  key={a.label}
                  icon={a.icon}
                  label={a.label}
                  onClick={() => { a.onClick(); onClose(); }}
                  danger={a.danger}
                />
              ))}
              <ActionRow
                icon={<Icon name="pin" size={16} />}
                label={t('workspace:taskDetailMenu.pinTab')}
                value={isPinned ? t('workspace:taskDetailMenu.pinOn') : t('workspace:taskDetailMenu.pinOff')}
                onClick={onTogglePin}
              />
              <ActionRow
                icon={<Icon name="close" size={16} />}
                label={t('workspace:taskDetailMenu.closeTab')}
                onClick={onCloseTab}
              />
            </div>

            {cautionActions.length > 0 && (
              <>
                <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.caution')}</div>
                <div style={{ paddingBottom: 8 }}>
                  {cautionActions.map((a) => (
                    <ActionRow
                      key={a.label}
                      icon={a.icon}
                      label={a.label}
                      value={a.danger ? t('workspace:taskDetailMenu.confirmRequired') : undefined}
                      onClick={() => { a.onClick(); onClose(); }}
                      danger={a.danger}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
