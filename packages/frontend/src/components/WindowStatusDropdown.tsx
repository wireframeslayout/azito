import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import type { Window, Task, Project } from '../pages/workspace/types';
import { useToast } from '../hooks/useToast';
import { useAgentDefinitions } from '../hooks/useAgentDefinitions';
import { AgentIcon } from './ui/AgentIcons';
import { Icon } from './ui/Icon';

interface WindowStatusDropdownProps {
  serverName: string;
  target: string;
  project: Project | null;
  allTasks: Task[];
  /** Owner context for registering an untracked window (task takes precedence). */
  taskId?: number;
  projectId?: number;
  onOpenTask?: (taskId: number, title: string) => void;
  /** Called after this dropdown registers a window or changes its type. */
  onChanged?: () => void;
}

export function findWindow(serverName: string, target: string, project: Project | null, allTasks: Task[]): Window | null {
  const targetBase = target.includes('.') ? target.split('.')[0] : target;

  if (project) {
    const match = project.windows.find((w) => {
      const wBase = w.tmuxTarget.includes('.') ? w.tmuxTarget.split('.')[0] : w.tmuxTarget;
      return w.serverName === serverName && wBase === targetBase;
    });
    if (match) return match;
  }

  for (const task of allTasks) {
    if (!task.windows) continue;
    const match = task.windows.find((w) => {
      const wBase = w.tmuxTarget.includes('.') ? w.tmuxTarget.split('.')[0] : w.tmuxTarget;
      return w.serverName === serverName && wBase === targetBase;
    });
    if (match) return match;
  }

  return null;
}

/** Real-data ownership check (Issue #28 Phase D-2) — a window is task-owned iff the `windows` row itself says so, never inferred from which screen happened to render it. */
export function isTaskOwnedWindow(win: Pick<Window, 'ownerType' | 'taskId'> | null | undefined): boolean {
  return !!win && win.ownerType === 'task' && win.taskId != null;
}

function findTaskForWindow(win: Window, allTasks: Task[]): Task | null {
  if (!isTaskOwnedWindow(win)) return null;
  return allTasks.find((t) => t.id === win.taskId) ?? null;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', gap: 12 }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
        {children}
      </span>
    </div>
  );
}

function ActionButton({ label, icon, onClick, loading }: { label: string; icon: React.ReactNode; onClick: () => void; loading?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={loading ? undefined : 'row-hover'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-sm)',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        color: loading ? 'var(--text-dim)' : 'var(--text)',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
      {loading ? 'Processing...' : label}
    </button>
  );
}

