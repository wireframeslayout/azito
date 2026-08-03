import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useAgentDefinitions } from '../hooks/useAgentDefinitions';
import type { AgentDefinition } from '../hooks/useAgentDefinitions';
import { useUnitTypes, findUnitType } from '../hooks/useUnitTypes';
import { useConfirm } from '../hooks/useConfirm';
import FormField from './FormField';
import { FormInput, FormTextarea, FormSelect, LoadingState, SubagentConfigCard, PhaseConfigCard, Button, FormPage } from './ui';
import type { SubagentConfig, PhaseConfigEntry } from './ui';
import type { Unit } from '../pages/workspace/types';

interface SidekickMeta {
  name: string;
  tags: string[];
  isDefault: boolean;
}

interface UnitFormViewProps {
  mode: 'create' | 'edit';
  unitId?: number;
  onSaved: (unitId?: number, name?: string) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text-dim)',
  margin: '24px 0 12px', paddingBottom: 8,
  borderBottom: '1px solid var(--border)',
  textTransform: 'uppercase', letterSpacing: 0.5,
};

function buildPreviewCommand(
  agentDef: AgentDefinition | undefined,
  workerType: string,
  workerModel: string,
  workerExtraArgs: string,
): string {
  if (!agentDef?.launchable) {
    return workerExtraArgs.trim();
  }
  const base = agentDef.launchCommand ?? workerType;
  const modelPart = workerModel ? ` --model '${workerModel}'` : '';
  const extraPart = workerExtraArgs.trim() ? ` ${workerExtraArgs.trim()}` : '';
  return `${base}${modelPart}${extraPart}`;
}

