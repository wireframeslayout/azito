import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { useNotificationChannel } from '../../hooks/useNotificationChannel';
import { Button } from '../ui';
import type { WindowViewMode } from '../ui/TerminalChatToggle';
import ConversationView from './ConversationView';
import { hostUnavailableReason, type HostUnavailableReason } from './hostUnavailable';

interface Subagent {
  id: string;
  name: string;
  description: string;
  agentType: string;
  model: string | null;
  status: 'finished' | 'unknown';
}
interface Props {
  windowId: number;
  sessionId: string;
  agentType: string;
  paneId: string;
  agentDetected: boolean;
  slashCommandsVisibleInLog?: boolean;
  viewMode?: WindowViewMode;
  onChangeViewMode?: (mode: WindowViewMode) => void;
  onParentChanged: () => void;
}
type ListState = { kind: 'loading' } | { kind: 'error'; reason: HostUnavailableReason | null } | { kind: 'ready'; agents: Subagent[] };

export default function SubagentChat({ windowId, sessionId, onParentChanged, ...conversationProps }: Props) {
  const { t } = useTranslation('transcript');
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    apiWithStatus<{ sessionId: string; subagents: Subagent[] } | { error: string }>(`/transcripts/windows/${windowId}/subagents`)
      .then(({ status, body }) => {
        if (current !== sequence.current) return;
        if (status !== 200 || 'error' in body) { setList({ kind: 'error', reason: 'error' in body ? hostUnavailableReason(body.error) : null }); return; }
        if (body.sessionId !== sessionId) { onParentChanged(); return; }
        setList({ kind: 'ready', agents: body.subagents });
      })
      .catch(() => { if (current === sequence.current) setList({ kind: 'error', reason: null }); });
  }, [windowId, sessionId, onParentChanged]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { sequence.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  useNotificationChannel({
    onSubagentsUpdated: (payload) => { if (payload.windowId === windowId && payload.sessionId === sessionId) refresh(); },
    onConnected: refresh,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <section aria-label={t('subagents.title')} style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border)', maxHeight: '35%', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--font-sm)' }}>{t('subagents.title')}</strong>
          <Button size="sm" variant={selected === null ? 'primary' : 'default'} aria-pressed={selected === null} onClick={() => setSelected(null)}>{t('subagents.parent')}</Button>
          {list.kind === 'ready' && list.agents.map((agent) => (
            <Button key={agent.id} style={{ maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'left' }} size="sm" variant={selected === agent.id ? 'primary' : 'default'} aria-pressed={selected === agent.id} onClick={() => setSelected(agent.id)}>
              {agent.name} · {agent.agentType} · {t(`subagents.status.${agent.status}`)}
            </Button>
          ))}
        </div>
        <div aria-live="polite" style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', marginTop: 'var(--space-1)' }}>
          {list.kind === 'loading' ? t('subagents.loading') : list.kind === 'error' ? <>{list.reason ? t(`windowChat.notFound.${list.reason}`) : t('subagents.error')} <Button size="sm" onClick={refresh}>{t('windowChat.retry')}</Button></> : list.agents.length === 0 ? t('subagents.empty') : null}
          {selected !== null && <div>{t('subagents.readOnly')}</div>}
        </div>
      </section>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ConversationView key={selected ?? 'parent'} windowId={windowId} sessionId={sessionId} onParentChanged={onParentChanged} subagentId={selected ?? undefined} {...conversationProps} />
      </div>
    </div>
  );
}