export function WindowStatusDropdown({ serverName, target, project, allTasks, taskId, projectId, onOpenTask, onChanged }: WindowStatusDropdownProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [editingType, setEditingType] = useState(false);
  const [selectedType, setSelectedType] = useState('terminal');
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const { agents: agentDefs } = useAgentDefinitions('worker');
  const typeOptions = [
    { value: 'terminal', label: 'terminal' },
    ...agentDefs.filter((d) => d.launchable).map((d) => ({ value: d.type, label: d.label })),
  ];

  const win = findWindow(serverName, target, project, allTasks);
  const task = win ? findTaskForWindow(win, allTasks) : null;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggle = useCallback(() => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const panelWidth = 300;
      const panelHeight = 280;
      const spaceBelow = window.innerHeight - rect.bottom;
      const right = Math.max(8, window.innerWidth - rect.right);
      const adjustedRight = Math.max(8, Math.min(right, window.innerWidth - panelWidth - 8));
      const vertical = spaceBelow < panelHeight
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 };
      setPanelStyle({ ...vertical, right: adjustedRight });
    }
    setOpen(!open);
  }, [open]);

  const handleCaptureSession = useCallback(async () => {
    if (!win) return;
    setActionLoading(true);
    try {
      const res = await api<{ agentSessionId?: string }>(`/windows/${win.id}/capture-session`, { method: 'POST' });
      showToast(res.agentSessionId ? `Session ID: ${res.agentSessionId.slice(0, 8)}...` : 'Session captured');
      onChanged?.();
    } catch (e) {
      showToast(`Failed: ${(e as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [win, showToast, onChanged]);

  const handleCapturePanes = useCallback(async () => {
    if (!win) return;
    setActionLoading(true);
    try {
      await api(`/windows/${win.id}/capture-panes`, { method: 'POST' });
      showToast('Pane layout captured');
      onChanged?.();
    } catch (e) {
      showToast(`Failed: ${(e as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [win, showToast, onChanged]);

  const handleCopySessionId = useCallback(() => {
    if (!win?.agentSessionId) return;
    navigator.clipboard.writeText(win.agentSessionId).then(() => {
      showToast('Copied to clipboard');
    });
  }, [win, showToast]);

  const handleChangeType = useCallback(async (newType: string) => {
    if (!win) return;
    setActionLoading(true);
    try {
      await api(`/windows/${win.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          window_type: newType === 'terminal' ? 'terminal' : 'agent',
          worker_type: newType === 'terminal' ? null : newType,
        }),
      });
      showToast('Window type updated');
      setEditingType(false);
      onChanged?.();
    } catch (e) {
      showToast(`Failed: ${(e as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [win, showToast, onChanged]);

  const handleRegister = useCallback(async () => {
    setActionLoading(true);
    try {
      const base = target.replace(/\.\d+$/, '');
      const body: Record<string, unknown> = {
        server_name: serverName,
        tmux_target: base,
        window_type: selectedType === 'terminal' ? 'terminal' : 'agent',
        worker_type: selectedType === 'terminal' ? null : selectedType,
      };
      const path = taskId ? `/tasks/${taskId}/windows` : `/projects/${projectId}/windows`;
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      showToast('Window registered');
      onChanged?.();
    } catch (e) {
      showToast(`Failed: ${(e as Error).message}`);
    } finally {
      setActionLoading(false);
    }
  }, [serverName, target, selectedType, taskId, projectId, showToast, onChanged]);

  const icon = win?.workerType ? <AgentIcon workerType={win.workerType} windowType="agent" size={13} /> : null;
  const label = win
    ? (win.windowType === 'agent' ? (win.workerType ?? 'agent') : 'terminal')
    : 'untracked';
  const triggerIcon = icon || (win ? '\u{2400}' : '?');

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Window status"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 'var(--radius-sm)', height: 24,
          border: '1px solid transparent', background: open ? 'var(--bg-hover, rgba(255,255,255,0.06))' : 'transparent',
          color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-sm)', whiteSpace: 'nowrap',
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        <span style={{ fontSize: 'var(--font-md)', display: 'inline-flex', alignItems: 'center' }}>{triggerIcon}</span>
        <span>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 1 }}><Icon name="chevron-down" size={14} /></span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'fixed', zIndex: 300,
            minWidth: 'min(280px, calc(100vw - 16px))', maxWidth: 'min(360px, calc(100vw - 16px))', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card, #1e1e2e)', border: '1px solid var(--border)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            overflow: 'hidden',
            ...panelStyle,
          }}
        >
          <div style={{
            padding: '8px 12px', borderBottom: '1px solid var(--border)',
            fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Window Status
          </div>

          {!win ? (
            <div style={{ padding: '12px' }}>
              <InfoRow label="Target">{target}</InfoRow>
              <InfoRow label="Status">
                <span style={{ color: 'var(--text-dim)' }}>not registered</span>
              </InfoRow>
              {(taskId || projectId) ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, marginTop: 8, borderTop: '1px solid var(--border)' }}>
                  <select
                    aria-label="Window type"
                    value={selectedType}
                    onChange={(e) => setSelectedType(e.target.value)}
                    disabled={actionLoading}
                    style={{
                      flex: 1, fontSize: 'var(--font-sm)', padding: '4px 6px', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
                    }}
                  >
                    {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <ActionButton icon={<Icon name="plus" size={16} />} label={`Register to ${taskId ? 'task' : 'project'}`} onClick={handleRegister} loading={actionLoading} />
                </div>
              ) : (
                <div style={{ paddingTop: 8, fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                  Open from a task or project to register this window.
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={{ padding: '8px 12px' }}>
                <InfoRow label="Window">
                  <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-xs)' }}>
                    {win.tmuxTarget.split(':')[1]?.split('.')[0] || win.tmuxTarget}
                  </span>
                </InfoRow>
                <InfoRow label="Type">
                  {editingType ? (
                    <select
                      aria-label="Window type"
                      value={win.windowType === 'agent' ? (win.workerType ?? 'terminal') : 'terminal'}
                      onChange={(e) => handleChangeType(e.target.value)}
                      disabled={actionLoading}
                      autoFocus
                      onBlur={() => setEditingType(false)}
                      style={{
                        fontSize: 'var(--font-sm)', padding: '2px 4px', borderRadius: 'var(--radius-sm)',
                        background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
                      }}
                    >
                      {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {icon && <span>{icon}</span>}
                      {win.windowType === 'agent' ? `${win.workerType}` : 'terminal'}
                      {win.workerModel && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>({win.workerModel.split('/').pop()?.split('[')[0]})</span>}
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingType(true); }}
                        title="Change window type"
                        aria-label="Change window type"
                        className="icon-btn"
                        style={{ border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 0, fontSize: 'var(--font-xs)' }}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                    </span>
                  )}
                </InfoRow>

                {win.agentSessionId && (
                  <InfoRow label="Session ID">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 'var(--font-xs)' }}>{win.agentSessionId.slice(0, 13)}...</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCopySessionId(); }}
                        title="Copy session ID"
                        className="icon-btn"
                        style={{ border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 0, fontSize: 'var(--font-sm)' }}
                      >
                        <Icon name="files" size={14} />
                      </button>
                    </span>
                  </InfoRow>
                )}
                {!win.agentSessionId && win.windowType === 'agent' && (
                  <InfoRow label="Session ID">
                    <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>not captured</span>
                  </InfoRow>
                )}

                {win.workingDirectory && (
                  <InfoRow label="Working Dir">
                    <span title={win.workingDirectory} style={{ fontFamily: 'monospace', fontSize: 'var(--font-xs)' }}>
                      {win.workingDirectory.length > 30 ? '...' + win.workingDirectory.slice(-28) : win.workingDirectory}
                    </span>
                  </InfoRow>
                )}

                <InfoRow label="Status">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
                    online
                  </span>
                </InfoRow>
              </div>

              {(project || task) && (
                <div style={{ padding: '4px 12px 8px', borderTop: '1px solid var(--border)' }}>
                  {project && (
                    <InfoRow label="Project">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Icon name="files" size={16} /> {project.name}
                      </span>
                    </InfoRow>
                  )}
                  <InfoRow label="Task">
                    {task ? (
                      <button
                        onClick={() => { onOpenTask?.(task.id, task.title); setOpen(false); }}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)',
                          padding: 0, fontSize: 'var(--font-sm)', display: 'inline-flex', alignItems: 'center', gap: 4,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                        }}
                        title={task.title}
                      >
                        <Icon name="tasks" size={16} /> #{task.id} {task.title.length > 20 ? task.title.slice(0, 20) + '...' : task.title} <Icon name="arrow-right" size={14} />
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text-dim)' }}>—</span>
                    )}
                  </InfoRow>
                </div>
              )}

              {win.windowType === 'agent' && (
                <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <ActionButton icon={<Icon name="refresh" size={16} />} label="Capture Session" onClick={handleCaptureSession} loading={actionLoading} />
                  <ActionButton icon={<Icon name="camera" size={16} />} label="Capture Panes" onClick={handleCapturePanes} loading={actionLoading} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
