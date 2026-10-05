import { describe, it, expect } from 'vitest';
import { splitPaneEnv } from './paneSecretEnv';

describe('splitPaneEnv', () => {
  it('routes credentials and isolation masks to ephemeralEnv', () => {
    const { env, ephemeralEnv } = splitPaneEnv({
      AZITO_TASK_TOKEN: 't',
      AZITO_HUB_PUSH: '1',
      AZITO_SECRET_API_KEY: 'k',
      AZITO_UI_TOKEN: '',
      AZITO_AGENT_TOKEN: '',
      AZITO_TASK_ID: '12',
      AZITO_AGENT_PORT: '3002',
    });
    expect(ephemeralEnv).toEqual({ AZITO_TASK_TOKEN: 't', AZITO_HUB_PUSH: '1', AZITO_SECRET_API_KEY: 'k', AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' });
    expect(env).toEqual({ AZITO_TASK_ID: '12', AZITO_AGENT_PORT: '3002' });
  });

  it('keeps keys it does not know as ephemeral', () => {
    expect(splitPaneEnv({ AZITO_NEW_CREDENTIAL: 'x', AZITO_SPLIT_SECRET: 'y' })).toEqual({ env: {}, ephemeralEnv: { AZITO_NEW_CREDENTIAL: 'x', AZITO_SPLIT_SECRET: 'y' } });
  });

  it('returns empty objects for empty input', () => {
    expect(splitPaneEnv({})).toEqual({ env: {}, ephemeralEnv: {} });
  });
});
