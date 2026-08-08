import { matchPath } from 'react-router-dom';

export const paths = {
  root: () => '/',
  workspace: (id: string | number, mode?: string) =>
    mode ? `/workspace/${id}/${mode}` : `/workspace/${id}`,
  servers: () => '/servers',
  server: (name: string, section?: string) =>
    section ? `/servers/${encodeURIComponent(name)}/${section}` : `/servers/${encodeURIComponent(name)}`,
  projects: () => '/projects',
  projectNew: () => '/projects/new',
  project: (id: string | number) => `/projects/${id}`,
  units: () => '/units',
  unitNew: () => '/units/new',
  unit: (id: number) => `/units/${id}`,
  unitEdit: (id: number) => `/units/${id}/edit`,
  sidekicks: () => '/sidekicks',
  sidekickNew: () => '/sidekicks/new',
  sidekickEdit: (name: string) => `/sidekicks/${name}/edit`,
  settings: (section = 'providers') => `/settings/${section}`,
  transcript: (sessionId?: string) => (sessionId ? `/transcript?session=${encodeURIComponent(sessionId)}` : '/transcript'),
};

export function matchWorkspacePath(pathname: string): { id: string; mode?: string } | null {
  const m = matchPath('/workspace/:id/:mode?', pathname);
  if (!m) return null;
  return { id: m.params.id!, mode: m.params.mode };
}

export function matchSettingsPath(pathname: string): { section: string } | null {
  const m = matchPath('/settings/:section', pathname);
  if (!m) return null;
  return { section: m.params.section! };
}

export function matchUnitPath(pathname: string): { id: string; edit: boolean } | null {
  const edit = matchPath('/units/:id/edit', pathname);
  if (edit) return { id: edit.params.id!, edit: true };
  const view = matchPath('/units/:id', pathname);
  if (view) return { id: view.params.id!, edit: false };
  return null;
}

export function matchSidekickEditPath(pathname: string): { name: string } | null {
  const m = matchPath('/sidekicks/:name/edit', pathname);
  if (!m) return null;
  return { name: m.params.name! };
}

export function matchServerPath(pathname: string): { name: string; section?: string } | null {
  const detail = matchPath('/servers/:name/:section', pathname);
  if (detail) return { name: decodeURIComponent(detail.params.name!), section: detail.params.section };
  const base = matchPath('/servers/:name', pathname);
  if (base) return { name: decodeURIComponent(base.params.name!) };
  return null;
}

export function isGlobalPagePath(pathname: string): boolean {
  return (
    pathname === '/servers' ||
    pathname.startsWith('/servers/') ||
    pathname === '/projects' ||
    pathname === '/projects/new' ||
    pathname === '/units' ||
    pathname.startsWith('/units/') ||
    pathname === '/sidekicks' ||
    pathname.startsWith('/sidekicks/') ||
    pathname.startsWith('/settings/') ||
    pathname === '/transcript'
  );
}

export const ROUTE_PATHS = [
  '/',
  '/workspace/:id',
  '/workspace/:id/:mode',
  '/servers',
  '/servers/:name',
  '/servers/:name/:section',
  '/projects',
  '/projects/new',
  '/projects/:id',
  '/units',
  '/units/new',
  '/units/:id',
  '/units/:id/edit',
  '/sidekicks',
  '/sidekicks/new',
  '/sidekicks/:name/edit',
  '/settings/:section',
  '/transcript',
] as const;
