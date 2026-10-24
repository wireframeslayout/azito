import { unpackTarGz, type TarEntry } from '../../../shared/fs/tarGz';

/**
 * What a Linux x86_64 agent needs from its tarball, checked on the tarball itself (not on the staging folder it came from), so
 * a bundle put together on a Windows or macOS hub is held to the same standard as one built on Linux: the native module for the
 * agent's OS is in it, and the launcher is executable.
 */

/** Where node-pty (the agent's terminal and the supervisor's pty) loads its Linux binary from. */
export const AGENT_PTY_NODE_PATH = 'node_modules/node-pty/build/Release/pty.node';
export const AGENT_LAUNCHER_PATH = 'run.sh';
/** Files of the agent bundle besides what is under node_modules. */
const REQUIRED_FILES = ['azito-agent.cjs', 'azito-supervisor.cjs', 'version.txt', AGENT_LAUNCHER_PATH];

/**
 * The prebuilds of the npm node-pty that a macOS and a Windows agent load (the same bundle serves every agent OS: node-pty uses
 * `build/Release` on Linux and `prebuilds/<platform>-<arch>` elsewhere). Debug symbols are not carried.
 */
const NODE_PTY_PREBUILD_FILES = [
  ...['darwin-arm64', 'darwin-x64'].flatMap((dir) => [`${dir}/pty.node`, `${dir}/spawn-helper`]),
  ...['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((file) => `win32-x64/${file}`),
].map((file) => `node_modules/node-pty/prebuilds/${file}`);

/** node-pty execs this on macOS to start a pty; the npm package ships it without the execute bit. */
export function isNodePtySpawnHelper(entryPath: string): boolean {
  return /^node_modules\/node-pty\/(prebuilds\/[^/]+|build\/Release)\/spawn-helper$/.test(entryPath);
}

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELF_CLASS_64 = 2;
const ELF_MACHINE_X86_64 = 62;

/** Why `data` is not a 64-bit x86-64 ELF shared object, or null when it is. (The preflight accepts x86_64 Linux agents only.) */
export function describeNotLinuxX64Elf(data: Buffer): string | null {
  if (data.length < 20 || !ELF_MAGIC.every((byte, i) => data[i] === byte)) return 'it is not an ELF file (a macOS or Windows binary?)';
  if (data[4] !== ELF_CLASS_64) return 'it is not a 64-bit ELF file';
  const machine = data.readUInt16LE(18);
  if (machine !== ELF_MACHINE_X86_64) return `it is built for ELF machine ${machine}, not x86-64 (62)`;
  return null;
}

function findFile(entries: readonly TarEntry[], entryPath: string): TarEntry | undefined {
  return entries.find((entry) => entry.type === 'file' && entry.path === entryPath);
}

/** Problems of the agent tarball for a Linux x86_64 host; empty when it is complete. */
export function findAgentBundleProblems(tarGz: Buffer): string[] {
  const entries = unpackTarGz(tarGz);
  const problems: string[] = [];
  for (const file of REQUIRED_FILES) {
    if (!findFile(entries, file)) problems.push(`${file} is missing`);
  }
  const launcher = findFile(entries, AGENT_LAUNCHER_PATH);
  if (launcher && (launcher.mode & 0o111) !== 0o111) {
    problems.push(`${AGENT_LAUNCHER_PATH} is not executable (mode ${launcher.mode.toString(8)})`);
  }
  // A Windows checkout can turn the script into CRLF (see .gitattributes), and `#!/bin/bash\r` does not start on Linux.
  if (launcher?.data?.includes(0x0d)) problems.push(`${AGENT_LAUNCHER_PATH} has CRLF line endings`);
  const pty = findFile(entries, AGENT_PTY_NODE_PATH);
  if (!pty) {
    problems.push(`${AGENT_PTY_NODE_PATH} is missing (node-pty has no Linux binary in the bundle)`);
  } else {
    const notElf = describeNotLinuxX64Elf(pty.data ?? Buffer.alloc(0));
    if (notElf) problems.push(`${AGENT_PTY_NODE_PATH} is not a Linux x86-64 binary: ${notElf}`);
  }
  for (const file of NODE_PTY_PREBUILD_FILES) {
    const entry = findFile(entries, file);
    if (!entry) problems.push(`${file} is missing (a macOS / Windows agent cannot start a pty)`);
    else if (isNodePtySpawnHelper(file) && (entry.mode & 0o111) !== 0o111) problems.push(`${file} is not executable (mode ${entry.mode.toString(8)})`);
  }
  return problems;
}

export function assertAgentBundleComplete(tarGz: Buffer, label: string): void {
  const problems = findAgentBundleProblems(tarGz);
  if (problems.length > 0) throw new Error(`${label} is not a complete Linux x86_64 agent bundle: ${problems.join('; ')}`);
}
