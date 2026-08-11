import { useEffect, useState } from 'react';

/**
 * SP チップ行の常設化（Issue #69 T8b）: `Layout` がマウントする常設スロット
 * （`workspace`/グローバルページどちらの表示中も残る、Layout の DOM ツリー上位）の
 * id。`Workspace`（チップ行＋タブスイッチャーシート）と `WorkspaceLayout`（≡ ナビ
 * シート）はこのフックでそのノードを取得し、`createPortal` で描画先を切り替える —
 * Layout がグローバルページ表示中に `Workspace` 自身のサブツリーを display:none で
 * 隠しても、ポータル先はその外側にあるため隠れない。
 */
export const MOBILE_SHELL_SLOT_ID = 'mobile-shell-slot';

export function useMobileShellPortalNode(): HTMLElement | null {
  const [node, setNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setNode(document.getElementById(MOBILE_SHELL_SLOT_ID));
  }, []);

  return node;
}
