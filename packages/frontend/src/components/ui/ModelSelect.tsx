import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidModelId } from '@azito/shared';
import { FormSelect, FormInput } from './FormInput';

const CUSTOM_SENTINEL = '__custom__';

interface ModelSelectProps {
  models: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  onValidityChange?: (valid: boolean) => void;
  placeholder?: string;
  note?: string;
  disabled?: boolean;
}

export function ModelSelect({ models, value, onChange, onValidityChange, placeholder, note, disabled }: ModelSelectProps) {
  const { t } = useTranslation('common');
  const [customMode, setCustomMode] = useState(false);
  const [localCustom, setLocalCustom] = useState('');

  const isInList = models.some((m) => m.id === value);
  const showCustomInput = customMode || (value !== '' && models.length > 0 && !isInList);
  const selectValue = showCustomInput ? CUSTOM_SENTINEL : value;

  const effectiveCustom = showCustomInput && !customMode && value !== '' ? value : localCustom;
  const validationError = effectiveCustom !== '' && !isValidModelId(effectiveCustom);

  const isValid = !showCustomInput || (effectiveCustom !== '' && isValidModelId(effectiveCustom));
  React.useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  if (customMode && isInList) {
    setCustomMode(false);
    setLocalCustom('');
  }

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === CUSTOM_SENTINEL) {
      setCustomMode(true);
      setLocalCustom('');
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
            value={effectiveCustom}
            onChange={handleCustomChange}
            placeholder="e.g. claude-opus-5-5[1m]"
            disabled={disabled}
            aria-label="Custom model ID"
            aria-invalid={validationError ? 'true' : undefined}
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
