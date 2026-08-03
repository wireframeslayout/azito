import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import Modal from './Modal';
import { Badge } from './ui/Badge';
import { Button, Spinner } from './ui';

interface DiscoveredRemote {
  name: string;
  url: string;
  provider: 'github' | 'gitlab' | 'other';
  owner: string | null;
  repoName: string | null;
  alreadyRegistered: boolean;
}

interface DiscoveredRepo {
  relativePath: string;
  absolutePath: string;
  remotes: DiscoveredRemote[];
}

interface DiscoverResponse {
  repositories: DiscoveredRepo[];
}

interface RepoDiscoveryDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  serverName: string;
  onRegistered: () => void;
}

const PROVIDER_TONE: Record<string, 'accent' | 'orange' | 'neutral'> = {
  github: 'accent',
  gitlab: 'orange',
  other: 'neutral',
};

export default function RepoDiscoveryDialog({ open, onClose, projectId, serverName, onRegistered }: RepoDiscoveryDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const discover = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<DiscoverResponse>(`/projects/${projectId}/servers/${serverName}/discover-repositories`);
      setRepos(res.repositories);
      const initial = new Set<string>();
      for (const repo of res.repositories) {
        for (const remote of repo.remotes) {
          if (!remote.alreadyRegistered) {
            initial.add(remote.url);
          }
        }
      }
      setSelected(initial);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to discover repositories');
    } finally {
      setLoading(false);
    }
  }, [projectId, serverName]);

  useEffect(() => {
    if (open) discover();
  }, [open, discover]);

  const toggleSelect = useCallback((url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const selectableRemotes = repos.flatMap((r) => r.remotes).filter((r) => !r.alreadyRegistered);

  const toggleAll = useCallback(() => {
    if (selected.size === selectableRemotes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableRemotes.map((r) => r.url)));
    }
  }, [selected.size, selectableRemotes]);

  const handleRegister = useCallback(async () => {
    const toRegister: Array<{ url: string; name?: string; provider: string; owner?: string; repoName?: string }> = [];
    for (const repo of repos) {
      for (const remote of repo.remotes) {
        if (selected.has(remote.url)) {
          toRegister.push({
            url: remote.url,
            provider: remote.provider,
            owner: remote.owner ?? undefined,
            repoName: remote.repoName ?? undefined,
          });
        }
      }
    }
    if (toRegister.length === 0) return;

    setSubmitting(true);
    try {
      await api(`/projects/${projectId}/repositories/bulk`, {
        method: 'POST',
        body: JSON.stringify({ repositories: toRegister }),
      });
      onRegistered();
      onClose();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to register repositories');
    } finally {
      setSubmitting(false);
    }
  }, [repos, selected, projectId, onRegistered, onClose]);

  const totalRemotes = repos.reduce((n, r) => n + r.remotes.length, 0);

  return (
    <Modal
      title="Discover Repositories"
      open={open}
      onClose={onClose}
      maxWidth={640}
      actions={
        !loading && !error && totalRemotes > 0 ? (
          <Button variant="primary" onClick={handleRegister} loading={submitting} loadingLabel="Registering..." disabled={selected.size === 0}>
            Register {selected.size} {selected.size === 1 ? 'repository' : 'repositories'}
          </Button>
        ) : undefined
      }
    >
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '32px 0' }}>
          <Spinner size={16} />
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Scanning for git repositories...</span>
        </div>
      )}

      {error && !loading && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{error}</div>
          <Button size="sm" onClick={discover}>Retry</Button>
        </div>
      )}

      {!loading && !error && totalRemotes === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-dim)', fontSize: 13 }}>
          No git repositories with remotes were found in the working directory.
        </div>
      )}

      {!loading && !error && totalRemotes > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {repos.length} {repos.length === 1 ? 'repository' : 'repositories'}, {totalRemotes} {totalRemotes === 1 ? 'remote' : 'remotes'}
            </span>
            {selectableRemotes.length > 0 && (
              <label style={{ fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={selected.size === selectableRemotes.length && selectableRemotes.length > 0}
                  onChange={toggleAll}
                  style={{ margin: 0 }}
                />
                Select all
              </label>
            )}
          </div>

          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            {repos.map((repo) => (
              <div key={repo.absolutePath}>
                <div style={{
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text-dim)',
                  background: 'var(--bg-card)',
                  borderBottom: '1px solid var(--border)',
                  fontFamily: 'monospace',
                }}>
                  {repo.relativePath}
                </div>
                {repo.remotes.map((remote) => {
                  const disabled = remote.alreadyRegistered;
                  return (
                    <label
                      key={`${repo.absolutePath}:${remote.name}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px 8px 16px',
                        fontSize: 13,
                        borderBottom: '1px solid var(--border)',
                        cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.45 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={disabled ? false : selected.has(remote.url)}
                        onChange={() => toggleSelect(remote.url)}
                        disabled={disabled}
                        style={{ margin: 0, flexShrink: 0 }}
                      />
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        <Badge tone={PROVIDER_TONE[remote.provider] ?? 'neutral'} style={{ fontSize: 10, padding: '1px 6px' }}>
                          {remote.provider}
                        </Badge>
                        {remote.name === 'origin' && (
                          <Badge tone="green" style={{ fontSize: 10, padding: '1px 6px' }}>origin</Badge>
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {remote.owner && remote.repoName ? `${remote.owner}/${remote.repoName}` : remote.url}
                        </span>
                        {remote.name !== 'origin' && (
                          <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{remote.name}</span>
                        )}
                      </span>
                      {disabled && (
                        <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>Registered</span>
                      )}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
