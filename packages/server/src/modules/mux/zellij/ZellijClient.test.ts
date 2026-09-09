import { describe, it, expect, vi } from 'vitest';
import { ZellijClient } from './ZellijClient';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import { WindowExistsError } from '../../tmux/WindowExistsError';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { MuxRef } from '@azito/shared';

const LIST_SESSIONS = 'azito [Created 300s ago] \n';

const QUERY_TAB_NAMES = 'main\nbuild\n';

const LIST_PANES_JSON = JSON.stringify([
  { id: 1, is_plugin: true, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'tab-bar', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 0, pane_content_y: 0, pane_rows: 1, pane_content_rows: 1, pane_columns: 120, pane_content_columns: 120, cursor_coordinates_in_pane: null, terminal_command: null, plugin_url: 'tab-bar', is_selectable: false, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 0, tab_position: 0, tab_name: 'main' },
  { id: 0, is_plugin: false, is_focused: true, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'bash in project', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 1, pane_content_y: 1, pane_rows: 24, pane_content_rows: 24, pane_columns: 60, pane_content_columns: 60, cursor_coordinates_in_pane: [3, 3], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 0, tab_position: 0, tab_name: 'main', pane_command: '/bin/bash', pane_cwd: '/home/user/project' },
  { id: 1, is_plugin: false, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'vim', exited: false, exit_status: null, is_held: false, pane_x: 60, pane_content_x: 60, pane_y: 1, pane_content_y: 1, pane_rows: 24, pane_content_rows: 24, pane_columns: 60, pane_content_columns: 60, cursor_coordinates_in_pane: [0, 0], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 0, tab_position: 0, tab_name: 'main', pane_command: 'vim', pane_cwd: '/home/user/project' },
  { id: 2, is_plugin: false, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'bash', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 0, pane_content_y: 0, pane_rows: 50, pane_content_rows: 50, pane_columns: 120, pane_content_columns: 120, cursor_coordinates_in_pane: [5, 0], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 1, tab_position: 1, tab_name: 'build', pane_command: '/bin/bash', pane_cwd: '/home/user/project' },
]);

function lastArgs(args: string[]): string {
  const actionIdx = args.indexOf('action');
  return actionIdx >= 0 ? args.slice(actionIdx + 1).join(' ') : args.join(' ');
}

function makeClient(handler: (args: string[]) => string) {
  const execMux = vi.fn(async (req: { kind: string; args?: string[] }) => {
    if (req.kind === 'zellij-ctl') return { stdout: 'ok', stderr: '', code: 0 };
    const result = handler(req.args ?? []);
    return { stdout: result, stderr: '', code: 0 };
  });
  const factory = {
    getTransport: () => ({ execMux, openTerminal: vi.fn() }),
  } as unknown as TransportFactory;
  return { client: new ZellijClient(factory, 'azito'), execMux };
}

function defaultHandler(args: string[]): string {
  const cmd = lastArgs(args);
  if (cmd.startsWith('list-panes')) return LIST_PANES_JSON;
  if (cmd.startsWith('query-tab-names')) return QUERY_TAB_NAMES;
  if (args.includes('list-sessions')) return LIST_SESSIONS;
  return '';
}

const server = { name: 'server007-zellij', type: 'agent' as const, muxRuntime: 'zellij' as const } as any;

