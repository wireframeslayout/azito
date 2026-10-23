import { describe, expect, it } from 'vitest';
import { decodeEncodedCommand } from './testing/fakeWindowsHost';
import { buildFirewallCommand, describeFirewallProblem, firewallRuleCommand, parseFirewallResult } from './windowsFirewall';

const wrap = (r: object) => `x\r\n<<AZITO_FIREWALL_BEGIN>>\r\n${JSON.stringify(r)}\r\n<<AZITO_FIREWALL_END>>\r\n`;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const IP = '100.64.0.9';

describe('buildFirewallCommand', () => {
  it('reads inbound rules with their filters, and adds a rule for this program, address and port only when elevated', () => {
    const script = decodeEncodedCommand(buildFirewallCommand(3902, "C:\\Program Files\\node's\\node.exe", IP));
    expect(script).toContain('$port=3902;');
    expect(script).toContain("$node='C:\\Program Files\\node''s\\node.exe'");
    expect(script).toContain("$ip='100.64.0.9'");
    expect(script).toContain('Get-NetFirewallPortFilter');
    expect(script).toContain('Get-NetFirewallApplicationFilter');
    expect(script).toContain('Get-NetFirewallAddressFilter');
    expect(script).toContain('Get-NetFirewallServiceFilter');
    expect(script).toContain("'Block'");
    expect(script).toContain('if($found -eq $false -and $el -and !$blocked.Count)');
    expect(script).toContain("-DisplayName 'AZITO Agent (TCP 3902)'");
    expect(script).toContain('-Program $node -LocalAddress $ip');
    expect(script).toContain("-RemoteAddress '100.64.0.0/10'");
  });
});

describe('buildFirewallCommand: the command line limit', () => {
  it('fits one cmd.exe command line (8191 characters) with a long node.exe path', () => {
    const longPath = `C:\\Users\\${'a'.repeat(100)}\\AppData\\Local\\Programs\\nodejs\\node.exe`;
    expect(buildFirewallCommand(3002, longPath, '100.64.255.255').length).toBeLessThanOrEqual(8191);
  });
});

describe('describeFirewallProblem', () => {
  const base = { ruleFound: false, elevated: false, created: false, problem: null, blockedBy: [] as string[] };
  it('is null when a rule exists, was just added, or the host could not say', () => {
    expect(describeFirewallProblem({ ...base, ruleFound: true }, 3002, NODE, IP)).toBeNull();
    expect(describeFirewallProblem({ ...base, elevated: true, created: true }, 3002, NODE, IP)).toBeNull();
    expect(describeFirewallProblem({ ...base, ruleFound: null }, 3002, NODE, IP)).toBeNull();
  });

  it('says why and how to fix it when there is no rule', () => {
    const text = describeFirewallProblem(base, 3002, NODE, IP)!;
    expect(text).toContain('TCP 3002');
    expect(text).toContain('not elevated');
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

describe('parseFirewallResult', () => {
  it('reads the result and refuses garbage', () => {
    expect(parseFirewallResult(wrap({ ruleFound: null, elevated: true, created: false, problem: null, blockedBy: [] }), '', 0).ruleFound).toBeNull();
    expect(() => parseFirewallResult('nothing', '', 1)).toThrow(/Could not read the Windows Firewall check/);
    expect(() => parseFirewallResult(wrap({ ruleFound: 'yes' }), '', 0)).toThrow(/unexpected result/);
  });
});
