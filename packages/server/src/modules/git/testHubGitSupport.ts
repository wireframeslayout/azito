import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { createSecretFileGuard } from '../../shared/os/secretFileGuard';
import { HubGitSupport } from './HubGitSupport';

/** For tests of the services that run local git: a HubGitSupport for the machine the test runs on, in a fresh directory. */
export function testHubGitSupport(baseDir: string = os.tmpdir()): HubGitSupport {
  const hostEnv = resolveCurrentHostEnv();
  const dir = path.join(fs.mkdtempSync(path.join(baseDir, 'azito-git-test-')), 'git-support');
  return new HubGitSupport(hostEnv, createSecretFileGuard(hostEnv.platform, process.env), dir);
}
