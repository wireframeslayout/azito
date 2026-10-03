import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { FormInput, FormSelect, InstallSteps, Button } from '../ui';
import FormField from '../FormField';
import type { InstallStep } from '../ui';
import type { Server } from '../../hooks/useServerManagement';
import { useHealth } from '../../hooks/useHealth';
import type { MuxDriverKind, MuxRuntime } from '@azito/shared';
import { defaultMuxNotice, defaultMuxOptions, tmuxRuntimeNotice, TMUX_RUNTIME_OPTIONS, type DefaultMuxNotice } from '../../lib/muxRuntimeForm';

interface ServerFormFieldsProps {
  mode: 'add' | 'edit';
  autoInstall: boolean;
  type: 'agent';
  /** The edited server's type; decides whether the default mux is offered and whether connection fields apply. Add mode is always an agent. */
  serverType: string;
  host: string;
  port: string;
  token: string;
  muxRuntime: MuxRuntime;
  /** Default mux kind; only edited for a local server (the field is hidden when the server type offers no choice). */
  defaultMux?: MuxDriverKind;
  onDefaultMuxChange?: (v: MuxDriverKind) => void;
  onAutoInstallChange: (v: boolean) => void;
  onTypeChange: (v: 'agent') => void;
  onHostChange: (v: string) => void;
  onPortChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onMuxRuntimeChange: (v: MuxRuntime) => void;
  nameField?: React.ReactNode;
  tokenPlaceholder?: string;
  installSteps?: InstallStep[];
  originalMuxRuntime?: MuxRuntime;
  originalDefaultMux?: MuxDriverKind;
  // Issue #29 review (3rd pass), Important finding 4: only meaningful — and
  // only rendered — in edit mode for an agent-type server (mirrors the
  // server-side gate in servers/routes.ts: isolationIntent is rejected
  // outright for any other effective type). Undefined in add mode, where
  // isolation declaration is intentionally out of scope for this change.
  isolationIntent?: boolean;
  onIsolationIntentChange?: (v: boolean) => void;
  // Issue #29 review (Minor finding, isolation doctor pass): the PERSISTED
  // value (the server entity's own `isolationIntent`, as loaded when the
  // edit modal opened — see useServerManagement.ts's `setEditIsolationIntent
  // (srv.isolationIntent ?? false)`), distinct from `isolationIntent` above
  // which is the live, in-progress FORM value. Disabling the toggle must be
  // driven by what is actually saved server-side right now, never by the
  // form's own unsaved edits — otherwise unchecking an already-isolated
  // server's toggle (to preview turning it off) immediately re-locks the
  // checkbox via `isolationToggleBlocked` before Save is even pressed, with
  // no way to change your mind and re-check it inside the same modal
  // session. Undefined in add mode, matching `isolationIntent` above.
  persistedIsolationIntent?: boolean;
}

interface MuxFieldsProps {
  serverType: string;
  defaultMux?: MuxDriverKind;
  onDefaultMuxChange?: (v: MuxDriverKind) => void;
  /** Persisted default mux; when it differs from `defaultMux` a note is shown (entering or leaving misao). Omitted in add mode. */
  originalDefaultMux?: MuxDriverKind;
  muxRuntime: MuxRuntime;
  onMuxRuntimeChange: (v: MuxRuntime) => void;
  /** Persisted tmux runtime; when it differs from `muxRuntime` a socket migration note is shown. Omitted in add mode. */
  originalMuxRuntime?: MuxRuntime;
}

const DEFAULT_MUX_LABEL_KEY: Record<MuxDriverKind, string> = {
  misao: 'serverModals.defaultMuxMisao',
  tmux: 'serverModals.defaultMuxTmux',
};

const MUX_RUNTIME_LABEL_KEY: Record<MuxRuntime, string> = {
  system: 'serverModals.muxSystem',
  managed: 'serverModals.muxManaged',
};

const DEFAULT_MUX_NOTICE_KEY: Record<DefaultMuxNotice, string> = {
  enterMisao: 'serverModals.misaoHint',
  leaveMisao: 'serverModals.misaoLeaveNote',
};

function MuxNotice({ id, tone, children }: { id: string; tone: 'info' | 'warning'; children: React.ReactNode }) {
  return (
    <div
      id={id}
      role="status"
      style={{ fontSize: 'var(--font-sm)', color: tone === 'info' ? 'var(--text-dim)' : 'var(--warning, #f0ad4e)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', marginBottom: 14 }}
    >
      {children}
    </div>
  );
}

