import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { renderMisaoUnit } from './misaoUnit';

const SYSTEMD = 'ExecStart=__NODE__ __AZITO_PREFIX__/misao/current/misao.mjs serve --socket __AZITO_PREFIX__/misao/misao.sock\nEnvironment=PATH=__PATH__\n';
const PLIST = '<string>__NODE__</string><string>__AZITO_PREFIX__/misao/current/misao.mjs</string><string>__PATH__</string>';

describe('renderMisaoUnit', () => {
  it('fills the node, the prefix and the PATH of a systemd unit', () => {
    expect(renderMisaoUnit({ template: SYSTEMD, manager: 'systemd', prefix: '/home/u/.azito', node: '/home/u/.nvm/versions/node/v24.14.0/bin/node', servicePath: '/usr/bin:/bin' })).toBe(
      'ExecStart=/home/u/.nvm/versions/node/v24.14.0/bin/node /home/u/.azito/misao/current/misao.mjs serve --socket /home/u/.azito/misao/misao.sock\nEnvironment=PATH=/usr/bin:/bin\n',
    );
  });

  it('escapes % for systemd, which reads it as a specifier', () => {
    expect(renderMisaoUnit({ template: SYSTEMD, manager: 'systemd', prefix: '/p', node: '/n', servicePath: '/a%b' })).toContain('Environment=PATH=/a%%b');
  });

  it('escapes XML for a launchd plist', () => {
    expect(renderMisaoUnit({ template: PLIST, manager: 'launchd', prefix: '/p', node: '/n&m', servicePath: '/a<b>' })).toBe('<string>/n&amp;m</string><string>/p/misao/current/misao.mjs</string><string>/a&lt;b&gt;</string>');
  });

  it('leaves no placeholder behind in the bundled templates', () => {
    const deploy = path.resolve(__dirname, '../../../../../../deploy');
    for (const [file, manager] of [['azito-misao.service', 'systemd'], ['com.azito.misao.plist', 'launchd']] as const) {
      const rendered = renderMisaoUnit({ template: fs.readFileSync(path.join(deploy, file), 'utf-8'), manager, prefix: '/p', node: '/n', servicePath: '/s' });
      expect(rendered).not.toMatch(/__[A-Z_]+__/);
      expect(rendered).toContain('/n');
    }
  });
});
