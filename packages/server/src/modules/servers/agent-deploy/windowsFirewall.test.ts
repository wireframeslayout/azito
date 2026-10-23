import { describe, expect, it } from 'vitest';
import { decodeEncodedCommand } from './testing/fakeWindowsHost';
import { buildFirewallCommand, describeFirewallProblem, firewallRuleCommand, parseFirewallResult } from './windowsFirewall';

const wrap = (r: object) => `x\r\n<<AZITO_FIREWALL_BEGIN>>\r\n${JSON.stringify(r)}\r\n<<AZITO_FIREWALL_END>>\r\n`;

describe('buildFirewallCommand', () => {
  it('looks for an enabled inbound Allow rule by port and by node.exe, and adds one only when the session is elevated', () => {
    const script = decodeEncodedCommand(buildFirewallCommand(3902, "C:\\Program Files\\node's\\node.exe"));
    expect(script).toContain('$port = 3902');
    expect(script).toContain("$node = 'C:\\Program Files\\node''s\\node.exe'");
    expect(script).toContain('Get-NetFirewallPortFilter');
    expect(script).toContain('Get-NetFirewallApplicationFilter');
    expect(script).toContain('if ($found -eq $false -and $elevated)');
    expect(script).toContain("-DisplayName 'AZITO Agent (TCP 3902)'");
    expect(script).toContain("-RemoteAddress '100.64.0.0/10'");
  });
});

describe('describeFirewallProblem', () => {
  const base = { ruleFound: false, elevated: false, created: false, problem: null };
  it('is null when a rule exists, was just added, or the host could not say', () => {
    expect(describeFirewallProblem({ ...base, ruleFound: true }, 3002)).toBeNull();
    expect(describeFirewallProblem({ ...base, elevated: true, created: true }, 3002)).toBeNull();
    expect(describeFirewallProblem({ ...base, ruleFound: null }, 3002)).toBeNull();
  });

  it('says why and how to fix it when there is no rule', () => {
    const text = describeFirewallProblem(base, 3002)!;
    expect(text).toContain('TCP 3002');
    expect(text).toContain('not elevated');
    expect(text).toContain(firewallRuleCommand(3002));
  });
});

describe('parseFirewallResult', () => {
  it('reads the result and refuses garbage', () => {
    expect(parseFirewallResult(wrap({ ruleFound: null, elevated: true, created: false, problem: null }), '', 0).ruleFound).toBeNull();
    expect(() => parseFirewallResult('nothing', '', 1)).toThrow(/Could not read the Windows Firewall check/);
    expect(() => parseFirewallResult(wrap({ ruleFound: 'yes' }), '', 0)).toThrow(/unexpected result/);
  });
});
