import path from 'path';
import fs from 'fs';
import { createServiceManager, type ServiceHost } from '../modules/system/createServiceManager';
import { HUB_SERVICE, runCommand } from '../modules/system/serviceManager';
import { createHubLock, underHubLock } from '../modules/system/hubLock';
import { resolveWindowsHub, uninstallWindowsTask, type ServiceCommandContext } from '../modules/system/windowsHubOperations';
import { assertNoHubLaunchers, assertNoOtherHubProcesses, consumeWindowsInstallRecord, prepareRecordedData, prepareRecordedRelease, removeRecordedTree, verifyRecordedDatabase, verifyRecordedRelease, verifyRecordedWrapper } from '../modules/system/windowsHubUninstall';
import { assertHubDirsOnlyOwnerWritable, findHubVersionsInUse } from '../modules/system/windowsHubFolderOps';
import { runCommandSpec } from '../shared/exec/runCommandSpec';
import { listOwnedDataNames, readOwnedSecret } from '../modules/system/windowsOwnedSecrets';
import { findHubProcesses } from '../modules/system/windowsHubService';
import { HUB_UPDATE_TASK } from '../modules/system/windowsHubUpdateTask';

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
    let dataDb = false;
    const dataFiles: string[] = [];
    let wrapper = false;
    if (removeData) {
      try {
        await prepareRecordedData(hub.layout.prefix, record, context.secretFileGuard, run, hub.systemRoot);
        data = true;
      } catch (err) {
        try {
          await assertHubDirsOnlyOwnerWritable(run, hub.systemRoot, [path.join(hub.layout.prefix, 'data')]);
          verifyRecordedDatabase(hub.layout.prefix, record, context.secretFileGuard);
          dataDb = true;
          retained.push('Data retained: only recorded data files can be removed; unrecorded data will be kept.');
        } catch (dbErr) {
          retained.push(`Data retained: ${err instanceof Error ? err.message : String(err)}; database: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
        try {
          await assertHubDirsOnlyOwnerWritable(run, hub.systemRoot, [path.join(hub.layout.prefix, 'data')]);
          for (const name of listOwnedDataNames(hub.layout.hubRoot)) {
            try {
              if (readOwnedSecret(hub.layout.prefix, hub.layout.hubRoot, name, record, context.secretFileGuard)) dataFiles.push(name);
            } catch (itemErr) {
              retained.push(`${name} retained: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`);
            }
          }
        } catch (itemErr) {
          retained.push(`Data files retained: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`);
        }
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
    await assertNoHubLaunchers(hub.hubRoots, run, hub.systemRoot, process.ppid);
    await assertNoOtherHubProcesses(hub.layout.hubRoot, run, hub.systemRoot, context.pid);
    consumeWindowsInstallRecord(hub.layout.hubRoot, record, context.secretFileGuard);
    console.log(JSON.stringify({ release: path.basename(release), data, dataDb, dataFiles, wrapper, pathAdded: record.pathAdded, retained }));
    const action = await new Promise<string>((resolve) => {
      process.stdin.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').trim()));
      process.stdin.once('end', () => resolve(''));
      process.stdin.resume();
    });
    if (action !== 'remove') return;
    try {
      if ((await hub.client.query(HUB_SERVICE.windowsTaskName)).exists || (await hub.client.query(HUB_UPDATE_TASK)).exists) throw new Error('A hub or update task appeared while preparing removal; inspect it and retry manually.');
      if ((await findHubProcesses(run, hub.systemRoot, hub.hubRoots, context.pid)).length > 0) throw new Error('A hub process started while preparing removal; stop it and inspect the retained files.');
      const inUse = await findHubVersionsInUse(run, hub.systemRoot, hub.hubRoots, { rejectUnknownVersions: true, excludePid: context.pid });
      if ([...inUse].some((version) => version.toLowerCase() === record.release.toLowerCase())) throw new Error('A process is using the recorded release; stop it and inspect the retained files.');
      await assertNoHubLaunchers(hub.hubRoots, run, hub.systemRoot, process.ppid);
      await assertNoOtherHubProcesses(hub.layout.hubRoot, run, hub.systemRoot, context.pid);
      if (data) {
        await prepareRecordedData(hub.layout.prefix, record, context.secretFileGuard, run, hub.systemRoot);
        await removeRecordedTree(hub.layout.prefix, 'data', run, hub.systemRoot);
      } else if (dataDb || dataFiles.length > 0) {
        const dir = path.join(hub.layout.prefix, 'data');
        await assertHubDirsOnlyOwnerWritable(run, hub.systemRoot, [dir]);
        if (dataDb) fs.unlinkSync(verifyRecordedDatabase(hub.layout.prefix, record, context.secretFileGuard));
        for (const name of dataFiles) {
          const secret = readOwnedSecret(hub.layout.prefix, hub.layout.hubRoot, name, record, context.secretFileGuard);
          if (secret === undefined) throw new Error(`The ownership record for ${name} disappeared.`);
          fs.unlinkSync(secret);
        }
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
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
