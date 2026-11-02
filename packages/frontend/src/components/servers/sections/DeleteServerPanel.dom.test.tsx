import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteServerPanel } from './DeleteServerPanel';
import { IDLE_DELETION, type HostRemovalSupport, type UninstallStep } from '../../../lib/serverDeletion';
import type { ServerDeletion } from '../../../hooks/useServerDeletion';

// The key is the text: the test checks which texts the panel picks for each host.
vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: (() => ({ t: (key: string) => key, i18n: { language: 'en' } })) as never,
}));

function deletion(support: HostRemovalSupport, overrides: Partial<ServerDeletion> = {}): ServerDeletion {
  return {
    ...IDLE_DELETION,
    phase: 'confirming',
    support,
    busy: false,
    open: vi.fn(),
    cancel: vi.fn(),
    setRemoveFromHost: vi.fn(),
    setRemoveMisao: vi.fn(),
    confirm: vi.fn(async () => undefined),
    deleteEntryOnly: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('DeleteServerPanel', () => {
  it('offers to remove an Apple Silicon Mac agent from its host, with the Mac texts', () => {
    render(<DeleteServerPanel deletion={deletion('macos')} />);
    expect(screen.getByRole('group', { name: 'danger.hostRemoval.groupLabel' })).toBeInTheDocument();
    expect(screen.getByText('danger.hostRemoval.removeFromHostDescMac')).toBeInTheDocument();
    expect(screen.getByText('danger.hostRemoval.removeMisaoDescMac')).toBeInTheDocument();
    expect(screen.queryByText('danger.hostRemoval.removeFromHostDesc')).toBeNull();
    expect(screen.queryByText('danger.hostRemoval.unsupported')).toBeNull();
  });

  it('says what stays on the Mac when the host removal is turned off', () => {
    render(<DeleteServerPanel deletion={deletion('macos', { choice: { removeFromHost: false, removeMisao: false } })} />);
    expect(screen.getByText('danger.hostRemoval.staysMac')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /danger\.hostRemoval\.manualSteps/ })).toHaveAttribute('href', expect.stringContaining('/posix-agent.md'));
  });

  it('keeps the Windows texts for a Windows agent', () => {
    render(<DeleteServerPanel deletion={deletion('windows')} />);
    expect(screen.getByText('danger.hostRemoval.removeFromHostDesc')).toBeInTheDocument();
    expect(screen.queryByText('danger.hostRemoval.removeFromHostDescMac')).toBeNull();
  });

  it('labels a failed Mac step as the launchd job', () => {
    const steps: UninstallStep[] = [{ id: 'task', outcome: 'failed', detail: 'not the managed agent' }];
    render(<DeleteServerPanel deletion={deletion('macos', { phase: 'hostFailed', failure: { kind: 'steps', steps } })} />);
    expect(screen.getByText('danger.hostRemoval.steps.launchdJob')).toBeInTheDocument();
    expect(screen.queryByText('danger.hostRemoval.steps.task')).toBeNull();
  });
});
