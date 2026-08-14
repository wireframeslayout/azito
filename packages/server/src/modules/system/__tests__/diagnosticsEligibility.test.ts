import { describe, it, expect } from 'vitest';
import { isDiagnosticsEnabled } from '../diagnosticsEligibility';

describe('isDiagnosticsEnabled', () => {
  it('ソースコード版はチャンネルによらず有効', () => {
    expect(isDiagnosticsEnabled('source', 'stable')).toBe(true);
    expect(isDiagnosticsEnabled('source', 'rc')).toBe(true);
  });

  it('インストール版は開発中バージョン（rc）のときだけ有効', () => {
    expect(isDiagnosticsEnabled('systemd', 'rc')).toBe(true);
    expect(isDiagnosticsEnabled('launchd', 'rc')).toBe(true);
  });

  it('インストール版で stable チャンネルなら無効', () => {
    expect(isDiagnosticsEnabled('systemd', 'stable')).toBe(false);
    expect(isDiagnosticsEnabled('launchd', 'stable')).toBe(false);
  });
});
