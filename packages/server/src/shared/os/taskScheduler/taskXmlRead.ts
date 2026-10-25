const XML_ENTITY = /&(lt|gt|quot|apos|amp);/g;
const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** A task definition (the XML the Task Scheduler exports) with its five predefined entities replaced, so that a path or an argument can be looked for in it as written. */
export function unescapeTaskXml(xml: string): string {
  return xml.replace(XML_ENTITY, (_, name: string) => XML_ENTITIES[name]!);
}

/** One `<Exec>` action of a task definition, entities replaced. */
export interface TaskExecAction {
  command: string;
  /** The `<Arguments>` command line as written (one string). */
  argumentsLine: string;
}

/** The program actions a task definition runs. Only these say what the task starts: its description and other text are not looked at. */
export function taskExecActions(xml: string): TaskExecAction[] {
  const tag = (block: string, name: string): string => unescapeTaskXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? '');
  return [...xml.matchAll(/<Exec>([\s\S]*?)<\/Exec>/g)].map((m) => ({ command: tag(m[1]!, 'Command'), argumentsLine: tag(m[1]!, 'Arguments') }));
}

/**
 * The program action of a task that has exactly ONE action and that action is an `<Exec>`; undefined for anything else. A task's
 * `<Actions>` can hold `<Exec>`, `<ComHandler>`, `<SendEmail>` and `<ShowMessage>` together: a task that does something besides the
 * program it is known by (or whose actions cannot be read as plain elements) is not read as that program's.
 */
export function soleExecAction(xml: string): TaskExecAction | undefined {
  const inner = /<Actions\b[^>]*>([\s\S]*?)<\/Actions>/.exec(xml)?.[1];
  if (inner === undefined) return undefined;
  const kinds: string[] = [];
  const rest = inner.replace(/<(Exec|ComHandler|SendEmail|ShowMessage)\b[^>]*>[\s\S]*?<\/\1>/g, (_, kind: string) => { kinds.push(kind); return ''; });
  if (rest.trim() !== '' || kinds.length !== 1 || kinds[0] !== 'Exec') return undefined;
  return taskExecActions(inner)[0];
}

/** The quote characters PowerShell reads as a single quote, which `powershellDialect.quote` doubles (the same set as the writer's). */
const QUOTE_CHARS = "'‘’‚‛";
const HUB_ROOT_LINE = new RegExp(`^\\$hubRoot = '((?:[^${QUOTE_CHARS}]|([${QUOTE_CHARS}])\\2)*)'\\r?$`, 'm');

/** The hub's `<prefix>\hub` folder, from the launcher script of the hub's task (its `$hubRoot = '...'` line, quotes undoubled); undefined when the script has no such line. */
export function hubRootOfScript(script: string): string | undefined {
  const hubRoot = HUB_ROOT_LINE.exec(script)?.[1];
  return hubRoot?.replace(new RegExp(`([${QUOTE_CHARS}])\\1`, 'g'), '$1');
}

/**
 * The folder a misao task starts the daemon in (its `--data` folder), read from the task definition: from the launcher script
 * (`AZITO_MISAO_ROOT`, a PowerShell literal where `'` is doubled) or from the plain command line (`--data "<root>"`). Undefined when
 * the definition has neither (not a misao task this code wrote).
 */
export function taskMisaoRoot(xml: string): string | undefined {
  return misaoRootOfCommandLine(unescapeTaskXml(xml));
}

/** {@link taskMisaoRoot} for text that is already unescaped (the `<Arguments>` lines of the task's actions, from {@link taskExecActions}). */
export function misaoRootOfCommandLine(decoded: string): string | undefined {
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(decoded)?.[1];
  if (encoded) {
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    const literal = /\$info\.EnvironmentVariables\['AZITO_MISAO_ROOT'\] = '((?:[^']|'')*)'/.exec(script)?.[1];
    return literal?.replace(/''/g, "'");
  }
  return /--data "([^"]*)"/.exec(decoded)?.[1];
}
