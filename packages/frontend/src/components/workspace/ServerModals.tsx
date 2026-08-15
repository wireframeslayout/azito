import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { FormInput, FormSelect, InstallSteps, Button } from '../ui';
import FormField from '../FormField';
import type { InstallStep } from '../ui';
import type { Server } from '../../hooks/useServerManagement';

interface ServerFormFieldsProps {
  mode: 'add' | 'edit';
  autoInstall: boolean;
  type: 'agent';
  host: string;
  port: string;
  token: string;
  muxRuntime: 'system' | 'managed';
  onAutoInstallChange: (v: boolean) => void;
  onTypeChange: (v: 'agent') => void;
  onHostChange: (v: string) => void;
  onPortChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onMuxRuntimeChange: (v: 'system' | 'managed') => void;
  nameField?: React.ReactNode;
  tokenPlaceholder?: string;
  installSteps?: InstallStep[];
  originalMuxRuntime?: 'system' | 'managed';
  // Issue #29 review (3rd pass), Important finding 4: only meaningful — and
  // only rendered — in edit mode for an agent-type server (mirrors the
  // server-side gate in servers/routes.ts: isolationIntent is rejected
  // outright for any other effective type). Undefined in add mode, where
  // isolation declaration is intentionally out of scope for this change.
  isolationIntent?: boolean;
  onIsolationIntentChange?: (v: boolean) => void;
}

function ServerFormFields({ mode, autoInstall, type, host, port, token, muxRuntime, onAutoInstallChange, onTypeChange, onHostChange, onPortChange, onTokenChange, onMuxRuntimeChange, nameField, tokenPlaceholder, installSteps, originalMuxRuntime, isolationIntent, onIsolationIntentChange }: ServerFormFieldsProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const [showToken, setShowToken] = useState(false);

  if (mode === 'add' && autoInstall) {
    return (
      <>
        {nameField}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.host')}</label>
          <FormInput value={host} onChange={(e) => onHostChange(e.target.value)} placeholder={t('serverModals.hostPlaceholder')} autoComplete="off" />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer', marginBottom: 14 }}>
          <label className="toggle">
            <input type="checkbox" checked={autoInstall} onChange={(e) => onAutoInstallChange(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
          {t('serverModals.autoInstall')}
        </label>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
          {t('serverModals.autoInstallDesc')}<br />
          {t('serverModals.autoInstallReq')}
        </div>
        {installSteps && installSteps.length > 0 && <InstallSteps steps={installSteps} />}
      </>
    );
  }

  return (
    <>
      {nameField}
      {mode === 'add' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer', marginBottom: 14 }}>
          <label className="toggle">
            <input type="checkbox" checked={autoInstall} onChange={(e) => onAutoInstallChange(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
          {t('serverModals.autoInstall')}
        </label>
      )}
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.type')}</label>
        <select value={type} onChange={(e) => onTypeChange(e.target.value as 'agent')} style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: 'var(--font-md)' }}>
          <option value="agent">{t('serverModals.agent')}</option>
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.host')}</label>
        <FormInput value={host} onChange={(e) => onHostChange(e.target.value)} placeholder={type === 'agent' ? t('serverModals.agentHostPlaceholder') : t('serverModals.hostPlaceholder')} autoComplete="off" />
      </div>
      {type === 'agent' && (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.port')}</label>
            <FormInput value={port} onChange={(e) => onPortChange(e.target.value)} placeholder={t('serverModals.portPlaceholder')} autoComplete="off" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.token')}</label>
            <div style={{ position: 'relative' }}>
              <FormInput type={showToken ? 'text' : 'password'} value={token} onChange={(e) => onTokenChange(e.target.value)} placeholder={tokenPlaceholder ?? t('serverModals.tokenPlaceholder')} autoComplete="off" style={{ paddingRight: 40 }} />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                title={showToken ? t('serverModals.hideToken') : t('serverModals.showToken')}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-lg)', padding: '2px 4px', lineHeight: 1 }}
              >
                {showToken ? '◉' : '◎'}
              </button>
            </div>
          </div>
        </>
      )}
      <FormField label={t('serverModals.muxRuntime')}>
        <FormSelect value={muxRuntime} onChange={(e) => onMuxRuntimeChange(e.target.value as 'system' | 'managed')}>
          <option value="system">{t('serverModals.muxSystem')}</option>
          <option value="managed">{t('serverModals.muxManaged')}</option>
        </FormSelect>
      </FormField>
      {mode === 'edit' && originalMuxRuntime && muxRuntime !== originalMuxRuntime && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--warning, #f0ad4e)', padding: '8px 10px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', marginBottom: 14 }}>
          {t('serverModals.muxMigrationWarning')}
        </div>
      )}
      {mode === 'edit' && type === 'agent' && onIsolationIntentChange && (
        <FormField label={t('serverModals.isolationIntent')}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer' }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={isolationIntent ?? false}
                onChange={(e) => onIsolationIntentChange(e.target.checked)}
                aria-describedby="server-modal-isolation-intent-hint"
              />
              <span className="toggle-slider" />
            </label>
            {t('serverModals.isolationIntentLabel')}
          </label>
          <div id="server-modal-isolation-intent-hint" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
            {t('serverModals.isolationIntentHint')}
          </div>
        </FormField>
      )}
    </>
  );
}

