import type { IServerTransport } from '../transport/ServerTransport';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const INSTALL_TIMEOUT_MS = 600_000;

export function chromiumBinaryGlob(osName: string): string {
  if (osName === 'Darwin') {
    // Playwright ships the macOS build as "Google Chrome for Testing.app", not
    // "Chromium.app", and the directory is arch-suffixed (chrome-mac-arm64).
    // Both the bundle and the executable inside it are matched by wildcards so
    // a future rename does not break detection again.
    return '"$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*';
  }
  return '"$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome';
}

/**
 * Shell snippet printing the first existing Chromium executable, or nothing.
 *
 * A `for` loop rather than `ls -d <glob> | head -1`: the macOS path contains
 * spaces ("Google Chrome for Testing"), which `ls` receives as separate
 * arguments and then prints as separate lines — `head -1` would return a
 * fragment of the path. Loop expansion keeps each match a single word.
 */
export function findChromiumBinaryCommand(osName: string): string {
  // Trailing `:` forces exit 0. With no match the loop ends on a failed `[ -x ]`,
  // and local/agent transports turn a non-zero exit into a thrown error — "no
  // browser installed" has to read as an empty result, not a failure.
  return `for p in ${chromiumBinaryGlob(osName)}; do [ -x "$p" ] && printf '%s\\n' "$p" && break; done 2>/dev/null; :`;
}

/**
 * Version of the playwright package this hub actually runs with — the browsers
 * we install must match it.
 *
 * Resolved from the installed package rather than from the repo's
 * package.json: a release bundle ships no package.json, and the old
 * `__dirname`-relative walk resolved to `/home/package.json` there, failing
 * with ENOENT before anything was installed.
 */
