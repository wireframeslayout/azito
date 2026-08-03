import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { Button } from './ui';

/** サーバー側 ResourceGuard の check() が返す計測結果（409 レスポンスの resources フィールド） */
export interface ResourceStatus {
  ok: boolean;
  reasons: Array<'memory' | 'load'>;
  memAvailablePercent: number | null;
  loadPerCore: number | null;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
}

interface ResourceWarningDialogProps {
  open: boolean;
  title: string;
  resources: ResourceStatus | null;
  /** 強制続行ボタンのラベル（例: それでも開く / それでも実行） */
  actionLabel: string;
  /** キャンセル時の補足文（例: キャンセルしてもタスクは失われません） */
  cancelHint?: string;
  loading?: boolean;
  onCancel: () => void;
  onForce: () => void;
}

function MetricRow({ label, value, threshold, exceeded }: {
  label: string;
  value: string;
  threshold: string;
  exceeded: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      padding: 'var(--space-2) var(--space-3)',
      background: 'var(--bg-solid)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    }}>
      <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: exceeded ? 'var(--danger)' : 'var(--success)' }}>
          {value}
        </span>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{threshold}</span>
      </span>
    </div>
  );
}

/**
 * リソースひっ迫警告ダイアログ。サーバーが 409 insufficient_resources を返したときに
 * 計測値と閾値を提示し、キャンセル / 強制続行（force 再送）を選ばせる。
 */
export default function ResourceWarningDialog({
  open, title, resources, actionLabel, cancelHint, loading = false, onCancel, onForce,
}: ResourceWarningDialogProps) {
  const { t } = useTranslation('common');
  if (!resources) return null;
  const memExceeded = resources.reasons.includes('memory');
  const loadExceeded = resources.reasons.includes('load');
  return (
    <Modal
      title={title}
      open={open}
      onClose={onCancel}
      maxWidth={420}
      actions={
        <Button variant="danger" onClick={onForce} loading={loading} loadingLabel="Processing...">
          {actionLabel}
        </Button>
      }
    >
      <div role="alertdialog" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ fontSize: 'var(--font-md)', color: 'var(--text)', lineHeight: 1.6, margin: 0 }}>
          {t('resourceWarning.description')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <MetricRow
            label={t('resourceWarning.freeMemory')}
            value={resources.memAvailablePercent != null ? `${resources.memAvailablePercent.toFixed(1)}%` : '—'}
            threshold={`${t('resourceWarning.minimum')} ${resources.memAvailablePercentMin}%`}
            exceeded={memExceeded}
          />
          <MetricRow
            label={t('resourceWarning.loadPerCore')}
            value={resources.loadPerCore != null ? resources.loadPerCore.toFixed(2) : '—'}
            threshold={`${t('resourceWarning.maximum')} ${resources.loadPerCoreMax}`}
            exceeded={loadExceeded}
          />
        </div>
        <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
          {t('resourceWarning.skipNote', { actionLabel })}
          {cancelHint ? ` ${cancelHint}` : ''}
        </p>
      </div>
    </Modal>
  );
}
