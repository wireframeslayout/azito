import { useCallback, useMemo, useState } from 'react';
import type { MuxDriverKind } from '@azito/shared';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { Server, Session } from '../../../hooks/useServerManagement';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { terminalRefFromWindow, terminalRefDisplayLabel, terminalTabId, resolveTerminalTarget, paneDeletePath, windowKillRequest, type TerminalRef } from '../../../lib/terminalRef';
import { stripPaneSuffix } from '@azito/shared';
import { resolveWindowDisplay, formatWindowDisplayLabel, sessionWindowLabel, type WindowIndexEntry } from '../../../lib/windowDisplay';
import { preferredPaneOrdinal } from '../../../lib/paneState';
import { refUsesMuxRoutes } from '../../../lib/sessionKind';
import { muxCreateFailureText } from '../../../lib/muxKindChoice';
import { errorMessageOf } from '../../../lib/apiResult';
import { useConfirm } from '../../../hooks/useConfirm';
import { useToast } from '../../../hooks/useToast';
import WindowTreePopover from '../WindowTreePopover';
import CreateSessionModal from '../CreateSessionModal';
import { TerminalContainer } from '../../TerminalContainer';
import { EmptyState } from '../../ui';
import { Icon } from '../../ui/Icon';

interface WindowsSectionProps {
  server: Server;
  sessions: Session[];
  refresh: () => void;
  windowById: Map<number, WindowIndexEntry>;
  taskById: Map<number, { title?: string }>;
  windowMetaError?: boolean;
}

