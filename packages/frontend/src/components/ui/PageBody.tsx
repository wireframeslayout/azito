import type { CSSProperties, ReactNode } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';

interface PageBodyProps {
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * PageHeaderと対になる一覧ページのコンテンツ領域。
 * 水平paddingをPageHeaderと一致させ（PC 20px / SP 12px）、タイトル左端とリストカード左端を揃える。
 * 利用側はPageContainerに `padding: 0` を指定し、PageHeader + PageBody を並べる。
 */
export function PageBody({ style, children }: PageBodyProps) {
  const isMobile = useIsMobile();
  return (
    <div style={{ padding: isMobile ? '0 12px 24px' : '0 20px 24px', ...style }}>
      {children}
    </div>
  );
}