describe('ZellijClient', () => {
  describe('kind and caps', () => {
    const { client } = makeClient(() => '');
    it('kind is zellij', () => expect(client.kind).toBe('zellij'));
    it('outputStream is false', () => expect(client.caps.outputStream).toBe(false));
    it('changeEvents is false', () => expect(client.caps.changeEvents).toBe(false));
    it('agentState is false', () => expect(client.caps.agentState).toBe(false));
    it('independentClients is true', () => expect(client.caps.independentClients).toBe(true));
    it('envInjection is true', () => expect(client.caps.envInjection).toBe(true));
    it('zoom is true', () => expect(client.caps.zoom).toBe(true));
    it('copyMode is false', () => expect(client.caps.copyMode).toBe(false));
    it('paneTitle is true', () => expect(client.caps.paneTitle).toBe(true));
    it('activityCounter is false', () => expect(client.caps.activityCounter).toBe(false));
    it('layoutSnapshot is true', () => expect(client.caps.layoutSnapshot).toBe(true));
    it('stablePaneHandle is true', () => expect(client.caps.stablePaneHandle).toBe(true));
  });

  describe('listWorkspaces', () => {
    it('returns 1 workspace with 2 windows, plugin panes excluded', async () => {
      const { client } = makeClient(defaultHandler);
      const workspaces = await client.listWorkspaces(server);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe('azito');
      expect(workspaces[0].windowCount).toBe(2);
      expect(workspaces[0].windows).toHaveLength(2);
      expect(workspaces[0].windows[0].name).toBe('main');
      expect(workspaces[0].windows[0].panes).toHaveLength(2);
      expect(workspaces[0].windows[1].name).toBe('build');
      expect(workspaces[0].windows[1].panes).toHaveLength(1);
    });

    it('returns empty when session not found', async () => {
      const { client } = makeClient((args) => {
        if (args.includes('list-sessions')) return 'other-session [Created 10s ago] \n';
        return defaultHandler(args);
      });
      const workspaces = await client.listWorkspaces(server);
      expect(workspaces).toHaveLength(0);
    });
  });

  describe('openWindow', () => {
    const EDITOR_PANES_JSON = JSON.stringify([
      ...JSON.parse(LIST_PANES_JSON),
      { id: 3, is_plugin: false, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'bash', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 0, pane_content_y: 0, pane_rows: 50, pane_content_rows: 50, pane_columns: 120, pane_content_columns: 120, cursor_coordinates_in_pane: [0, 0], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 2, tab_position: 2, tab_name: 'editor', pane_command: '/bin/bash', pane_cwd: '/home/user/project' },
    ]);

    it('calls ensureResident then new-tab, returns ref', async () => {
      const { client, execMux } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('new-tab')) return '3';
        if (cmd.startsWith('list-panes')) return EDITOR_PANES_JSON;
        return defaultHandler(args);
      });
      const { ref } = await client.openWindow(server, 'azito', 'editor');
      expect(ref).toEqual({ kind: 'zellij', workspace: 'azito', window: 'editor' });
      const ctlCall = execMux.mock.calls.find(([req]: any) => req.kind === 'zellij-ctl');
      expect(ctlCall).toBeDefined();
      expect(ctlCall![0]).toMatchObject({ kind: 'zellij-ctl', action: 'ensure-resident', session: 'azito' });
      const newTabCall = execMux.mock.calls.find(([req]: any) => req.args?.includes('new-tab'));
      expect(newTabCall).toBeDefined();
    });

    it('falls back to go-to-tab-name + new-pane when pane missing', async () => {
      const { client, execMux } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('new-tab')) return '3';
        if (cmd.startsWith('new-pane')) return 'terminal_5';
        return defaultHandler(args);
      });
      await client.openWindow(server, 'azito', 'editor');
      const goToCall = execMux.mock.calls.find(([req]: any) => req.args?.includes('go-to-tab-name'));
      expect(goToCall).toBeDefined();
      expect(goToCall![0].args).toContain('editor');
      const newPaneCall = execMux.mock.calls.find(([req]: any) => {
        const a = req.args as string[] | undefined;
        return a?.includes('new-pane') && !a?.includes('new-tab');
      });
      expect(newPaneCall).toBeDefined();
    });

    it('generates win--xxxx name when baseName is empty', async () => {
      const GENERATED_PANES = JSON.stringify([
        ...JSON.parse(LIST_PANES_JSON),
        { id: 3, is_plugin: false, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'bash', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 0, pane_content_y: 0, pane_rows: 50, pane_content_rows: 50, pane_columns: 120, pane_content_columns: 120, cursor_coordinates_in_pane: [0, 0], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 2, tab_position: 2, tab_name: 'placeholder', pane_command: '/bin/bash', pane_cwd: '/home/user/project' },
      ]);
      const { client } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('query-tab-names')) return QUERY_TAB_NAMES;
        if (cmd.startsWith('new-tab')) return '3';
        if (cmd.startsWith('list-panes')) return GENERATED_PANES;
        return defaultHandler(args);
      });
      const result = await client.openWindow(server, 'azito');
      expect(result.windowName).toMatch(/^win--[a-z0-9]{4}$/);
    });

    it('uses explicit baseName as-is without suffix', async () => {
      const { client } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('query-tab-names')) return QUERY_TAB_NAMES;
        if (cmd.startsWith('new-tab')) return '3';
        if (cmd.startsWith('list-panes')) return JSON.stringify([
          ...JSON.parse(LIST_PANES_JSON),
          { id: 3, is_plugin: false, is_focused: false, is_fullscreen: false, is_floating: false, is_suppressed: false, title: 'bash', exited: false, exit_status: null, is_held: false, pane_x: 0, pane_content_x: 0, pane_y: 0, pane_content_y: 0, pane_rows: 50, pane_content_rows: 50, pane_columns: 120, pane_content_columns: 120, cursor_coordinates_in_pane: [0, 0], terminal_command: null, plugin_url: null, is_selectable: true, index_in_pane_group: {}, default_fg: null, default_bg: null, tab_id: 2, tab_position: 2, tab_name: 'dev', pane_command: '/bin/bash', pane_cwd: '/home/user/project' },
        ]);
        return defaultHandler(args);
      });
      const result = await client.openWindow(server, 'azito', 'dev');
      expect(result.windowName).toBe('dev');
    });

    it('throws WindowExistsError when tab name already exists', async () => {
      const { client } = makeClient(defaultHandler);
      await expect(client.openWindow(server, 'azito', 'main')).rejects.toBeInstanceOf(WindowExistsError);
      await expect(client.openWindow(server, 'azito', 'main')).rejects.toMatchObject({ windowName: 'main' });
    });
  });

  describe('closeWindow', () => {
    it('resolves tab ID then calls close-tab --tab-id', async () => {
      const { client, execMux } = makeClient(defaultHandler);
      await client.closeWindow(server, { kind: 'zellij', workspace: 'azito', window: 'main' });
      const closeCall = execMux.mock.calls.find(([req]: any) => req.args.includes('close-tab'));
      expect(closeCall).toBeDefined();
      expect(closeCall![0].args).toContain('--tab-id');
      expect(closeCall![0].args).toContain('0');
    });
  });

  describe('windowExists', () => {
    it('returns true for existing tab', async () => {
      const { client } = makeClient(defaultHandler);
      expect(await client.windowExists(server, { kind: 'zellij', workspace: 'azito', window: 'main' })).toBe(true);
    });

    it('returns false for non-existent tab', async () => {
      const { client } = makeClient(defaultHandler);
      expect(await client.windowExists(server, { kind: 'zellij', workspace: 'azito', window: 'nonexist' })).toBe(false);
    });
  });

  describe('listPanesByRef', () => {
    it('returns terminal panes for tab with correct handles', async () => {
      const { client } = makeClient(defaultHandler);
      const ref: MuxRef = { kind: 'zellij', workspace: 'azito', window: 'main' };
      const panes = await client.listPanesByRef(server, ref);
      expect(panes).toHaveLength(2);
      expect(panes[0].handle as string).toBe('terminal_0');
      expect(panes[0].ordinal).toBe(1);
      expect(panes[0].command).toBe('/bin/bash');
      expect(panes[0].active).toBe(true);
      expect(panes[1].handle as string).toBe('terminal_1');
      expect(panes[1].ordinal).toBe(2);
      expect(panes[1].command).toBe('vim');
    });
  });

  describe('refFromPaneHandle', () => {
    it('maps terminal_0 back to main tab with ordinal 1', async () => {
      const { client } = makeClient(defaultHandler);
      const result = await client.refFromPaneHandle(server, 'terminal_0' as any);
      expect(result).toEqual({
        ref: { kind: 'zellij', workspace: 'azito', window: 'main' },
        ordinal: 1,
      });
    });

    it('returns null for unknown pane', async () => {
      const { client } = makeClient(defaultHandler);
      const result = await client.refFromPaneHandle(server, 'terminal_999' as any);
      expect(result).toBeNull();
    });
  });

  describe('resolvePane', () => {
    it('resolves ordinal 1 to terminal_0', async () => {
      const { client } = makeClient(defaultHandler);
      const ref: MuxRef = { kind: 'zellij', workspace: 'azito', window: 'main' };
      const handle = await client.resolvePane(server, ref, 1);
      expect(handle as string).toBe('terminal_0');
    });

    it('resolves ordinal 2 to terminal_1', async () => {
      const { client } = makeClient(defaultHandler);
      const ref: MuxRef = { kind: 'zellij', workspace: 'azito', window: 'main' };
      const handle = await client.resolvePane(server, ref, 2);
      expect(handle as string).toBe('terminal_1');
    });

    it('throws for out-of-range ordinal', async () => {
      const { client } = makeClient(defaultHandler);
      const ref: MuxRef = { kind: 'zellij', workspace: 'azito', window: 'main' };
      await expect(client.resolvePane(server, ref, 5)).rejects.toThrow('out of range');
    });
  });

  describe('probePane', () => {
    it('alive for existing pane', async () => {
      const { client } = makeClient(defaultHandler);
      const result = await client.probePane(server, 'terminal_0' as any);
      expect(result).toEqual({ alive: true, verified: true });
    });

    it('dead for non-existing pane', async () => {
      const { client } = makeClient(defaultHandler);
      const result = await client.probePane(server, 'terminal_999' as any);
      expect(result).toEqual({ alive: false, verified: true });
    });
  });

  describe('splitPaneByHandle', () => {
    it('calls focus-pane-id then new-pane and returns new handle', async () => {
      const calls: string[] = [];
      const { client } = makeClient((args) => {
        const cmd = lastArgs(args);
        calls.push(cmd);
        if (cmd.startsWith('new-pane')) return 'terminal_5';
        return defaultHandler(args);
      });
      const { handle } = await client.splitPaneByHandle(server, 'terminal_0' as any, 'v');
      expect(handle as string).toBe('terminal_5');
      const focusIdx = calls.findIndex((c) => c.includes('focus-pane-id'));
      const newPaneIdx = calls.findIndex((c) => c.includes('new-pane'));
      expect(focusIdx).toBeGreaterThanOrEqual(0);
      expect(newPaneIdx).toBeGreaterThan(focusIdx);
    });

    it('maps h to right and v to down', async () => {
      const directions: string[] = [];
      const { client } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('new-pane')) {
          const dirIdx = args.indexOf('--direction');
          if (dirIdx >= 0) directions.push(args[dirIdx + 1]);
          return 'terminal_6';
        }
        return defaultHandler(args);
      });
      await client.splitPaneByHandle(server, 'terminal_0' as any, 'h');
      await client.splitPaneByHandle(server, 'terminal_0' as any, 'v');
      expect(directions).toEqual(['right', 'down']);
    });
  });

  describe('captureScreen', () => {
    it('calls dump-screen with --pane-id', async () => {
      const { client, execMux } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('dump-screen')) return 'line1\nline2\nline3\n';
        return defaultHandler(args);
      });
      const result = await client.captureScreen(server, 'terminal_0' as any);
      expect(result.stdout).toBe('line1\nline2\nline3\n');
      expect(result.code).toBe(0);
      const dumpCall = execMux.mock.calls.find(([req]: any) => req.args.includes('dump-screen'));
      expect(dumpCall![0].args).toContain('--pane-id');
      expect(dumpCall![0].args).toContain('terminal_0');
    });

    it('slices lines when start/end specified', async () => {
      const { client } = makeClient((args) => {
        if (lastArgs(args).startsWith('dump-screen')) return 'line0\nline1\nline2\nline3';
        return defaultHandler(args);
      });
      const result = await client.captureScreen(server, 'terminal_0' as any, 1, 3);
      expect(result.stdout).toBe('line1\nline2');
    });
  });

  describe('sendKeysToHandle', () => {
    it('sends bytes for special keys and chars for text via --pane-id', async () => {
      const cmds: string[][] = [];
      const { client } = makeClient((args) => {
        const cmd = lastArgs(args);
        if (cmd.startsWith('write')) cmds.push(args.slice(args.indexOf('action') + 1));
        return '';
      });
      await client.sendKeysToHandle(server, 'terminal_0' as any, ['C-c', 'hello']);
      expect(cmds).toHaveLength(2);
      expect(cmds[0][0]).toBe('write');
      expect(cmds[0]).toContain('--pane-id');
      expect(cmds[0]).toContain('terminal_0');
      expect(cmds[0]).toContain('3');
      expect(cmds[1][0]).toBe('write-chars');
      expect(cmds[1]).toContain('--pane-id');
      expect(cmds[1]).toContain('hello');
    });
  });

  describe('sendTextToHandle', () => {
    it('calls write-chars with --pane-id', async () => {
      const { client, execMux } = makeClient(() => '');
      await client.sendTextToHandle(server, 'terminal_0' as any, 'echo hello\n');
      const writeCall = execMux.mock.calls.find(([req]: any) => req.args.includes('write-chars'));
      expect(writeCall).toBeDefined();
      expect(writeCall![0].args).toContain('--pane-id');
      expect(writeCall![0].args).toContain('terminal_0');
      expect(writeCall![0].args).toContain('echo hello\n');
    });
  });

  describe('paneCommandByHandle', () => {
    it('returns command from pane info', async () => {
      const { client } = makeClient(defaultHandler);
      expect(await client.paneCommandByHandle(server, 'terminal_0' as any)).toBe('/bin/bash');
      expect(await client.paneCommandByHandle(server, 'terminal_1' as any)).toBe('vim');
    });

    it('returns null for unknown pane', async () => {
      const { client } = makeClient(defaultHandler);
      expect(await client.paneCommandByHandle(server, 'terminal_999' as any)).toBeNull();
    });
  });

  describe('renameWindowByRef', () => {
    it('calls rename-tab with --tab-id', async () => {
      const { client, execMux } = makeClient(defaultHandler);
      await client.renameWindowByRef(server, { kind: 'zellij', workspace: 'azito', window: 'main' }, 'new-name');
      const renameCall = execMux.mock.calls.find(([req]: any) => req.args.includes('rename-tab'));
      expect(renameCall).toBeDefined();
      expect(renameCall![0].args).toContain('--tab-id');
      expect(renameCall![0].args).toContain('0');
      expect(renameCall![0].args).toContain('new-name');
    });
  });

  describe('renameWorkspace', () => {
    it('throws error (not supported)', async () => {
      const { client } = makeClient(() => '');
      await expect(client.renameWorkspace(server, 'old', 'new')).rejects.toThrow('does not support session rename');
    });
  });

  describe('measurePanePids', () => {
    it('returns empty array', async () => {
      const { client } = makeClient(() => '');
      const result = await client.measurePanePids(server);
      expect(result).toEqual([]);
    });
  });

  describe('listAllPanes', () => {
    it('returns all terminal panes across tabs', async () => {
      const { client } = makeClient(defaultHandler);
      const panes = await client.listAllPanes(server);
      expect(panes).toHaveLength(3);
      expect(panes[0].paneId).toBe('terminal_0');
      expect(panes[0].sessionName).toBe('azito');
      expect(panes[0].windowName).toBe('main');
      expect(panes[0].currentCommand).toBe('/bin/bash');
      expect(panes[2].paneId).toBe('terminal_2');
      expect(panes[2].windowName).toBe('build');
    });
  });

  describe('zoomPaneByHandle', () => {
    it('calls toggle-fullscreen --pane-id', async () => {
      const { client, execMux } = makeClient(() => '');
      await client.zoomPaneByHandle(server, 'terminal_0' as any);
      const call = execMux.mock.calls.find(([req]: any) => req.args.includes('toggle-fullscreen'));
      expect(call).toBeDefined();
      expect(call![0].args).toContain('--pane-id');
      expect(call![0].args).toContain('terminal_0');
    });
  });

  describe('unzoomPaneByHandle', () => {
    it('calls toggle-fullscreen --pane-id (toggle)', async () => {
      const { client, execMux } = makeClient(() => '');
      await client.unzoomPaneByHandle(server, 'terminal_1' as any);
      const call = execMux.mock.calls.find(([req]: any) => req.args.includes('toggle-fullscreen'));
      expect(call).toBeDefined();
      expect(call![0].args).toContain('--pane-id');
      expect(call![0].args).toContain('terminal_1');
    });
  });

  describe('setPaneTitle', () => {
    it('calls rename-pane --pane-id with title', async () => {
      const { client, execMux } = makeClient(() => '');
      await client.setPaneTitle(server, 'terminal_0' as any, 'my-title');
      const call = execMux.mock.calls.find(([req]: any) => req.args.includes('rename-pane'));
      expect(call).toBeDefined();
      expect(call![0].args).toContain('--pane-id');
      expect(call![0].args).toContain('terminal_0');
      expect(call![0].args).toContain('my-title');
    });
  });

  describe('resolveTabId fallback via query-tab-names', () => {
    it('resolves pane-less tab via query-tab-names index', async () => {
      const { client, execMux } = makeClient((args) => {
        const cmd = lastArgs(args);
        // list-panes returns only panes for "main" — "empty-tab" has none
        if (cmd.startsWith('list-panes')) return LIST_PANES_JSON;
        if (cmd.startsWith('query-tab-names')) return 'main\nempty-tab\nbuild\n';
        if (cmd.startsWith('close-tab')) return '';
        return defaultHandler(args);
      });
      // closeWindow internally calls resolveTabId; "empty-tab" is not in list-panes
      // but is index 1 in query-tab-names
      await client.closeWindow(server, { kind: 'zellij', workspace: 'azito', window: 'empty-tab' });
      const closeCall = execMux.mock.calls.find(([req]: any) => req.args.includes('close-tab'));
      expect(closeCall).toBeDefined();
      expect(closeCall![0].args).toContain('--tab-id');
      expect(closeCall![0].args).toContain('1');
    });
  });

  describe('capability-gated methods throw MuxCapabilityMissingError', () => {
    const { client } = makeClient(() => '');
    const ref: MuxRef = { kind: 'zellij', workspace: 'azito', window: 'main' };

    it('startOutputStream', () => expect(client.startOutputStream(server, 'h' as any, '/tmp/x')).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('stopOutputStream', () => expect(client.stopOutputStream(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('isPaneInModeByHandle', () => expect(client.isPaneInModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('cancelPaneModeByHandle', () => expect(client.cancelPaneModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('windowActivity', () => expect(client.windowActivity(server, ref)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
  });
});