function getPlaywrightVersion(): string {
  const req = createRequire(__filename);
  const pkgPath = req.resolve('playwright/package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  if (!version) throw new Error('playwright version not found in playwright/package.json');
  return version;
}

export interface BrowserRuntimeInstallResult {
  success: boolean;
  chromiumVersion?: string;
  fontInstalled?: boolean;
  warning?: string;
  error?: string;
}

export class BrowserRuntimeInstaller {
  async install(transport: IServerTransport): Promise<BrowserRuntimeInstallResult> {
    try {
      const osResult = await transport.exec('uname -s');
      const osName = osResult.stdout.trim();
      if (osName !== 'Linux' && osName !== 'Darwin') {
        return { success: false, error: `Browser runtime は Linux/macOS のみ対応。検出: ${osName}` };
      }

      const pwVersion = getPlaywrightVersion();
      const installResult = await transport.exec(
        `npx playwright@${pwVersion} install chromium 2>&1`,
        INSTALL_TIMEOUT_MS,
      );
      if (installResult.code !== 0) {
        return { success: false, error: `Chromium install failed: ${installResult.stdout}${installResult.stderr}` };
      }

      let fontInstalled: boolean | undefined;
      let warning: string | undefined;

      if (osName === 'Linux') {
        const fontDir = '$HOME/.local/share/fonts';
        const fontFile = `${fontDir}/NotoSansCJKjp-Regular.otf`;

        // `which` exits 1 when the command is absent; without `|| true` that
        // throws instead of taking the intended "skip the font step" path.
        const fcCheck = await transport.exec('which fc-list 2>/dev/null || true');
        if (!fcCheck.stdout.trim()) {
          warning = 'fc-list not found; font check skipped';
        } else {
          // `|| true` keeps a missing font — the normal case on a fresh host —
          // from exiting non-zero, which local/agent transports surface as a
          // thrown error and would abort the whole browser runtime install.
          const fontFileCheck = await transport.exec(`test -f "${fontFile}" && echo exists || true`);
          const alreadyInstalled = fontFileCheck.stdout.trim() === 'exists';
          let installedNow = false;

          if (alreadyInstalled) {
            fontInstalled = true;
          } else {
            const unzipCheck = await transport.exec('which unzip 2>/dev/null || true');
            if (!unzipCheck.stdout.trim()) {
              warning = 'unzip not found; font install skipped';
            } else {
              const fontUrl = 'https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/06_NotoSansCJKjp.zip';
              await transport.exec(`mkdir -p "${fontDir}"`);
              const dlResult = await transport.exec(
                `cd /tmp && curl -fsSL "${fontUrl}" -o NotoSansCJKjp.zip && unzip -o NotoSansCJKjp.zip NotoSansCJKjp-Regular.otf -d NotoSansCJKjp && cp NotoSansCJKjp/NotoSansCJKjp-Regular.otf "${fontFile}.tmp" && mv "${fontFile}.tmp" "${fontFile}" && rm -rf NotoSansCJKjp NotoSansCJKjp.zip 2>&1`,
                INSTALL_TIMEOUT_MS,
              );
              fontInstalled = dlResult.code === 0;
              if (!fontInstalled) {
                warning = `Font install failed (non-fatal): ${dlResult.stderr || dlResult.stdout}`;
              } else {
                installedNow = true;
              }
            }
          }

          if (alreadyInstalled || installedNow) {
            const fontconfigDir = '$HOME/.config/fontconfig/conf.d';
            const fontconfigFile = `${fontconfigDir}/99-azito-noto-cjk.conf`;
            const confCheck = await transport.exec(
              `grep -qF "Noto Sans CJK JP" "${fontconfigFile}" 2>/dev/null && echo exists || true`,
            );
            let fontconfigCreated = false;
            if (confCheck.stdout.trim() !== 'exists') {
              const writeResult = await transport.exec(
                `mkdir -p "${fontconfigDir}" && cat > "${fontconfigFile}" << 'AZITO_FONTCONFIG_EOF'\n` +
                  '<?xml version="1.0"?>\n' +
                  '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n' +
                  '<fontconfig>\n' +
                  '  <alias>\n' +
                  '    <family>sans-serif</family>\n' +
                  '    <prefer>\n' +
                  '      <family>Noto Sans CJK JP</family>\n' +
                  '    </prefer>\n' +
                  '  </alias>\n' +
                  '  <alias>\n' +
                  '    <family>serif</family>\n' +
                  '    <prefer>\n' +
                  '      <family>Noto Sans CJK JP</family>\n' +
                  '    </prefer>\n' +
                  '  </alias>\n' +
                  '</fontconfig>\n' +
                  'AZITO_FONTCONFIG_EOF',
              );
              if (writeResult.code === 0) {
                fontconfigCreated = true;
              } else {
                warning = `fontconfig prefer rule write failed (non-fatal): ${writeResult.stderr || writeResult.stdout}`;
              }
            }

            if (installedNow || fontconfigCreated) {
              await transport.exec('fc-cache -f');
            }

            // grep exits 1 when it matches nothing, which is the very case this check
            // is looking for — let it report an empty result instead of throwing.
            const verifyFont = await transport.exec('fc-list | grep -F "Noto Sans CJK JP" || true');
            if (!verifyFont.stdout.trim()) {
              await transport.exec(`rm -f "${fontFile}"`);
              fontInstalled = false;
              warning = warning ?? 'Noto Sans CJK JP not recognized by fc-list after install (non-fatal)';
            }
          }
        }
      }

      const verifyResult = await transport.exec(findChromiumBinaryCommand(osName));
      const chromePath = verifyResult.stdout.trim();
      if (!chromePath) {
        return { success: false, fontInstalled, warning, error: 'Post-install verification failed: chrome binary not found' };
      }

      const buildMatch = chromePath.match(/chromium-(\d+)/);
      const chromiumVersion = buildMatch ? `chromium-${buildMatch[1]}` : undefined;

      return { success: true, chromiumVersion, fontInstalled, warning };
    } catch (err: unknown) {
      const e = err as Error & { stdout?: string; stderr?: string };
      const detail = [e.message, e.stdout?.slice(-200), e.stderr?.slice(-200)].filter(Boolean).join(' | ');
      return { success: false, error: detail };
    }
  }
}
