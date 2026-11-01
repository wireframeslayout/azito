import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import type { ContextBlock } from './groupToolBlocks';

export function ToolRunGroup({ blocks, children }: { blocks: ContextBlock[]; children: ReactNode }) {
  const { t } = useTranslation('transcript');
  const count = blocks.filter(({ block }) => block.kind === 'tool_use').length;
  const errors = blocks.filter(({ block }) => block.kind === 'tool_result' && block.isError).length;
  return <details className="tool-run"><summary><Icon name="terminal" size={16} /><span>{t('conversation.toolRun', { count })}</span>{errors > 0 && <span className="tool-run-errors">{t('conversation.toolRunErrors', { count: errors })}</span>}<span className="tool-run-chevron"><Icon name="chevron-right" size={16} /></span></summary>{children}</details>;
}
