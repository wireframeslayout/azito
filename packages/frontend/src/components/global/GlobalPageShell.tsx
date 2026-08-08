import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { matchSettingsPath, matchUnitPath, matchSidekickEditPath, matchServerPath, paths } from '../../paths';
import GlobalPageLayout from './GlobalPageLayout';

const Units = lazy(() => import('../../pages/Units'));
const Sidekicks = lazy(() => import('../../pages/Sidekicks'));
const GlobalSettingsPage = lazy(() => import('../settings/GlobalSettingsPage'));
const UnitFormView = lazy(() => import('../UnitFormView'));
const SidekickFormView = lazy(() => import('../SidekickFormView'));
const ProjectsPanel = lazy(() => import('../workspace/ProjectsPanel'));
const ProjectFormView = lazy(() => import('../ProjectFormView'));
const ServersListPage = lazy(() => import('../servers/ServersListPage'));
const ServerDetailPage = lazy(() => import('../servers/ServerDetailPage'));
const Transcript = lazy(() => import('../../pages/Transcript'));

function LoadingFallback() {
  const { t } = useTranslation('common');
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: 'var(--font-base)' }}>
      {t('states.loading')}
    </div>
  );
}

export default function GlobalPageShell() {
  const { t } = useTranslation('common');
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;

  const settingsMatch = matchSettingsPath(pathname);
  if (settingsMatch) {
    return (
      <GlobalPageLayout title="Settings">
        <Suspense fallback={<LoadingFallback />}>
          <GlobalSettingsPage initialSection={settingsMatch.section} />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/units') {
    return (
      <GlobalPageLayout title="Units">
        <Suspense fallback={<LoadingFallback />}>
          <Units
            onOpenUnit={(unitId) => navigate(paths.unit(unitId))}
            onCreate={() => navigate(paths.unitNew())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/units/new') {
    return (
      <GlobalPageLayout title="New Unit">
        <Suspense fallback={<LoadingFallback />}>
          <UnitFormView
            mode="create"
            onSaved={() => navigate(paths.units())}
            onCancel={() => navigate(paths.units())}
            backLabel="Units"
            onBack={() => navigate(paths.units())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  const unitMatch = matchUnitPath(pathname);
  if (unitMatch) {
    const unitId = parseInt(unitMatch.id, 10);
    if (unitMatch.edit) {
      return (
        <GlobalPageLayout title="Edit Unit">
          <Suspense fallback={<LoadingFallback />}>
            <UnitFormView
              mode="edit"
              unitId={unitId}
              onSaved={() => navigate(paths.units())}
              onCancel={() => navigate(paths.units())}
              backLabel="Units"
              onBack={() => navigate(paths.units())}
            />
          </Suspense>
        </GlobalPageLayout>
      );
    }
    return (
      <GlobalPageLayout title={`Unit #${unitId}`}>
        <Suspense fallback={<LoadingFallback />}>
          <Units
            onOpenUnit={(id) => navigate(paths.unit(id))}
            onCreate={() => navigate(paths.unitNew())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/sidekicks') {
    return (
      <GlobalPageLayout title="Sidekicks">
        <Suspense fallback={<LoadingFallback />}>
          <Sidekicks
            onOpenSidekick={(name) => navigate(paths.sidekickEdit(name))}
            onCreate={() => navigate(paths.sidekickNew())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/sidekicks/new') {
    return (
      <GlobalPageLayout title="New Sidekick">
        <Suspense fallback={<LoadingFallback />}>
          <SidekickFormView
            mode="create"
            onSaved={() => navigate(paths.sidekicks())}
            onCancel={() => navigate(paths.sidekicks())}
            backLabel="Sidekicks"
            onBack={() => navigate(paths.sidekicks())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  const sidekickMatch = matchSidekickEditPath(pathname);
  if (sidekickMatch) {
    return (
      <GlobalPageLayout title={`Edit: ${sidekickMatch.name}`}>
        <Suspense fallback={<LoadingFallback />}>
          <SidekickFormView
            mode="edit"
            sidekickName={sidekickMatch.name}
            onSaved={() => navigate(paths.sidekicks())}
            onCancel={() => navigate(paths.sidekicks())}
            backLabel="Sidekicks"
            onBack={() => navigate(paths.sidekicks())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  const serverMatch = matchServerPath(pathname);
  if (serverMatch) {
    return (
      <GlobalPageLayout
        title={serverMatch.name}
        backLabel={t('globalPages.serversList')}
        onBack={() => navigate(paths.servers())}
      >
        <Suspense fallback={<LoadingFallback />}>
          <ServerDetailPage serverName={serverMatch.name} section={serverMatch.section} />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/servers') {
    return (
      <GlobalPageLayout title="Servers">
        <Suspense fallback={<LoadingFallback />}>
          <ServersListPage />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/projects') {
    return (
      <GlobalPageLayout title="Projects">
        <Suspense fallback={<LoadingFallback />}>
          <ProjectsPanel onCreateProject={() => navigate(paths.projectNew())} />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/transcript') {
    return (
      <GlobalPageLayout title={t('globalPages.transcript')}>
        <Suspense fallback={<LoadingFallback />}>
          <Transcript />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  if (pathname === '/projects/new') {
    return (
      <GlobalPageLayout title="New Project">
        <Suspense fallback={<LoadingFallback />}>
          <ProjectFormView
            onSaved={() => navigate(paths.projects())}
            onCancel={() => navigate(paths.projects())}
            backLabel="Projects"
            onBack={() => navigate(paths.projects())}
          />
        </Suspense>
      </GlobalPageLayout>
    );
  }

  return null;
}
