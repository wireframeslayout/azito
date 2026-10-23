import { describe, it, expect } from 'vitest';
import { detectDefaultBranch } from './detectDefaultBranch';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { CommandSpawnError, type CommandResult } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, fakeRunTransport, ok } from '../../shared/exec/testing/commandTesting';

/** Answers by the ref a command names: `symbolic-ref` or `refs/heads/<x>`. */
function makeTransport(answers: { symbolicRef?: CommandResult; main?: CommandResult; master?: CommandResult }) {
  return fakeRunTransport((spec) => {
    if (spec.args[0] === 'symbolic-ref') return answers.symbolicRef ?? failed(1);
    if (spec.args.includes('refs/heads/main')) return answers.main ?? failed(1);
    if (spec.args.includes('refs/heads/master')) return answers.master ?? failed(1);
    throw new Error(`unexpected command: ${spec.args.join(' ')}`);
  });
}

const sha = (c: string): CommandResult => ok(c.repeat(40) + '\n');

describe('detectDefaultBranch', () => {
  it('detects from origin/HEAD when set', async () => {
    const t = makeTransport({ symbolicRef: ok('refs/remotes/origin/main\n') });
    expect(await detectDefaultBranch(t, '/repo')).toBe('main');
    expect(t.specs).toHaveLength(1);
    expect(t.specs[0]).toMatchObject({ file: 'git', cwd: '/repo', args: ['symbolic-ref', 'refs/remotes/origin/HEAD'] });
  });

  it('detects master from origin/HEAD', async () => {
    expect(await detectDefaultBranch(makeTransport({ symbolicRef: ok('refs/remotes/origin/master\n') }), '/repo')).toBe('master');
  });

  it('detects a non-standard branch from origin/HEAD', async () => {
    expect(await detectDefaultBranch(makeTransport({ symbolicRef: ok('refs/remotes/origin/develop\n') }), '/repo')).toBe('develop');
  });

  it('falls back to main when origin/HEAD is not set (exit 1) and only main exists', async () => {
    expect(await detectDefaultBranch(makeTransport({ main: sha('a') }), '/repo')).toBe('main');
  });

  it('falls back to master when origin/HEAD is not set and only master exists', async () => {
    expect(await detectDefaultBranch(makeTransport({ master: sha('b') }), '/repo')).toBe('master');
  });

  it('returns null when both main and master exist (ambiguous)', async () => {
    expect(await detectDefaultBranch(makeTransport({ main: sha('a'), master: sha('b') }), '/repo')).toBeNull();
  });

  it('returns null when neither main nor master exists', async () => {
    expect(await detectDefaultBranch(makeTransport({}), '/repo')).toBeNull();
  });

  it('ignores origin/HEAD output of a failed command', async () => {
    const t = makeTransport({ symbolicRef: failed(128, 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n', 'refs/remotes/origin/x\n'), master: sha('c') });
    expect(await detectDefaultBranch(t, '/repo')).toBe('master');
  });

  it('does not take a failed rev-parse as an existing branch even if it printed a sha', async () => {
    expect(await detectDefaultBranch(makeTransport({ main: failed(1, '', 'a'.repeat(40)) }), '/repo')).toBeNull();
  });

  it('lets a git that cannot start propagate', async () => {
    const transport = { run: async () => { throw new CommandSpawnError('ENOENT', 'spawn git ENOENT'); } } as unknown as IServerTransport;
    await expect(detectDefaultBranch(transport, '/repo')).rejects.toBeInstanceOf(CommandSpawnError);
  });

  it.skipIf(process.platform === 'win32')('runs the same argv the old shell strings made', async () => {
    const t = makeTransport({});
    await detectDefaultBranch(t, '/repo');
    expect(t.specs.map(argvOfSpec)).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
      'git rev-parse --verify --quiet refs/heads/main',
      'git rev-parse --verify --quiet refs/heads/master',
    ].map(argvOfShellLine));
  });
});
