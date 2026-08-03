import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { api } from '../api/client';
import { useNotificationChannel } from '../hooks/useNotificationChannel';
import { timeAgo } from '../utils/time';
import { ansiToHtml } from '../utils/ansi';
import { EmptyState } from './ui';
import { Icon } from './ui/Icon';
import { useTerminalTheme } from '../hooks/useTerminalTheme';
import { buildWsUrl } from '../api/wsUrl';
import { useToast } from '../hooks/useToast';
import { useTranslation } from 'react-i18next';

interface PhasePrompt {
  id: number;
  phase: string;
  prompt: string;
  order: number;
  enabled: boolean;
  updatedAt: string;
}

interface LogEntry {
  type: string;
  content: string;
  createdAt: string;
  unitId?: number;
}

interface TaskLogViewProps {
  taskId: number;
  unitId?: number;
  taskStatus?: string;
  planMarkdown?: string | null;
  maxHeight?: string;
  /** When true the component fills its parent's height via flex instead of using maxHeight */
  fillHeight?: boolean;
}

// ── Helpers ──

function parseContent(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Classify a log entry into a visual style bucket */
function classify(type: string, parsed: any): 'system' | 'orchestrator' | 'worker-prompt' | 'terminal' | 'done' | 'error' | 'launch' | 'auto-approve' | 'user-comment' | 'session-resumed' | null {
  if (type === 'user_comment') return 'user-comment';
  if (type === 'status_change') {
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.status === 'done') return 'done';
      if (parsed.status === 'failed') return 'error';
      if (parsed.status === 'session_resumed') return 'session-resumed';
    }
    return 'system';
  }
  if (type === 'llm_request') return 'orchestrator';
  if (type === 'llm_response') {
    if (typeof parsed === 'object' && parsed?.action === 'done') return 'done';
    if (typeof parsed === 'object' && parsed?.action === 'error') return 'error';
    // prompt responses are shown via the subsequent 'command' log entry, skip here
    return 'orchestrator';
  }
  if (type === 'command') {
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.type === 'wait_poll' || parsed.type === 'wait_start' || parsed.type === 'llm_classify') return null;
      if (parsed.type === 'worker_prompt') return 'worker-prompt';
      if (parsed.type === 'worker_launch') return 'launch';
      if (parsed.type === 'auto_approve') return 'auto-approve';
    }
    return 'system';
  }
  if (type === 'output') return 'terminal';
  return 'system';
}

// ── Bubble renderers ──

function SystemBubble({ children, time }: { children: React.ReactNode; time: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 16px' }}>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', textAlign: 'center', maxWidth: '80%' }}>
        {children}
        <span style={{ marginLeft: 8, fontSize: 'var(--font-2xs)', opacity: 0.7 }}>{timeAgo(time)}</span>
      </span>
    </div>
  );
}

function OrchestratorBubble({ parsed, time, logType }: { parsed: any; time: string; logType: string }) {
  const { t } = useTranslation('tasks');
  // llm_request: show "Orchestrator request #N"
  if (logType === 'llm_request') {
    const label = typeof parsed === 'object' && parsed !== null
      ? t('log.orchestratorRequest', { iteration: parsed.iteration || '?' })
      : t('log.orchestratorThinking');
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '4px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-flex', color: 'var(--accent)' }}><Icon name="external-link" size={14} /></span>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontStyle: 'italic' }}>{label}</span>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(time)}</span>
        </div>
      </div>
    );
  }
  // llm_response with action=prompt: just show a brief indicator (the full prompt is in the 'command' entry)
  return null;
}

