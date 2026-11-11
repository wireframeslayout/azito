import { Button } from '../ui/Button';
import type { WindowSnapshotState } from '../../hooks/useWindowSnapshots';

interface Props { snapshot?: WindowSnapshotState; previewLabel: string; loadingLabel: string; errorLabel: string; closedLabel: string; retryLabel: string; onRetry: () => void }
export function LinkedSnapshot({ snapshot, previewLabel, loadingLabel, errorLabel, closedLabel, retryLabel, onRetry }: Props) {
  if (snapshot && !snapshot.error && !snapshot.content) return null;
  return <div style={{ margin: 'var(--space-2) 0', minWidth: 0, minHeight: 'calc(var(--space-6) * 2)', boxSizing: 'border-box', background: 'var(--bg-solid)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-2)', color: 'var(--text)' }}>
    {!snapshot ? <div role="status"><span>{loadingLabel}</span><span aria-hidden="true" style={{ display: 'block', height: 'var(--space-2)', width: '80%', marginTop: 'var(--space-2)', borderRadius: 'var(--radius-sm)', background: 'var(--border)' }} /><span aria-hidden="true" style={{ display: 'block', height: 'var(--space-2)', width: '55%', marginTop: 'var(--space-2)', borderRadius: 'var(--radius-sm)', background: 'var(--border)' }} /></div>
      : snapshot.error?.code === 'window_not_found' ? <span>{closedLabel}</span>
      : snapshot.error ? <div><span>{errorLabel}</span> <Button size="sm" style={{ position: 'relative', zIndex: 1 }} onClick={onRetry}>{retryLabel}</Button></div>
      : <pre className="linked-snapshot-output" role="region" aria-label={previewLabel} tabIndex={0} style={{ position: 'relative', zIndex: 1, margin: 0, minWidth: 0, maxHeight: 'calc(var(--space-6) * 4)', overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-xs)' }}>{snapshot.content}</pre>}
  </div>;
}
