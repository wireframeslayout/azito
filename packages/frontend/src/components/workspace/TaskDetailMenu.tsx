import { type CSSProperties, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Icon } from '../ui/Icon';
import { AgentIcon } from '../ui/AgentIcons';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { isSameWindowTarget } from '../../utils/tmuxTarget';
import StatusDropdown from '../task/StatusDropdown';
import type { Task, Window } from '../../pages/workspace/types';

export interface TaskDetailMenuAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface TaskDetailMenuProps {
  open: boolean;
  onClose: () => void;
  task: Task;
  unitName?: string | null;
  hasUnit: boolean;
  /** タスク全体アクション（実行・停止・編集・アーカイブ/復元・削除）— 旧 SP ⋯ コンテキスト
   * メニューが持っていた項目群をそのままここへ移設する（機能欠落防止、Issue #69 S8）。 */
  actions: TaskDetailMenuAction[];
  /** コミット履歴/差分の件数取得先（Task Git タブ・DiffViewer と同じサーバー/パス解決）。
   * どちらか欠けている場合、行自体を表示しない（既存の availableFixedViews と同じ条件）。 */
  diffPath?: string | null;
  diffServerName?: string;
  browserCount: number;
  onStatusChange: (status: string) => void;
  onOpenDescription: () => void;
  onOpenUnit: () => void;
  onOpenCommits: () => void;
  onOpenDiff: () => void;
  onOpenBrowser: () => void;
  isPinned: boolean;
  onTogglePin: () => void;
  onCloseTab: () => void;
  /** タスクの全ウィンドウ（Issue #69 T8a）。「ウィンドウ」節が空なら描かない。 */
  windows: Window[];
  /** 現在コンテンツ表示中（または最終アクティブ）のウィンドウ — 該当行に ✓ を出す。 */
  focusedWindowTarget: { serverName: string; target: string } | null;
  /** 行タップ: メニューを閉じ、そのウィンドウのコンテンツ（端末/チャットは localStorage 記憶
   * モード）を表示する。実際の表示切替は呼び出し元（TaskPanel の handleMobileSelect）が担う。 */
  onSelectWindow: (serverName: string, target: string) => void;
  /** ＋「ウィンドウを追加」行（既存 AddWindow 導線）。省略時は追加行を出さない。 */
  onOpenAddWindow?: () => void;
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

function MenuRow({ label, value, onClick, danger }: { label: string; value?: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="row-hover" style={{ ...rowStyle, color: danger ? 'var(--danger)' : rowStyle.color }}>
      <span>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)', minWidth: 0 }}>
        {value !== undefined && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
        {!danger && <Icon name="chevron-right" size={16} />}
      </span>
    </button>
  );
}

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

function WindowMenuRow({ w, isCurrent, onSelect }: { w: Window; isCurrent: boolean; onSelect: () => void }) {
  const { t } = useTranslation('workspace');
  const { windowIndicator } = useAgentActivity();
  const status = windowIndicator(w.serverName, w.tmuxTarget);
  const isWorking = status === 'working' || status === 'blocked';

  return (
    <button type="button" onClick={onSelect} className="row-hover" style={{ ...rowStyle, justifyContent: 'flex-start', gap: 10 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, flexShrink: 0 }}>
        {isWorking ? <BrailleSpinner /> : <IdleDot />}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
        <AgentIcon workerType={w.workerType} windowType={w.windowType} size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {w.label || w.tmuxTarget}
      </span>
      {isCurrent && (
        <span aria-label={t('taskDetailMenu.currentWindow')} style={{ display: 'inline-flex', color: 'var(--accent)', flexShrink: 0 }}>
          <Icon name="check" size={16} />
        </span>
      )}
    </button>
  );
}

/**
 * SP タスク詳細 ⋯ フルサイズメニュー（Issue #69 S8）。MobileNavSheet と同文法の全画面シート
 * — 「ステータス」「表示」「タブ操作」の3節。表示節の各行はコンテンツ直置きを禁止し、すべて
 * フルスクリーン表示への遷移（onOpen*）にする。件数（コミット履歴 N件・差分 +X -Y）はこの
 * メニューが開いているときだけ軽量に取得する（常時ポーリングはしない — 開くたび最新化されれば
 * 十分）。
 */
export default function TaskDetailMenu({
  open, onClose, task, unitName, hasUnit, actions, diffPath, diffServerName, browserCount,
  onStatusChange, onOpenDescription, onOpenUnit, onOpenCommits, onOpenDiff, onOpenBrowser,
  isPinned, onTogglePin, onCloseTab, windows, focusedWindowTarget, onSelectWindow, onOpenAddWindow,
}: TaskDetailMenuProps) {
  const { t } = useTranslation(['tasks', 'workspace', 'common']);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [diffStat, setDiffStat] = useState<{ add: number; del: number } | null>(null);

  const canShowGit = hasUnit && !!diffPath && !!diffServerName;

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
        <div style={headerStyle}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="icon-btn"
            style={{
              width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'none', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="mobile-scroll-inset" style={{ flex: 1, overflow: 'auto' }}>
          {actions.length > 0 && (
            <div style={{ paddingTop: 4, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
              {actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => { a.onClick(); onClose(); }}
                  className="row-hover"
                  style={{ ...rowStyle, justifyContent: 'flex-start', color: a.danger ? 'var(--danger)' : rowStyle.color }}
                >
                  {a.icon && <span style={{ display: 'flex', alignItems: 'center' }}>{a.icon}</span>}
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          )}

          <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.status')}</div>
          <div style={{ padding: '4px 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <StatusDropdown status={task.status} onChange={onStatusChange} />
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
              {t('workspace:taskDetailMenu.tapToChange')}
            </span>
          </div>

          <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.display')}</div>
          <div style={{ paddingBottom: 4 }}>
            <MenuRow
              label={t('workspace:viewLabels.description')}
              value={t('workspace:taskDetailMenu.showFull')}
              onClick={() => { onOpenDescription(); onClose(); }}
            />
            <MenuRow
              label={t('workspace:taskDetailMenu.unitAndExecution')}
              value={hasUnit ? (unitName ?? t('workspace:taskDetailMenu.unassigned')) : t('workspace:taskDetailMenu.unassigned')}
              onClick={() => { onOpenUnit(); onClose(); }}
            />
            {canShowGit && (
              <>
                <MenuRow
                  label={t('workspace:viewLabels.commits')}
                  value={commitCount !== null ? t('workspace:taskDetailMenu.commitCount', { count: commitCount }) : '—'}
                  onClick={() => { onOpenCommits(); onClose(); }}
                />
                <MenuRow
                  label={t('workspace:viewLabels.diff')}
                  value={diffStat ? `+${diffStat.add} -${diffStat.del}` : '—'}
                  onClick={() => { onOpenDiff(); onClose(); }}
                />
              </>
            )}
            {browserCount > 0 && (
              <MenuRow
                label={t('common:labels.browser')}
                value={browserCount}
                onClick={() => { onOpenBrowser(); onClose(); }}
              />
            )}
          </div>

          {(windows.length > 0 || onOpenAddWindow) && (
            <>
              <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.windows')}</div>
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
                    />
                  );
                })}
                {onOpenAddWindow && (
                  <button
                    type="button"
                    onClick={() => { onOpenAddWindow(); onClose(); }}
                    className="row-hover"
                    style={{ ...rowStyle, justifyContent: 'flex-start', gap: 10, color: 'var(--accent)' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, flexShrink: 0 }}>
                      <Icon name="plus" size={14} />
                    </span>
                    <span>{t('workspace:windows.addWindow')}</span>
                  </button>
                )}
              </div>
            </>
          )}

          <div style={sectionLabelStyle}>{t('workspace:taskDetailMenu.tabActions')}</div>
          <div style={{ paddingBottom: 8 }}>
            <MenuRow
              label={t('workspace:taskDetailMenu.pin')}
              value={isPinned ? t('workspace:taskDetailMenu.pinOn') : t('workspace:taskDetailMenu.pinOff')}
              onClick={onTogglePin}
            />
            <MenuRow
              label={t('workspace:taskDetailMenu.closeTab')}
              onClick={onCloseTab}
              danger
            />
          </div>
        </div>
      </div>
    </>
  );
}
