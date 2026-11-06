# macOS・Linux のエージェントサーバー

Linux x64 / arm64 と、arm64 Node を使う Apple Silicon Mac に、SSH 経由で agent を導入できます。Intel Mac と Rosetta 上の x64 Node は対象外です。Windows については [Windows のエージェントサーバー](./windows-agent.md) を参照してください。

## 準備と追加

対象ユーザーのログインシェルから Node.js 24 以上と Tailscale を使えるようにします。macOS では Tailscale アプリ内の CLI も探索します。misao が使える場合、tmux は任意です。通常の AZITO の手順で SSH 接続を準備し、**Servers → Add → Agent** で SSH ホストを指定します。導入前の確認で不足するコマンドと Node のアーキテクチャを表示します。

単一の agent 配布物に Linux x64 / arm64 と macOS のネイティブモジュールが入ります。ソース版のハブ（Linux x64）で `AZITO_AGENT_NODE_PTY_LINUX_ARM64` を設定していない場合は arm64 を含まない配布物を作り、Linux arm64 ホストへの導入と更新は理由を示して断ります。arm64 にも導入するときは、Linux arm64 でビルドした node-pty フォルダーを指定してハブを再起動してください。misao はホストに合うバイナリを別途導入します。agent の更新では misao を停止しません。misao の明示的な更新ではペインが閉じることがあります。

## サービスと制限

Linux では可能ならユーザー systemd、それ以外ではバックグラウンドプロセスを使います。macOS の agent は GUI とは別の `user/<uid>` の Background launchd ジョブです。このユーザードメインが必要で、再起動後はユーザーのログインを待つ場合があります。バックグラウンドドメインが利用可能な間は、GUI からのログアウト自体ではジョブは停止しません。ハブの停止中も agent と misao は動作できますが、ホストとユーザードメインの状態に依存します。Mac の misao は独立したバックグラウンドプロセスで、今回新たな自動再起動は設けていません。

Apple Silicon Mac の agent はサーバー行から削除できます。管理対象ジョブとインストール ID を確認してから agent を停止・削除します。ホストから削除した agent は、ハブの起動時の復旧でも再び起動しません。Intel Mac の agent は更新とホストからの削除の対象外です。misao の削除を指定しても所有権を確認できない場合はスキップとして理由を返し、misao を残します。Linux ホストからの削除は未対応です。サーバー行の削除はハブの登録だけを消します。

## トラブルシューティング

事前確認で Node や Tailscale が見つからない場合は、対象ユーザーのログインシェルの PATH と初期化ファイルを確認してください。Apple Silicon では Rosetta の有無にかかわらず arm64 Node を使います。tmux がない場合は misao の導入が必要です。launchd の起動に失敗した場合は `user/<uid>` の存在と `~/.azito/agent/agent.log` を確認してください。定義を確認できないジョブは変更しません。所有者を確認してから再試行してください。再起動・ログアウト・復旧の実際の動作は対象環境で確認してください。
