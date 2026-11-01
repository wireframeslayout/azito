import { describe, expect, it } from 'vitest';
import { diagnosticWindowTitle } from '../../lib/activityDiagnostics';
import type { ActivityDiagnosticRow } from '../../lib/activityDiagnostics';

const row: ActivityDiagnosticRow = { serverName: 'local', target: 'dev:w_01234567890123456789012345', state: 'idle', decidedBy: 'none' };

describe('diagnosticWindowTitle', () => {
  it('uses the registered misao window label and a generic name when absent', () => {
    expect(diagnosticWindowTitle({ ...row, windowId: 12, windowDisplay: { label: 'Editor', labelSource: 'user', windowType: 'agent', workerType: 'claude', muxRef: { kind: 'misao' } } }, 'Window')).toBe('Editor · W-12');
    expect(diagnosticWindowTitle(row, 'Window')).toBe('Window');
  });

  it('keeps tmux targets unchanged', () => {
    expect(diagnosticWindowTitle({ ...row, target: 'dev:editor' }, 'Window')).toBe('dev:editor');
  });
});