function WorkerPromptBubble({ parsed, time, type }: { parsed: any; time: string; type: string }) {
  const { t } = useTranslation('tasks');
  let text = '';
  if (type === 'command' && typeof parsed === 'object' && parsed?.type === 'worker_prompt') {
    text = parsed.text || '';
  } else if (typeof parsed === 'object' && parsed !== null) {
    text = parsed.text || parsed.summary || parsed.message || '';
  } else {
    text = String(parsed);
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 16px' }}>
      <div style={{ maxWidth: '75%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(time)}</span>
          <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, color: 'var(--purple)', textTransform: 'uppercase' }}>
            {t('log.workerPrompt')} &#8601;
          </span>
        </div>
        <div style={{
          background: 'var(--accent)', color: '#fff' /* lint-allow: hex - white text on solid accent fill; no on-color token yet */, padding: '10px 14px',
          borderRadius: '14px 14px 4px 14px', fontSize: 'var(--font-sm)', lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {text}
        </div>
      </div>
    </div>
  );
}

function TerminalBubble({ parsed, time }: { parsed: any; time: string }) {
  const { t } = useTranslation('tasks');
  const raw = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  const lines = raw.split('\n');
  const preview = lines.slice(0, 3).join('\n').slice(0, 200);
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '4px 16px' }}>
      <div style={{ maxWidth: '85%', minWidth: 200 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, cursor: 'pointer' }}
          onClick={() => setExpanded(!expanded)}
        >
          <span style={{ display: 'inline-flex', color: 'var(--success)' }}><Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} /></span>
          <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, color: 'var(--success)', textTransform: 'uppercase' }}>
            {t('log.terminalOutput')}
          </span>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>
            {t('log.linesCount', { count: lines.length })} · {timeAgo(time)}
          </span>
        </div>
        {expanded ? (
          <TerminalContent raw={raw} />
        ) : (
          <pre
            onClick={() => setExpanded(true)}
            style={{
              fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
              fontSize: 'var(--font-xs)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              color: '#6e7681' /* lint-allow: hex - muted collapsed-preview shade, distinct from --text-dim */, padding: '8px 12px', background: 'var(--bg)',
              borderRadius: 'var(--radius-md)', borderLeft: '3px solid var(--success)',
              margin: 0, cursor: 'pointer', overflow: 'hidden', maxHeight: 60,
            }}
          >
            {preview}{lines.length > 3 ? '…' : ''}
          </pre>
        )}
      </div>
    </div>
  );
}

function TerminalContent({ raw }: { raw: string }) {
  const { ansiPalette } = useTerminalTheme();
  const html = useMemo(() => ansiToHtml(raw, ansiPalette), [raw, ansiPalette]);
  return (
    <pre
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
        fontSize: 'var(--font-xs)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        color: ansiPalette.foreground, padding: 12, background: 'var(--bg)',
        borderRadius: 'var(--radius-md)', borderLeft: '3px solid var(--success)',
        margin: 0, maxHeight: 400, overflowY: 'auto',
      }}
    />
  );
}

function DoneBanner({ parsed, time, variant }: { parsed: any; time: string; variant: 'done' | 'error' }) {
  const isDone = variant === 'done';
  const color = isDone ? 'var(--success)' : 'var(--danger)';
  const icon = isDone ? '✓' : '✗';
  let message = '';
  if (typeof parsed === 'object' && parsed !== null) {
    message = parsed.text || parsed.summary || parsed.message || parsed.status || variant;
  } else {
    message = String(parsed);
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 20px', borderRadius: 'var(--radius-lg)',
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}>
        <span style={{ fontSize: 'var(--font-base)', color }}>{icon}</span>
        <span style={{ fontSize: 'var(--font-sm)', color, fontWeight: 500 }}>{message}</span>
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(time)}</span>
      </div>
    </div>
  );
}

function LaunchBubble({ parsed, time }: { parsed: any; time: string }) {
  const { t } = useTranslation('tasks');
  const cmd = typeof parsed === 'object' && parsed !== null ? parsed.command : String(parsed);
  return (
    <SystemBubble time={time}>
      <span>{t('log.launched')}</span>
      <code style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', background: 'rgba(255,165,0,0.08)', borderRadius: 'var(--radius-sm)', color: 'var(--warning)' }}>
        {cmd}
      </code>
    </SystemBubble>
  );
}

function AutoApproveBubble({ parsed, time }: { parsed: any; time: string }) {
  const { t } = useTranslation('tasks');
  const detected = typeof parsed === 'object' && parsed !== null ? parsed.detected : '';
  return (
    <SystemBubble time={time}>
      <span>{'✓'} {t('log.autoApproved')}</span>
      {detected && <code style={{ fontSize: 'var(--font-2xs)', color: 'var(--warning)' }}>{detected}</code>}
    </SystemBubble>
  );
}

