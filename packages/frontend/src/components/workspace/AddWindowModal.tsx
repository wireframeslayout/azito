import React from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import FormField from '../FormField';
import DirectoryInput from '../DirectoryInput';
import { FormInput, FormSelect, baseInputStyle, Button } from '../ui';
import { api } from '../../api/client';
import type { Server, Session } from '../../pages/workspace/types';

interface AddWindowModalProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  onSubmit: () => void;
  awMode: 'existing' | 'session' | 'new';
  setAwMode: (mode: 'existing' | 'session' | 'new') => void;
  awServer: string;
  setAwServer: (server: string) => void;
  awTarget: string;
  setAwTarget: (target: string) => void;
  awLabel: string;
  setAwLabel: (label: string) => void;
  awSessionData: Record<string, Session[]>;
  setAwSessionData: (data: Record<string, Session[]>) => void;
  awSelectedSession: string;
  setAwSelectedSession: (session: string) => void;
  awNewSession: string;
  awNewWindowName: string;
  setAwNewWindowName: (name: string) => void;
  awNewCommand: string;
  setAwNewCommand: (command: string) => void;
  awWorkDir: string;
  setAwWorkDir: (dir: string) => void;
  awAgent: string;
  onAgentChange: (agent: string) => void;
  awAgentModel: string;
  setAwAgentModel: (model: string) => void;
  awWorkerModels: { id: string; label: string }[];
  agentPresets: Record<string, { command: string; label: string }>;
  agentPresetsLoading?: boolean;
  agentPresetsError?: string | null;
  servers: Server[];
  projectServers: { serverName: string; workingDirectory?: string }[];
  project: { workingDirectory?: string } | null;
}

function getWindowTargets(awSessionData: Record<string, Session[]>, awServer: string): { value: string; label: string }[] {
  const sessions = awSessionData[awServer] || [];
  const targets: { value: string; label: string }[] = [];
  for (const s of sessions) {
    for (const w of s.windows) {
      targets.push({ value: `${s.name}:${w.index}`, label: `${s.name} / ${w.index}: ${w.name} (${w.panes.length} panes)` });
    }
  }
  return targets;
}

