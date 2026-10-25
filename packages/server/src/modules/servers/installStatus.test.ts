import { describe, it, expect } from 'vitest';
import { parseNodeVersion, parseTmuxVersion, parseHarnessCheck, parseTailscaleCheck, parseChromiumInstall } from './installStatusParsers';

describe('install-status parsing', () => {
  describe('node version', () => {
    it('parses v24.x as installed', () => {
      expect(parseNodeVersion('v24.14.0\n')).toEqual({ installed: true, version: 'v24.14.0' });
    });

    it('parses v22.x as installed with warning', () => {
      expect(parseNodeVersion('v22.0.0')).toEqual({ installed: true, version: 'v22.0.0', detail: 'v24+ required' });
    });

    it('returns not installed for empty output', () => {
      expect(parseNodeVersion('')).toEqual({ installed: false, detail: 'node not found' });
    });

    it('handles version with terminal artifacts stripped', () => {
      expect(parseNodeVersion('v24.5.1')).toEqual({ installed: true, version: 'v24.5.1' });
    });
  });

  describe('tmux version', () => {
    it('parses tmux 3.4 as installed', () => {
      expect(parseTmuxVersion('tmux 3.4', 0)).toEqual({ installed: true, version: 'tmux 3.4' });
    });

    it('returns not installed for non-zero exit code', () => {
      expect(parseTmuxVersion('', 127)).toEqual({ installed: false, detail: 'tmux not found' });
    });
  });

  describe('harness check', () => {
    it('detects installed harness', () => {
      expect(parseHarnessCheck('/home/user/.claude/skills/azt-implement\n')).toEqual({ installed: true });
    });

    it('detects missing harness', () => {
      expect(parseHarnessCheck('')).toEqual({ installed: false, detail: 'azt-harness not installed' });
    });
  });

  describe('tailscale check', () => {
    it('detects tailscale with IP', () => {
      expect(parseTailscaleCheck('100.64.0.1\n')).toEqual({ installed: true, version: '100.64.0.1' });
    });

    it('detects missing tailscale', () => {
      expect(parseTailscaleCheck('')).toEqual({ installed: false, detail: 'tailscale not configured' });
    });
  });

  describe('chromium install', () => {
    it('detects installed chromium with build number', () => {
      expect(parseChromiumInstall('/home/user/.cache/ms-playwright/chromium-1234/chrome-linux/chrome\n'))
        .toEqual({ installed: true, version: 'chromium-1234' });
    });

    it('returns not installed for empty output', () => {
      expect(parseChromiumInstall(''))
        .toEqual({ installed: false, detail: 'Chromium not installed (run Browser runtime install)' });
    });

    it('returns not installed for non-matching output', () => {
      expect(parseChromiumInstall('some other output'))
        .toEqual({ installed: false, detail: 'Chromium not installed (run Browser runtime install)' });
    });

    it('detects installed chromium from macOS path', () => {
      expect(parseChromiumInstall('/Users/user/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium\n'))
        .toEqual({ installed: true, version: 'chromium-1234' });
    });

    it('detects installed chromium from macOS arm64 path', () => {
      expect(parseChromiumInstall('/Users/user/Library/Caches/ms-playwright/chromium-5678/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium\n'))
        .toEqual({ installed: true, version: 'chromium-5678' });
    });
  });
});
