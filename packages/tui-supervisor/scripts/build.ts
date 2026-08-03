import * as path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

async function main(): Promise<void> {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(ROOT, 'dist', 'azito-supervisor.cjs'),
    external: ['node-pty'],
    logLevel: 'warning',
  });
  console.log('[build] dist/azito-supervisor.cjs generated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
