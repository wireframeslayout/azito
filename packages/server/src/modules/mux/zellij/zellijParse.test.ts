import { describe, it, expect } from 'vitest';
import {
  parseListSessions,
  parseQueryTabNames,
  parseListPanes,
  formatZellijPaneId,
  parseZellijPaneId,
} from './zellijParse';

describe('parseListSessions', () => {
  it('parses active sessions with timestamps', () => {
    const stdout = 'azito-poc [Created 0s ago] \nwork [Created 5m ago] \n';
    expect(parseListSessions(stdout)).toEqual(['azito-poc', 'work']);
  });

  it('skips EXITED sessions', () => {
    const stdout = 'azito [Created 1h ago] \nold-session [EXITED] \n';
    expect(parseListSessions(stdout)).toEqual(['azito']);
  });

  it('handles empty output', () => {
    expect(parseListSessions('')).toEqual([]);
    expect(parseListSessions('\n')).toEqual([]);
  });

  it('handles session name without bracket metadata', () => {
    const stdout = 'simple-name\n';
    expect(parseListSessions(stdout)).toEqual(['simple-name']);
  });
});

describe('parseQueryTabNames', () => {
  it('parses tab names one per line', () => {
    const stdout = 'Tab #1\nwin--poc\ntest-tab\n';
    expect(parseQueryTabNames(stdout)).toEqual(['Tab #1', 'win--poc', 'test-tab']);
  });

  it('handles empty output', () => {
    expect(parseQueryTabNames('')).toEqual([]);
  });

  it('trims whitespace', () => {
    expect(parseQueryTabNames('  main  \n  build  \n')).toEqual(['main', 'build']);
  });
});

describe('parseListPanes', () => {
  const SAMPLE_JSON = JSON.stringify([
    {
      id: 0,
      is_plugin: false,
      is_focused: true,
      is_fullscreen: false,
      is_floating: false,
      is_suppressed: false,
      title: 'bash in azito',
      exited: false,
      exit_status: null,
      is_held: false,
      pane_x: 0, pane_content_x: 0,
      pane_y: 0, pane_content_y: 0,
      pane_rows: 48, pane_content_rows: 48,
      pane_columns: 120, pane_content_columns: 120,
      cursor_coordinates_in_pane: [3, 3],
      terminal_command: null,
      plugin_url: null,
      is_selectable: true,
      index_in_pane_group: {},
      default_fg: null, default_bg: null,
      tab_id: 0, tab_position: 0, tab_name: 'main',
      pane_command: '/bin/bash',
      pane_cwd: '/home/user/project',
    },
    {
      id: 1,
      is_plugin: true,
      is_focused: false,
      is_fullscreen: false,
      is_floating: false,
      is_suppressed: false,
      title: 'tab-bar',
      exited: false,
      exit_status: null,
      is_held: false,
      pane_x: 0, pane_content_x: 0,
      pane_y: 0, pane_content_y: 0,
      pane_rows: 1, pane_content_rows: 1,
      pane_columns: 120, pane_content_columns: 120,
      cursor_coordinates_in_pane: null,
      terminal_command: null,
      plugin_url: 'tab-bar',
      is_selectable: false,
      index_in_pane_group: {},
      default_fg: null, default_bg: null,
      tab_id: 0, tab_position: 0, tab_name: 'main',
    },
  ]);

  it('parses JSON pane listing', () => {
    const panes = parseListPanes(SAMPLE_JSON);
    expect(panes).toHaveLength(2);

    expect(panes[0].id).toBe(0);
    expect(panes[0].isPlugin).toBe(false);
    expect(panes[0].isFocused).toBe(true);
    expect(panes[0].tabId).toBe(0);
    expect(panes[0].tabName).toBe('main');
    expect(panes[0].paneCommand).toBe('/bin/bash');
    expect(panes[0].paneCwd).toBe('/home/user/project');
    expect(panes[0].paneRows).toBe(48);
    expect(panes[0].paneColumns).toBe(120);

    expect(panes[1].id).toBe(1);
    expect(panes[1].isPlugin).toBe(true);
    expect(panes[1].paneCommand).toBeNull();
  });
});

describe('formatZellijPaneId', () => {
  it('formats terminal pane', () => {
    expect(formatZellijPaneId(4, false)).toBe('terminal_4');
  });
  it('formats plugin pane', () => {
    expect(formatZellijPaneId(2, true)).toBe('plugin_2');
  });
});

describe('parseZellijPaneId', () => {
  it('parses terminal_N', () => {
    expect(parseZellijPaneId('terminal_4')).toEqual({ id: 4, isPlugin: false });
  });
  it('parses plugin_N', () => {
    expect(parseZellijPaneId('plugin_2')).toEqual({ id: 2, isPlugin: true });
  });
  it('parses bare number as terminal', () => {
    expect(parseZellijPaneId('3')).toEqual({ id: 3, isPlugin: false });
  });
  it('throws on invalid format', () => {
    expect(() => parseZellijPaneId('invalid')).toThrow('Invalid zellij pane ID');
  });
});
