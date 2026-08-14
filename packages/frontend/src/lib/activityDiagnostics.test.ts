import { describe, it, expect } from 'vitest';
import { activityDotState, parseDiagnosticsResponse, type ActivityDiagnosticRow } from './activityDiagnostics';

describe('parseDiagnosticsResponse', () => {
  const row: ActivityDiagnosticRow = {
    serverName: 'local',
    target: 'azito:agent-1',
    state: 'working',
    decidedBy: 'tier0_supervisor',
  };

  it('returns the rows on a 2xx array body', () => {
    expect(parseDiagnosticsResponse(200, [row])).toEqual([row]);
  });

  it('rejects a non-2xx response instead of passing its error body through as rows', () => {
    // api() だけでは 500 の Fastify エラーオブジェクトがそのまま行配列として流れ、描画時に落ちる。
    expect(() => parseDiagnosticsResponse(500, { statusCode: 500, error: 'Internal Server Error' }))
      .toThrow(/status 500/);
  });

  it('rejects a 2xx body that is not an array', () => {
    expect(() => parseDiagnosticsResponse(200, { statusCode: 200 })).toThrow(/unexpected body/);
  });
});

describe('activityDotState', () => {
  const make = (
    target: string,
    state: ActivityDiagnosticRow['state'],
    decidedBy: ActivityDiagnosticRow['decidedBy'],
  ): ActivityDiagnosticRow => ({ serverName: 'local', target, state, decidedBy });

  it('未取得は消灯（未取得を「稼働あり」と見せない）', () => {
    expect(activityDotState(null)).toBe('off');
  });

  it('オフラインしか無ければ消灯', () => {
    expect(activityDotState([make('a', 'offline', 'tier0_supervisor')])).toBe('off');
  });

  it('イベント駆動（Tier 0/1）の判定が1件でもあれば accent', () => {
    expect(activityDotState([
      make('a', 'idle', 'tier2_title'),
      make('b', 'working', 'tier1_hook'),
    ])).toBe('active');
  });

  it('フォールバック Tier だけなら dim', () => {
    expect(activityDotState([
      make('a', 'working', 'tier4_probe'),
      make('b', 'offline', 'tier0_supervisor'),
    ])).toBe('inactive');
  });
});
