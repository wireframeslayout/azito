import type { MisaoServiceManager } from './MisaoServiceController';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface MisaoUnitInput {
  /** The bundled `deploy/azito-misao.service` or `deploy/com.azito.misao.plist`. */
  template: string;
  manager: MisaoServiceManager;
  /** `<prefix>/misao/...` holds the daemon; absolute, no characters a unit file would reinterpret (see resolveMisaoPaths). */
  prefix: string;
  /** Absolute path of the node that runs the daemon: the hub's bundled node, or the node an agent runs on. */
  node: string;
  /** PATH the daemon's panes see (see buildServicePath). */
  servicePath: string;
}

/**
 * Fills the bundled service template in. One renderer for the hub's own service and for the one installed on an agent
 * server, so the two can never drift apart. systemd treats `%` as a specifier and a plist is XML, so values are escaped
 * for the format they land in.
 */
export function renderMisaoUnit({ template, manager, prefix, node, servicePath }: MisaoUnitInput): string {
  const escape = (value: string): string => (manager === 'launchd' ? xmlEscape(value) : value.replace(/%/g, '%%'));
  return template
    .replaceAll('__NODE__', escape(node))
    .replaceAll('__AZITO_PREFIX__', prefix)
    .replaceAll('__PATH__', escape(servicePath));
}
