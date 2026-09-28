import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { InstallSteps, FormSelect, FormInput, Chip, Button } from '../../ui';
import type { InstallStep, ChipTone } from '../../ui';
import { Icon } from '../../ui/Icon';
import type { Server } from '../../../hooks/useServerManagement';
import type { InstallStatusResponse, InstallStatusItem } from '../serverSections';
import { useToast } from '../../../hooks/useToast';
import { useConfirm } from '../../../hooks/useConfirm';

const URL_PATTERN = /^https?:\/\/[\w.:\-[\]]+\/?$/;

const INSTALL_COMMANDS: Record<string, { label: string; commands: { os: string; cmd: string }[] }> = {
  tmux: {
    label: 'tmux',
    commands: [
      { os: 'Ubuntu/Debian', cmd: 'sudo apt update && sudo apt install -y tmux' },
      { os: 'macOS', cmd: 'brew install tmux' },
    ],
  },
  node: {
    label: 'Node.js v24+',
    commands: [
      { os: 'nvm', cmd: 'nvm install 24 && nvm use 24' },
      { os: 'Ubuntu/Debian', cmd: 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs' },
    ],
  },
  tailscale: {
    label: 'Tailscale',
    commands: [
      { os: 'Linux', cmd: 'curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh' },
    ],
  },
};

interface SetupSectionProps {
  server: Server;
  installStatus: InstallStatusResponse | null;
  refresh: () => void;
}

export default function SetupSection({ server, installStatus, refresh }: SetupSectionProps) {
  const { t } = useTranslation('servers');
  const [installingHarness, setInstallingHarness] = useState(false);
  const [installingAgent, setInstallingAgent] = useState(false);
  const [installingChromium, setInstallingChromium] = useState(false);
  const [harnessSteps, setHarnessSteps] = useState<InstallStep[]>([]);
  const [agentSteps, setAgentSteps] = useState<InstallStep[]>([]);
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [baseUrlCandidates, setBaseUrlCandidates] = useState<{ label: string; url: string }[]>([]);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const { showToast } = useToast();
  const confirm = useConfirm();

  const handleRecheck = useCallback(() => {
    setIsRechecking(true);
    Promise.resolve(refresh()).finally(() => setIsRechecking(false));
  }, [refresh]);

  const handleInstallHarness = useCallback(async (azitoUrl: string) => {
    setInstallingHarness(true);
    setHarnessSteps([]);
    setShowUrlDialog(false);
    try {
      const encoded = encodeURIComponent(server.name);
      const res = await api<{ ok: boolean; steps: InstallStep[]; error?: string }>(
        `/servers/${encoded}/harness/install`,
        { method: 'POST', body: JSON.stringify({ azito_url: azitoUrl }) },
      );
      setHarnessSteps(res.steps);
      if (res.ok) await refresh();
    } catch (err: unknown) {
      setHarnessSteps([{ step: 'error', status: 'error', message: (err as Error).message }]);
    } finally {
      setInstallingHarness(false);
    }
  }, [server.name, refresh]);

  const openUrlDialog = useCallback(async () => {
    setShowUrlDialog(true);
    setLoadingCandidates(true);
    try {
      const res = await api<{ candidates: { label: string; url: string }[] }>('/server-info/base-urls');
      setBaseUrlCandidates(res.candidates);
      if (res.candidates.length > 0) {
        setSelectedUrl(res.candidates[0].url);
      } else {
        setSelectedUrl('__custom__');
        setCustomUrl(window.location.origin);
      }
    } catch {
      setBaseUrlCandidates([]);
      setSelectedUrl('__custom__');
      setCustomUrl(window.location.origin);
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  const handleInstallAgent = useCallback(async () => {
    setInstallingAgent(true);
    setAgentSteps([]);
    try {
      const encoded = encodeURIComponent(server.name);
      const res = await api<{ ok: boolean; steps: InstallStep[]; error?: string }>(
        `/servers/${encoded}/agent/install`,
        { method: 'POST' },
      );
      setAgentSteps(res.steps);
      if (res.ok) await refresh();
    } catch (err: unknown) {
      setAgentSteps([{ step: 'error', status: 'error', message: (err as Error).message }]);
    } finally {
      setInstallingAgent(false);
    }
  }, [server.name, refresh]);

  const handleInstallChromium = useCallback(async () => {
    setInstallingChromium(true);
    try {
      const encoded = encodeURIComponent(server.name);
      const res = await api<{ ok?: boolean; error?: string }>(`/servers/${encoded}/install-browser-runtime`, { method: 'POST' });
      if (!res.ok) throw new Error(res.error || 'Install failed');
      await refresh();
    } catch (err: unknown) {
      showToast(`Browser runtime install failed: ${(err as Error).message}`);
    } finally {
      setInstallingChromium(false);
    }
  }, [server.name, refresh, showToast]);

  const handleApplyTmuxConfig = useCallback(async () => {
    const res = await api<{ ok?: boolean; error?: string }>(`/servers/${encodeURIComponent(server.name)}/apply-tmux-config`, { method: 'POST' });
    if (res.error) showToast(res.error);
    else showToast('Recommended config applied');
  }, [server.name, showToast]);

  if (!installStatus) return null;

  const isRemote = server.type === 'agent';
  const canInstallAgent = isRemote && server.sshHost;
  const showTailscale = !!installStatus.tailscale;
  const showAgent = !!(installStatus.agent || canInstallAgent);
  const showChromium = !!installStatus.chromium;

  // 進捗計算: 表示中の行のみを母数にする。任意コンポーネント（chromium）も母数に含めるが、
  // 未導入でも異常扱い（赤）にはしない（S1 デザインの決定④）。
  const progressRows: { installed: boolean }[] = [
    { installed: installStatus.tmux.installed },
    { installed: installStatus.node.installed },
    ...(showTailscale ? [{ installed: installStatus.tailscale!.installed }] : []),
    { installed: installStatus.aztHarness.installed },
    ...(showAgent ? [{ installed: installStatus.agent?.installed ?? false }] : []),
    ...(showChromium ? [{ installed: installStatus.chromium!.installed }] : []),
  ];
  const totalCount = progressRows.length;
  const completedCount = progressRows.filter((r) => r.installed).length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  const agentItem = installStatus.agent ?? { installed: false, detail: 'Agent not installed' };
  const agentUpdateAvailable = agentItem.installed && installStatus.agent?.versionMatch === false;

  return (
    <div>
      <style>{`
        @keyframes azt-step-spin { to { transform: rotate(360deg); } }
        .azt-step-spin { display: inline-block; animation: azt-step-spin 1s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .azt-step-spin { animation: none; }
        }
      `}</style>

      <h3 style={{
        fontFamily: 'var(--mono)',
        fontSize: 'var(--font-xs)',
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        borderBottom: '1px solid var(--border)',
        paddingBottom: 6,
        marginBottom: 'var(--space-4)',
        marginTop: 0,
      }}>
        {t('setup.title')}
      </h3>

      {/* 進捗行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            {t('setup.progressComplete', { completed: completedCount, total: totalCount })}
          </div>
          <span
            role="meter"
            aria-valuenow={Math.round(progressPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('setup.progressAriaLabel')}
            style={{
              display: 'block', width: '100%', height: 6, borderRadius: 'var(--radius-full)',
              background: 'color-mix(in srgb, var(--border) 60%, transparent)', overflow: 'hidden',
            }}
          >
            <span style={{ display: 'block', height: '100%', width: `${progressPercent}%`, background: 'var(--success)', transition: 'width 0.3s ease' }} />
          </span>
        </div>
        <Button size="sm" onClick={handleRecheck} disabled={isRechecking}>
          {isRechecking ? t('setup.rechecking') : `⟳ ${t('setup.recheck')}`}
        </Button>
      </div>

      <StepRow
        label="tmux"
        item={installStatus.tmux}
        categoryLabel={t('setup.foundation')}
        running={false}
        action={
          server.muxRuntime === 'system' && installStatus.tmux.installed ? (
            <Button size="sm" variant="ghost" onClick={handleApplyTmuxConfig}>{t('setup.applySettings')}</Button>
          ) : undefined
        }
      >
        {!installStatus.tmux.installed && <TmuxSetupCards server={server} refresh={refresh} />}
      </StepRow>

      <StepRow
        label="Node.js"
        item={installStatus.node}
        categoryLabel={t('setup.foundation')}
        running={false}
        manualCommands={INSTALL_COMMANDS.node.commands}
      />

      {showTailscale && (
        <StepRow
          label="Tailscale"
          item={installStatus.tailscale!}
          categoryLabel={t('setup.foundation')}
          running={false}
          manualCommands={INSTALL_COMMANDS.tailscale.commands}
        />
      )}

      <StepRow
        label="AZITO Harness"
        item={installStatus.aztHarness}
        running={installingHarness}
        action={
          <InstallActionButton
            installed={installStatus.aztHarness.installed}
            installing={installingHarness}
            onInstall={isRemote ? openUrlDialog : () => handleInstallHarness(window.location.origin)}
          />
        }
      >
        <StepLog steps={harnessSteps} installing={installingHarness} />
        {showUrlDialog && (
          <UrlDialog
            loading={loadingCandidates}
            candidates={baseUrlCandidates}
            selectedUrl={selectedUrl}
            customUrl={customUrl}
            onSelectedUrlChange={setSelectedUrl}
            onCustomUrlChange={setCustomUrl}
            onCancel={() => setShowUrlDialog(false)}
            onInstall={handleInstallHarness}
          />
        )}
      </StepRow>

      {showAgent && (
        <StepRow
          label="Agent Server"
          item={agentItem}
          categoryLabel={t('setup.agentLabel')}
          running={installingAgent}
          stateOverride={agentUpdateAvailable ? { label: t('setup.updateAvailable'), tone: 'orange' } : undefined}
          action={
            !agentItem.installed && canInstallAgent ? (
              <Button size="sm" variant="primary" onClick={handleInstallAgent} disabled={installingAgent}>
                {installingAgent ? 'Installing...' : 'Install'}
              </Button>
            ) : agentUpdateAvailable && canInstallAgent ? (
              <Button size="sm" variant="primary" onClick={handleInstallAgent} disabled={installingAgent}>
                {installingAgent ? 'Updating...' : 'Update'}
              </Button>
            ) : agentItem.installed && canInstallAgent ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const ok = await confirm({ title: 'Reinstall Agent', message: 'Are you sure you want to reinstall?' });
                  if (ok) handleInstallAgent();
                }}
                disabled={installingAgent}
              >
                {installingAgent ? 'Reinstalling...' : 'Reinstall'}
              </Button>
            ) : undefined
          }
        >
          <StepLog steps={agentSteps} installing={installingAgent} />
        </StepRow>
      )}

      {showChromium && (
        <StepRow
          label="Browser runtime (Chromium)"
          item={installStatus.chromium!}
          optional
          description={t('setup.browserRuntimeDesc')}
          running={installingChromium}
          action={
            <InstallActionButton
              installed={installStatus.chromium!.installed}
              installing={installingChromium}
              onInstall={handleInstallChromium}
            />
          }
        />
      )}
    </div>
  );
}

function TmuxSetupCards({ server, refresh }: { server: Server; refresh: () => void }) {
  const { t } = useTranslation('servers');
  const [installing, setInstalling] = useState(false);
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const isManaged = server.muxRuntime === 'managed';

  const putMuxRuntime = useCallback(async (muxRuntime: 'system' | 'managed') => {
    const res = await api<{ ok?: boolean; error?: string }>(
      `/servers/${encodeURIComponent(server.name)}`,
      { method: 'PUT', body: JSON.stringify({ muxRuntime }) },
    );
    if (res.error) throw new Error(res.error);
  }, [server.name]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    const willSwitch = !isManaged;
    const log: InstallStep[] = [];
    const pushStep = (step: InstallStep) => { log.push(step); setSteps([...log]); };
    const updateLastStep = (step: InstallStep) => { log[log.length - 1] = step; setSteps([...log]); };

    try {
      if (willSwitch) {
        pushStep({ step: 'switch', status: 'running', message: t('setup.switchingToManaged') });
        try {
          await putMuxRuntime('managed');
          updateLastStep({ step: 'switch', status: 'ok', message: t('setup.switchedToManaged') });
        } catch (err: unknown) {
          updateLastStep({ step: 'switch', status: 'error', message: (err as Error).message });
          return;
        }
      }

      pushStep({ step: 'install', status: 'running', message: t('setup.deployingBinary') });
      let res: { ok?: boolean; version?: string; error?: string };
      try {
        res = await api<{ ok?: boolean; version?: string; error?: string }>(
          `/servers/${encodeURIComponent(server.name)}/install-tmux`,
          { method: 'POST' },
        );
      } catch (err: unknown) {
        // fetch 例外・接続断も res.error と同様に扱い、managed に切り替えていた場合は
        // best-effort でロールバックする（放置すると muxRuntime が managed のまま残る）。
        updateLastStep({ step: 'install', status: 'error', message: (err as Error).message });
        if (willSwitch) {
          try {
            await putMuxRuntime('system');
          } catch (rollbackErr: unknown) {
            console.warn('[SetupSection] mux runtime rollback failed:', rollbackErr);
          }
        }
        return;
      }
      if (res.error) {
        updateLastStep({ step: 'install', status: 'error', message: res.error });
        if (willSwitch) {
          pushStep({ step: 'rollback', status: 'running', message: t('setup.rollingBack') });
          try {
            await putMuxRuntime('system');
            updateLastStep({ step: 'rollback', status: 'ok', message: t('setup.rolledBack') });
          } catch (rollbackErr: unknown) {
            updateLastStep({ step: 'rollback', status: 'error', message: (rollbackErr as Error).message });
          }
        }
        return;
      }
      updateLastStep({ step: 'install', status: 'ok', message: t('setup.installComplete', { version: res.version ?? '?' }) });
      await refresh();
    } finally {
      setInstalling(false);
    }
  }, [isManaged, putMuxRuntime, refresh, server.name]);

  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 'var(--space-3)',
      }}>
        <div style={{
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--accent-a08)',
          padding: 'var(--space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
              {t('setup.managedTmux')}
            </span>
            <Chip tone="accent">{t('setup.recommended')}</Chip>
          </div>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', margin: 0, lineHeight: 1.6 }}>
            {t('setup.managedTmuxDesc')}
            {isManaged
              ? t('setup.managedAlready')
              : t('setup.managedSwitch')}
          </p>
          <div>
            <Button size="sm" variant="primary" onClick={handleInstall} disabled={installing}>
              {installing ? t('setup.installing') : t('setup.installButton')}
            </Button>
          </div>
          <StepLog steps={steps} installing={installing} />
        </div>

        {!isManaged && (
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
              {t('setup.selfInstall')}
            </span>
            <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', margin: 0 }}>
              {t('setup.selfInstallDesc')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {INSTALL_COMMANDS.tmux.commands.map((c) => (
                <div key={c.os}>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginBottom: 4 }}>{c.os}</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px',
                  }}>
                    <code style={{ flex: 1, fontSize: 'var(--font-sm)', color: 'var(--text)', wordBreak: 'break-all', fontFamily: 'inherit' }}>{c.cmd}</code>
                    <CopyButton text={c.cmd} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface StepRowItem extends InstallStatusItem {
  versionMatch?: boolean;
}

function StepRow({
  label, item, categoryLabel, optional, running, stateOverride, description, action, manualCommands, children,
}: {
  label: string;
  item: StepRowItem;
  categoryLabel?: string;
  optional?: boolean;
  running: boolean;
  stateOverride?: { label: string; tone: ChipTone };
  description?: string;
  action?: React.ReactNode;
  manualCommands?: { os: string; cmd: string }[];
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('servers');
  const [showCommands, setShowCommands] = useState(false);

  let badgeTone: 'green' | 'red' | 'orange' | 'accent';
  let badgeIcon: string;
  let stateChip: { label: string; tone: ChipTone };
  if (running) {
    badgeTone = 'accent';
    badgeIcon = '⟳';
    stateChip = { label: t('setup.stateInstalling'), tone: 'accent' };
  } else if (item.installed) {
    badgeTone = 'green';
    badgeIcon = '✓';
    stateChip = { label: t('setup.stateInstalled'), tone: 'green' };
  } else if (optional) {
    badgeTone = 'orange';
    badgeIcon = '–';
    stateChip = { label: t('setup.stateNotInstalled'), tone: 'orange' };
  } else {
    badgeTone = 'red';
    badgeIcon = '✕';
    stateChip = { label: t('setup.stateNotInstalled'), tone: 'red' };
  }
  if (stateOverride) stateChip = stateOverride;

  const hasManualToggle = !item.installed && !!manualCommands && manualCommands.length > 0;

  return (
    <div style={{ padding: 'var(--space-3) 0', borderBottom: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span
          aria-hidden="true"
          title={item.detail}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: '50%', flexShrink: 0, fontSize: 'var(--font-sm)', fontWeight: 700,
            background: `color-mix(in srgb, var(--${badgeTone}) 15%, transparent)`,
            color: `var(--${badgeTone})`,
          }}
        >
          <span className={running ? 'azt-step-spin' : undefined}>{badgeIcon}</span>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>{label}</span>
            {optional && <Chip tone="orange">{t('setup.optional')}</Chip>}
            {categoryLabel && <Chip>{categoryLabel}</Chip>}
            <Chip tone={stateChip.tone}>{stateChip.label}</Chip>
          </div>
          {(item.version || item.detail) && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
              {item.version}{item.version && item.detail ? ' · ' : ''}{item.detail}
            </div>
          )}
          {description && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{description}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
          {action}
          {hasManualToggle && (
            <Button size="sm" variant="ghost" onClick={() => setShowCommands((v) => !v)} aria-expanded={showCommands}>
              {showCommands ? t('setup.hideManual') : t('setup.showManual')}
            </Button>
          )}
        </div>
      </div>
      {showCommands && manualCommands && (
        <div style={{ paddingLeft: 34, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {manualCommands.map((c) => (
            <div key={c.os}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginBottom: 4 }}>{c.os}</div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px',
              }}>
                <code style={{ flex: 1, fontSize: 'var(--font-sm)', color: 'var(--text)', wordBreak: 'break-all', fontFamily: 'inherit' }}>{c.cmd}</code>
                <CopyButton text={c.cmd} />
              </div>
            </div>
          ))}
        </div>
      )}
      {children && <div style={{ paddingLeft: 34, marginTop: 8 }}>{children}</div>}
    </div>
  );
}

function InstallActionButton({
  installed, installing, onInstall,
}: {
  installed: boolean;
  installing: boolean;
  onInstall?: () => void;
}) {
  const confirm = useConfirm();
  if (!onInstall) return null;
  if (!installed) {
    return (
      <Button size="sm" variant="primary" onClick={onInstall} disabled={installing}>
        {installing ? 'Installing...' : 'Install'}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        const ok = await confirm({ title: 'Reinstall', message: 'Are you sure you want to reinstall?' });
        if (ok) onInstall();
      }}
      disabled={installing}
    >
      {installing ? 'Reinstalling...' : 'Reinstall'}
    </Button>
  );
}

function StepLog({ steps, installing }: { steps: InstallStep[]; installing: boolean }) {
  const { t } = useTranslation('servers');
  const hasError = steps.some((s) => s.status === 'error');
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (installing) { setCollapsed(false); return; }
    if (steps.length > 0) setCollapsed(!hasError);
  }, [installing, steps, hasError]);

  if (steps.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 'var(--font-xs)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <Icon name="chevron-right" size={14} rotate={collapsed ? 0 : 90} />
        </span>
        {collapsed ? t('setup.showLog') : t('setup.hideLog')}
      </button>
      {!collapsed && (
        <div style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          padding: '2px 12px', marginTop: 4,
        }}>
          <InstallSteps steps={steps} />
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        background: 'none', border: '1px solid var(--border)',
        color: copied ? 'var(--success)' : 'var(--text-dim)',
        borderRadius: 'var(--radius-sm)', padding: '2px 8px', fontSize: 'var(--font-xs)', cursor: 'pointer', flexShrink: 0,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function UrlDialog({
  loading, candidates, selectedUrl, customUrl,
  onSelectedUrlChange, onCustomUrlChange, onCancel, onInstall,
}: {
  loading: boolean;
  candidates: { label: string; url: string }[];
  selectedUrl: string;
  customUrl: string;
  onSelectedUrlChange: (v: string) => void;
  onCustomUrlChange: (v: string) => void;
  onCancel: () => void;
  onInstall: (url: string) => void;
}) {
  const { t } = useTranslation('servers');
  const isCustom = selectedUrl === '__custom__';
  const effectiveUrl = isCustom ? customUrl : selectedUrl;
  const isValid = effectiveUrl && URL_PATTERN.test(effectiveUrl);

  return (
    <div style={{ padding: 16, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <h4 style={{ fontSize: 'var(--font-sm)', fontWeight: 600, margin: '0 0 12px', color: 'var(--text)' }}>
        {t('setup.urlDialogTitle')}
      </h4>
      <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', margin: '0 0 12px' }}>
        {t('setup.urlDialogDesc')}
      </p>
      {loading ? (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', padding: '8px 0' }}>{t('setup.fetchingCandidates')}</div>
      ) : (
        <>
          <FormSelect
            value={selectedUrl}
            onChange={(e) => {
              onSelectedUrlChange(e.target.value);
              if (e.target.value !== '__custom__') onCustomUrlChange('');
            }}
            style={{ marginBottom: 8 }}
          >
            {candidates.map((c) => (
              <option key={c.url} value={c.url}>{c.label} — {c.url}</option>
            ))}
            <option value="__custom__">{t('setup.customUrl')}</option>
          </FormSelect>
          {isCustom && (
            <FormInput
              value={customUrl}
              onChange={(e) => onCustomUrlChange(e.target.value)}
              placeholder="http://your-hub-host:3001"
              style={{ marginBottom: 8 }}
            />
          )}
          {isCustom && customUrl && !URL_PATTERN.test(customUrl) && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger)', marginBottom: 8 }}>
              {t('setup.urlInvalid')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={onCancel}
              style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 'var(--radius-sm)', padding: '6px 16px', fontSize: 'var(--font-sm)', cursor: 'pointer' }}
            >
              {t('common:actions.cancel')}
            </button>
            <button
              onClick={() => { if (isValid) onInstall(effectiveUrl); }}
              disabled={!isValid}
              style={{
                background: 'var(--accent)', color: '#fff', border: 'none', // lint-allow: hex - white text on solid accent fill; no on-color token yet
                borderRadius: 'var(--radius-sm)', padding: '6px 16px', fontSize: 'var(--font-sm)', cursor: 'pointer',
                opacity: isValid ? 1 : 0.6,
              }}
            >
              {t('setup.install')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
