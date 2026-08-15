import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Server } from './useServerManagement';
import { useToast } from './useToast';

// ServerDetailPage の編集モーダル専用フック。useServerManagement は全サーバーの
// セッション取得 + 60sポーリング + イベント購読を伴うため、編集フォーム状態と
// PUT /api/servers/:name 送信だけが必要なこの画面では使わない（不要な購読を避ける）。
export function useServerEditForm() {
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [editType, setEditType] = useState<'agent'>('agent');
  const [editHost, setEditHost] = useState('');
  const [editPort, setEditPort] = useState('3002');
  const [editToken, setEditToken] = useState('');
  const [editMuxRuntime, setEditMuxRuntime] = useState<'system' | 'managed'>('system');
  // Issue #29 review (3rd pass), Important finding 4: isolationIntent had no
  // UI — the only way to declare a server isolated was a raw PUT. Mirrors
  // the other edit* fields: seeded from the server row on open, sent back
  // unconditionally for agent-type servers (the no-op-preserving guard lives
  // server-side in routes.ts, see Important finding 2).
  const [editIsolationIntent, setEditIsolationIntent] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation('servers');

  const openEditModal = useCallback((srv: Server) => {
    setEditServer(srv);
    setEditType('agent');
    setEditHost(srv.host ?? '');
    setEditPort(String(srv.agentPort ?? '3002'));
    setEditToken('');
    setEditMuxRuntime(srv.muxRuntime ?? 'system');
    setEditIsolationIntent(srv.isolationIntent ?? false);
  }, []);

  // 成功時のみ true を返す。呼び出し元はこれを見て、バリデーション失敗/APIエラー時に
  // refresh を走らせないようにする。
  const handleEditServer = useCallback(async (): Promise<boolean> => {
    if (!editServer) return false;
    if (!editHost.trim()) { showToast('Host is required'); return false; }
    if (editType === 'agent') {
      if (!editPort.trim()) { showToast('Port is required'); return false; }
    }
    const body: Record<string, unknown> = {
      type: editType,
      host: editHost.trim(),
      muxRuntime: editMuxRuntime,
    };
    if (editType === 'agent') {
      body.agentPort = parseInt(editPort.trim(), 10);
      if (editToken.trim()) {
        body.agentToken = editToken.trim();
      }
      body.isolationIntent = editIsolationIntent;
    }
    const res = await api<{ error?: string; windowCount?: number; isolationCleanup?: 'done' | 'failed' | 'skipped' }>(`/servers/${encodeURIComponent(editServer.name)}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
    if (res.error) {
      // Issue #29 review, Critical finding 1: the false->true isolation gate
      // (routes.ts) rejects with this error code + windowCount when windows
      // may already hold injected credentials — translate it into a
      // localized, count-bearing toast rather than showing the raw code.
      if (res.error === 'isolation_intent_blocked_by_windows') {
        showToast(t('overview.isolationBlockedByWindowsToast', { count: res.windowCount ?? 0 }));
      } else {
        showToast(res.error);
      }
      return false;
    }
    // Issue #29 review (3rd pass), Important finding 4: a false->true
    // transition attempts a synchronous cleanup of any previously-distributed
    // operator token server-side (routes.ts attemptIsolationCleanup) — surface
    // a non-'done' outcome immediately via toast, in addition to the existing
    // OverviewSection Notice the next isolationReport fetch will pick up.
    if (res.isolationCleanup === 'failed') showToast(t('overview.isolationCleanupToastFailed'));
    else if (res.isolationCleanup === 'skipped') showToast(t('overview.isolationCleanupToastSkipped'));
    setEditServer(null);
    return true;
  }, [editServer, editType, editHost, editPort, editToken, editMuxRuntime, editIsolationIntent, showToast, t]);

  return {
    editServer, setEditServer,
    editType, setEditType,
    editHost, setEditHost,
    editPort, setEditPort,
    editToken, setEditToken,
    editMuxRuntime, setEditMuxRuntime,
    editIsolationIntent, setEditIsolationIntent,
    openEditModal,
    handleEditServer,
  };
}
