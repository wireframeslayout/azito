import os from 'os';
import path from 'path';

/**
 * Test support: the misao binary the `*.misaoIntegration.test.ts` files start real daemons from. `MISAO_CLI` names the
 * `misao` executable (a release binary, or `target/release/misao` of a misao checkout); the default is that checkout path.
 * The files skip themselves when it does not exist. Mirrored by `e2e/fixtures/misaoDaemon.ts`.
 */
export const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/target/release/misao');
