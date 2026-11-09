import { Button } from '../ui/Button';
import type { WindowSnapshotState } from '../../hooks/useWindowSnapshots';

interface Props { snapshot?: WindowSnapshotState; loadingLabel: string; retryLabel: string; onRetry: () => void }
export function LinkedSnapshot({ snapshot, loadingLabel, retryLabel, onRetry }: Props) {
  if (!snapshot) return <span>{loadingLabel}</span>;
  if (snapshot.error) return <div><span>{snapshot.error.message}</span> <Button size="sm" onClick={onRetry}>{retryLabel}</Button></div>;
  return <pre aria-hidden="true" style={{ margin: 0, overflow: 'hidden', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{snapshot.content}</pre>;
}
