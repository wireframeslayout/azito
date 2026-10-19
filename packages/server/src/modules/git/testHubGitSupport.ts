import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { createSecretFileGuard } from '../../shared/os/secretFileGuard';
import { HubGitSupport } from './HubGitSupport';

/** For tests of the services that run local git: a HubGitSupport for the machine the test runs on. */
export function testHubGitSupport(): HubGitSupport {
  const hostEnv = resolveCurrentHostEnv();
  return new HubGitSupport(hostEnv, createSecretFileGuard(hostEnv.platform, process.env));
}
