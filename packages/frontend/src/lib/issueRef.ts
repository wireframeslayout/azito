import { isSupportedProvider, buildIssueUrl as buildIssueUrlForProvider } from './gitProvider';

export function parseSourceRef(sourceRef: string): { owner: string; repo: string; number: number } | null {
  const hashIdx = sourceRef.indexOf('#');
  if (hashIdx < 0) return null;

  const num = parseInt(sourceRef.slice(hashIdx + 1), 10);
  if (!Number.isFinite(num) || num <= 0) return null;

  const left = sourceRef.slice(0, hashIdx);
  const lastSlash = left.lastIndexOf('/');
  if (lastSlash < 1) return null;

  const owner = left.slice(0, lastSlash);
  const repo = left.slice(lastSlash + 1);
  if (!owner || !repo) return null;

  return { owner, repo, number: num };
}

export function buildIssueUrl(source: string, sourceRef: string, repoUrl?: string | null): string | null {
  const parsed = parseSourceRef(sourceRef);
  if (!parsed || !isSupportedProvider(source)) return null;

  return buildIssueUrlForProvider(source, parsed.owner, parsed.repo, parsed.number, repoUrl);
}
