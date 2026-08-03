import { useCallback, useState } from 'react';
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
  const { showToast } = useToast();

  const openEditModal = useCallback((srv: Server) => {
    setEditServer(srv);
    setEditType('agent');
    setEditHost(srv.host ?? '');
    setEditPort(String(srv.agentPort ?? '3002'));
    setEditToken('');
    setEditMuxRuntime(srv.muxRuntime ?? 'system');
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
    }
    const res = await api<{ error?: string }>(`/servers/${encodeURIComponent(editServer.name)}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
    if (res.error) { showToast(res.error); return false; }
    setEditServer(null);
    return true;
  }, [editServer, editType, editHost, editPort, editToken, editMuxRuntime, showToast]);

  return {
    editServer, setEditServer,
    editType, setEditType,
    editHost, setEditHost,
    editPort, setEditPort,
    editToken, setEditToken,
    editMuxRuntime, setEditMuxRuntime,
    openEditModal,
    handleEditServer,
  };
}
