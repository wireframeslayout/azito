import { useTranslation } from 'react-i18next';
import { InstallSteps, type InstallStep } from '../ui/InstallSteps';

export function ServerInstallSteps({ steps }: { steps: InstallStep[] }) {
  const { t } = useTranslation('servers');
  return <InstallSteps steps={steps} renderMessage={(step) => step.code === 'macos_local_network_permission'
    ? <>{t('localNetwork.guidance')}<br />{t('localNetwork.detail')}: {step.detail}</>
    : step.message} />;
}
