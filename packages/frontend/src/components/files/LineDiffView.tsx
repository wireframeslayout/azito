import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Overlay } from '../ui/Overlay';
import { Button } from '../ui/Button';
import type { DiffLine } from '../../utils/lineDiff';

interface LineDiffViewProps { lines: DiffLine[] | null; mobile: boolean; onClose: () => void }
export function LineDiffView({ lines, mobile, onClose }: LineDiffViewProps) {
  const { t } = useTranslation('files');
  const titleId = useId();
  return <Overlay open onClose={onClose} labelledBy={titleId} maxWidth={mobile ? '100vw' : '90vw'} maxHeight={mobile ? '100dvh' : '90vh'} style={mobile ? { width: '100vw', height: '100dvh', borderRadius: 0 } : undefined}>
    <h2 id={titleId} style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--font-lg)' }}>{t('editor.diff')}</h2>
    {lines === null ? <p>{t('editor.diffUnavailable')}</p> : <div style={{ overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--space-2)' }}><strong>{t('editor.latest')}</strong><strong>{t('editor.yours')}</strong></div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-sm)' }}>{lines.map((line, index) => <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--space-2)' }}>
        <div style={{ color: line.kind === 'removed' ? 'var(--danger)' : 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line.kind !== 'added' ? `${line.kind === 'removed' ? '- ' : '  '}${line.text}` : '\u00a0'}</div>
        <div style={{ color: line.kind === 'added' ? 'var(--success)' : 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line.kind !== 'removed' ? `${line.kind === 'added' ? '+ ' : '  '}${line.text}` : '\u00a0'}</div>
      </div>)}</div>
    </div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}><Button size="sm" onClick={onClose}>{t('editor.closeDiff')}</Button></div>
  </Overlay>;
}
