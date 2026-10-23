import { describe, expect, it, vi } from 'vitest';
import { decodeEncodedCommand } from './testing/fakeWindowsHost';
import {
  buildFirewallAddCommand, buildFirewallDumpCommand, checkFirewall, describeFirewallProblem, evaluateFirewallRules, firewallRuleCommand,
  parseAddressSpec, parseFirewallAdd, parseFirewallDump, type FirewallResult, type FirewallRuleRecord,
} from './windowsFirewall';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const IP = '100.64.0.9';
const TARGET = { port: 3002, nodePath: NODE, localAddress: IP, networkCategory: 'Public' as string | null };

function rule(over: Partial<FirewallRuleRecord> = {}): FirewallRuleRecord {
  return {
    name: 'r', displayName: 'a rule', action: 'Allow', profile: 'Any', package: '', owner: '', service: 'Any', protocol: 'TCP',
    localPort: ['Any'], program: 'Any', remoteAddress: ['Any'], localAddress: ['Any'], ...over,
  };
}
const allowed = (rules: FirewallRuleRecord[], target = TARGET): string[] => evaluateFirewallRules(rules, target).allowedBy;
const blocked = (rules: FirewallRuleRecord[], target = TARGET): string[] => evaluateFirewallRules(rules, target).blockedBy;

describe('evaluateFirewallRules: Allow', () => {
  it('counts a rule that covers this program, port, address and the tailnet', () => {
    expect(allowed([rule({ displayName: 'ours', program: NODE.toUpperCase(), localPort: ['3002'], localAddress: [IP], remoteAddress: ['100.64.0.0/255.192.0.0'], profile: 'Public' })])).toEqual(['ours']);
    expect(allowed([rule({ remoteAddress: ['100.64.0.0/10'] })])).toEqual(['a rule']);
    expect(allowed([rule({ remoteAddress: ['10.0.0.0/8', '100.0.0.0/8'] })])).toEqual(['a rule']);
  });

  it.each([
    ['a port range', { localPort: ['3000-3010'] }],
    ['another port', { localPort: ['3003'] }],
    ['another program', { program: 'C:\\other\\node.exe' }],
    ['UDP', { protocol: 'UDP' }],
    ['LocalSubnet only', { remoteAddress: ['LocalSubnet'] }],
    ['another remote network', { remoteAddress: ['192.168.0.0/16'] }],
    ['part of the tailnet', { remoteAddress: ['100.64.0.0/16'] }],
    ['another local address', { localAddress: ['127.0.0.1'] }],
    ['one packaged app', { package: 'S-1-15-2-1' }],
    ['one owner', { owner: 'S-1-5-21-1' }],
    ['one service', { service: 'Dnscache' }],
    ['another profile (the adapter is Public)', { profile: 'Domain, Private' }],
  ] as Array<[string, Partial<FirewallRuleRecord>]>)('does not count a rule for %s', (_name, over) => {
    expect(allowed([rule(over)])).toEqual([]);
  });

  it('counts only the Public / Any rules when the adapter\'s profile cannot be read', () => {
    const unknown = { ...TARGET, networkCategory: null };
    expect(allowed([rule({ profile: 'Private' })], unknown)).toEqual([]);
    expect(allowed([rule({ profile: 'Public, Private' })], unknown)).toEqual(['a rule']);
    expect(allowed([rule({ profile: 'Any' })], unknown)).toEqual(['a rule']);
  });

  it('reads DomainAuthenticated as the Domain profile', () => {
    expect(allowed([rule({ profile: 'Domain' })], { ...TARGET, networkCategory: 'DomainAuthenticated' })).toEqual(['a rule']);
  });

  it('ignores a disabled-looking or unknown action', () => {
    expect(allowed([rule({ action: 'NotConfigured' })])).toEqual([]);
  });
});

