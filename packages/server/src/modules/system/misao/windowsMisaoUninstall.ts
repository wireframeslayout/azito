import fs from 'fs';
import path from 'path';
import type { HostEnv } from '../../../shared/os/hostEnv';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';
import type { SpecRunner } from '../windowsHubService';
import { prepareRecordedMisao, removeRecordedTree, verifyRecordedMisaoPointer, type WindowsInstallRecord } from '../windowsHubUninstall';
import { assertNoWindowsAgent } from './windowsMisaoAgentGuard';
import { createLocalMisaoWindows } from './misaoLocalWindows';
import { misaoWindowsUserOf, resolveMisaoPaths } from './misaoPaths';
import { readMisaoBundle } from './MisaoBundle';

/** Stop only a recorded, verified misao when a Windows agent can be ruled out. */
export async function uninstallRecordedMisao(input: {
  prefix: string;
  record: WindowsInstallRecord;
  host: HostEnv;
  bundleRoot: string | null;
  guard: SecretFileGuard;
  run: SpecRunner;
  systemRoot: string;
  pid: number;
}): Promise<void> {
  const saved = input.record.misao;
  if (!saved) throw new Error('This installer did not record creating misao.');
  const user = misaoWindowsUserOf(input.host.platform);
  if (!user) throw new Error('Windows misao is unavailable on this host.');
  const paths = resolveMisaoPaths(input.prefix, user);
  const bundle = readMisaoBundle(input.bundleRoot);
  if (!bundle) throw new Error('The bundled misao release cannot be read.');
  const local = createLocalMisaoWindows(input.host, paths, user.userName, process.env, input.guard);
  const assertUnshared = (): Promise<void> => assertNoWindowsAgent(input.run, input.systemRoot, path.win32.join(paths.root, saved.version, 'misao.exe'), local.taskName, input.pid, process.ppid);
  await local.operationLock.run(async () => {
    await prepareRecordedMisao(input.prefix, input.record, input.guard, input.run, input.systemRoot);
    await assertUnshared();
    await local.installer.removeOwnedTaskForUninstall(local.target, bundle, saved.version, saved.taskHash, assertUnshared);
    const checked = await prepareRecordedMisao(input.prefix, input.record, input.guard, input.run, input.systemRoot);
    await assertUnshared();
    if ((await local.tasks.query(local.taskName)).exists) throw new Error('A misao task appeared during removal; the release is retained.');
    await removeRecordedTree(checked.root, checked.version, input.run, input.systemRoot);
    fs.unlinkSync(verifyRecordedMisaoPointer(input.prefix, input.record, input.guard));
  });
}
