import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import OverviewSection from './OverviewSection';
import type { Server, Session } from '../../../hooks/useServerManagement';

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => key === 'overview.fetchUnavailable' ? `Unavailable${values?.reason}` : key === 'overview.sessionsSummary' ? `Sessions ${values?.sessionCount}` : key === 'sessionState.partial' ? 'Partial' : key === 'overview.fetchReasons.agent_unreachable' ? 'Agent unreachable' : key === 'overview.fetchReasons.daemon_unreachable' ? 'Daemon unreachable' : key }) }));
vi.mock('../../../hooks/useServerResources', () => ({ useServerResourcesContext: () => [], getHealthLevel: () => 'healthy' }));
vi.mock('../../../hooks/useIsolationDoctor', () => ({ useIsolationDoctor: () => ({ running: false, runDoctor: vi.fn() }) }));
vi.mock('../../../hooks/useHealth', () => ({ useHealth: () => ({ scopedAuthEnabled: true }) }));

it('shows unavailable reasons instead of old values until recovery', () => {
  const props = {
    server: { name: 'a', type: 'agent', defaultMux: 'misao' } as Server,
    status: { status: 'offline' as const }, installStatus: null,
    sessions: [{ name: 'old', attached: false, windowCount: 1, windows: [] }] as Session[],
    isolationReport: null, isolationReportUnavailable: false,
    isolationCleanupReport: null, isolationCleanupReportUnavailable: false,
    muxDriverStatus: 'ok' as const, refresh: vi.fn(), onEdit: vi.fn(),
  };
  const { rerender } = render(<OverviewSection {...props} sessionsState="error" sessionsReason="agent_unreachable" muxFetchState="error" muxReason="agent_unreachable" />);
  expect(screen.getAllByText('Unavailable (Agent unreachable)')).toHaveLength(2);
  expect(screen.queryByText('overview.misaoConnected')).not.toBeInTheDocument();
  expect(screen.queryByText('Sessions 1')).not.toBeInTheDocument();
  rerender(<OverviewSection {...props} sessionsState="ready" muxFetchState="ready" />);
  expect(screen.getByText('overview.misaoConnected')).toBeInTheDocument();
  expect(screen.getByText('Sessions 1')).toBeInTheDocument();
});

it('shows a partial listing as partial, not as unavailable', () => {
  render(
    <OverviewSection
      server={{ name: 'a', type: 'agent', defaultMux: 'misao' } as Server}
      status={{ status: 'online' }} installStatus={null} sessions={[]}
      isolationReport={null} isolationReportUnavailable={false}
      isolationCleanupReport={null} isolationCleanupReportUnavailable={false}
      muxDriverStatus="ok" refresh={vi.fn()} onEdit={vi.fn()}
      sessionsState="partial" sessionsReason="daemon_unreachable" muxFetchState="ready"
    />,
  );
  expect(screen.getByText('Partial (Daemon unreachable)')).toBeInTheDocument();
  expect(screen.queryByText(/^Unavailable/)).not.toBeInTheDocument();
});


it('preserves unknown reason codes alongside translated known reasons', () => {
  render(<OverviewSection server={{ name: 'a', type: 'agent', defaultMux: 'misao' } as Server}
    status={{ status: 'offline' }} installStatus={null} sessions={[]}
    isolationReport={null} isolationReportUnavailable={false} isolationCleanupReport={null} isolationCleanupReportUnavailable={false}
    muxDriverStatus="unknown" refresh={vi.fn()} onEdit={vi.fn()} sessionsState="partial"
    sessionsReason="daemon_unreachable, future_reason" muxFetchState="error" muxReason="future_reason" />);
  expect(screen.getByText('Partial (Daemon unreachable, future_reason)')).toBeInTheDocument();
  expect(screen.getByText('Unavailable (future_reason)')).toBeInTheDocument();
});
