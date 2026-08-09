import { useSearchParams } from 'react-router-dom';
import ConversationView from '../components/transcript/ConversationView';
import SessionListView from '../components/transcript/SessionListView';

const DEFAULT_AGENT_TYPE = 'claude';

/**
 * Claude Code / Codex セッショントランスクリプトのチャットビュー。
 * `?session=<id>&agent=<type>` で会話ビューを直接開ける（共有リンク用）。`agent` を省略した
 * 既存の直リンクは claude として扱う（Issue #69 Phase B より前のリンクとの後方互換）。
 * 一覧⇄会話の切り替えはこのページ内の状態（URLクエリ）で行い、グローバルページの「戻る」導線は変更しない。
 */
export default function Transcript() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get('session');
  const agentType = searchParams.get('agent') ?? DEFAULT_AGENT_TYPE;

  const selectSession = (id: string, agent: string) => {
    setSearchParams({ session: id, agent });
  };

  const backToList = () => {
    setSearchParams({}, { replace: false });
  };

  if (sessionId) {
    return <ConversationView sessionId={sessionId} agentType={agentType} onBack={backToList} />;
  }

  return <SessionListView onSelect={selectSession} />;
}