/** Two independent fields: which mux a (local) server uses by default, and which tmux binary it runs. */
function MuxFields({ serverType, defaultMux, onDefaultMuxChange, originalDefaultMux, muxRuntime, onMuxRuntimeChange, originalMuxRuntime }: MuxFieldsProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const defaultMuxNoticeId = useId();
  const runtimeNoticeId = useId();
  const kindOptions = defaultMuxOptions(serverType);
  const kindNotice = defaultMux ? defaultMuxNotice(originalDefaultMux, defaultMux) : null;
  const runtimeNotice = tmuxRuntimeNotice(originalMuxRuntime, muxRuntime);
  return (
    <>
      {defaultMux && onDefaultMuxChange && kindOptions.length > 1 && (
        <>
          <FormField label={t('serverModals.defaultMux')}>
            <FormSelect
              value={defaultMux}
              onChange={(e) => onDefaultMuxChange(e.target.value as MuxDriverKind)}
              aria-describedby={kindNotice ? defaultMuxNoticeId : undefined}
            >
              {kindOptions.map((option) => <option key={option} value={option}>{t(DEFAULT_MUX_LABEL_KEY[option])}</option>)}
            </FormSelect>
          </FormField>
          {kindNotice && <MuxNotice id={defaultMuxNoticeId} tone={kindNotice === 'enterMisao' ? 'info' : 'warning'}>{t(DEFAULT_MUX_NOTICE_KEY[kindNotice])}</MuxNotice>}
        </>
      )}
      <FormField label={t('serverModals.muxRuntime')}>
        <FormSelect
          value={muxRuntime}
          onChange={(e) => onMuxRuntimeChange(e.target.value as MuxRuntime)}
          aria-describedby={runtimeNotice ? runtimeNoticeId : undefined}
        >
          {TMUX_RUNTIME_OPTIONS.map((option) => <option key={option} value={option}>{t(MUX_RUNTIME_LABEL_KEY[option])}</option>)}
        </FormSelect>
      </FormField>
      {runtimeNotice && <MuxNotice id={runtimeNoticeId} tone="warning">{t('serverModals.muxMigrationWarning')}</MuxNotice>}
    </>
  );
}

