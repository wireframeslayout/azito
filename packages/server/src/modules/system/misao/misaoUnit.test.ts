import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { renderMisaoUnit } from './misaoUnit';

const SYSTEMD = 'ExecStart=__AZITO_PREFIX__/misao/current/misao serve --socket __AZITO_PREFIX__/misao/misao.sock\nEnvironment=PATH=__PATH__\n';
const PLIST = '<string>__AZITO_PREFIX__/misao/current/misao</string><string>__PATH__</string>';

describe('renderMisaoUnit', () => {
  it('fills the prefix and the PATH of a systemd unit', () => {
    expect(renderMisaoUnit({ template: SYSTEMD, manager: 'systemd', prefix: '/home/u/.azito', servicePath: '/usr/bin:/bin' })).toBe(
      'ExecStart=/home/u/.azito/misao/current/misao serve --socket /home/u/.azito/misao/misao.sock\nEnvironment=PATH=/usr/bin:/bin\n',
    );
  });

  it('escapes % for systemd, which reads it as a specifier', () => {
    expect(renderMisaoUnit({ template: SYSTEMD, manager: 'systemd', prefix: '/p', servicePath: '/a%b' })).toContain('Environment=PATH=/a%%b');
  });

  it('escapes XML for a launchd plist', () => {
    expect(renderMisaoUnit({ template: PLIST, manager: 'launchd', prefix: '/p', servicePath: '/a<b>' })).toBe('<string>/p/misao/current/misao</string><string>/a&lt;b&gt;</string>');
  });

  it('leaves no placeholder behind in the bundled templates, and runs the binary directly (no node)', () => {
    const deploy = path.resolve(__dirname, '../../../../../../deploy');
    for (const [file, manager] of [['azito-misao.service', 'systemd'], ['com.azito.misao.plist', 'launchd']] as const) {
      const rendered = renderMisaoUnit({ template: fs.readFileSync(path.join(deploy, file), 'utf-8'), manager, prefix: '/p', servicePath: '/s' });
      expect(rendered).not.toMatch(/__[A-Z_]+__/);
      expect(rendered).toContain('/p/misao/current/misao');
      expect(rendered).not.toContain('misao.mjs');
    }
  });
});