interface AddServerModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  loading: boolean;
  name: string;
  onNameChange: (v: string) => void;
  autoInstall: boolean;
  onAutoInstallChange: (v: boolean) => void;
  type: 'agent';
  onTypeChange: (v: 'agent') => void;
  host: string;
  onHostChange: (v: string) => void;
  port: string;
  onPortChange: (v: string) => void;
  token: string;
  onTokenChange: (v: string) => void;
  muxRuntime: 'system' | 'managed';
  onMuxRuntimeChange: (v: 'system' | 'managed') => void;
  installSteps: InstallStep[];
}

export function AddServerModal({
  open, onClose, onSubmit, loading,
  name, onNameChange,
  autoInstall, onAutoInstallChange,
  type, onTypeChange,
  host, onHostChange,
  port, onPortChange,
  token, onTokenChange,
  muxRuntime, onMuxRuntimeChange,
  installSteps,
}: AddServerModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <Modal title={t('serverModals.addTitle')} open={open} onClose={onClose} actions={<Button variant="primary" onClick={onSubmit} loading={loading} loadingLabel={t('serverModals.installing')}>{t('common:actions.add')}</Button>}>
      <ServerFormFields
        mode="add"
        autoInstall={autoInstall}
        type={type} host={host} port={port} token={token} muxRuntime={muxRuntime}
        onAutoInstallChange={onAutoInstallChange}
        onTypeChange={onTypeChange} onHostChange={onHostChange} onPortChange={onPortChange} onTokenChange={onTokenChange} onMuxRuntimeChange={onMuxRuntimeChange}
        installSteps={installSteps}
        nameField={
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.displayName')}</label>
            <FormInput value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={t('serverModals.displayNamePlaceholder')} autoComplete="off" />
          </div>
        }
      />
    </Modal>
  );
}

interface EditServerModalProps {
  server: Server | null;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  type: 'agent';
  onTypeChange: (v: 'agent') => void;
  host: string;
  onHostChange: (v: string) => void;
  port: string;
  onPortChange: (v: string) => void;
  token: string;
  onTokenChange: (v: string) => void;
  muxRuntime: 'system' | 'managed';
  onMuxRuntimeChange: (v: 'system' | 'managed') => void;
  isolationIntent: boolean;
  onIsolationIntentChange: (v: boolean) => void;
}

export function EditServerModal({
  server, onClose, onSubmit,
  type, onTypeChange,
  host, onHostChange,
  port, onPortChange,
  token, onTokenChange,
  muxRuntime, onMuxRuntimeChange,
  isolationIntent, onIsolationIntentChange,
}: EditServerModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <Modal title={t('serverModals.editTitle', { name: server?.name ?? '' })} open={server !== null} onClose={onClose} actions={<Button variant="primary" onClick={onSubmit}>{t('common:actions.save')}</Button>}>
      <ServerFormFields
        mode="edit"
        autoInstall={false}
        type={type} host={host} port={port} token={token} muxRuntime={muxRuntime}
        onAutoInstallChange={() => {}}
        onTypeChange={onTypeChange} onHostChange={onHostChange} onPortChange={onPortChange} onTokenChange={onTokenChange} onMuxRuntimeChange={onMuxRuntimeChange}
        tokenPlaceholder={server?.hasAgentToken ? t('serverModals.tokenUnchanged') : t('serverModals.tokenPlaceholder')}
        originalMuxRuntime={server?.muxRuntime}
        isolationIntent={isolationIntent}
        onIsolationIntentChange={onIsolationIntentChange}
      />
    </Modal>
  );
}
