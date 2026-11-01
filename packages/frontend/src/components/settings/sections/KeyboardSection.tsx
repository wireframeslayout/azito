import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeyBindings, type HotkeyAction } from '../../../hooks/useHotkeys';
import { formatKeySpec, parseKeySpec } from '../../../lib/hotkeys/keySpec';
import { Notice, SegmentedToggle } from '../../ui';
import { Icon } from '../../ui/Icon';

export default function KeyboardSection() {
  const { t } = useTranslation('settings');
  const { bindings, setBinding, chordMs, setChordMs } = useHotkeyBindings();
  const [error, setError] = useState<'conflict' | 'storage-error' | null>(null);
  const changeBinding = (action: HotkeyAction, value: string) => {
    const result = setBinding(action, value === 'disabled' ? null : parseKeySpec(value));
    setError(result === 'ok' ? null : result);
  };
  const changeInterval = (value: string) => {
    const result = setChordMs(Number(value));
    setError(result === 'ok' ? null : result);
  };
  const bindingValue = (action: HotkeyAction) => {
    const binding = bindings[action];
    return binding ? formatKeySpec(binding) : 'disabled';
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)', minWidth: 0 }}>
        <div style={{ fontWeight: 600, flex: 1, minWidth: 'min(100%, calc(var(--space-4) * 9))' }}>{t('keyboard.search')}</div>
        <div style={{ minWidth: 0, maxWidth: '100%' }}>
          <SegmentedToggle wrap ariaLabel={t('keyboard.search')} value={bindingValue('search.open')} onChange={(value) => changeBinding('search.open', value)} options={[
            { value: 'Space Space', label: t('keyboard.spaceTwice') },
            { value: 'Ctrl+K', label: 'Ctrl+K' },
            { value: 'Ctrl+R', label: 'Ctrl+R' },
            { value: 'disabled', label: t('keyboard.disabled') },
          ]} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div style={{ flex: 1, minWidth: 'min(100%, calc(var(--space-4) * 9))' }}>
          <div style={{ fontWeight: 600 }}>{t('keyboard.interval')}</div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('keyboard.intervalDescription')}</div>
        </div>
        <SegmentedToggle ariaLabel={t('keyboard.interval')} value={String(chordMs)} onChange={changeInterval} options={['200', '300', '500'].map((value) => ({ value, label: t('keyboard.seconds', { value: Number(value) / 1000 }) }))} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
        <Icon name="terminal" size={14} />{t('keyboard.notice')}
      </div>
      {error && <Notice tone="danger">{t(error === 'conflict' ? 'keyboard.conflict' : 'keyboard.storageError')}</Notice>}
    </div>
  );
}
