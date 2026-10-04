import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MuxDriverKind } from '@azito/shared';
import type { MuxAvailabilityMap } from '../../lib/muxKindChoice';
import { SegmentedToggle, type SegmentedToggleOption } from './SegmentedToggle';
import { Spinner } from './Spinner';

interface MuxKindSelectProps {
  value: MuxDriverKind;
  onChange: (kind: MuxDriverKind) => void;
  /** 選べる方式（表示順）。 */
  kinds: readonly MuxDriverKind[];
  availability: MuxAvailabilityMap;
  /** 方式の可否を確認中。切り替えを止めて「確認中」を出す。 */
  loading?: boolean;
  /** 可否の確認に失敗した。選択は止めず、作成時にハブが最終判定する旨を出す。 */
  checkFailed?: boolean;
  disabled?: boolean;
}

const textStyle = { fontSize: 'var(--font-xs)', color: 'var(--text-dim)', lineHeight: 1.5 } as const;

/**
 * 窓を開くターミナル方式（misao / tmux）の切り替え。使えない方式は disabled にして理由を画面に出す。
 * 表示の判定（初期値・理由・可否）は lib/muxKindChoice の純関数が持ち、ここは描画だけを行う。
 */
export function MuxKindSelect({ value, onChange, kinds, availability, loading = false, checkFailed = false, disabled = false }: MuxKindSelectProps) {
  const { t } = useTranslation('workspace');
  const reasonId = useId();
  const down = kinds.filter((kind) => !availability[kind].ok);

  const options: SegmentedToggleOption<MuxDriverKind>[] = kinds.map((kind) => {
    const state = availability[kind];
    const reason = !state.ok && state.reason ? t(`muxKind.reason.${state.reason}`) : undefined;
    return {
      value: kind,
      label: t(`muxKind.${kind}`),
      disabled: !state.ok,
      disabledReason: reason,
      describedBy: reasonId,
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <SegmentedToggle
        options={options}
        value={value}
        onChange={onChange}
        size="md"
        ariaLabel={t('muxKind.label')}
        disabled={disabled || loading}
      />
      <div id={reasonId} role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {loading && (
          <span style={{ ...textStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Spinner size={10} />
            {t('muxKind.checking')}
          </span>
        )}
        {!loading && down.map((kind) => (
          <span key={kind} style={{ ...textStyle, overflowWrap: 'anywhere' }}>
            {t(`muxKind.${kind}`)}: {t(`muxKind.reason.${availability[kind].reason ?? 'unavailable'}`)}
          </span>
        ))}
        {checkFailed && <span role="alert" style={{ ...textStyle, color: 'var(--danger)' }}>{t('muxKind.checkFailed')}</span>}
      </div>
    </div>
  );
}