export default function WindowsSection({ server, sessions, refresh, windowById, taskById, windowMetaError = false }: WindowsSectionProps) {
  const { t } = useTranslation('servers');
  const { t: tw } = useTranslation('workspace');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const isMobile = useIsMobile();
  const [showTree, setShowTree] = useState(false);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [selectedRef, setSelectedRef] = useState<TerminalRef | null>(null);

  const firstRef = useMemo<TerminalRef | null>(() => {
    for (const sess of sessions) {
      for (const win of sess.windows) {
        return terminalRefFromWindow(server.name, win.windowId, win.ref, preferredPaneOrdinal(win) ?? 1);
      }
    }
    return null;
  }, [sessions, server.name]);

  const activeRef = selectedRef ?? firstRef;

  const activeLabel = useMemo(() => {
    if (!activeRef) return null;
    if (activeRef.kind === 'windowId') {
      const sessWin = sessions.flatMap(s => s.windows).find(w => w.windowId === activeRef.windowId);
      const pane = sessWin
        ? (activeRef.pane != null ? sessWin.panes.find(p => p.index === activeRef.pane) : undefined) ?? sessWin.panes[0]
        : undefined;
      const regWin = windowById.get(activeRef.windowId);
      const display = resolveWindowDisplay({
        windowId: activeRef.windowId,
        paneTitle: pane?.title,
        paneCommand: pane?.command,
        label: regWin?.label,
        workerType: regWin?.workerType,
        windowType: regWin?.windowType,
        taskTitle: regWin?.taskId != null ? taskById.get(regWin.taskId)?.title : undefined,
        tmuxTarget: sessWin ? sessionWindowLabel(sessions.find(s => s.windows.includes(sessWin!))!.name, sessWin) : undefined,
      });
      return formatWindowDisplayLabel(display);
    }
    const sessWin = sessions.flatMap((s) => s.windows.map((w) => ({ sessionName: s.name, win: w }))).find(({ win }) => win.ref === activeRef.ref);
    if (sessWin) return sessionWindowLabel(sessWin.sessionName, sessWin.win);
    const resolved = resolveTerminalTarget(activeRef, sessions);
    if (resolved) return stripPaneSuffix(resolved);
    return terminalRefDisplayLabel(activeRef);
  }, [activeRef, sessions, windowById, taskById]);

  const handleSelect = useCallback((ref: TerminalRef) => {
    setSelectedRef(ref);
    setShowTree(false);
  }, []);

  // Creation always goes through the mux routes with an explicit kind: a new session in the kind the user picked,
  // a new window in the kind of the session it is added to. A refusal comes back as a body, shown as text.
  const failureText = useCallback((res: unknown): string | null => muxCreateFailureText(res, tw), [tw]);

  const handleCreateSession = useCallback(async (name: string, kind: MuxDriverKind): Promise<string | null> => {
    const res = await api<unknown>(`/servers/${encodeURIComponent(server.name)}/mux/workspaces`, { method: 'POST', body: JSON.stringify({ name, kind }) });
    const failure = failureText(res);
    if (failure === null) refresh();
    return failure;
  }, [server.name, refresh, failureText]);

  const handleAddWindow = useCallback(async (sessionName: string, kind: MuxDriverKind) => {
    const res = await api<unknown>(`/servers/${encodeURIComponent(server.name)}/mux/workspaces/${encodeURIComponent(sessionName)}/windows`, { method: 'POST', body: JSON.stringify({ kind }) });
    const failure = failureText(res);
    if (failure !== null) {
      showToast(failure);
      return;
    }
    refresh();
  }, [server.name, refresh, failureText, showToast]);

  const handleSplitPane = useCallback(async (sessionName: string, windowName: string, direction: string, windowId?: number, ref?: string) => {
    if (windowId != null) {
      await api(`/windows/${windowId}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    } else if (refUsesMuxRoutes(ref)) {
      await api(`/servers/${encodeURIComponent(server.name)}/mux/windows/${encodeURIComponent(ref)}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    } else {
      await api(
        `/servers/${encodeURIComponent(server.name)}/sessions/${sessionName}/windows/${encodeURIComponent(windowName)}/panes`,
        { method: 'POST', body: JSON.stringify({ direction }) },
      );
    }
    refresh();
  }, [server.name, refresh]);

  // Deleting what is on screen leaves `selectedRef` pointing at a pane ordinal / window that is gone: fall back to the first window.
  const handleDeletePane = useCallback(async (ref: TerminalRef, label: string, handle?: string) => {
    const ok = await confirm({ title: t('confirm.killPane'), message: t('confirm.killPaneMessage', { name: label }), danger: true });
    if (!ok) return;
    try {
      const failure = errorMessageOf(await api<unknown>(paneDeletePath(ref, handle), { method: 'DELETE' }));
      if (failure) {
        showToast(failure);
        return;
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
      return;
    }
    setSelectedRef(null);
    refresh();
  }, [confirm, showToast, refresh, t]);

  const handleKillWindow = useCallback(async (ref: TerminalRef, label: string) => {
    const ok = await confirm({ title: t('confirm.killWindow'), message: t('confirm.killWindowMessage', { name: label }), danger: true });
    if (!ok) return;
    const { path, method } = windowKillRequest(ref);
    try {
      const failure = errorMessageOf(await api<unknown>(path, { method }));
      if (failure) {
        showToast(failure);
        return;
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
      return;
    }
    setSelectedRef(null);
    refresh();
  }, [confirm, showToast, refresh, t]);

  const metaErrorBar = windowMetaError ? (
    <div style={{ padding: '6px 12px', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
      {t('windows.metaFetchError')}
      <button onClick={refresh} className="icon-btn" style={{ fontSize: 'var(--font-xs)', color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
        {t('windows.retry')}
      </button>
    </div>
  ) : null;

  const createSessionModal = createSessionOpen ? (
    <CreateSessionModal
      server={server}
      onClose={() => setCreateSessionOpen(false)}
      onCreate={async (name, kind) => {
        const failure = await handleCreateSession(name, kind);
        if (failure === null) setCreateSessionOpen(false);
        return failure;
      }}
    />
  ) : null;

  if (sessions.length === 0) {
    return (
      <div>
        {metaErrorBar}
        {createSessionModal}
        <EmptyState title={t('windows.noSessions')} />
        <div style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
          <button
            onClick={() => setCreateSessionOpen(true)}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none', // lint-allow: hex - white text on solid accent fill; no on-color token yet
              borderRadius: 'var(--radius-md)', padding: '8px 20px',
              fontSize: 'var(--font-sm)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Icon name="plus" size={16} /> {t('windows.createSession')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {metaErrorBar}
      {createSessionModal}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-xs)',
      }}>
        <button
          onClick={() => setShowTree(!showTree)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg-card)',
            border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 12px',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-xs)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          {activeLabel ?? 'Select window'}
          <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-dim)' }}>
            <Icon name="chevron-down" size={14} rotate={showTree ? 180 : 0} />
          </span>
        </button>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {activeRef ? (
          <TerminalContainer
            key={terminalTabId(activeRef)}
            serverName={server.name}
            target={activeLabel ?? ''}
            terminalRef={activeRef}
            registeredWindow={activeRef.kind === 'windowId' ? windowById.get(activeRef.windowId) : undefined}
            sessions={sessions}
            onWindowChanged={refresh}
            onTargetRemoved={() => setSelectedRef(null)}
            onRetargetPane={(pane) => setSelectedRef({ ...activeRef, pane })}
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: '14px 16px', fontSize: 'var(--font-xs)' }}>{t('windows.noWindowSelected')}</div>
        )}
      </div>

      {showTree && (
        <WindowTreePopover
          sessions={sessions}
          serverName={server.name}
          selectedRef={activeRef}
          onSelect={handleSelect}
          onClose={() => setShowTree(false)}
          onCreateSession={() => setCreateSessionOpen(true)}
          onAddWindow={handleAddWindow}
          onSplitPane={handleSplitPane}
          onDeletePane={handleDeletePane}
          onKillWindow={handleKillWindow}
          isMobile={isMobile}
          windowById={windowById}
          taskById={taskById}
        />
      )}
    </div>
  );
}
