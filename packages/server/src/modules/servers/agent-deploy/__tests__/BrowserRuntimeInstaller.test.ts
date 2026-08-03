import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserRuntimeInstaller, findChromiumBinaryCommand } from '../BrowserRuntimeInstaller';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IServerTransport } from '../../transport/ServerTransport';

function createMockTransport(responses: Record<string, { stdout: string; stderr?: string; code?: number }>): IServerTransport {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (cmd.includes(key)) return { stdout: value.stdout, stderr: value.stderr ?? '', code: value.code ?? 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }),
  } as unknown as IServerTransport;
}

describe('BrowserRuntimeInstaller', () => {
  let installer: BrowserRuntimeInstaller;

  beforeEach(() => {
    installer = new BrowserRuntimeInstaller();
  });

  it('rejects unsupported OS', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'FreeBSD\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Linux/macOS');
  });

  it('installs chromium on macOS without font processing', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Darwin\n' },
      'playwright@': { stdout: 'Downloading chromium\n' },
      'chrome-mac*/*.app': { stdout: '/Users/user/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.chromiumVersion).toBe('chromium-1234');
    expect(result.fontInstalled).toBeUndefined();
    expect(result.warning).toBeUndefined();

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c) => c.includes('fc-list'))).toBe(false);
    expect(calls.some((c) => c.includes('unzip'))).toBe(false);
    expect(calls.some((c) => c.includes('fontconfig'))).toBe(false);
    expect(calls.some((c) => c.includes('NotoSansCJK'))).toBe(false);
  });

  it('uses pinned playwright version from package.json', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'Downloading chromium\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: 'exists\n' },
      'fc-list': { stdout: 'NotoSansCJK-Regular.ttc: Noto Sans CJK JP\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.chromiumVersion).toBe('chromium-1234');
    expect(result.fontInstalled).toBe(true);

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const playwrightCall = execFn.mock.calls.find((c: string[]) => c[0].includes('playwright@'));
    expect(playwrightCall).toBeDefined();
    expect(playwrightCall![0]).toMatch(/playwright@\d+\.\d+/);
  });

  it('installs the managed font file when a system CJK font exists but the AZITO-managed file does not', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      // AZITO-managed font file absent, even though some other CJK font is present on the system.
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: '\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: '\n' },
      'which unzip': { stdout: '/usr/bin/unzip\n' },
      'curl -fsSL': { stdout: '', code: 0 },
      'fc-list': { stdout: 'NotoSansCJK-Regular.ttc: Noto Sans CJK JP\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-1111/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.fontInstalled).toBe(true);

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c) => c.includes('curl -fsSL') && c.includes('NotoSansCJKjp.zip'))).toBe(true);
    // Atomic placement: copy to a .tmp path, then mv into place — never cp straight
    // onto the final fontFile path (which would risk leaving a partial file behind).
    const downloadCall = calls.find((c) => c.includes('curl -fsSL'));
    expect(downloadCall).toContain('cp NotoSansCJKjp/NotoSansCJKjp-Regular.otf "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf.tmp"');
    expect(downloadCall).toContain('mv "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf.tmp" "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"');
    expect(calls.some((c) => c.includes('cat > "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"'))).toBe(true);
    expect(calls.some((c) => c === 'fc-cache -f')).toBe(true);
  });

  it('creates the fontconfig prefer file when missing, without re-downloading an already-installed font', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: '\n' },
      'fc-list': { stdout: 'NotoSansCJK-Regular.ttc: Noto Sans CJK JP\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-2222/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.fontInstalled).toBe(true);

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c) => c.includes('curl -fsSL'))).toBe(false);
    expect(calls.some((c) => c.includes('cat > "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"'))).toBe(true);
    expect(calls.some((c) => c === 'fc-cache -f')).toBe(true);
  });

  it('re-writes an existing but corrupt/empty fontconfig conf (missing the prefer rule)', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      // Conf file exists but doesn't contain the prefer rule (grep -qF fails -> no "exists").
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: '\n' },
      'fc-list': { stdout: 'NotoSansCJK-Regular.ttc: Noto Sans CJK JP\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-4444/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.fontInstalled).toBe(true);

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((c) => c.includes('cat > "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"'))).toBe(true);
  });

  it('sets a non-fatal warning (without touching fontInstalled) when writing the fontconfig conf fails', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: '\n' },
      'cat > "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: '', stderr: 'permission denied', code: 1 },
      'fc-list': { stdout: 'NotoSansCJK-Regular.ttc: Noto Sans CJK JP\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-5555/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    // Font itself is already installed and recognized by fc-list — only the
    // fontconfig prefer-rule write failed, so fontInstalled must stay true.
    expect(result.fontInstalled).toBe(true);
    expect(result.warning).toContain('fontconfig prefer rule write failed');

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    // fc-cache should not run since neither a font install nor a fontconfig write succeeded.
    expect(calls.some((c) => c === 'fc-cache -f')).toBe(false);
  });

  it('reports fontInstalled false with a non-fatal warning and self-heals by removing the managed font file when fc-list does not recognize it after install', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      // A stale/corrupt managed font file is present (e.g. left over from an interrupted run).
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: 'exists\n' },
      'fc-list': { stdout: '\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-3333/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.fontInstalled).toBe(false);
    expect(result.warning).toContain('not recognized');

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const calls = execFn.mock.calls.map((c: unknown[]) => c[0] as string);
    // Self-heal: the stale managed font file is removed so the next run re-downloads it
    // instead of treating the corrupt file as "already installed" forever.
    expect(calls.some((c) => c === 'rm -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"')).toBe(true);
  });

  it('skips font check when fc-list is not available and reports warning', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-5678/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.warning).toContain('fc-list not found');
    expect(result.fontInstalled).toBeUndefined();
  });

  it('skips font install when unzip is not available and reports warning', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: '\n' },
      'which unzip': { stdout: '\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-9999/chrome-linux/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.warning).toContain('unzip not found');
    expect(result.fontInstalled).toBeUndefined();
  });

  it('passes timeoutMs to transport.exec for long-running commands', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '\n' },
      'ms-playwright': { stdout: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux/chrome\n' },
    });
    await installer.install(transport);
    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const playwrightCall = execFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('playwright@'));
    expect(playwrightCall![1]).toBe(600_000);
  });

  it('detects chrome binary under the newer chrome-linux64 directory layout', async () => {
    // Keyed on the literal glob (`chrome-linux*/chrome`) rather than the generic
    // `ls -d` prefix, so this only resolves when the verification command actually
    // uses the wildcarded glob that matches both chrome-linux/ and chrome-linux64/.
    // If the source reverts to the old `chrome-linux/chrome` glob, this key won't
    // match and the command falls through to the empty-stdout default below,
    // failing the assertions — guarding against the regression this test targets.
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '\n' },
      'chrome-linux*/chrome': { stdout: '/home/user/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(true);
    expect(result.chromiumVersion).toBe('chromium-1228');

    const execFn = transport.exec as ReturnType<typeof vi.fn>;
    const verifyCall = execFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('ms-playwright'));
    expect(verifyCall).toBeDefined();
    expect(verifyCall![0]).toContain('chromium-*/chrome-linux*/chrome');
  });

  it('returns error when post-install verification fails', async () => {
    const transport = createMockTransport({
      'uname -s': { stdout: 'Linux\n' },
      'playwright@': { stdout: 'ok\n' },
      'which fc-list': { stdout: '/usr/bin/fc-list\n' },
      'test -f "$HOME/.local/share/fonts/NotoSansCJKjp-Regular.otf"': { stdout: 'exists\n' },
      'grep -qF "Noto Sans CJK JP" "$HOME/.config/fontconfig/conf.d/99-azito-noto-cjk.conf"': { stdout: 'exists\n' },
      'fc-list': { stdout: 'NotoSansCJK\n' },
      'ms-playwright': { stdout: '\n' },
    });
    const result = await installer.install(transport);
    expect(result.success).toBe(false);
    expect(result.error).toContain('chrome binary not found');
  });
});