function SessionResumedBubble({ parsed, time }: { parsed: any; time: string }) {
  const { t } = useTranslation('tasks');
  const entries = typeof parsed === 'object' && parsed !== null ? parsed.historyEntries : '?';
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '6px 16px', borderRadius: 'var(--radius-lg)',
        background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
      }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)' }}><Icon name="refresh" size={14} /></span>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--accent)', fontWeight: 500 }}>
          {t('log.llmResumed', { entries })}
        </span>
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(time)}</span>
      </div>
    </div>
  );
}

function UserCommentBubble({ parsed, time }: { parsed: any; time: string }) {
  const { t } = useTranslation('tasks');
  const text = typeof parsed === 'object' && parsed !== null ? (parsed.text || '') : String(parsed);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 16px' }}>
      <div style={{ maxWidth: '75%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', opacity: 0.6 }}>{timeAgo(time)}</span>
          <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, color: 'var(--success)', textTransform: 'uppercase' }}>
            {t('log.userComment')}
          </span>
        </div>
        <div style={{
          background: 'color-mix(in srgb, var(--success) 18%, transparent)',
          color: 'var(--text)', padding: '10px 14px',
          borderRadius: '14px 14px 4px 14px', fontSize: 'var(--font-sm)', lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)',
        }}>
          {text}
        </div>
      </div>
    </div>
  );
}

// ── Render a single log entry ──

function ChatBubble({ log }: { log: LogEntry }) {
  const parsed = parseContent(log.content);
  const kind = classify(log.type, parsed);
  if (kind === null) return null;

  switch (kind) {
    case 'system': {
      let msg = '';
      if (typeof parsed === 'object' && parsed !== null) {
        const parts: string[] = [];
        if (parsed.status) parts.push(parsed.status);
        if (parsed.message) parts.push(parsed.message);
        if (parsed.summary) parts.push(parsed.summary);
        msg = parts.join(' - ') || log.type;
      } else {
        msg = String(parsed);
      }
      return <SystemBubble time={log.createdAt}>{msg}</SystemBubble>;
    }
    case 'orchestrator':
      return <OrchestratorBubble parsed={parsed} time={log.createdAt} logType={log.type} />;
    case 'worker-prompt':
      return <WorkerPromptBubble parsed={parsed} time={log.createdAt} type={log.type} />;
    case 'terminal':
      return <TerminalBubble parsed={parsed} time={log.createdAt} />;
    case 'done':
      return <DoneBanner parsed={parsed} time={log.createdAt} variant="done" />;
    case 'error':
      return <DoneBanner parsed={parsed} time={log.createdAt} variant="error" />;
    case 'launch':
      return <LaunchBubble parsed={parsed} time={log.createdAt} />;
    case 'auto-approve':
      return <AutoApproveBubble parsed={parsed} time={log.createdAt} />;
    case 'user-comment':
      return <UserCommentBubble parsed={parsed} time={log.createdAt} />;
    case 'session-resumed':
      return <SessionResumedBubble parsed={parsed} time={log.createdAt} />;
    default:
      return <SystemBubble time={log.createdAt}>{String(parsed)}</SystemBubble>;
  }
}

// ── Main component ──

interface HealthData {
  stale: boolean;
  lastActivityAt: string;
  staleSinceMinutes: number;
}

