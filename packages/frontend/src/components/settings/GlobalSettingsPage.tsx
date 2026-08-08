import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { paths } from '../../paths';
import { useIsMobile } from '../../hooks/useIsMobile';
import ProviderSection from './ProviderSection';
import SettingsSectionNav from './SettingsSectionNav';
import SettingsSectionList from './SettingsSectionList';
import StorageSection from './sections/StorageSection';
import ResourceGuardSection from './sections/ResourceGuardSection';
import NotificationsSection from './sections/NotificationsSection';
import AuditLogSection from './sections/AuditLogSection';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, normalizeSettingsSection } from './settingsSections';
import type { SettingsSectionId } from './settingsSections';
import { PageContainer, PageHeader, PageBody, LoadingState, EyebrowBack } from '../ui';

const AppearanceSection = lazy(() => import('./appearance/AppearanceSection'));
const SystemSection = lazy(() => import('./SystemSection'));

interface GlobalSettingsPageProps {
  initialSection?: string;
}

/** Whether a section switch was self-initiated (navigate() called below) vs. an
 * external route change (deep link, browser back/forward) — only the latter
 * should override the mobile list/detail view that a same-tick click already set. */
function isExternalSectionChange(section: string | undefined, lastSelfNavigated: string | undefined): boolean {
  return section !== lastSelfNavigated;
}

export default function GlobalSettingsPage({ initialSection }: GlobalSettingsPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const activeSection: SettingsSectionId = normalizeSettingsSection(initialSection);
  const lastSelfNavigatedRef = useRef<string | undefined>(initialSection);

  // Mobile only: list of sections vs. a section's detail. A deep link to a
  // non-default section (e.g. the "update available" shortcut that opens
  // System directly) skips the list; the default section always starts at
  // the list, matching the Servers drilldown convention (no section in the
  // URL -> list first).
  const [mobileView, setMobileView] = useState<'list' | 'detail'>(
    () => (initialSection && normalizeSettingsSection(initialSection) !== DEFAULT_SETTINGS_SECTION ? 'detail' : 'list'),
  );

  useEffect(() => {
    if (!isExternalSectionChange(initialSection, lastSelfNavigatedRef.current)) return;
    lastSelfNavigatedRef.current = initialSection;
    setMobileView(initialSection && normalizeSettingsSection(initialSection) !== DEFAULT_SETTINGS_SECTION ? 'detail' : 'list');
  }, [initialSection]);

  const selectSection = (id: SettingsSectionId) => {
    lastSelfNavigatedRef.current = id;
    navigate(paths.settings(id));
  };

  const selectMobileSection = (id: SettingsSectionId) => {
    setMobileView('detail');
    selectSection(id);
  };

  const activeLabelKey = SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.labelKey;
  const activeLabel = activeLabelKey ? t(activeLabelKey) : t('common:navigation.settings');

  const detailContent = (
    <Suspense fallback={<LoadingState />}>
      {activeSection === 'appearance' && <AppearanceSection />}
      {activeSection === 'providers' && <ProviderSection layout="inline" />}
      {activeSection === 'storage' && <StorageSection />}
      {activeSection === 'resources' && <ResourceGuardSection />}
      {activeSection === 'notifications' && <NotificationsSection />}
      {activeSection === 'security' && <AuditLogSection />}
      {activeSection === 'system' && <SystemSection />}
    </Suspense>
  );

  const detailPane = (
    <PageContainer maxWidth={760} style={{ height: undefined, overflowY: undefined, padding: 0 }}>
      {isMobile && (
        <div style={{ padding: '14px 12px 0' }}>
          <EyebrowBack label={t('common:navigation.settings')} onBack={() => setMobileView('list')} />
        </div>
      )}
      <PageHeader title={activeLabel} />
      <PageBody>{detailContent}</PageBody>
    </PageContainer>
  );

  if (isMobile) {
    return mobileView === 'list'
      ? <SettingsSectionList onSelect={selectMobileSection} />
      : detailPane;
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, height: '100%' }}>
      <SettingsSectionNav activeSection={activeSection} onSelect={selectSection} />
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {detailPane}
      </div>
    </div>
  );
}
