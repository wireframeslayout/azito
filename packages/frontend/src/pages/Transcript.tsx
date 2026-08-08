import { useSearchParams } from 'react-router-dom';
import ConversationView from '../components/transcript/ConversationView';
import SessionListView from '../components/transcript/SessionListView';

/**
 * Claude Code セッショントランスクリプトのチャットビュー。
 * `?session=<id>` で会話ビューを直接開ける（共有リンク用）。一覧⇄会話の切り替えは
 * このページ内の状態（URLクエリ）で行い、グローバルページの「戻る」導線は変更しない。
 */
export default function Transcript() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get('session');

  const selectSession = (id: string) => {
    setSearchParams({ session: id });
  };

  const backToList = () => {
    setSearchParams({}, { replace: false });
  };

  if (sessionId) {
    return <ConversationView sessionId={sessionId} onBack={backToList} />;
  }

  return <SessionListView onSelect={selectSession} />;
}
