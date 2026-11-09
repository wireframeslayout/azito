import { describe, expect, it } from 'vitest';
import { misaoFailureReason } from './misaoFailureReason';

describe('misao failure reasons', () => {
  it.each([[1001, 'pane not found'], [1002, 'pane has exited'], [1006, 'workspace not found'], [1007, 'window not found']])('maps RPC code %i', (code, reason) => {
    expect(misaoFailureReason({ code, message: 'AZITO_UI_TOKEN=secret' })).toBe(reason);
  });
  it.each(['command not found: claude AZITO_UI_TOKEN=secret', 'program not found: secret'])('reports program resolution failure safely', (message) => {
    expect(misaoFailureReason({ code: 1007, message })).toBe('program not found');
  });
  it('does not expose unrecognized errors', () => {
    expect(misaoFailureReason({ message: 'pane.open AZITO_UI_TOKEN=secret' })).toBe('execution failed');
  });
});
