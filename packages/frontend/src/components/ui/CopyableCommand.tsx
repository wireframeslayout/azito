import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { useToast } from '../../hooks/useToast';

interface CopyableCommandProps {
  command: string;
}

/**
 * A command to run by hand, shown as selectable text beside a button that copies it. The text can be selected and copied even where the
 * clipboard API is not available (a page without HTTPS): the button then says so instead of failing without a word.
 */
export function CopyableCommand({ command }: CopyableCommandProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const copy = (): void => {
    const write = navigator.clipboard?.writeText(command);
    if (write === undefined) {
      showToast(t('terminal.clipboardFailed'));
      return;
    }
    write.then(() => showToast(t('copyCommand.copied')), () => showToast(t('terminal.clipboardFailed')));
  };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
      <code
        tabIndex={0}
        style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text)', background: 'var(--bg)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-2)', overflowWrap: 'anywhere', userSelect: 'all',
        }}
      >
        {command}
      </code>
      <Button size="sm" onClick={copy} aria-label={t('copyCommand.copyLabel', { command })}>{t('copyCommand.copy')}</Button>
    </div>
  );
}
