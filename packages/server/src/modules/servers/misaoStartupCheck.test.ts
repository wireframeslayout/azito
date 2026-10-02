import { describe, it, expect, vi } from 'vitest';
import { reportMisaoServersWhenDisabled } from './misaoStartupCheck';

describe('reportMisaoServersWhenDisabled', () => {
  it('logs one error per misao server with recovery steps when the flag is off', () => {
    const logger = { error: vi.fn() };
    const repo = { listNamesByMuxRuntime: vi.fn().mockReturnValue(['alpha', 'beta']) };
    expect(reportMisaoServersWhenDisabled(repo, false, logger)).toEqual(['alpha', 'beta']);
    expect(repo.listNamesByMuxRuntime).toHaveBeenCalledWith('misao');
    expect(logger.error).toHaveBeenCalledTimes(2);
    const message = logger.error.mock.calls[0][0] as string;
    expect(message).toContain('"alpha"');
    expect(message).toContain('AZITO_EXPERIMENTAL_MISAO=1');
    expect(message).toContain("'system'");
    expect(message).toContain('PUT /api/servers/alpha {"muxRuntime":"system"}');
  });

  it('URL-encodes the server name in the PUT recovery hint', () => {
    const logger = { error: vi.fn() };
    reportMisaoServersWhenDisabled({ listNamesByMuxRuntime: () => ['my server'] }, false, logger);
    expect(logger.error.mock.calls[0][0]).toContain('PUT /api/servers/my%20server {"muxRuntime":"system"}');
  });

  it('is silent when no misao server exists', () => {
    const logger = { error: vi.fn() };
    expect(reportMisaoServersWhenDisabled({ listNamesByMuxRuntime: () => [] }, false, logger)).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is on', () => {
    const logger = { error: vi.fn() };
    const repo = { listNamesByMuxRuntime: vi.fn().mockReturnValue(['alpha']) };
    expect(reportMisaoServersWhenDisabled(repo, true, logger)).toEqual([]);
    expect(repo.listNamesByMuxRuntime).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
