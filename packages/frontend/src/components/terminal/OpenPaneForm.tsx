import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from '../FormField';
import { Button, FormInput, FormSelect, ModelSelect } from '../ui';
import { api } from '../../api/client';
import { useAgentDefinitions } from '../../hooks/useAgentDefinitions';
import { buildAgentCommand, buildAgentPresets } from '../../hooks/useAddWindowModal';
import { errorMessageOf } from '../../lib/apiResult';

interface OpenPaneFormProps {
  serverName: string;
  /** Formatted MuxRef of the window the pane is opened in. */
  muxRef: string;
  onOpened: () => void;
}

interface ModelOption {
  id: string;
  label: string;
}

/**
 * Opens a shell pane in an existing window and, for an agent or a custom command, types the launch command into it.
 * The command choices are the ones the add-window dialog offers.
 */
export function OpenPaneForm({ serverName, muxRef, onOpened }: OpenPaneFormProps) {
  const { t } = useTranslation('workspace');
  const { t: tc } = useTranslation('common');
  const { agents, loading: agentsLoading, error: agentsError } = useAgentDefinitions('worker');
  const [agent, setAgent] = useState('none');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelValid, setModelValid] = useState(true);
  const [customCommand, setCustomCommand] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets = buildAgentPresets(agents, t);
  const isAgent = agent !== 'none' && agent !== 'custom';

  async function handleAgentChange(next: string): Promise<void> {
    setAgent(next);
    setModel('');
    setModels([]);
    if (next === 'none' || next === 'custom') return;
    try {
      const res = await api<ModelOption[]>(`/workers/models/${next}`);
      if (Array.isArray(res)) setModels(res);
    } catch {
      // The model list is a convenience: without it the default model is used.
    }
  }

  async function handleSubmit(): Promise<void> {
    const command = buildAgentCommand(agent, model, presets[agent]?.command ?? '', customCommand);
    if (agent !== 'none' && !command.trim()) {
      setError(t('addWindow.agentCommandUnavailable'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<unknown>(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(muxRef)}/panes/open`, {
        method: 'POST',
        body: JSON.stringify(command ? { command } : {}),
      });
      const failure = errorMessageOf(res);
      if (failure) {
        setError(failure);
        return;
      }
      onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const agentSelectDisabled = submitting || agentsLoading || !!agentsError;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}
      style={{ width: '100%', maxWidth: 320, textAlign: 'left' }}
    >
      <FormField label={t('addWindow.codingAgent')}>
        <FormSelect value={agent} onChange={(e) => void handleAgentChange(e.target.value)} disabled={agentSelectDisabled}>
          {agentsLoading
            ? <option value="none">{t('addWindow.loadingAgents')}</option>
            : agentsError
              ? <option value="none">{t('addWindow.noneShellOnly')}</option>
              : Object.entries(presets).map(([key, preset]) => (
                <option key={key} value={key}>{preset.label}</option>
              ))}
        </FormSelect>
        {agentsError && (
          <div role="alert" style={{ marginTop: 6, color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
            {t('addWindow.failedLoadAgents', { error: agentsError })}
          </div>
        )}
      </FormField>
      {isAgent && (
        <FormField label={t('addWindow.model')}>
          <ModelSelect
            models={models}
            value={model}
            onChange={setModel}
            onValidityChange={setModelValid}
            placeholder={tc('labels.default')}
            disabled={submitting}
          />
        </FormField>
      )}
      {agent === 'custom' && (
        <FormField label={t('addWindow.customCommand')}>
          <FormInput
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            placeholder={t('addWindow.customCommandPlaceholder')}
            disabled={submitting}
          />
        </FormField>
      )}
      {error && (
        <div role="alert" style={{ marginBottom: 10, color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
          {error}
        </div>
      )}
      <Button type="submit" variant="primary" size="sm" loading={submitting} loadingLabel={tc('terminal.paneUnavailable.opening')} disabled={!modelValid}>
        {tc('terminal.paneUnavailable.open')}
      </Button>
    </form>
  );
}