function ServerFormFields({ mode, autoInstall, type, serverType, host, port, token, muxRuntime, defaultMux, onDefaultMuxChange, onAutoInstallChange, onTypeChange, onHostChange, onPortChange, onTokenChange, onMuxRuntimeChange, nameField, tokenPlaceholder, installSteps, originalMuxRuntime, originalDefaultMux, isolationIntent, onIsolationIntentChange, persistedIsolationIntent }: ServerFormFieldsProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const [showToken, setShowToken] = useState(false);
  // Issue #29 Step 2 C-1 (client-side courtesy — the real enforcement is the
  // server's 409 on PUT /api/servers/:name): a server not yet declaring
  // isolation cannot be switched ON while scoped auth is confirmed off,
  // because the API authorization gate only audit-logs what it would deny
  // in that mode (see routes.ts's isolation_intent_requires_scoped_auth
  // gate). An already-isolated server (isolationIntent already true) must
  // stay toggle-able OFF regardless — disabling isolation is never blocked.
  // `scopedAuthEnabled === null` (health not loaded yet) is treated as "not
  // confirmed off", so the toggle stays enabled until we positively know
  // it would be rejected.
  //
  // `checked` uses the live form value (isolationIntent) so the checkbox
  // reflects what the user is currently editing; `disabled` uses the
  // PERSISTED value (persistedIsolationIntent) so unchecking an
  // already-isolated server doesn't strand the toggle in a disabled state
  // before the edit is saved — see persistedIsolationIntent's doc comment
  // above.
  const { scopedAuthEnabled } = useHealth();
  const muxField = (
    <MuxFields
      serverType={serverType}
      defaultMux={defaultMux}
      onDefaultMuxChange={onDefaultMuxChange}
      originalDefaultMux={mode === 'edit' ? originalDefaultMux : undefined}
      muxRuntime={muxRuntime}
      onMuxRuntimeChange={onMuxRuntimeChange}
      originalMuxRuntime={mode === 'edit' ? originalMuxRuntime : undefined}
    />
  );
  // A local server has no connection settings: the only editable things are its mux settings.
  if (mode === 'edit' && serverType === 'local') return muxField;
  const isolationCurrentlyOn = isolationIntent ?? false;
  const isolationPersistedOn = persistedIsolationIntent ?? false;
  const isolationToggleBlocked = scopedAuthEnabled === false && !isolationPersistedOn;

  if (mode === 'add' && autoInstall) {
    return (
      <>
        {nameField}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{t('serverModals.host')}</label>
          <FormInput value={host} onChange={(e) => onHostChange(e.target.value)} placeholder={t('serverModals.hostPlaceholder')} autoComplete="off" />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer', marginBottom: 14 }}>
          {/* Issue #29 review (8th pass), Minor finding: a <label> nested
              inside another <label> is invalid HTML (only the outer one can
              legitimately toggle the input; a nested one is ambiguous/
              ignored by browsers and assistive tech). This inner element
              exists purely for the `.toggle`/`.toggle-slider` sibling-selector
              CSS (global.css) — it doesn't need to be a label at all, since
              the outer <label> already associates the checkbox by
              containment. */}
          <span className="toggle">
            <input type="checkbox" checked={autoInstall} onChange={(e) => onAutoInstallChange(e.target.checked)} />
            <span className="toggle-slider" />
          </span>
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
          {/* Issue #29 review (8th pass), Minor finding: a <label> nested
              inside another <label> is invalid HTML (only the outer one can
              legitimately toggle the input; a nested one is ambiguous/
              ignored by browsers and assistive tech). This inner element
              exists purely for the `.toggle`/`.toggle-slider` sibling-selector
              CSS (global.css) — it doesn't need to be a label at all, since
              the outer <label> already associates the checkbox by
              containment. */}
          <span className="toggle">
            <input type="checkbox" checked={autoInstall} onChange={(e) => onAutoInstallChange(e.target.checked)} />
            <span className="toggle-slider" />
          </span>
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
      {muxField}
      {mode === 'edit' && type === 'agent' && onIsolationIntentChange && (
        <FormField label={t('serverModals.isolationIntent')}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer' }}>
            {/* Issue #29 review (8th pass), Minor finding: same
                nested-<label> fix as the autoInstall toggles above — the
                inner element is CSS-only styling, not a second label. */}
            <span className="toggle">
              <input
                type="checkbox"
                checked={isolationCurrentlyOn}
                disabled={isolationToggleBlocked}
                onChange={(e) => onIsolationIntentChange(e.target.checked)}
                aria-describedby="server-modal-isolation-intent-hint"
              />
              <span className="toggle-slider" />
            </span>
            {t('serverModals.isolationIntentLabel')}
          </label>
          <div id="server-modal-isolation-intent-hint" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
            {t('serverModals.isolationIntentHint')}
          </div>
          {isolationToggleBlocked && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--warning, #f0ad4e)', marginTop: 6 }}>
              {t('serverModals.isolationRequiresScopedAuth')}
            </div>
          )}
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
  muxRuntime: MuxRuntime;
  onMuxRuntimeChange: (v: MuxRuntime) => void;
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
        type={type} serverType="agent" host={host} port={port} token={token} muxRuntime={muxRuntime}
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
  muxRuntime: MuxRuntime;
  onMuxRuntimeChange: (v: MuxRuntime) => void;
  defaultMux: MuxDriverKind;
  onDefaultMuxChange: (v: MuxDriverKind) => void;
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
  defaultMux, onDefaultMuxChange,
  isolationIntent, onIsolationIntentChange,
}: EditServerModalProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <Modal title={t('serverModals.editTitle', { name: server?.name ?? '' })} open={server !== null} onClose={onClose} actions={<Button variant="primary" onClick={onSubmit}>{t('common:actions.save')}</Button>}>
      <ServerFormFields
        mode="edit"
        autoInstall={false}
        type={type} serverType={server?.type ?? 'agent'} host={host} port={port} token={token} muxRuntime={muxRuntime} defaultMux={defaultMux} onDefaultMuxChange={onDefaultMuxChange}
        onAutoInstallChange={() => {}}
        onTypeChange={onTypeChange} onHostChange={onHostChange} onPortChange={onPortChange} onTokenChange={onTokenChange} onMuxRuntimeChange={onMuxRuntimeChange}
        tokenPlaceholder={server?.hasAgentToken ? t('serverModals.tokenUnchanged') : t('serverModals.tokenPlaceholder')}
        originalMuxRuntime={server?.muxRuntime}
        originalDefaultMux={server?.defaultMux}
        isolationIntent={isolationIntent}
        onIsolationIntentChange={onIsolationIntentChange}
        persistedIsolationIntent={server?.isolationIntent}
      />
    </Modal>
  );
}