export default function AddWindowModal({
  open, onClose, loading, onSubmit,
  awMode, setAwMode,
  awServer, setAwServer,
  awTarget, setAwTarget,
  awLabel, setAwLabel,
  awSessionData, setAwSessionData,
  awSelectedSession, setAwSelectedSession,
  awNewSession,
  awNewWindowName, setAwNewWindowName,
  awNewCommand, setAwNewCommand,
  awWorkDir, setAwWorkDir,
  awAgent, onAgentChange,
  awAgentModel, setAwAgentModel,
  awWorkerModels,
  agentPresets,
  agentPresetsLoading,
  agentPresetsError,
  servers, projectServers, project,
}: AddWindowModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <Modal title={t('addWindow.title')} open={open} onClose={onClose} actions={<Button variant="primary" onClick={onSubmit} loading={loading} loadingLabel={t('addWindow.adding')}>{awMode === 'new' ? t('addWindow.createAndAdd') : awMode === 'session' ? t('addWindow.addAllWindows') : t('addWindow.add')}</Button>}>
      {awMode === 'new' ? (
        <>
          {projectServers.length > 1 && (
            <FormField label={t('addWindow.server')}>
              <FormSelect value={awServer} onChange={(e) => {
                setAwServer(e.target.value);
                const ps = projectServers.find((p) => p.serverName === e.target.value);
                setAwWorkDir(ps?.workingDirectory || project?.workingDirectory || '');
              }}>
                {(projectServers.length > 0 ? servers.filter((s) => projectServers.some((ps) => ps.serverName === s.name)) : servers).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </FormSelect>
            </FormField>
          )}
          {projectServers.length <= 1 && awServer && (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>{t('addWindow.serverLabel')}{awServer}</div>
          )}
          <FormField label={t('addWindow.session')}>
            <FormInput value={awNewSession} readOnly style={{ opacity: 0.7, cursor: 'default' }} />
          </FormField>
          <FormField label={t('addWindow.windowName')}>
            <FormInput value={awNewWindowName} onChange={(e) => setAwNewWindowName(e.target.value)} placeholder={t('addWindow.windowNamePlaceholder')} />
          </FormField>
          <FormField label={t('addWindow.workingDir')}>
            <DirectoryInput
              value={awWorkDir}
              onChange={setAwWorkDir}
              serverName={awServer}
              placeholder={t('addWindow.workingDirPlaceholder')}
              style={baseInputStyle}
            />
          </FormField>
          <FormField label={t('addWindow.codingAgent')} hint={t('addWindow.agentHint')}>
            <FormSelect value={awAgent} onChange={(e) => onAgentChange(e.target.value)} disabled={agentPresetsLoading || !!agentPresetsError}>
              {agentPresetsLoading
                ? <option value="none">{t('addWindow.loadingAgents')}</option>
                : agentPresetsError
                  ? <option value="none">{t('addWindow.noneShellOnly')}</option>
                  : Object.entries(agentPresets).map(([key, val]) => (
                    <option key={key} value={key}>{val.label}</option>
                  ))}
            </FormSelect>
            {agentPresetsError && (
              <div role="alert" style={{
                marginTop: 6, padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)',
                color: 'var(--danger)', fontSize: 'var(--font-sm)',
              }}>
                {t('addWindow.failedLoadAgents', { error: agentPresetsError })}
              </div>
            )}
          </FormField>
          {awAgent !== 'none' && awAgent !== 'custom' && awWorkerModels.length > 0 && (
            <FormField label={t('addWindow.model')}>
              <FormSelect value={awAgentModel} onChange={(e) => setAwAgentModel(e.target.value)}>
                <option value="">{t('common:labels.default')}</option>
                {awWorkerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </FormSelect>
            </FormField>
          )}
          {awAgent === 'custom' && (
            <FormField label={t('addWindow.customCommand')}>
              <FormInput value={awNewCommand} onChange={(e) => setAwNewCommand(e.target.value)} placeholder={t('addWindow.customCommandPlaceholder')} />
            </FormField>
          )}
          <FormField label={t('addWindow.label')} hint={t('addWindow.labelHint')}>
            <FormInput value={awLabel} onChange={(e) => setAwLabel(e.target.value)} placeholder={t('addWindow.labelPlaceholder')} />
          </FormField>
        </>
      ) : awMode === 'existing' ? (
        <>
          <FormField label={t('addWindow.server')}>
            <FormSelect value={awServer} onChange={(e) => setAwServer(e.target.value)}>
              {servers.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </FormSelect>
          </FormField>
          <FormField label={t('addWindow.window')}>
            <FormSelect value={awTarget} onChange={(e) => setAwTarget(e.target.value)}>
              <option value="">{t('addWindow.selectWindow')}</option>
              {getWindowTargets(awSessionData, awServer).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </FormSelect>
          </FormField>
          <FormField label={t('addWindow.label')} hint={t('addWindow.labelHint')}>
            <FormInput value={awLabel} onChange={(e) => setAwLabel(e.target.value)} placeholder={t('addWindow.labelPlaceholder')} />
          </FormField>
        </>
      ) : (
        <>
          <FormField label={t('addWindow.server')}>
            <FormSelect value={awServer} onChange={(e) => setAwServer(e.target.value)}>
              {servers.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </FormSelect>
          </FormField>
          <FormField label={t('addWindow.session')} hint={t('addWindow.sessionHint')}>
            <FormSelect value={awSelectedSession} onChange={(e) => setAwSelectedSession(e.target.value)}>
              <option value="">{t('addWindow.selectSession')}</option>
              {(awSessionData[awServer] || []).map((s) => (
                <option key={s.name} value={s.name}>{t('addWindow.sessionWindowCount', { name: s.name, count: s.windows.length })}</option>
              ))}
            </FormSelect>
          </FormField>
          {awSelectedSession && (() => {
            const sess = (awSessionData[awServer] || []).find((s) => s.name === awSelectedSession);
            if (!sess) return null;
            return (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-md)' }}>
                <div style={{ fontWeight: 500, marginBottom: 6, color: 'var(--text-dim)' }}>{t('addWindow.windowsToAdd')}</div>
                {sess.windows.map((w) => (
                  <div key={w.index} style={{ padding: '3px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', width: 20, textAlign: 'right' }}>{w.index}:</span>
                    <span>{w.name}</span>
                    <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>({w.panes.length} pane{w.panes.length !== 1 ? 's' : ''})</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      )}

      {awMode === 'new' && (
        <details style={{ marginTop: 12, fontSize: 'var(--font-md)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', userSelect: 'none' }}>
            {t('addWindow.importAdvanced')}
          </summary>
          <div style={{ display: 'flex', gap: 4, marginTop: 8, marginBottom: 8 }}>
            {(['existing', 'session'] as const).map((m) => (
              <button key={m} onClick={async () => {
                const missingServers = servers.filter((s) => !awSessionData[s.name]);
                if (missingServers.length > 0) {
                  const data = { ...awSessionData };
                  for (const srv of missingServers) {
                    try { const s = await api<Session[]>(`/servers/${srv.name}/sessions`); if (Array.isArray(s)) data[srv.name] = s; } catch {}
                  }
                  setAwSessionData(data);
                }
                setAwMode(m);
              }}
                style={{ flex: 1, padding: '6px 10px', fontSize: 'var(--font-sm)', fontWeight: 500, cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-dim)' }}>
                {m === 'existing' ? t('addWindow.singleWindow') : t('addWindow.entireSession')}
              </button>
            ))}
          </div>
        </details>
      )}
      {awMode !== 'new' && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setAwMode('new')}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: 0 }}>
            &larr; {t('addWindow.backToNew')}
          </button>
        </div>
      )}
    </Modal>
  );
}