describe('evaluateFirewallRules: Block', () => {
  it('counts a Block on the port, on the program with any port, and on a range that contains the port', () => {
    expect(blocked([rule({ action: 'Block', displayName: 'port', localPort: ['3002'] })])).toEqual(['port']);
    expect(blocked([rule({ action: 'Block', displayName: 'program', program: NODE })])).toEqual(['program']);
    expect(blocked([rule({ action: 'Block', displayName: 'range', localPort: ['3000-3010'] })])).toEqual(['range']);
    expect(blocked([rule({ action: 'Block', displayName: 'inet', localPort: ['3002'], remoteAddress: ['Internet'] })])).toEqual(['inet']);
    expect(blocked([rule({ action: 'Block', displayName: 'overlap', localPort: ['3002'], remoteAddress: ['100.100.0.0/16'] })])).toEqual(['overlap']);
  });

  it.each([
    ['another port of the same program', { program: NODE, localPort: ['3003'] }],
    ['a range that misses the port', { localPort: ['3003-3010'] }],
    ['another program', { program: 'C:\\other\\node.exe', localPort: ['3002'] }],
    ['a remote network that is not the tailnet', { localPort: ['3002'], remoteAddress: ['192.168.0.0/16'] }],
    ['LocalSubnet', { localPort: ['3002'], remoteAddress: ['LocalSubnet'] }],
    ['another local address', { localPort: ['3002'], localAddress: ['127.0.0.1'] }],
    ['another profile', { localPort: ['3002'], profile: 'Domain' }],
    ['a packaged app', { localPort: ['3002'], package: 'S-1-15-2-1' }],
    ['UDP', { localPort: ['3002'], protocol: 'UDP' }],
  ] as Array<[string, Partial<FirewallRuleRecord>]>)('does not count a Block for %s', (_name, over) => {
    expect(blocked([rule({ action: 'Block', ...over })])).toEqual([]);
  });

  it('counts a Block of any profile when the adapter\'s profile cannot be read', () => {
    expect(blocked([rule({ action: 'Block', localPort: ['3002'], profile: 'Domain' })], { ...TARGET, networkCategory: null })).toEqual(['a rule']);
  });
});

describe('parseAddressSpec', () => {
  it.each([
    ['Any', { kind: 'any' }],
    ['10.0.0.1', { kind: 'range', low: 167772161, high: 167772161 }],
    ['10.0.0.0/8', { kind: 'range', low: 167772160, high: 184549375 }],
    ['10.0.0.0/255.0.0.0', { kind: 'range', low: 167772160, high: 184549375 }],
    ['10.0.0.1-10.0.0.9', { kind: 'range', low: 167772161, high: 167772169 }],
    ['LocalSubnet', { kind: 'keyword', name: 'localsubnet' }],
    ['fe80::/64', { kind: 'other' }],
    ['10.0.0.0/33', { kind: 'other' }],
    ['10.0.0.0/255.0.255.0', { kind: 'other' }],
  ])('reads %s', (spec, expected) => {
    expect(parseAddressSpec(spec)).toEqual(expected);
  });
});

