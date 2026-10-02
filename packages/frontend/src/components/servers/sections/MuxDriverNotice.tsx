import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui';
import type { MuxDriverStatus } from '../../../lib/muxDriverStatus';

interface MuxDriverNoticeProps {
  status: MuxDriverStatus;
}

/** Tells the operator why a misao server cannot be driven. Renders nothing while the driver is fine or its state is not known. */
export function MuxDriverNotice({ status }: MuxDriverNoticeProps) {
  const { t } = useTranslation('servers');
  if (status === 'unreachable') {
    return <Notice tone="warning" sub={t('overview.misaoUnreachableSub')}>{t('overview.misaoUnreachable')}</Notice>;
  }
  if (status === 'disabled') {
    return <Notice tone="warning" sub={t('overview.misaoDisabledSub')}>{t('overview.misaoDisabled')}</Notice>;
  }
  return null;
}
