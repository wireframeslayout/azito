import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeyBindings } from '../../../hooks/useHotkeys';
import { formatKeySpec, parseKeySpec } from '../../../lib/hotkeys/keySpec';
import { Notice, SegmentedToggle } from '../../ui';

export default function KeyboardSection() {
  const { t } = useTranslation('settings');
  const { bindings, setBinding, chordMs, setChordMs } = useHotkeyBindings();
  const [error, setError] = useState<'conflict' | 'storage-error' | null>(null);
  const changeBinding = (action: 'search.open' | 'maximize.open', value: string) => {
    const result = setBinding(action, value === 'disabled' ? null : parseKeySpec(value));
    setError(result === 'ok' ? null : result);
  };
  const changeInterval = (value: string) => {
    const result = setChordMs(Number(value));
    setError(result === 'ok' ? null : result);
  };
  const bindingValue = (action: 'search.open' | 'maximize.open') => {
    const binding = bindings[action];
    return binding ? formatKeySpec(binding) : 'disabled';
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t('keyboard.search')}</div>
        <div>
          <SegmentedToggle wrap ariaLabel={t('keyboard.search')} value={bindingValue('search.open')} onChange={(value) => changeBinding('search.open', value)} options={[
            { value: 'Space Space', label: t('keyboard.spaceTwice') },
            { value: 'Ctrl+K', label: 'Ctrl+K' },
            { value: 'Ctrl+R', label: 'Ctrl+R' },
            { value: 'disabled', label: t('keyboard.disabled') },
          ]} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('keyboard.interval')}</div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('keyboard.intervalDescription')}</div>
        </div>
        <SegmentedToggle ariaLabel={t('keyboard.interval')} value={String(chordMs)} onChange={changeInterval} options={['200', '300', '500'].map((value) => ({ value, label: t('keyboard.seconds', { value: Number(value) / 1000 }) }))} />
      </div>
      <Notice tone="info">{t('keyboard.notice')}</Notice>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div style={{ fontWeight: 600 }}>{t('keyboard.maximize')}</div>
        <SegmentedToggle ariaLabel={t('keyboard.maximize')} value={bindingValue('maximize.open')} onChange={(value) => changeBinding('maximize.open', value)} options={[
          { value: 'Ctrl+Shift+M', label: 'Ctrl+Shift+M' },
          { value: 'disabled', label: t('keyboard.disabled') },
        ]} />
      </div>
      {error && <Notice tone="danger">{t(error === 'conflict' ? 'keyboard.conflict' : 'keyboard.storageError')}</Notice>}
    </div>
  );
}
