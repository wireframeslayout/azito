import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import FormField from '../FormField';
import { FormSelect } from './FormInput';

export interface SubagentConfig {
  enabled: boolean;
  provider: string;
  model: string;
}

interface AgentModel {
  id: string;
  label: string;
}

interface AgentDefinition {
  type: string;
  label: string;
  models: AgentModel[];
}

interface SubagentConfigCardProps {
  title: string;
  description: string;
  value: SubagentConfig | null;
  onChange: (next: SubagentConfig | null) => void;
  workerType?: string;
}

export default function SubagentConfigCard({ title, description, value, onChange, workerType }: SubagentConfigCardProps) {
  const { t } = useTranslation('common');
  const [agents, setAgents] = useState<AgentDefinition[]>([]);

  useEffect(() => {
    api<AgentDefinition[]>('/agents?context=subagent').then(setAgents);
  }, []);

  const isEnabled = value?.enabled === true;
  const models = agents.find((a) => a.type === value?.provider)?.models ?? [];
  const showCreditWarning = isEnabled && value?.provider === 'claude' && workerType !== 'claude';

  const handleToggle = () => {
    if (isEnabled) {
      onChange(null);
    } else {
      onChange({ enabled: true, provider: '', model: '' });
    }
  };

  const handleAgentChange = (provider: string) => {
    onChange({ enabled: true, provider, model: '' });
  };

  const handleModelChange = (model: string) => {
    if (!value) return;
    onChange({ ...value, model });
  };

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <label className="toggle">
          <input type="checkbox" checked={isEnabled} onChange={handleToggle} />
          <span className="toggle-slider" />
        </label>
      </div>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: 4 }}>{description}</div>
      {isEnabled && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <FormField label={t('subagentConfig.agent')}>
            <FormSelect value={value?.provider ?? ''} onChange={(e) => handleAgentChange(e.target.value)}>
              <option value="">{t('subagentConfig.selectAgent')}</option>
              {agents.map((a) => (
                <option key={a.type} value={a.type}>{a.label}</option>
              ))}
            </FormSelect>
          </FormField>
          <FormField label={t('subagentConfig.model')}>
            <FormSelect value={value?.model ?? ''} onChange={(e) => handleModelChange(e.target.value)}>
              <option value="">{t('subagentConfig.selectModel')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </FormSelect>
          </FormField>
        </div>
      )}
      {showCreditWarning && (
        <div role="alert" style={{
          marginTop: 10,
          padding: '8px 12px',
          background: 'color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent)',
          border: '1px solid var(--warning, #f59e0b)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--font-sm)',
          lineHeight: 1.5,
          color: 'var(--warning, #f59e0b)',
        }}>
          ⚠ {t('subagentConfig.headlessWarning')}
        </div>
      )}
    </div>
  );
}