export default function TaskLogView({ taskId, unitId, taskStatus, maxHeight, fillHeight }: TaskLogViewProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [phasePrompts, setPhasePrompts] = useState<PhasePrompt[]>([]);
  const [selectedPhaseIds, setSelectedPhaseIds] = useState<Set<number>>(new Set());
  const [health, setHealth] = useState<HealthData | null>(null);
  const [retrying, setRetrying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { showToast } = useToast();
  const { t } = useTranslation(['tasks', 'common']);

  useEffect(() => { followRef.current = follow; }, [follow]);

  useEffect(() => {
    if (followRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // WebSocket connection
  useEffect(() => {
    const wsUrl = buildWsUrl({ mode: 'task-logs', server: 'local', target: 'logs', taskId: String(taskId) });
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'init' && Array.isArray(msg.logs)) {
            setLogs(msg.logs);
          } else if (msg.type === 'log' && msg.log) {
            setLogs((prev) => [...prev, msg.log]);
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      };
      ws.onerror = () => { ws?.close(); };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [taskId]);

  // Fetch available phase prompts
  useEffect(() => {
    api<PhasePrompt[]>('/phase-prompts')
      .then((data) => {
        if (Array.isArray(data)) {
          setPhasePrompts(data.filter((p) => p.enabled));
        }
      })
      .catch(() => { /* ignore */ });
  }, []);

  const enabledPhases = useMemo(() => phasePrompts, [phasePrompts]);

  const togglePhase = useCallback((id: number) => {
    setSelectedPhaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Event-driven health refresh via WebSocket
  useNotificationChannel({
    onTaskStatus: useCallback(({ taskId: id }: { taskId: number }) => {
      if (id !== taskId || taskStatus !== 'in_progress') return;
      api<HealthData>(`/tasks/${taskId}/health`).then(setHealth).catch(() => {});
    }, [taskId, taskStatus]),
  });

  // Health check: initial fetch + fallback polling (60s safety net)
  useEffect(() => {
    if (taskStatus !== 'in_progress') {
      setHealth(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api<HealthData>(`/tasks/${taskId}/health`);
        if (!cancelled) setHealth(data);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [taskId, taskStatus]);

  const handleRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/tasks/${taskId}/retry`, {
        method: 'POST',
      });
      if (res.error) {
        showToast(res.error);
      } else {
        setHealth(null);
        setLogs([]);
      }
    } catch (err: unknown) {
      showToast((err as Error).message);
    } finally {
      setRetrying(false);
    }
  }, [taskId, retrying, showToast]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (!atBottom && followRef.current) setFollow(false);
  }, []);

  const toggleFollow = useCallback(() => {
    setFollow((prev) => {
      const next = !prev;
      if (next && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      return next;
    });
  }, []);

  const canComment = unitId != null && taskStatus !== 'in_progress' && taskStatus !== 'open';

  const handleSendComment = useCallback(async () => {
    if (!commentText.trim() || !unitId || sending) return;
    setSending(true);
    try {
      const selectedNames = phasePrompts
        .filter((p) => selectedPhaseIds.has(p.id))
        .map((p) => p.phase);
      const res = await api<{ error?: string }>(`/units/${unitId}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ taskId, comment: commentText.trim(), ...(selectedNames.length > 0 ? { phaseNames: selectedNames } : {}) }),
      });
      if (res.error) {
        showToast(res.error);
      } else {
        setCommentText('');
        setSelectedPhaseIds(new Set());
        if (commentRef.current) commentRef.current.style.height = 'auto';
      }
    } catch (err: unknown) {
      showToast((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [commentText, unitId, taskId, sending, showToast]);

  const containerStyle: React.CSSProperties = fillHeight
    ? { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }
    : { position: 'relative' };

  const scrollStyle: React.CSSProperties = fillHeight
    ? { flex: 1, overflowY: 'auto', paddingTop: 12, paddingBottom: 12, background: 'transparent' }
    : { maxHeight: maxHeight || '600px', overflowY: 'auto', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)', paddingTop: 12, paddingBottom: 12 };

  return (
    <div style={containerStyle}>
      {/* Chat area */}
      <div ref={scrollRef} onScroll={handleScroll} style={scrollStyle}>
        {logs.length === 0 ? (
          <EmptyState title={t('log.noLogs')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {logs.map((log, i) => (
              <ChatBubble key={i} log={log} />
            ))}
          </div>
        )}
      </div>

      {/* Stale warning banner */}
      {health?.stale && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 16px', flexShrink: 0,
          background: 'color-mix(in srgb, var(--warning, #f59e0b) 12%, transparent)',
          borderTop: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 30%, transparent)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex' }}><Icon name="warning" size={14} /></span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--warning, #f59e0b)', fontWeight: 500 }}>
              {t('log.staleWarning', { count: health.staleSinceMinutes })}
            </span>
          </div>
          <button
            onClick={handleRetry}
            disabled={retrying}
            style={{
              background: 'var(--warning, #f59e0b)', border: 'none', color: '#fff', // lint-allow: hex - white text on solid warning fill; no on-color token yet
              borderRadius: 'var(--radius-sm)', padding: '5px 14px', fontSize: 'var(--font-sm)', fontWeight: 600,
              cursor: retrying ? 'not-allowed' : 'pointer',
              opacity: retrying ? 0.5 : 1,
            }}
          >
            {retrying ? t('common:actions.retrying') : t('common:actions.retry')}
          </button>
        </div>
      )}

      {/* Retry button for failed tasks */}
      {taskStatus === 'failed' && !health?.stale && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '8px 16px', flexShrink: 0,
          borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={handleRetry}
            disabled={retrying}
            style={{
              background: 'var(--danger, #ef4444)', border: 'none', color: '#fff', // lint-allow: hex - white text on solid danger fill; no on-color token yet
              borderRadius: 'var(--radius-sm)', padding: '6px 20px', fontSize: 'var(--font-sm)', fontWeight: 600,
              cursor: retrying ? 'not-allowed' : 'pointer',
              opacity: retrying ? 0.5 : 1,
            }}
          >
            {retrying ? t('common:actions.retrying') : t('log.retryTask')}
          </button>
        </div>
      )}

      {/* Follow-up comment input */}
      {canComment && (
        <div style={{
          padding: '8px 16px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-card)', flexShrink: 0,
        }}>
          {enabledPhases.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {enabledPhases.map((phase) => {
                const selected = selectedPhaseIds.has(phase.id);
                return (
                  <button
                    key={phase.id}
                    onClick={() => togglePhase(phase.id)}
                    style={{
                      fontSize: 'var(--font-xs)',
                      padding: '3px 10px',
                      borderRadius: 'var(--radius-lg)',
                      cursor: 'pointer',
                      border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                      background: selected ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--bg)',
                      color: selected ? 'var(--accent)' : 'var(--text-dim)',
                      fontWeight: selected ? 600 : 400,
                      transition: 'border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease',
                    }}
                  >
                    {phase.phase}
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={commentRef}
              value={commentText}
              onChange={(e) => {
                setCommentText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendComment();
                }
              }}
              rows={1}
              placeholder={t('log.followUpPlaceholder')}
              style={{
                flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: '8px 12px', color: 'var(--text)',
                fontSize: 'var(--font-md)', fontFamily: 'inherit', outline: 'none',
                minHeight: 38, maxHeight: 120, resize: 'none',
              }}
            />
            <button
              onClick={handleSendComment}
              disabled={sending || !commentText.trim()}
              style={{
                background: 'var(--success)', border: 'none', color: '#fff', // lint-allow: hex - white text on solid success fill; no on-color token yet
                borderRadius: 'var(--radius-md)', padding: '8px 16px', fontSize: 'var(--font-md)', fontWeight: 600,
                cursor: sending || !commentText.trim() ? 'not-allowed' : 'pointer',
                opacity: sending || !commentText.trim() ? 0.5 : 1,
                minHeight: 38, flexShrink: 0,
              }}
            >
              {sending ? t('common:actions.sending') : t('common:actions.send')}
            </button>
          </div>
        </div>
      )}

      {/* Footer bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)',
        flexShrink: 0,
        ...(fillHeight ? {} : { borderRadius: '0 0 6px 6px', border: '1px solid var(--border)', borderTop: '1px solid var(--border)' }),
      }}>
        <button
          onClick={toggleFollow}
          style={{
            fontSize: 'var(--font-xs)', padding: '3px 12px', borderRadius: 'var(--radius-lg)', cursor: 'pointer',
            border: '1px solid var(--border)',
            background: follow ? 'var(--accent)' : 'var(--bg)',
            color: follow ? '#fff' : 'var(--text-dim)', // lint-allow: hex - white text on solid accent fill; no on-color token yet
          }}
        >
          {t('log.follow')} {follow ? '◉' : '○'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{t('log.entriesCount', { count: logs.length })}</span>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connected ? 'var(--success)' : 'var(--text-dim)',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: 'var(--font-2xs)', color: connected ? 'var(--success)' : 'var(--text-dim)' }}>
            {connected ? t('log.live') : t('log.connecting')}
          </span>
        </div>
      </div>
    </div>
  );
}
