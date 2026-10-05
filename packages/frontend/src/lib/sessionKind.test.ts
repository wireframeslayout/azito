import { describe, it, expect } from 'vitest';
import type { Session } from '../pages/workspace/types';
import { findSessionByKey, hasMixedKinds, refUsesMuxRoutes, sessionKey, sessionKindOf, windowTargetOptions, windowTargetSelectOptions } from './sessionKind';

const MISAO_ID = 'w_01M40229BC46M2RPATEBX4JN25';
const misaoRef = JSON.stringify({ kind: 'misao', workspace: 'dev', window: MISAO_ID });
const tmuxRef = JSON.stringify({ kind: 'tmux', workspace: 'dev', window: 'editor' });
const tmuxDev: Session = { name: 'dev', kind: 'tmux', windows: [{ index: 0, name: 'editor', panes: [], ref: tmuxRef, windowId: null }] };
const misaoDev: Session = { name: 'dev', kind: 'misao', windows: [{ index: 0, name: 'main', panes: [], ref: misaoRef, windowId: null }] };

describe('sessionKindOf', () => {
  it('takes the hub stamp, else the kind its windows refs carry, else tmux', () => {
    expect(sessionKindOf(misaoDev)).toBe('misao');
    expect(sessionKindOf({ windows: misaoDev.windows })).toBe('misao');
    expect(sessionKindOf({ windows: [] })).toBe('tmux');
  });
});

describe('sessionKey / findSessionByKey', () => {
  it('keeps a tmux session keyed by its plain name and tells a same-named misao session apart', () => {
    expect(sessionKey(tmuxDev)).toBe('dev');
    expect(sessionKey(misaoDev)).toBe('misao:dev');
    expect(findSessionByKey([tmuxDev, misaoDev], 'dev')).toBe(tmuxDev);
    expect(findSessionByKey([tmuxDev, misaoDev], 'misao:dev')).toBe(misaoDev);
  });
});

describe('windowTargetOptions', () => {
  it('keeps <session>:<index> for tmux and offers a misao window by its id, never by its ordinal (M-022)', () => {
    const options = windowTargetOptions([tmuxDev, misaoDev]);
    expect(options.map((o) => [o.value, o.kind])).toEqual([['dev:0', 'tmux'], [`dev:${MISAO_ID}`, 'misao']]);
  });

  it('names the mux in the label only when two muxes are listed', () => {
    expect(windowTargetSelectOptions([tmuxDev])[0].label).toBe('dev / 0: editor (0 panes)');
    expect(windowTargetSelectOptions([tmuxDev, misaoDev]).map((o) => o.label)).toEqual([
      'dev (tmux) / 0: editor (0 panes)',
      'dev (misao) / 0: main (0 panes)',
    ]);
    expect(hasMixedKinds([tmuxDev])).toBe(false);
  });
});

describe('refUsesMuxRoutes', () => {
  it('sends a tmux ref (or none) to the legacy routes and any other mux to the mux routes', () => {
    expect(refUsesMuxRoutes(tmuxRef)).toBe(false);
    expect(refUsesMuxRoutes(undefined)).toBe(false);
    expect(refUsesMuxRoutes('not-json')).toBe(false);
    expect(refUsesMuxRoutes(misaoRef)).toBe(true);
  });
});