describe('the scripts', () => {
  it('collects inbound rules and their filters (the in-force store first), and decides nothing itself', () => {
    const script = decodeEncodedCommand(buildFirewallDumpCommand(IP));
    expect(script).toContain("-IPAddress '100.64.0.9'");
    for (const cmdlet of ['Get-NetFirewallRule', 'Get-NetFirewallPortFilter', 'Get-NetFirewallApplicationFilter', 'Get-NetFirewallAddressFilter', 'Get-NetFirewallServiceFilter', 'Get-NetConnectionProfile']) expect(script).toContain(cmdlet);
    expect(script).toContain('ActiveStore');
    expect(script).toContain('PersistentStore');
    expect(script).not.toContain('New-NetFirewallRule');
  });

  it('adds the rule for this program, address and port, from the tailnet only', () => {
    const script = decodeEncodedCommand(buildFirewallAddCommand(3902, "C:\\Program Files\\node's\\node.exe", IP));
    expect(script).toContain("-DisplayName 'AZITO Agent (TCP 3902)'");
    expect(script).toContain("-LocalPort 3902 -Program 'C:\\Program Files\\node''s\\node.exe' -LocalAddress '100.64.0.9' -RemoteAddress '100.64.0.0/10' -Profile Any");
  });

  it.each([
    ['the default path', NODE],
    ['a 260-character path', `C:\\${'a'.repeat(250)}\\node.exe`.slice(0, 260)],
  ])('fits one cmd.exe command line (8191 characters) with %s', (_name, nodePath) => {
    expect(buildFirewallDumpCommand('100.64.255.255').length).toBeLessThanOrEqual(8191);
    expect(buildFirewallAddCommand(65535, nodePath, '100.64.255.255').length).toBeLessThanOrEqual(8191);
  });

  it('never uses two spellings of one variable (PowerShell variables are case-insensitive)', () => {
    const automatic = new Set(['_', 'true', 'false', 'null', 'global', 'env', 'lastexitcode', 'erroractionpreference', 'progresspreference', 'psitem', 'match']);
    for (const command of [buildFirewallDumpCommand(IP), buildFirewallAddCommand(3002, NODE, IP)]) {
      const spellings = new Map<string, Set<string>>();
      for (const [, name] of decodeEncodedCommand(command).matchAll(/\$(?:global:|env:)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (automatic.has(name!.toLowerCase())) continue;
        spellings.set(name!.toLowerCase(), (spellings.get(name!.toLowerCase()) ?? new Set()).add(name!));
      }
      const clashes = [...spellings.values()].filter((set) => set.size > 1).map((set) => [...set].join(' / '));
      expect(clashes).toEqual([]);
    }
  });
});

function dumped(over: object = {}): string {
  const dump = { elevated: true, networkCategory: 'Public', store: 'ActiveStore', problem: null, rules: [], ...over };
  return `x\r\n<<AZITO_FIREWALL_DUMP_BEGIN>>\r\n${JSON.stringify(dump)}\r\n<<AZITO_FIREWALL_DUMP_END>>\r\n`;
}
const added = (created: boolean, problem: string | null = null): string => `<<AZITO_FIREWALL_ADD_BEGIN>>\n${JSON.stringify({ created, problem })}\n<<AZITO_FIREWALL_ADD_END>>\n`;

describe('checkFirewall', () => {
  const run = (answers: string[]) => {
    const exec = vi.fn(async (_command: string) => ({ stdout: answers.shift() ?? '', stderr: '', code: 0 }));
    return { exec, result: () => checkFirewall(exec, 3002, NODE, IP) };
  };

  it('finds an Allow rule and adds nothing', async () => {
    const { exec, result } = run([dumped({ rules: [rule({ displayName: 'ours' })] })]);
    expect(await result()).toMatchObject({ ruleFound: true, created: false, allowedBy: ['ours'], blockedBy: [], store: 'ActiveStore' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('adds the rule when nothing covers the agent and the session is elevated', async () => {
    const { exec, result } = run([dumped(), added(true)]);
    expect(await result()).toMatchObject({ ruleFound: false, created: true });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('adds nothing beside a Block rule, or from a session that is not elevated', async () => {
    const blockedRun = run([dumped({ rules: [rule({ action: 'Block', displayName: 'cancelled prompt', localPort: ['3002'] })] })]);
    expect(await blockedRun.result()).toMatchObject({ ruleFound: false, created: false, blockedBy: ['cancelled prompt'] });
    expect(blockedRun.exec).toHaveBeenCalledTimes(1);
    const plain = run([dumped({ elevated: false })]);
    expect(await plain.result()).toMatchObject({ ruleFound: false, created: false, elevated: false });
    expect(plain.exec).toHaveBeenCalledTimes(1);
  });

  it('reports a host that cannot be read as unknown, not as "no rule"', async () => {
    const { result } = run([dumped({ problem: 'reading the rules failed: boom' })]);
    expect(await result()).toMatchObject({ ruleFound: null, problem: 'reading the rules failed: boom' });
  });

  it('refuses garbage', () => {
    expect(() => parseFirewallDump('nothing', '', 1)).toThrow(/Could not read the Windows Firewall rules/);
    expect(() => parseFirewallDump(dumped({ rules: [{ name: 1 }] }), '', 0)).toThrow(/unexpected result/);
    expect(() => parseFirewallAdd('nothing', '', 1)).toThrow(/Could not read the result of adding/);
  });
});

describe('describeFirewallProblem', () => {
  const base: FirewallResult = { ruleFound: false, elevated: false, created: false, problem: null, blockedBy: [], allowedBy: [], store: 'ActiveStore' };
  it('is null when a rule exists, was just added, or the host could not say', () => {
    expect(describeFirewallProblem({ ...base, ruleFound: true }, 3002, NODE, IP)).toBeNull();
    expect(describeFirewallProblem({ ...base, elevated: true, created: true }, 3002, NODE, IP)).toBeNull();
    expect(describeFirewallProblem({ ...base, ruleFound: null }, 3002, NODE, IP)).toBeNull();
  });

  it('says why and how to fix it when there is no rule', () => {
    const text = describeFirewallProblem(base, 3002, NODE, IP)!;
    expect(text).toContain('TCP 3002');
    expect(text).toContain('not elevated');
    expect(text).toContain('in the profile of the Tailscale adapter');
    expect(text).toContain('a rule for a port range or one limited to other remote addresses does not count');
    expect(text).toContain(firewallRuleCommand(3002, NODE, IP));
  });

  it('stops with the DisplayName of an enabled inbound Block rule, even when an Allow rule exists', () => {
    const text = describeFirewallProblem({ ...base, ruleFound: true, blockedBy: ['node.js', 'Other'] }, 3002, NODE, IP)!;
    expect(text).toContain('"node.js", "Other"');
    expect(text).toContain('A Block rule wins');
  });
});

describe('firewallRuleCommand', () => {
  it('limits the rule to the program, the local address, the port and the tailnet', () => {
    expect(firewallRuleCommand(3002, NODE, IP)).toBe(`New-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3002 -Program "${NODE}" -LocalAddress 100.64.0.9 -RemoteAddress 100.64.0.0/10 -Profile Any`);
  });
});
