import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidModelId } from '@azito/shared';
import { FormSelect, FormInput } from './FormInput';

const CUSTOM_SENTINEL = '__custom__';

interface ModelSelectProps {
  models: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  note?: string;
  disabled?: boolean;
}

export function ModelSelect({ models, value, onChange, placeholder, note, disabled }: ModelSelectProps) {
  const { t } = useTranslation('common');
  const isCustom = value !== '' && !models.some((m) => m.id === value);
  const [customMode, setCustomMode] = useState(isCustom);
  const [localCustom, setLocalCustom] = useState(isCustom ? value : '');

  const showCustomInput = customMode || isCustom;
  const selectValue = showCustomInput ? CUSTOM_SENTINEL : value;
  const validationError = localCustom !== '' && !isValidModelId(localCustom);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === CUSTOM_SENTINEL) {
      setCustomMode(true);
      setLocalCustom('');
      onChange('');
    } else {
      setCustomMode(false);
      setLocalCustom('');
      onChange(v);
    }
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalCustom(v);
    if (v && isValidModelId(v)) {
      onChange(v);
    } else {
      onChange('');
    }
  };

  return (
    <div>
      <FormSelect value={selectValue} onChange={handleSelectChange} disabled={disabled}>
        <option value="">{placeholder ?? t('labels.default')}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
        <option value={CUSTOM_SENTINEL}>{t('modelSelect.custom')}</option>
      </FormSelect>
      {note && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
          {note}
        </div>
      )}
      {showCustomInput && (
        <div style={{ marginTop: 8 }}>
          <FormInput
            value={localCustom}
            onChange={handleCustomChange}
            placeholder="e.g. claude-opus-5-5[1m]"
            disabled={disabled}
            aria-label="Custom model ID"
            aria-invalid={validationError}
            style={validationError ? { borderColor: 'var(--danger)' } : undefined}
          />
          {validationError && (
            <div role="alert" style={{
              fontSize: 'var(--font-xs)',
              color: 'var(--danger)',
              marginTop: 4,
            }}>
              {t('modelSelect.invalidId')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
