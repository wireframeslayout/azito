import { Button } from '../ui/Button';
import type { WindowSnapshotState } from '../../hooks/useWindowSnapshots';

interface Props { snapshot?: WindowSnapshotState; loadingLabel: string; errorLabel: string; closedLabel: string; retryLabel: string; onRetry: () => void }
export function LinkedSnapshot({ snapshot, loadingLabel, errorLabel, closedLabel, retryLabel, onRetry }: Props) {
  if (!snapshot) return <div role="status" style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)', color: 'var(--text-dim)' }}><span>{loadingLabel}</span><span aria-hidden="true" style={{ display: 'block', height: 'var(--space-2)', width: '80%', marginTop: 'var(--space-2)', borderRadius: 'var(--radius-sm)', background: 'var(--border)' }} /><span aria-hidden="true" style={{ display: 'block', height: 'var(--space-2)', width: '55%', marginTop: 'var(--space-2)', borderRadius: 'var(--radius-sm)', background: 'var(--border)' }} /></div>;
  if (snapshot.error?.code === 'window_not_found') return <span>{closedLabel}</span>;
  if (snapshot.error) return <div><span>{errorLabel}</span> <Button size="sm" style={{ position: 'relative', zIndex: 1 }} onClick={onRetry}>{retryLabel}</Button></div>;
  return <pre aria-hidden="true" style={{ margin: 0, overflow: 'hidden', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{snapshot.content}</pre>;
}
