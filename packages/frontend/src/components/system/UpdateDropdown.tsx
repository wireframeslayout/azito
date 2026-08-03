import { useTranslation } from 'react-i18next';
import { useSystemUpdate } from '../../hooks/useSystemUpdate';
import type { UpdateCommit } from '../../hooks/useSystemUpdate';
import { Chip } from '../ui/Chip';
import { Spinner } from '../ui/Spinner';

interface UpdateDropdownProps {
  onStartUpdate: () => void;
  onCheckNow: () => void;
}

const COMMIT_TYPE_RE = /^(feat|fix|refactor|docs|test|chore|perf|style|build|ci)(\([^)]*\))?!?:\s*/;

function parseCommitMessage(message: string): { type: string | null; rest: string } {
  const m = message.match(COMMIT_TYPE_RE);
  if (!m) return { type: null, rest: message };
  return { type: m[1], rest: message.slice(m[0].length) };
}

function commitTypeTone(type: string): 'green' | 'orange' | 'default' {
  if (type === 'feat') return 'green';
  if (type === 'fix') return 'orange';
  return 'default';
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatLastChecked(dateIso: string | null): string {
  if (!dateIso) return '';
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function UpdateDropdown({ onStartUpdate, onCheckNow }: UpdateDropdownProps) {
  const { t } = useTranslation('settings');
  const { status, checking, canStart } = useSystemUpdate();

  if (!status) {
    return (
      <div style={{ padding: '16px 14px', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
        {t('system.fetchingInfo')}
      </div>
    );
  }

  const hasUpdate = status.status === 'update-available';
  const isDisabled = status.status === 'disabled';
  const isCheckFailed = status.status === 'check-failed';

  return (
    <div>
      <div style={{
        padding: '10px 14px 8px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
          {t('system.title')}
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
          hub · local
        </div>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border)' }}>
        <VersionRow label={t('system.current')} sha={status.currentCommit} date={null} />
        <VersionRow label={t('system.latest')} sha={status.latestCommit} date={status.latestDate} />
        {hasUpdate && status.commitsBehind > 0 && (
          <div style={{ marginTop: 2 }}>
            <Chip tone="accent">{t('system.commitsBehind', { count: status.commitsBehind })}</Chip>
          </div>
        )}
      </div>

      {hasUpdate && status.commits.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: 'auto', borderBottom: '1px solid var(--border)' }}>
          {status.commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))}
        </div>
      )}

      {status.runningTasks > 0 && (
        <div style={{
          margin: '10px 14px',
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--warning-a08)',
          border: '1px solid var(--warning-a35)',
          color: 'var(--warning)',
          fontSize: 'var(--font-xs)',
        }}>
          {t('system.runningTasksWarning', { count: status.runningTasks })}
        </div>
      )}

      {isDisabled && (
        <div style={{
          margin: '10px 14px',
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-xs)',
        }}>
          {status.disabledReason || t('system.disabledDefault')}
        </div>
      )}

      {isCheckFailed && (
        <div style={{
          margin: '10px 14px',
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-a08)',
          border: '1px solid var(--danger-a35)',
          color: 'var(--danger)',
          fontSize: 'var(--font-xs)',
        }}>
          {t('system.checkFailed')}
        </div>
      )}

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!canStart}
            onClick={onStartUpdate}
            style={{ flex: 1, fontSize: 'var(--font-sm)' }}
          >
            {t('system.updateAndRestart')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={onCheckNow}
            disabled={checking}
            style={{ fontSize: 'var(--font-sm)', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {checking && <Spinner size={10} />}
            {t('system.recheck')}
          </button>
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
          {checking ? t('system.statusChecking') : status.latestDate ? `${t('system.lastChecked')}: ${formatLastChecked(status.latestDate)}` : ''}
        </div>
      </div>
    </div>
  );
}

function VersionRow({ label, sha, date }: { label: string; sha: string | null; date: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--font-sm)' }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)' }}>
        <span style={{ color: 'var(--purple)' }}>{sha ? shortSha(sha) : '—'}</span>
        {date && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{formatLastChecked(date)}</span>}
      </span>
    </div>
  );
}

function CommitRow({ commit }: { commit: UpdateCommit }) {
  const { type, rest } = parseCommitMessage(commit.message);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 14px',
      fontSize: 'var(--font-xs)',
    }}>
      <span style={{ fontFamily: 'var(--mono)', color: 'var(--purple)', flexShrink: 0 }}>{shortSha(commit.sha)}</span>
      {type && <Chip tone={commitTypeTone(type)}>{type}</Chip>}
      <span style={{
        color: 'var(--text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}>
        {rest}
      </span>
    </div>
  );
}
