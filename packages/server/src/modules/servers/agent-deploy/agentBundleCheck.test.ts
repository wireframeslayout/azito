import { describe, it, expect } from 'vitest';
import { packTarGz, type TarEntry } from '../../../shared/fs/tarGz';
import { assertAgentBundleComplete, describeNotLinuxX64Elf, describeNotLinuxElf, findAgentBundleProblems, isNodePtySpawnHelper, AGENT_PTY_NODE_PATH, AGENT_PTY_ARM64_NODE_PATH } from './agentBundleCheck';

function elf(machine: number, elfClass = 2): Buffer {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, elfClass]).copy(header);
  header.writeUInt16LE(machine, 18);
  return header;
}

function file(entryPath: string, data: Buffer | string, mode = 0o644): TarEntry {
  return { path: entryPath, type: 'file', mode, data: Buffer.from(data) };
}

function completeBundle(): TarEntry[] {
  return [
    file('azito-agent.cjs', 'agent'),
    file('azito-supervisor.cjs', 'supervisor'),
    file('version.txt', 'abc'),
    file('run.sh', '#!/bin/bash\n', 0o755),
    file(AGENT_PTY_NODE_PATH, elf(62)),
    file(AGENT_PTY_ARM64_NODE_PATH, elf(183)),
    file('node_modules/node-pty/lib/index.js', 'js'),
    ...['darwin-arm64', 'darwin-x64'].flatMap((dir) => [
      file(`node_modules/node-pty/prebuilds/${dir}/pty.node`, 'macho'),
      file(`node_modules/node-pty/prebuilds/${dir}/spawn-helper`, 'macho', 0o755),
    ]),
    ...['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => file(`node_modules/node-pty/prebuilds/win32-x64/${f}`, 'pe')),
  ];
}

const pack = (entries: TarEntry[]): Buffer => packTarGz(entries, 1_700_000_000);

describe('describeNotLinuxElf for arm64', () => {
  it('accepts aarch64 and rejects x86-64 or a 32-bit ELF', () => {
    expect(describeNotLinuxElf(elf(183), 'arm64')).toBeNull();
    expect(describeNotLinuxElf(elf(62), 'arm64')).toMatch(/machine 62, not aarch64/);
    expect(describeNotLinuxElf(elf(183, 1), 'arm64')).toMatch(/64-bit/);
  });
});

describe('describeNotLinuxX64Elf', () => {
  it('accepts a 64-bit x86-64 ELF', () => {
    expect(describeNotLinuxX64Elf(elf(62))).toBeNull();
  });

  it('names a Mach-O, a PE, an arm64 ELF and a 32-bit ELF', () => {
    expect(describeNotLinuxX64Elf(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...new Array(30).fill(0)]))).toMatch(/not an ELF/);
    expect(describeNotLinuxX64Elf(Buffer.from([0x4d, 0x5a, ...new Array(30).fill(0)]))).toMatch(/not an ELF/);
    expect(describeNotLinuxX64Elf(elf(183))).toMatch(/machine 183/);
    expect(describeNotLinuxX64Elf(elf(62, 1))).toMatch(/64-bit/);
  });
});

describe('findAgentBundleProblems', () => {
  it('is empty for a complete bundle', () => {
    expect(findAgentBundleProblems(pack(completeBundle()))).toEqual([]);
  });

  it('reports a bundle built on a Windows or macOS host: no Linux pty.node', () => {
    const entries = completeBundle().filter((e) => e.path !== AGENT_PTY_NODE_PATH);
    expect(findAgentBundleProblems(pack(entries))).toEqual([`${AGENT_PTY_NODE_PATH} is missing (node-pty has no Linux x64 binary in the bundle)`]);
  });

  it('rejects missing, swapped and shadowed Linux arm64 binaries', () => {
    const missing = completeBundle().filter((e) => e.path !== AGENT_PTY_ARM64_NODE_PATH);
    expect(findAgentBundleProblems(pack(missing))).toEqual([expect.stringContaining('linux-arm64/pty.node is missing')]);
    const swapped = completeBundle().map((e) => e.path === AGENT_PTY_ARM64_NODE_PATH ? { ...e, data: elf(62) } : e);
    expect(findAgentBundleProblems(pack(swapped))).toEqual([expect.stringContaining('not a Linux arm64 binary')]);
    expect(findAgentBundleProblems(pack([...completeBundle(), file('node_modules/node-pty/build/Release/pty.node', elf(62))]))).toEqual([expect.stringContaining('shadows architecture-specific prebuilds')]);
  });

  it('reports the prebuilds a macOS / Windows agent needs when they are missing, and a spawn-helper that cannot run', () => {
    const noWindows = completeBundle().filter((e) => !e.path.includes('win32-x64'));
    expect(findAgentBundleProblems(pack(noWindows)).every((p) => p.includes('win32-x64') && p.includes('is missing'))).toBe(true);
    const slowHelper = completeBundle().map((e) => (e.path.endsWith('darwin-x64/spawn-helper') ? { ...e, mode: 0o644 } : e));
    expect(findAgentBundleProblems(pack(slowHelper))).toEqual(['node_modules/node-pty/prebuilds/darwin-x64/spawn-helper is not executable (mode 644)']);
  });

  it('reports a launcher without its execute bit', () => {
    const entries = completeBundle().map((e) => (e.path === 'run.sh' ? { ...e, mode: 0o644 } : e));
    expect(findAgentBundleProblems(pack(entries))).toEqual(['run.sh is not executable (mode 644)']);
  });

  it('reports a launcher with CRLF line endings (a Windows checkout without .gitattributes)', () => {
    const entries = completeBundle().map((e) => (e.path === 'run.sh' ? { ...e, data: Buffer.from('#!/bin/bash\r\nexec node x\r\n') } : e));
    expect(findAgentBundleProblems(pack(entries))).toEqual(['run.sh has CRLF line endings']);
  });

  it('reports a pty.node of the wrong OS', () => {
    const entries = completeBundle().map((e) => (e.path === AGENT_PTY_NODE_PATH ? { ...e, data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...new Array(30).fill(0)]) } : e));
    expect(findAgentBundleProblems(pack(entries))[0]).toMatch(/not a Linux x64 binary/);
  });

  it('throws with the label and every problem', () => {
    expect(() => assertAgentBundleComplete(pack([]), 'the tarball')).toThrow(/the tarball is not a complete agent bundle: azito-agent\.cjs is missing/);
  });
});

describe('isNodePtySpawnHelper', () => {
  it('matches node-pty spawn-helpers only', () => {
    expect(isNodePtySpawnHelper('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).toBe(true);
    expect(isNodePtySpawnHelper('node_modules/node-pty/build/Release/spawn-helper')).toBe(true);
    expect(isNodePtySpawnHelper('node_modules/other/spawn-helper')).toBe(false);
    expect(isNodePtySpawnHelper('node_modules/node-pty/lib/spawn-helper.js')).toBe(false);
  });
});