const execFileAsync = promisify(execFile);

/** Runs the generated snippet through a real shell with HOME pointed at a fixture. */
async function runWithHome(osName: string, home: string): Promise<string> {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', findChromiumBinaryCommand(osName)], {
    env: { HOME: home, PATH: process.env.PATH ?? '' },
  });
  return stdout.trim();
}

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\n');
  fs.chmodSync(filePath, 0o755);
}

describe('findChromiumBinaryCommand', () => {
  it('finds the macOS binary inside a bundle whose name contains spaces', async () => {
    // Playwright ships "Google Chrome for Testing.app", not "Chromium.app", and
    // those spaces are why this cannot be `ls -d <glob> | head -1`.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-chromium-mac-'));
    const binary = path.join(
      home,
      'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    makeExecutable(binary);

    expect(await runWithHome('Darwin', home)).toBe(binary);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds the Linux binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-chromium-linux-'));
    const binary = path.join(home, '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome');
    makeExecutable(binary);

    expect(await runWithHome('Linux', home)).toBe(binary);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prints nothing when no browser is installed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-chromium-empty-'));
    expect(await runWithHome('Darwin', home)).toBe('');
    expect(await runWithHome('Linux', home)).toBe('');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ignores a match that exists but is not executable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-chromium-noexec-'));
    const binary = path.join(home, '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '');
    fs.chmodSync(binary, 0o644);

    expect(await runWithHome('Linux', home)).toBe('');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
