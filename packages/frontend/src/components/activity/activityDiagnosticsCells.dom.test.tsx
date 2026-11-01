import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MatchCell } from './activityDiagnosticsCells';
import type { ActivityDiagnosticRow } from '../../lib/activityDiagnostics';

const row: ActivityDiagnosticRow = { serverName: 'local', target: 'dev:editor', state: 'idle', decidedBy: 'none', supervisorMatchedBy: 'muxPaneRef' };

describe('MatchCell', () => {
  it('preserves tmux notation and uses mux-independent notation for misao', () => {
    const view = render(<MatchCell row={row} />);
    expect(screen.getByText('%N')).toBeTruthy();
    view.rerender(<MatchCell row={{ ...row, target: 'dev:w_01234567890123456789012345' }} />);
    expect(screen.getByText('pane')).toBeTruthy();
    expect(screen.queryByText('%N')).toBeNull();
  });
});