export default function UnitFormView({ mode, unitId, onSaved, onCancel, backLabel, onBack }: UnitFormViewProps) {
  const isEdit = mode === 'edit' && !!unitId;
  const { t } = useTranslation(['units', 'common']);

  const { data: unit, refresh } = useApi<Unit>(isEdit ? `/units/${unitId}` : null);
  const { data: sidekicks } = useApi<SidekickMeta[]>('/sidekicks');
  const { agents: agentDefs, loading: agentDefsLoading, error: agentDefsError } = useAgentDefinitions('worker');
  const { unitTypes } = useUnitTypes();
  const confirm = useConfirm();

  const [name, setName] = useState('');
  const [unitTypeName, setUnitTypeName] = useState('');
  const [selfReviewMax, setSelfReviewMax] = useState('2');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reviewSubagent, setReviewSubagent] = useState<SubagentConfig | null>(null);
  const [implementSubagent, setImplementSubagent] = useState<SubagentConfig | null>(null);
  const [phaseConfig, setPhaseConfig] = useState<Record<string, PhaseConfigEntry>>({});

  const [workerType, setWorkerType] = useState('');
  const [workerExtraArgs, setWorkerExtraArgs] = useState('');
  const [workerModel, setWorkerModel] = useState('');
  const [workerExecutionMode, setWorkerExecutionMode] = useState('tmux-pipe');
  const [workerRuntime, setWorkerRuntime] = useState('tui');
  const [workerTypes, setWorkerTypes] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    if (unit) {
      setName(unit.name);
      setUnitTypeName(unit.unitType);
      setSelfReviewMax(String(unit.selfReviewMaxAttempts ?? 2));
      setSystemPrompt(unit.systemPrompt || '');
      if (unit.reviewSubagent) {
        setReviewSubagent({ enabled: unit.reviewSubagent.enabled, provider: unit.reviewSubagent.provider, model: unit.reviewSubagent.model });
      } else {
        setReviewSubagent(null);
      }
      if (unit.implementSubagent) {
        setImplementSubagent({ enabled: unit.implementSubagent.enabled, provider: unit.implementSubagent.provider, model: unit.implementSubagent.model });
      } else {
        setImplementSubagent(null);
      }
      setPhaseConfig(unit.phaseConfig ?? {});
      setWorkerExtraArgs(unit.workerExtraArgs ?? '');
      setWorkerModel(unit.workerModel || '');
      setWorkerExecutionMode(unit.workerExecutionMode || 'tmux-pipe');
      setWorkerRuntime(unit.workerRuntime || 'tui');
    }
  }, [unit]);

  useEffect(() => {
    if (!unitTypeName && unitTypes.length > 0 && !isEdit) {
      setUnitTypeName(unitTypes[0].name);
    }
  }, [unitTypes, unitTypeName, isEdit]);

  const selectedUnitType = findUnitType(unitTypes, unitTypeName);
  const selectedPhases = selectedUnitType?.phases ?? [];

  const loadModels = useCallback(async (type: string) => {
    const models = await api<{ id: string; label: string }[]>(`/workers/models/${type}`);
    setModelOptions(models);
    if (!isEdit && models.length) setWorkerModel(models[0].id);
  }, [isEdit]);

  useEffect(() => {
    api<string[]>('/workers/types').then((types) => {
      setWorkerTypes(types);
      if (isEdit && unit) {
        const type = unit.workerType || 'generic';
        setWorkerType(type);
        loadModels(type);
      } else if (types.length) {
        setWorkerType(types[0]);
        loadModels(types[0]);
      }
    });
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps

  const onWorkerTypeChange = useCallback((type: string) => {
    setWorkerType(type);
    loadModels(type);
  }, [loadModels]);

  const sidekicksByPhase = useMemo(() => {
    const phaseNames = selectedPhases.map((p) => p.name);
    const grouped: Record<string, SidekickMeta[]> = {};
    for (const name of phaseNames) grouped[name] = [];
    for (const s of sidekicks ?? []) {
      for (const name of phaseNames) {
        if (s.tags.includes(name)) grouped[name].push(s);
      }
    }
    return grouped;
  }, [sidekicks, selectedPhases]);

  const handlePhaseConfigChange = (phase: string, next: PhaseConfigEntry) => {
    setPhaseConfig((prev) => {
      const updated = { ...prev, [phase]: next };
      if (next.enabled !== false && !next.sidekick) {
        delete updated[phase];
      }
      return updated;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) { setError(t('common:validation.nameRequired')); return; }
    setError(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        unit_type: unitTypeName || undefined,
        self_review_max_attempts: parseInt(selfReviewMax, 10) || 2,
        system_prompt: systemPrompt.trim() || null,
        review_subagent: reviewSubagent?.enabled ? { enabled: true, provider: reviewSubagent.provider, model: reviewSubagent.model } : null,
        implement_subagent: implementSubagent?.enabled ? { enabled: true, provider: implementSubagent.provider, model: implementSubagent.model } : null,
        phase_config: Object.keys(phaseConfig).length > 0 ? phaseConfig : null,
        worker_type: workerType || null,
        worker_extra_args: workerExtraArgs.trim() || null,
        worker_model: workerModel || null,
        worker_execution_mode: workerExecutionMode,
        worker_runtime: workerRuntime,
      };
      if (isEdit) {
        await api(`/units/${unitId}`, { method: 'PUT', body: JSON.stringify(payload) });
        refresh();
        onSaved(unitId, name.trim());
      } else {
        const created = await api<{ id: number }>('/units', { method: 'POST', body: JSON.stringify(payload) });
        onSaved(created.id, name.trim());
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({ title: t('form.deleteUnit'), message: t('form.deleteConfirm'), danger: true });
    if (!ok) return;
    await api(`/units/${unitId}`, { method: 'DELETE' });
    onCancel();
  };

  if (isEdit && !unit) {
    return <LoadingState />;
  }

  const currentAgentDef = agentDefs.find((d) => d.type === workerType);
  const isGeneric = !agentDefsLoading && !currentAgentDef?.launchable;
  const previewCommand = agentDefsLoading
    ? ''
    : buildPreviewCommand(currentAgentDef, workerType, workerModel, workerExtraArgs);

  return (
    <FormPage
      title={isEdit ? t('form.editUnit') : t('form.newUnit')}
      submitLabel={isEdit ? t('common:actions.save') : t('common:actions.create')}
      onSubmit={handleSave}
      onCancel={onCancel}
      loading={saving}
      loadingLabel={t('common:actions.saving')}
      error={error}
      backLabel={backLabel}
      onBack={onBack}
    >
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 24, maxWidth: 620, lineHeight: 1.5 }}>
        {t('form.description')}
      </p>

      <FormField label={t('form.name')}>
        <FormInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t('form.namePlaceholder')} />
      </FormField>

      <FormField label={t('form.unitType')}>
        <FormSelect value={unitTypeName} onChange={(e) => setUnitTypeName(e.target.value)}>
          {unitTypes.map((ut) => <option key={ut.name} value={ut.name}>{ut.label}</option>)}
        </FormSelect>
      </FormField>

      <h3 style={sectionHeaderStyle}>{t('runtime.title')}</h3>
      <FormField label={t('runtime.workerType')}>
        <FormSelect value={workerType} onChange={(e) => onWorkerTypeChange(e.target.value)}>
          {workerTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </FormSelect>
      </FormField>
      <FormField label={t('runtime.model')}>
        <FormSelect value={workerModel} onChange={(e) => setWorkerModel(e.target.value)}>
          {modelOptions.length === 0 ? <option value="">{t('runtime.freeInput')}</option> : modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </FormSelect>
      </FormField>
      {agentDefsError && (
        <div role="alert" style={{
          padding: '8px 12px', marginBottom: 16, borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)',
          color: 'var(--danger)', fontSize: 'var(--font-md)',
        }}>
          {t('runtime.agentDefsError')} {agentDefsError}
        </div>
      )}
      <FormField label={agentDefsLoading ? t('runtime.additionalOptions') : (isGeneric ? t('runtime.command') : t('runtime.additionalOptions'))}>
        <FormInput
          value={workerExtraArgs}
          onChange={(e) => setWorkerExtraArgs(e.target.value)}
          placeholder={agentDefsLoading ? t('runtime.loadingAgentDefs') : (isGeneric ? t('runtime.commandPlaceholder') : t('runtime.extraArgsPlaceholder'))}
        />
      </FormField>
      <FormField label={t('runtime.launchCommand')}>
        <code style={{
          display: 'block', padding: '8px 10px',
          background: 'var(--bg-secondary, var(--bg-alt, #1e1e1e))',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-md)',
          color: 'var(--text-dim)',
          fontFamily: 'monospace',
          wordBreak: 'break-all',
          minHeight: 36,
        }}>
          {agentDefsLoading
            ? <span style={{ opacity: 0.4 }}>{t('runtime.loading')}</span>
            : previewCommand || <span style={{ opacity: 0.4 }}>{t('runtime.empty')}</span>}
        </code>
      </FormField>
      <FormField
        label={t('runtime.workerRuntime')}
        hint={t('runtime.workerRuntimeHint')}
      >
        <FormSelect value={workerRuntime} onChange={(e) => setWorkerRuntime(e.target.value)}>
          <option value="tui">{t('runtime.runtimeTui')}</option>
          <option value="headless" disabled>{t('runtime.runtimeHeadless')}</option>
          <option value="api" disabled>{t('runtime.runtimeApi')}</option>
        </FormSelect>
      </FormField>
      {workerRuntime === 'tui' && (
        <FormField
          label={t('runtime.executionMode')}
          hint={t('runtime.executionModeHint')}
        >
          <FormSelect value={workerExecutionMode} onChange={(e) => setWorkerExecutionMode(e.target.value)}>
            <option value="tmux-pipe">{t('runtime.modePipe')}</option>
            <option value="http-signal">{t('runtime.modeHttpSignal')}</option>
          </FormSelect>
        </FormField>
      )}

      <h3 style={sectionHeaderStyle}>{t('phases.title')}</h3>
      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: '-8px 0 12px' }}>
        {t('phases.description')}
      </p>
      {selectedPhases.map((phase) => (
        <PhaseConfigCard
          key={phase.name}
          phaseLabel={phase.label}
          options={(sidekicksByPhase[phase.name] ?? []).map((s) => ({ name: s.name, isDefault: s.isDefault }))}
          value={phaseConfig[phase.name]}
          onChange={(next) => handlePhaseConfigChange(phase.name, next)}
        />
      ))}

      <h3 style={sectionHeaderStyle}>{t('subagents.title')}</h3>
      <SubagentConfigCard
        title={t('subagents.reviewTitle')}
        description={t('subagents.reviewDescription')}
        value={reviewSubagent}
        onChange={setReviewSubagent}
        workerType={workerType || undefined}
      />
      <SubagentConfigCard
        title={t('subagents.implementTitle')}
        description={t('subagents.implementDescription')}
        value={implementSubagent}
        onChange={setImplementSubagent}
        workerType={workerType || undefined}
      />

      <h3 style={sectionHeaderStyle}>{t('advanced.title')}</h3>
      <FormField label={t('advanced.selfReviewMax')} hint={t('advanced.selfReviewHint')}>
        <FormSelect value={selfReviewMax} onChange={(e) => setSelfReviewMax(e.target.value)}>
          <option value="0">{t('advanced.selfReviewSkip')}</option>
          <option value="1">1</option>
          <option value="2">{t('advanced.selfReviewDefault')}</option>
          <option value="3">3</option>
        </FormSelect>
      </FormField>
      <FormField label={t('advanced.systemPrompt')} hint={t('advanced.systemPromptHint')}>
        <FormTextarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={6} placeholder={t('advanced.systemPromptPlaceholder')} style={{ resize: 'vertical', minHeight: 100 }} />
      </FormField>

      {isEdit && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginTop: 32, marginBottom: 40 }}>
          <Button variant="danger" onClick={handleDelete}>{t('form.deleteUnit')}</Button>
        </div>
      )}
    </FormPage>
  );
}
