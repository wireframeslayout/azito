import { useTranslation } from 'react-i18next';
import type { MuxDriverKind } from '@azito/shared';
import type { MuxKindSelectModel } from '../../lib/muxKindChoice';
import FormField from '../FormField';
import { MuxKindSelect } from '../ui';

interface MuxKindFieldProps {
  /** null while the server is not known yet. Nothing is shown when the server offers one mux only. */
  model: MuxKindSelectModel | null;
  onChange: (kind: MuxDriverKind) => void;
  disabled?: boolean;
}

/** The "terminal type" field of a new-window form: which mux (misao / tmux) the window opens in. */
export default function MuxKindField({ model, onChange, disabled }: MuxKindFieldProps) {
  const { t } = useTranslation('workspace');
  if (!model || !model.visible) return null;
  return (
    <FormField label={t('muxKind.label')}>
      <MuxKindSelect
        value={model.value}
        onChange={onChange}
        kinds={model.kinds}
        availability={model.availability}
        loading={model.loading}
        checkFailed={model.checkFailed}
        disabled={disabled}
      />
    </FormField>
  );
}
