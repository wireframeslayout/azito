import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { useNotificationChannel } from '../../hooks/useNotificationChannel';
import { Button } from '../ui';
import { Icon } from '../ui/Icon';
import Modal from '../Modal';
import type { WindowViewMode } from '../../lib/windowViewMode';
import ConversationView from './ConversationView';
import { hostUnavailableReason, type HostUnavailableReason } from './hostUnavailable';
import { resolveSubagentRelay } from './subagentRelay';

interface Subagent {
  id: string;
  name: string;
  description: string;
  agentType: string;
  model: string | null;
  routingName?: string | null;
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

function readSelection(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function saveSelection(key: string, id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(key);
    else localStorage.setItem(key, id);
  } catch { /* Selection remains available for this view. */ }
}

export default function SubagentChat({ windowId, sessionId, onParentChanged, ...conversationProps }: Props) {
  const { t } = useTranslation('transcript');
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const agentElements = useRef(new Map<string, HTMLDivElement>());
  const details = list.kind === 'ready' ? list.agents.find(agent => agent.id === detailsId) : undefined;
  const sequence = useRef(0);
  const storageKey = `azito.subagent.${windowId}.${sessionId}`;
  const restored = useRef<string | null>(null);
  const select = (id: string | null) => {
    setSelected(id);
    saveSelection(storageKey, id);
  };
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    apiWithStatus<{ sessionId: string; subagents: Subagent[] } | { error: string }>(`/transcripts/windows/${windowId}/subagents?sessionId=${encodeURIComponent(sessionId)}`)
      .then(({ status, body }) => {
        if (current !== sequence.current) return;
        if (status !== 200 || 'error' in body) { setList({ kind: 'error', reason: 'error' in body ? hostUnavailableReason(body.error) : null }); return; }
        if (body.sessionId !== sessionId) { onParentChanged(); return; }
        setList({ kind: 'ready', agents: body.subagents });
        if (restored.current !== storageKey) {
          restored.current = storageKey;
          const saved = readSelection(storageKey);
          if (saved && body.subagents.some((agent) => agent.id === saved)) setSelected(saved);
          else { setSelected(null); if (saved) saveSelection(storageKey, null); }
        } else {
          setSelected((selectedId) => {
            if (!selectedId || body.subagents.some((agent) => agent.id === selectedId)) return selectedId;
            saveSelection(storageKey, null);
            return null;
          });
        }
      })
      .catch(() => { if (current === sequence.current) setList({ kind: 'error', reason: null }); });
  }, [windowId, sessionId, onParentChanged, storageKey]);
  useEffect(() => {
    setSelected(null);
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { sequence.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  useEffect(() => {
    if (selected && list.kind === 'ready') agentElements.current.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, list.kind]);
  useEffect(() => {
    if (detailsId && !details) setDetailsId(null);
  }, [detailsId, details]);
  useNotificationChannel({
    onSubagentsUpdated: (payload) => { if (payload.windowId === windowId && payload.sessionId === sessionId) refresh(); },
    onConnected: refresh,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <section aria-label={t('subagents.title')} style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', overflowX: 'auto', minWidth: 0, padding: 'var(--space-1)' }}>
          <strong style={{ fontSize: 'var(--font-sm)', flexShrink: 0 }}>{t('subagents.title')}</strong>
          <Button style={{ minHeight: 'calc(var(--space-6) + var(--space-5))', flexShrink: 0 }} size="sm" variant={selected === null ? 'primary' : 'default'} aria-pressed={selected === null} onClick={() => select(null)}>{t('subagents.parent')}</Button>
          {list.kind === 'ready' && list.agents.map((agent) => (
            <div key={agent.id} ref={el => { if (el) agentElements.current.set(agent.id, el); else agentElements.current.delete(agent.id); }} style={{ flexShrink: 0, width: 'calc(12 * var(--space-6))', maxWidth: '100%', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}><Button title={`${agent.name} · ${agent.agentType}${agent.model ? ` · ${agent.model}` : ''} · ${t(`subagents.status.${agent.status}`)} — ${agent.description}`} aria-describedby={`subagent-description-${agent.id}`} style={{ display: 'block', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', minHeight: 'calc(var(--space-6) + var(--space-5))' }} size="sm" variant={selected === agent.id ? 'primary' : 'default'} aria-pressed={selected === agent.id} onClick={() => select(agent.id)}>
                {agent.name} · {agent.agentType}{agent.model && ` · ${agent.model}`} · {t(`subagents.status.${agent.status}`)}
              </Button><Button size="sm" aria-label={t('subagents.details', { name: agent.name })} onClick={() => setDetailsId(agent.id)} style={{ minHeight: 'calc(var(--space-6) + var(--space-5))', flexShrink: 0 }}><Icon name="info" size={14} /></Button></div>
              <div id={`subagent-description-${agent.id}`} title={agent.description} style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', marginTop: 'var(--space-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.description}</div>
            </div>
          ))}
        </div>
        <div aria-live="polite" style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', marginTop: 'var(--space-1)' }}>
          {list.kind === 'loading' ? t('subagents.loading') : list.kind === 'ready' && list.agents.length === 0 ? t('subagents.empty') : null}
          {list.kind === 'error' ? <>{list.reason ? t(`windowChat.notFound.${list.reason}`) : t('subagents.error')} <Button style={{ minHeight: 'calc(var(--space-6) + var(--space-5))' }} size="sm" onClick={refresh}>{t('windowChat.retry')}</Button></> : null}
        </div>
      </section>
      {details && <Modal open title={t('subagents.detailsTitle')} onClose={() => setDetailsId(null)} hideCancel actions={<Button onClick={() => setDetailsId(null)}>{t('actions.close', { ns: 'common' })}</Button>}><div style={{ overflowWrap: 'anywhere' }}><strong>{details.name}</strong><p>{details.agentType}{details.model && ` · ${details.model}`} · {t(`subagents.status.${details.status}`)}</p><p>{details.description}</p></div></Modal>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ConversationView key={selected ?? 'parent'} windowId={windowId} sessionId={sessionId} onParentChanged={onParentChanged} subagentId={selected ?? undefined} subagentRelay={selected === null ? undefined : resolveSubagentRelay(list.kind === 'ready' ? list.agents : null, selected)} {...conversationProps} />
      </div>
    </div>
  );
}
