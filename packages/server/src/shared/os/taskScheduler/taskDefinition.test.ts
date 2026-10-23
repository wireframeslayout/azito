import { describe, expect, it } from 'vitest';
import { buildTaskXml, decodeTaskXml, encodeTaskXml, escapeXml, type TaskDefinitionInput } from './taskDefinition';

const INPUT: TaskDefinitionInput = {
  userId: 'DESKTOP-1\\alice',
  description: 'AZITO hub',
  executable: 'C:\\Program Files\\AZITO\\azito.exe',
  args: ['serve', '--dir', 'C:\\Users\\alice\\My Data'],
  workingDirectory: 'C:\\Users\\alice\\.azito',
  restartOnFailure: { intervalMinutes: 1, count: 3 },
};

const EXPECTED = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <RegistrationInfo>',
  '    <Description>AZITO hub</Description>',
  '  </RegistrationInfo>',
  '  <Triggers>',
  '    <LogonTrigger>',
  '      <Enabled>true</Enabled>',
  '      <UserId>DESKTOP-1\\alice</UserId>',
  '    </LogonTrigger>',
  '  </Triggers>',
  '  <Principals>',
  '    <Principal id="Author">',
  '      <UserId>DESKTOP-1\\alice</UserId>',
  '      <LogonType>InteractiveToken</LogonType>',
  '      <RunLevel>LeastPrivilege</RunLevel>',
  '    </Principal>',
  '  </Principals>',
  '  <Settings>',
  '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
  '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
  '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
  '    <AllowHardTerminate>true</AllowHardTerminate>',
  '    <StartWhenAvailable>false</StartWhenAvailable>',
  '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
  '    <IdleSettings>',
  '      <StopOnIdleEnd>false</StopOnIdleEnd>',
  '      <RestartOnIdle>false</RestartOnIdle>',
  '    </IdleSettings>',
  '    <AllowStartOnDemand>true</AllowStartOnDemand>',
  '    <Enabled>true</Enabled>',
  '    <Hidden>false</Hidden>',
  '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
  '    <WakeToRun>false</WakeToRun>',
  '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
  '    <Priority>7</Priority>',
  '    <RestartOnFailure>',
  '      <Interval>PT1M</Interval>',
  '      <Count>3</Count>',
  '    </RestartOnFailure>',
  '  </Settings>',
  '  <Actions Context="Author">',
  '    <Exec>',
  '      <Command>C:\\Program Files\\AZITO\\azito.exe</Command>',
  '      <Arguments>serve --dir "C:\\Users\\alice\\My Data"</Arguments>',
  '      <WorkingDirectory>C:\\Users\\alice\\.azito</WorkingDirectory>',
  '    </Exec>',
  '  </Actions>',
  '</Task>',
  '',
].join('\r\n');

describe('buildTaskXml', () => {
  it('builds the logon-trigger, least-privilege, restart-on-failure task', () => {
    expect(buildTaskXml(INPUT)).toBe(EXPECTED);
  });

  it('asks for no admin rights and stores no password', () => {
    const xml = buildTaskXml(INPUT);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).not.toMatch(/HighestAvailable|Password|S4U/);
  });

  it('quotes the arguments first and escapes XML in every text value', () => {
    const xml = buildTaskXml({ ...INPUT, description: 'a & b <c> "d" \'e\'', args: ['x "y" & <z>'], userId: 'D\\a&b' });
    expect(xml).toContain("<Description>a &amp; b &lt;c&gt; \"d\" 'e'</Description>");
    expect(xml).toContain('<Arguments>"x \\"y\\" &amp; &lt;z&gt;"</Arguments>');
    expect(xml).toContain('<UserId>D\\a&amp;b</UserId>');
  });

  it('keeps Japanese and spaces in the paths and arguments', () => {
    const xml = buildTaskXml({ ...INPUT, executable: 'C:\\ユーザー\\私 の\\node.exe', args: ['日本語 の 引数'], workingDirectory: 'D:\\作業 場所', userId: 'PC\\太郎' });
    expect(xml).toContain('<Command>C:\\ユーザー\\私 の\\node.exe</Command>');
    expect(xml).toContain('<Arguments>"日本語 の 引数"</Arguments>');
    expect(xml).toContain('<WorkingDirectory>D:\\作業 場所</WorkingDirectory>');
  });

  it('writes no Arguments text for no arguments', () => {
    expect(buildTaskXml({ ...INPUT, args: [] })).toContain('<Arguments></Arguments>');
  });

  it.each([
    ['a relative executable', { executable: 'azito.exe' }, /executable must be an absolute Windows path/],
    ['a drive-less rooted executable', { executable: '\\azito.exe' }, /absolute Windows path/],
    ['a POSIX executable', { executable: '/usr/bin/azito' }, /absolute Windows path/],
    ['a quote in the executable', { executable: 'C:\\a"b\\x.exe' }, /double quote/],
    ['a relative working directory', { workingDirectory: 'work' }, /workingDirectory must be an absolute/],
    ['an empty user', { userId: ' ' }, /userId/],
    ['a restart interval under a minute', { restartOnFailure: { intervalMinutes: 0, count: 3 } }, /intervalMinutes/],
    ['a fractional restart interval', { restartOnFailure: { intervalMinutes: 1.5, count: 3 } }, /intervalMinutes/],
    ['no restarts', { restartOnFailure: { intervalMinutes: 1, count: 0 } }, /count/],
    ['too many restarts', { restartOnFailure: { intervalMinutes: 1, count: 1000 } }, /count/],
    ['a control character in the description', { description: 'a\u0001b' }, /control character/],
    ['a NUL in an argument', { args: ['a\0b'] }, /NUL/],
  ] satisfies [string, Partial<TaskDefinitionInput>, RegExp][])('rejects %s', (_name, patch, message) => {
    expect(() => buildTaskXml({ ...INPUT, ...patch })).toThrow(message);
  });
});

describe('escapeXml', () => {
  it('escapes & < > and keeps quotes, tab and newline', () => {
    expect(escapeXml('&<>"\'\t\n')).toBe('&amp;&lt;&gt;"\'\t\n');
  });
});

describe('encodeTaskXml / decodeTaskXml', () => {
  it('writes UTF-16 LE with a BOM and reads it back', () => {
    const xml = buildTaskXml({ ...INPUT, description: '日本語 😀' });
    const bytes = encodeTaskXml(xml);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(decodeTaskXml(bytes)).toBe(xml);
  });

  it('refuses bytes without the BOM', () => {
    expect(() => decodeTaskXml(Buffer.from('<Task/>', 'utf-8'))).toThrow(/UTF-16/);
  });
});
