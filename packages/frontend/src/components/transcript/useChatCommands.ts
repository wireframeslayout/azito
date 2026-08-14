import { useEffect, useState } from 'react';
import { apiWithStatus } from '../../api/client';
import type { ChatCommand } from './chatCommands';

interface ChatCommandsResponse {
  commands: ChatCommand[];
}

/**
 * agentType が判明したウィンドウについて、そのエージェント向けのチャットコマンド定義を1回取得する
 * （Issue #338 フェーズC）。ウィンドウ切り替え（agentType 変化）のたびに再取得する。取得エラー時は
 * 空配列を返す — コマンドパレットが単に出ないだけで、送信機能そのものは損なわれない。
 */
export function useChatCommands(agentType: string | undefined): ChatCommand[] {
  const [commands, setCommands] = useState<ChatCommand[]>([]);

  useEffect(() => {
    if (!agentType) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    apiWithStatus<ChatCommandsResponse>(`/chat-commands?worker_type=${encodeURIComponent(agentType)}`)
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status !== 200) {
          setCommands([]);
          return;
        }
        setCommands(body.commands);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentType]);

  return commands;
}
