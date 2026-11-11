import path from 'path';
import fs from 'fs';
import { createServiceManager, type ServiceHost } from '../modules/system/createServiceManager';
import { HUB_SERVICE, runCommand } from '../modules/system/serviceManager';
import { createHubLock, underHubLock } from '../modules/system/hubLock';
import { resolveWindowsHub, uninstallWindowsTask, type ServiceCommandContext } from '../modules/system/windowsHubOperations';
import { consumeWindowsInstallRecord, prepareRecordedData, prepareRecordedRelease, removeRecordedTree, verifyRecordedRelease, verifyRecordedWrapper } from '../modules/system/windowsHubUninstall';
import { assertHubDirsOnlyOwnerWritable } from '../modules/system/windowsHubFolderOps';
import { runCommandSpec } from '../shared/exec/runCommandSpec';

/** Prepares the installer to remove only items proved by its record. */
export async function windowsHubUninstallCommand(host: ServiceHost, context: ServiceCommandContext, removeData: boolean): Promise<void> {
  if (host.platform !== 'win32') throw new Error('Windows uninstall requires Windows.');
  const created = createServiceManager(host, HUB_SERVICE, runCommand);
  if ('error' in created) throw created.error;
  const hub = resolveWindowsHub(host, context);
  const lock = createHubLock(hub.layout.hubRoot, context.secretFileGuard, hub.systemRoot);
  const run = (spec: Parameters<typeof runCommandSpec>[0]) => runCommandSpec(spec, hub.runHost);
  await underHubLock(lock, async () => {
    await uninstallWindowsTask(created.manager, hub, context);
    const { record, release } = await prepareRecordedRelease(hub.layout.prefix, context.secretFileGuard, run, hub.systemRoot);
    const retained: string[] = [];
    let data = false;
    let wrapper = false;
    if (removeData) {
      try {
        await prepareRecordedData(hub.layout.prefix, record, run, hub.systemRoot);
        data = true;
      } catch (err) {
        retained.push(`Data retained: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (record.wrapperSha256 !== null) {
      try {
        await assertHubDirsOnlyOwnerWritable(run, hub.systemRoot, [path.join(hub.layout.prefix, 'bin')]);
        wrapper = verifyRecordedWrapper(hub.layout.prefix, record);
        if (!wrapper) retained.push('The CLI wrapper is changed; it is retained.');
      } catch (err) {
        retained.push(`CLI wrapper retained: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else retained.push('The CLI wrapper was not recorded as created by this installer; inspect it manually.');
    consumeWindowsInstallRecord(hub.layout.hubRoot, record, context.secretFileGuard);
    console.log(JSON.stringify({ release: path.basename(release), data, wrapper, pathAdded: record.pathAdded, retained }));
    const action = await new Promise<string>((resolve) => {
      process.stdin.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').trim()));
      process.stdin.once('end', () => resolve(''));
      process.stdin.resume();
    });
    if (action !== 'remove') return;
    try {
      if (data) {
        await prepareRecordedData(hub.layout.prefix, record, run, hub.systemRoot);
        await removeRecordedTree(hub.layout.prefix, 'data', run, hub.systemRoot);
      }
      await assertHubDirsOnlyOwnerWritable(run, hub.systemRoot, [release, ...record.inventory.directories.map((dir) => path.join(release, dir))]);
      verifyRecordedRelease(hub.layout.hubRoot, record);
      await removeRecordedTree(hub.layout.hubRoot, record.release, run, hub.systemRoot);
      const pointer = path.join(hub.layout.hubRoot, 'current.txt');
      const stat = fs.lstatSync(pointer);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(pointer, 'utf8').trim() !== record.release) throw new Error(`The pointer ${pointer} changed and is retained.`);
      fs.unlinkSync(pointer);
      console.log(JSON.stringify({ removed: true }));
    } catch (err) {
      console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      process.exitCode = 1;
    }
  });
}
