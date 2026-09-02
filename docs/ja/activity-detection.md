# 稼働検知 Tier 判定リファレンス

AZITO がエージェントウィンドウの「稼働中 / ブロック中 / 非稼働」をどう判定しているかの全仕様です。
5層の観測ソースと優先順位、停止理由（reason）、タイミング定数、診断パネルの読み方、
質問（AskUserQuestion）のライフサイクル、サーバータイプ別の対応範囲を扱います。

判定の中核は `packages/server/src/modules/operations/AgentActivityMonitor.ts` です。
以下に挙げる定数名はすべて実装のものと一致します。

## 1. 全体像 -- 優先順位ラダー

`AgentActivityMonitor` が **5秒ごと**にウィンドウ（キー = `serverName::target`、ペインサフィックス
正規化済み）を評価します。各キーは上から順に問い合わされ、**最初に判定を下した層で確定**します。
これにより「上位層の idle を下位層の working が上書きする」ことは構造的に起こりません。

```
Tier 0  tui-supervisor（イベント駆動・最優先）
        エージェントを包む PTY ラッパーが WebSocket で active / idle / exit を直接報告。
        反映 〜1秒。接続中のキーでは下位層を完全にバイパス
   |  未接続 / フレーム未受信なら
   v
Tier 1  Claude Code hooks（イベント駆動）
        UserPromptSubmit で start、Stop で stop を webhook 送信。反映 即時。
        クラッシュ時は「前面が素のシェルに戻った」ことで失効
   |  シグナルが無ければ
   v
Tier 2  ペイン分類（ポーリング・タイトル/画面規則）
        ペインタイトルのグリフ（◐◑◒◓ = 稼働 / ✳ = idle）と画面末尾の文言
        （"esc to interrupt" = 稼働、許可プロンプト = ブロック）で分類。反映 〜5秒
   |  分類不能（unknown）なら
   v
Tier 3  活動量ヒューリスティック（ポーリング）
        tmux の window_activity が 30秒以内に進み、かつ前面コマンドが素のシェルでないこと。
        開始はデバウンス付き
   |  それでも判定できなければ
   v
Tier 4  プロセス実在＋セッショントランスクリプト（バックグラウンドプローブ）
        ps ツリーで claude/codex を検出し、セッション JSONL の末尾を分類。
        supervisor も hooks も無い手動起動ペインの受け皿。working のみの加算的判定
```

### 3つの特例

| 特例 | 内容 |
|---|---|
| 実行ラン（タスク実行） | 実行中として登録されたランは検知なしで稼働扱い（登録 = 稼働）。supervisor が付いていればその active/idle がこれを精緻化する |
| 純 supervisor エントリ | `windows` テーブルに行が無くても、supervisor が接続していればそれ自体を根拠に稼働スナップショットへ載る（例: `azs claude` の手動ペイン） |
| blocked 精緻化 | Tier 0 が idle を報告したキー（および Tier 2 が idle タイトルを分類したキー）に限り、画面規則で「応答待ちプロンプト」（AskUserQuestion の選択画面等）を追加確認し、該当すれば **blocked** に精緻化する。blocked の間は completed 遷移を発行せず、解消時に初めて完了扱い。**working への昇格は行わない**（ラダー不変条件の維持） |

blocked 精緻化が必要な理由は、supervisor がタイトルしか見えないためです。Claude Code は
AskUserQuestion を表示中もタイトルの idle グリフ（`✳ `）を維持するため、タイトルだけを見る
supervisor は idle を報告します。

## 2. Tier 0 -- supervisor（リアルタイム主系）

`tui-supervisor` はエージェントの PTY を包んで起動し、ハブへ永続 WebSocket（`/ws/supervisor`）で
接続します（10秒ハートビート、切断時は指数バックオフで無期限再接続）。

### supervisor 内部の判定

| 判定器 | 内容 |
|---|---|
| タイトル追跡 | PTY 出力中の OSC 0/2 タイトルを解析。**認識済みマーカー**（稼働 `⠀-⣿ ◐◑◒◓ ✻✶✽✢∗` / idle `✳ ` / `Action Required`）を**一度観測した後のみ**タイトル権威モードに移行。1チャンク内の全タイトルを累積判定（チャンク境界に非依存） |
| バイト量追跡 | 3秒窓の出力バイト量で active/idle を判定。タイトル権威モード移行前（未認識タイトルのみの generic TUI 等）はこちらが有効なまま |
| 送信 | 状態**遷移時**に activity フレームを送信＋active 中は15秒ごとに再送（keepalive）。子プロセス終了は `child_exit` として明示送信 |

### ハブ側の扱い

接続中の supervisor が報告した状態は**そのキーの正**であり、Tier 1〜4 は照会されません。
状態の消滅は `child_exit` / WS 切断のみ（推測による失効なし）。稼働開始の反映は実測 **約1秒**です。

診断上、Tier 0 判定には「そのシグナルを受信した時刻」（`evidenceAt`）が紐付きます。supervisor が
再接続してまだフレームを送っていない間は、古い接続の判定を「Tier 0 生存」として表示しません
（判定なし・フレーム待ちに降格）。

### 子プロセスへの TMUX / TMUX_PANE 再エクスポート

`PtyProxy` は子コマンドを `$SHELL -lc` で起動します（PATH 解決のためログインシェルは必須）。
しかしログインプロファイルの処理で `TMUX` / `TMUX_PANE` が失われることがあり、Claude Code の
hooks（`azito-activity` / `azito-interaction` / `azito-notify` / `azito-question`）はいずれも
`TMUX_PANE` が空だと早期 exit するため、supervisor でラップした全ウィンドウで Tier 1 シグナル・
回答待ちバナー・完了通知が沈黙していました。

現在は `buildLoginShellCommand()`（`packages/tui-supervisor/src/PtyProxy.ts`）が、値が存在する
場合のみコマンド文字列の先頭で両変数を再エクスポートします。プロファイル評価の後に実行される
ため確実に復元されます。tmux 外での起動時は何も注入しません。

### Combined mode（ハイブリッド判定）

Claude Code v2.1.236 以降、tmux 配下ではペインタイトルが「文言変化時のみ書き込み」に変更された
（CHANGELOG: "Fixed terminal tab titles jumping in tmux"）。結果、作業中スピナーグリフ
（◐◑◒◓ 等）がタイトルに出現しなくなり、タイトルは常に `✳ <topic>` で固定される。

`ActivityTracker` はこの状況に対応するため、2つの判定モードを持つ:

| モード | 進入条件 | 判定方式 |
|--------|---------|---------|
| **title-authoritative** | `working` または `blocked` タイトルを一度でも観測 | タイトルのみ（バイト量無効）。codex / claude ≤2.1.234 がここに入る |
| **combined** | 上記以外（初期状態含む） | バイト量ヒューリスティック + タイトル昇格。claude ≥2.1.236 on tmux がここに入る |

Combined mode では:

- バイト量ヒューリスティックで idle/active を判定する
- エコー緩和: **当該 tick に新規出力がある**閾値超過が `ACTIVE_CONSECUTIVE_TICKS`（2）tick 連続
  した場合のみ idle→active に遷移する（単発のキーストロークエコーでは遷移しない）
- `working` / `blocked` タイトルが観測された瞬間に title-authoritative mode に昇格する
- Combined mode で emit される active frame には `status` を付けない（バイト由来であることを
  ハブが区別可能）

| 定数 | 値 | 説明 |
|------|---|------|
| `ACTIVE_CONSECUTIVE_TICKS` | 2 | idle→active 遷移に必要な連続閾値超過 tick 数（新規出力ありの tick のみカウント） |

### 登録時のスナップショット frame

`HubClient` は `registered` メッセージ受信時に `ActivityTracker` の現在状態をスナップショット
として activity frame を1枚送信する（`ready` 再送と同じ位置）。これにより、登録前に発生した
状態遷移が失われても、接続直後にハブが最新状態を認識できる。再接続時も同様に発火する。

## 3. Tier 1 -- Claude Code hooks

| 要素 | 内容 |
|---|---|
| シグナル | `UserPromptSubmit` フック → `start`、`Stop` フック → `stop` を `POST /api/webhooks/agent-activity` へ（共有 `AZITO_WEBHOOK_TOKEN`） |
| キー解決 | tmux の `#{?session_grouped,#{session_group},#{session_name}}` -- ブラウザタブ用リンクドセッション（`_azito_*`）経由でも正典セッション名で `windows` テーブルと突合。一致した**全ウィンドウ行**に反映 |
| 効果 | 該当キーの Tier 2/3 をバイパスして即時に状態を反転 |
| 失効 | クラッシュフェイルセーフ: Stop を受けないまま前面ペインが素のシェルに戻ったら解除。ウィンドウ消滅でも解除 |
| 前提 | 各サーバーで `harness/setup.sh` による配線が必要。未配線環境では発火しない（下位層が受け持つ） |

### 宛先プロファイルの原子的解決（AZITO_PREFIX 規約）

`AZITO_URL` / `AZITO_WEBHOOK_TOKEN` / `AZITO_SERVER_NAME` の3変数は、**常に単一のプロファイルと
してまとめて解決**されます。変数単位のマージは行いません。

| ルール | 条件 | 動作 |
|---|---|---|
| 1 | 3変数がすべて環境に存在する | その一式をそのまま使う（env ファイルは読まない） |
| 2 | それ以外 | 環境にある部分的な値をすべて破棄し、`AZITO_PREFIX` で選ばれた env ファイル（`~/.azito/azitoctl[-<prefix>].env`、mode 600）から一式を読む |

ルール2が「隙間を埋める」のではなく「捨てる」のは、ハブが作成する全 tmux セッション/ウィンドウへ
`AZITO_URL` を注入するため「URL だけある」状態が常態だからです。部分プロファイルを採用すると、
env ファイルの**別ハブのトークン**を注入された URL へ送ってしまいます（認証失敗であると同時に
資格情報の漏洩）。

したがって宛先の切り替えは個別変数の上書きではなく **`AZITO_PREFIX` のみ**で行います。
`harness/setup.sh --prefix <name> ...` がその env ファイルを書き、settings.json の hook コマンドへ
`AZITO_PREFIX` だけを埋め込みます。トークンは `curl --config -`（stdin）経由で渡され、argv には
現れません。

解決後、`AZITO_WEBHOOK_TOKEN` または `AZITO_SERVER_NAME` が空なら hook は何もせず exit 0 します。

対象スクリプト: `harness/hooks/azito-activity.sh`、`azito-interaction.sh`、`azito-question.sh`。

## 4. Tier 2 -- ペイン分類（タイトル/画面）

5秒ポーリングでペインタイトルと画面末尾を規則分類します（`paneStateClassifier.ts`）。
先勝ちの規則リストで、supervisor 側のタイトル追跡と**同一のグリフ集合**を使います
（変更時は `packages/tui-supervisor/src/TitleStateTracker.ts` の `WORKING_SPINNER_RE` も
更新する規約）。

| エージェント | 規則（上から先勝ち） |
|---|---|
| claude | 画面に選択/確認プロンプト（"enter to select" ＋ "esc to cancel"、"do you want to proceed?"）→ **blocked** ／ タイトル先頭が稼働グリフ → working ／ `✳ ` → idle ／ 画面に "esc to interrupt" → working ／ プロンプト枠（`❯`）→ idle |
| codex | タイトルに "Action Required" → **blocked** ／ 稼働グリフ → working ／ 画面に確認文言（"allow command?"、"enter to submit"、"[y/n]" 等）→ blocked ／ 非空タイトルのみ → idle |

`claude` / `codex` 以外（`generic` 等）は常に `unknown` を返し、Tier 3 へ落ちます
（`CLASSIFIABLE_AGENT_TYPES`）。

### 画面確認の3値（blocked / not_blocked / unknown）

画面確認（`screenVerdict()`）の答えは3値です。`unknown` は「blocked でない」の同義語ではなく
**「見られなかった」**を意味します。

| 答え | 発生条件 |
|---|---|
| `blocked` | 画面規則が blocked に一致 |
| `not_blocked` | 画面を読めて、blocked ではなかった |
| `unknown` | `capture-pane` が失敗/非0終了、tmux スナップショット（`listSessions`）がそのサーバーで失敗、または分類規則を持たないエージェント種別 |

`unknown` のとき、そのキーは**直前 tick に公開していた状態を保持**します
（`heldStatusOnUnknown()`）。これは**保留であって昇格ではありません** -- 既に持っていた状態
（working か blocked）を維持するだけで、より良い状態にはなりません。かつ有界で、失敗が
**`UNKNOWN_HOLD_MS`（30秒）**続いたらその層本来の判定に戻ります。`unknownSince` は連続失敗の
**最初**の時刻で、後続の失敗ではリセットされません（成功でクリア）。

### 再キャプチャの抑制と並列度

`capture-pane` は往復コストが高いため、次のキャッシュ規則で回数を抑えます。

- 同一 tick 内の再問い合わせはキャッシュ値を返す
- 直前の答えが `not_blocked` で、かつ `window_activity` が前回成功時から進んでいなければ
  再キャプチャしない（再描画のないペインは繰り返し読まない）
- キャッシュ済みの `blocked` は**決して再利用しない** -- プロンプトが消えた瞬間を捉えることが
  目的であり、入力枠しか再描画しないペインは activity だけではキャッシュを無効化できないため
- `unknown` も再利用しない（毎 tick 読み直す）

キャプチャはラダー実行前に `prefetchScreenVerdicts()` でまとめて先読みし、**サーバー単位で最大
`SCREEN_CHECK_CONCURRENCY`（4）並列**で走らせます。逐次実行だと1 tick のコストが全ペインの往復の
合計になり、tick 間隔を超えて次の tick が落とされるためです。サーバー間は並列です。

## 5. Tier 3 -- 活動量ヒューリスティック

| 条件 | 内容 |
|---|---|
| 稼働 | tmux `window_activity` が **30秒以内**（`ACTIVITY_THRESHOLD_SEC`）に進んでいる、かつ前面ペインのコマンドが素のシェルでない（シェルでのキー入力エコーも activity を進めるための除外） |
| 開始デバウンス | 未確認キーは直近 `START_WINDOW_TICKS`（4 tick ≒ 20秒）の窓内で `START_CONFIRM_ADVANCES`（2回）の活動前進を集めて開始を確定 -- 一瞬の出力（ペインへのフォーカスによる再描画は activity をちょうど1回進める）で誤点灯しない |
| 停止 | 30秒間 activity が進まない、または前面が素のシェルに戻る |

デバウンスが「連続 N tick」ではなくスライド窓内の回数なのは、15秒おきにしか出力しない
バースト型のエージェントを取りこぼさないためです。

## 6. Tier 4 -- プロセス＋トランスクリプト（プローブ）

supervisor も hooks も無く、タイトルも活動量も語らないウィンドウの受け皿です。
**バックグラウンドで15秒ごと**にスナップショットを更新し、`collect()` はキャッシュを参照する
だけです（tick をブロックしない）。

| 段階 | 内容 |
|---|---|
| 1. プロセス実在 | サーバー単位で1回取得した `list-panes` / `ps` スナップショットから、ペインの子孫プロセスに claude/codex（basename）を探す。無ければ offline |
| 2. セッション解決 | ウィンドウの `agentSessionId`（未紐付けなら resolver の cwd 照合を低頻度・バックオフ付きで自動起動し、採用ガード付きで書き戻し） |
| 3. 末尾走査 | セッション JSONL の末尾をエスカレーション後方スキャンで走査し、`in_progress` / `terminal_final` / `terminal_interrupted` / `terminal_local` / `unknown` に分類（下記） |
| 4. 判定 | **working と判定するのは**: 末尾が `in_progress` かつ「最後の意味のあるエントリの timestamp」が **120秒以内**（`SESSION_ACTIVITY_WINDOW_MS`）のときのみ。`terminal_*` と unknown は working 根拠にならない（ファイル mtime は使わない -- resume 時の housekeeping 書き込みで誤点灯しないため） |
| 5. 完了合成 | `terminal_final` を観測したら completedAt を運び、どの tick も稼働を目撃できなかった短いターンでも **completed 遷移をサーバーが合成発行**（30秒受理窓、二重発行防止付き） |

### 末尾走査（エスカレーション後方スキャン）

実セッションの末尾は attachment（1件で数KB〜）や `ai-title` / `file-history-snapshot` といった
housekeeping レコードで埋まることが常態です。固定 16KB の単発窓では意味のあるエントリに届かず
`unknown` を返し、Tier 4 の working/completed 判定とチャットの回答待ちゲートが実セッションで
ほぼ常に沈黙していました（実測: 25KB のセッションで user 発話 627B の後ろに attachment 5件
約24KB）。

現在は `scanSessionTailState()`（`packages/server/src/modules/transcripts/sources/entryHelpers.ts`）が
段階的に窓を広げます。

| 項目 | 値 |
|---|---|
| 走査窓の段階（`TAIL_STATE_SCAN_WINDOWS`） | 16KB → 64KB → 256KB |
| エスカレーション条件 | その段階で意味のあるエントリが1件も得られなかった場合のみ |
| 打ち切り | 意味のあるエントリを発見 ／ 窓がファイル先頭に到達（`hasOlder === false`）／ 最大窓（256KB）を使い切って `unknown` |
| 読み取り総量の上限 | **672KB**（= 2 × (16+64+256)KB）。1段階あたり「改行探索のプローブ」＋「本読み」の最大2走査 |

各段階は前段の続きから遡るのではなく、常に EOF から一回り大きい窓を読み直します。
`readBeforeWindow` にはオーバーサイズ行の窓拡張（既定で要求サイズの最大8倍まで遡る）を止める
`maxExpandWindows: 1` を渡しており、これにより遡る深さは末尾から厳密に 256KB に収まります
（この抑止が無いと実測 1.7MB の同期読みが発生し得ました）。窓を埋め尽くす 256KB 超の単一
レコードはその段階で改行が見つからず、最終段階まで進んでも決着しないので `unknown` になります。

### 安全装置

1. Tier 4 は **working のみの加算的判定** -- idle/offline は Tier 3 へフォールスルーし、未紐付け
   ウィンドウで上位判定を沈黙させない
2. プローブ取得が失敗し続けた場合、**最終成功から60秒**（`PROCESS_PROBE_MAX_AGE_MS`）を超えた
   キャッシュは使わない（失敗は「新しい答えが無い」であって「何も動いていない」ではないが、
   古い答えで停止済みのエージェントを永久に点灯させてはならない）
3. 実行ラン終了直後のキーは「プローブが非稼働を観測するまで」Tier 4 を無効化（終了遷移の
   飲み込み防止）

## 7. 停止遷移の reason

稼働→停止の遷移イベントには**停止理由**が付きます。UI の「完了」行は `completed` のみから
生成されます（中断・削除・オフラインは完了扱いしない）。

| reason | 発生経路 | UI での扱い |
|---|---|---|
| `completed` | supervisor の active→idle ／ hook の Stop ／ Tier 2 の working→idle ／ Tier 4 の `terminal_final` 観測（合成含む） | 「完了」行を生成（60分 TTL、再完了で更新・未読化）。完了 push 通知 |
| `interrupted` | 末尾が中断マーカー（停止ボタン・Esc） | 完了行を作らない |
| `deleted` | tmux ウィンドウ消滅（live→gone のエッジで一度だけ）／ `windows` 行の削除 | 該当の完了行も即時除去 |
| `offline` | プロセス消滅・クラッシュフェイルセーフ・supervisor の `child_exit` / 切断 | 完了行を作らない |
| `unknown` | 活動が枯れた等、終端の証拠が無い停止 | 完了行を作らない |

`completed` / `interrupted` は鮮度ゲート（`COMPLETION_SYNTHESIS_MAX_AGE_MS` 以内の観測）を通った
場合のみ採用されます。

## 8. タイミング定数

| 定数 | 値 | 意味 |
|---|---|---|
| `POLL_INTERVAL_MS` | 5秒 | monitor の評価 tick（Tier 2/3 の反映粒度） |
| `START_CONFIRM_ADVANCES` | 2回 | Tier 3 の開始確定に必要な活動前進の回数 |
| `START_WINDOW_TICKS` | 4 tick（≒20秒） | 上記回数を数えるスライド窓の幅 |
| `UNKNOWN_HOLD_MS` | 30秒 | 画面確認が `unknown` の間、直前状態を保持できる上限 |
| `SCREEN_CHECK_CONCURRENCY` | 4 | `capture-pane` のサーバー単位の同時実行上限 |
| `PROCESS_PROBE_REFRESH_MS` | 15秒 | Tier 4 スナップショットの背景更新周期 |
| `PROCESS_PROBE_MAX_AGE_MS` | 60秒 | プローブ成功からこの時間を超えたキャッシュは判定に使わない |
| `ACTIVITY_THRESHOLD_SEC` | 30秒 | Tier 3 の活動鮮度窓（稼働の維持・停止判定） |
| `SESSION_ACTIVITY_WINDOW_MS` | 120秒 | Tier 4 の「最後の意味のあるエントリ」の鮮度窓 |
| `COMPLETION_SYNTHESIS_MAX_AGE_MS` | 30秒 | 合成 completed 遷移の受理窓 |
| `OPERATION_ATTRIBUTION_TTL_MS` | 90秒 | 実行ラン終了後、合成完了をそのランに帰属させる猶予 |
| `LAST_TRANSITION_TTL_MS` | 30分 | 診断パネル用に「最終遷移」を保持する期間（判定には未使用） |
| supervisor keepalive | 15秒 | active 中の activity フレーム再送（ハブ再起動後の状態回復） |
| 完了行 TTL | 60分 | フロント Provider が load 時・定期・保存時に一律 prune |

E2E では `AZITO_E2E_FAST_INTERVALS=1` が**観測周期のみ**（tick 1.5秒 / プローブ 3秒 /
キャッシュ TTL 2秒）を短縮します。判定閾値（`PROCESS_PROBE_MAX_AGE_MS` 60秒、`UNKNOWN_HOLD_MS`
30秒、`COMPLETION_SYNTHESIS_MAX_AGE_MS` 30秒、`SESSION_ACTIVITY_WINDOW_MS` 120秒）は本番と同一
です -- 閾値まで縮めると E2E が本番と異なる意味論を検証してしまうためです。

## 9. 診断パネルの読み方

Settings → System → **稼働検知診断**（3秒更新・読み取り専用、API は `GET /api/debug/activity`）。

| 表示 | 意味 |
|---|---|
| `tier0_supervisor` | 現在の supervisor 接続から受信したフレームがこの状態を決めている（証拠世代チェック済み）-- 「supervisor が実際に検知している」客観的根拠 |
| supervisor 列「フレーム未受信」 | 接続は生きているが activity フレームがまだ来ていない（旧ビルド supervisor／再接続直後）。判定は下位層が代行中 |
| `tier1_hook` 〜 `tier4_probe` | その層のフォールバックが判定した状態。`tier4_probe` 表示が多い場合は supervisor / hook の配線を確認 |
| `none`（稼働中） | 実行ラン登録による稼働（登録 = 稼働。検知層の判定ではない） |
| `refinedBy: tier2_title` | Tier 0 が idle と判定した行を Tier 2 の画面分類が blocked へ精緻化した印。`decidedBy` は判定した層のまま残る（「Tier 0 idle ＋ Tier 2 blocked」と読む） |
| 最終遷移 | 直近の遷移とその reason（§7）-- 「なぜ消えたか」の証跡 |

行の並びは state 順（working → blocked → idle → offline → none）です。
`evidenceAt` が無い、または supervisor の `connectedAt` より古い `tier0_supervisor` 行は、
フロント側で「未判定」に書き換えられます（`isStaleTier0`）。

### 表示条件ゲート

診断パネルは常時表示ではありません。開発者向けの内部情報のため、次の条件を満たす環境でのみ
UI 導線が現れます（`isDiagnosticsEnabled()`）。

```
diagnosticsEnabled = (deployMode === 'source') || (updateChannel === 'rc')
```

つまり**ソースチェックアウト**か **rc チャンネル**の環境に限られます。判定結果は
update-status 応答の `diagnosticsEnabled` に載り、フロントは**フェイルクローズ**
（未取得・取得失敗時は非表示）で扱います。API（`GET /api/debug/activity`）自体は無条件で、
ゲートされるのは UI 導線のみです。

### ステータスバー導線

Settings 画面へ移動しなくても、ステータスバーの「稼働検知」項目からフローティングの
ドロップダウンで開けます（Hub 項目とフォーカス中サーバー項目の間）。

| 要素 | 内容 |
|---|---|
| ドット | offline 以外の行が無い → 消灯 ／ イベント駆動層（`tier0_supervisor` / `tier1_hook`）で判定された行がある → アクセント ／ それ以外（フォールバック層のみ）→ 減光 |
| ポーリング | 開いている間 3秒、閉じている間 30秒 |
| 表示内容 | コンパクト表示。offline 行は隠して件数だけフッターに出す。「全件表示 →」で Settings の全件テーブルへ |
| 行クリック | 該当タスク／ターミナルを開く。通知センターのナビゲーション対応オープナーを使うため、ワークスペース外のグローバルページからでも遷移できる（行には `projectId` が含まれる） |

## 10. インタラクション（質問）ライフサイクル

エージェントが AskUserQuestion で応答待ちになったとき、チャットビューで質問カードを表示し、
選択肢をタップして回答できます。

```
PermissionRequest hook（azito-question.sh）
   |  質問文つきの open シグナル
   |                              Notification hook（azito-interaction.sh）
   |                                 |  質問文なしの open シグナル（約1分遅れ）
   v                                 v
POST /api/webhooks/agent-interaction  →  InteractionMonitor が pending 状態を開く
   |
   +--> 質問文あり: チャットに「質問カード（選択肢つき）」を表示
   +--> 質問文なし: チャットに「回答待ちバナー」を表示
   |
   |  （同時に Tier 2 の画面規則が同じペインを blocked と分類し、稼働表示は blocked のまま
   |    維持される。この間 completed 遷移は発行されない）
   v
選択肢タップ → POST /api/transcripts/window-signal { action: 'answer', openedAt, paneId }
   |  世代・ペイン・質問形の検証（consumePendingAnswer）を通れば数字キー1文字を送出
   |  通らなければ 409 で何も送らない（pending は消さない）
   v
送信済みカード（スピナー表示）のまま余韻で残る
   |  トランスクリプトに新しいレコードが現れて pending をクローズ
   v
チャットに answered（選択肢に ✓）／ declined のカードを正典として表示
```

チャットビューは約2秒間隔でポーリングし、`GET /api/transcripts/:agent/:id` の応答に載る
`pendingInteraction` / `pendingQuestion` からこの状態を導出します。

### 質問カードが出る条件

`pendingQuestion` は `pendingInteraction` のゲートの**内側**に入れ子になっており、カードが
バナーより広い条件で出ることはありません。

| ゲート | 条件 |
|---|---|
| ワーカー種別 | `workerType` プロファイルの `interactionSignal` が `none`（例: codex）ならモニターを参照せず `pendingInteraction: false` |
| pending 存在 | `InteractionMonitor.isPending(windowId)` |
| セッション末尾 | `getSessionTailState(sessionId).state === 'in_progress'`（§6 の末尾走査を使う。固定 16KB 窓だった頃このゲートがほぼ常に沈黙していた） |
| 回答可能な形 | 質問が1件、`multiSelect: false`、選択肢が1〜9件（`MAX_TAPPABLE_OPTIONS`）。それ以外はバナーに退化 |
| 送信失敗後 | その世代（`openedAt`）はカードを出さずバナーに退化する |

### 各段階の前提と規約

| 段階 | 内容 |
|---|---|
| PermissionRequest hook | `harness/hooks/azito-question.sh`。AskUserQuestion のピッカーが開いた瞬間に発火し（`bypassPermissions` 下でも発火）、stdin ペイロードの `tool_input`（`questions: [{question, header, multiSelect, options: [{label, description}]}]`）をそのまま転送する |
| 純粋な観測者であること | PermissionRequest hook は stdout に書いた内容で allow/deny を左右できてしまうため、この hook はどの経路でも stdout に**一切書かず**常に exit 0 する。AskUserQuestion 以外の permission request は何もせず即座に return |
| Notification hook | `azito-interaction.sh`。質問文は取得できず「回答待ちである」ことだけを報告する。約1分遅れて届く。どちらのシグナルも同じ pending 状態を開き、`InteractionMonitor` は**到着順に関わらず内容を持っていた方**を保持する |
| argv 非露出 | トークンも質問文も `curl` の argv に載せない（`ps` からローカルの全ユーザーに見える）。ペイロードは `--data-binary @-` で stdin から、トークンは `--config <(...)`（プロセス置換）から渡す。一時ファイルを残さず、トークンが別プロセスの引数になることもない |
| TMUX_PANE 前提 | hook はいずれも `TMUX_PANE` が空だと exit 0 する。supervisor 配下では §2 の再エクスポートがこの前提を満たす |
| 世代束縛 | 回答リクエストには表示していた質問の世代識別子 `openedAt` を添える。pending の `openedAt` と一致しなければ成立しない（古い質問カードへの回答が新しい質問へ流れ込まない） |
| ペイン束縛 | pending にはシグナル発火元の `paneIndex` を記録する。クライアントが指定した `paneId` はそのまま信用せず tmux のペイン index へ解決してから突合する -- 複数ペインのウィンドウでは、クライアントが名指しするペインがピッカーを開いているペインとは限らず、別ペインへ数字が飛べばそこで動いているプロンプトへ文字が混入する |
| 送出できるキー | 選択肢の並び順そのままの数字キー1文字（`1`〜`9`）のみ。単一選択（`multiSelect: false`）かつ質問が1件の AskUserQuestion に限る |
| 検証の原子性 | 世代・ペイン・質問形の検証はすべて消費と同じ1ステップ（`consumePendingAnswer`）で行い、成立しなかった場合は pending を消さない |
| pending のクローズ | ①セッションに新しいトランスクリプトレコードが現れた（正）②`cancel` シグナル（予約・呼び出し元なし）③10分のタイムアウト ④`windows` 行の消滅。状態はメモリのみで永続化しない（再起動で失われても最悪バナーの取りこぼしであり、古い状態が残ることはない） |
| 兄弟ウィンドウ行 | 同一 tmux ターゲットを指す `windows` 行は複数あり得る（プロジェクト所有行とタスク所有行）。1つのシグナルは一致した全行の pending を開き、クローズも全行を対称に閉じる |
| 内容の優先 | 質問文ありのシグナルは、到着順に関わらず質問文なしのシグナルに上書きされない（回答可能なカードがバナーへ退化しない） |
| 32KB ガード | 質問文を載せたペイロードが 32768 バイトを超える場合は `content` を落として送る（シグナル自体は失わずバナーへ退化） |
| declined | API のアクションではない。Esc による拒否（`User rejected tool use`）や CLI の自由入力による決着をトランスクリプトから導出して表示する。ターミナル側での操作が正典 |
| 回答0件の扱い | 採用できた文字列回答が0件（`answers` が空、または値がすべて非文字列）の `tool_result` は `answered` として扱わない。UI が ✓ も declined 注記も出せないため、interaction 化せず生の tool 行として表示する |

### 関連 API

| 用途 | エンドポイント |
|---|---|
| hook → サーバーのシグナル（質問文つき） | `POST /api/webhooks/agent-interaction`（Bearer は `AZITO_WEBHOOK_TOKEN`） |
| 質問の取得（ポーリング） | `GET /api/transcripts/:agent/:id?offset=&windowId=` → `{ ..., pendingInteraction, pendingQuestion? }` |
| 回答の送信 | `POST /api/transcripts/window-signal` body `{ windowId, paneId, action: 'answer', key: '1'..'9', openedAt }` |
| 拒否（declined） | 専用エンドポイントは無い（ターミナル側で操作し、トランスクリプト経由で反映される） |

`window-signal` の検証は 400（`Invalid windowId` / `Invalid paneId` / `Invalid action` / `Invalid key` /
`Invalid openedAt`）、404（`Window not found` / `Pane not found`）、409（`No pending question for this
request`）を返します。

## 11. サーバータイプ別の対応範囲

サーバータイプは `local` と `agent` の2種です（`ssh` はレガシー扱いで、migration 058 が
既存行を `ssh_disabled` へ書き換えます）。

| 機能 | local | agent（リモート） | 根拠 |
|---|---|---|---|
| Tier 0 supervisor | 対応 | 対応 | `shouldSupervise()` はサーバータイプを見ない（`windowType === 'agent'` のみで判定）。シグナルは supervisor プロセスから HTTP で届く |
| Tier 1 hooks | 対応 | 対応 | hook スクリプトがハブへ curl するだけで、サーバータイプのゲートは無い |
| Tier 2 ペイン分類 | 対応 | 対応 | `TmuxClient.listSessions` / `capturePane` がトランスポートを抽象化 |
| Tier 3 活動量 | 対応 | 対応 | 同上 |
| Tier 4 プローブ | 対応 | **非対応** | ローカルの `ps` と `~/.claude/projects` 等のセッション JSONL 直読みが必要。`WindowActivityStatusService` はローカルサーバーのウィンドウのみに絞り、`WindowSessionResolver.getActivityStatus()` は非ローカルで offline を返す |
| セッション解決 | 対応 | **非対応** | 非ローカルは解決ラダーごとスキップし `reason: 'unsupported_server'` を返す |
| トランスクリプト表示 | 対応 | **非対応** | トランスクリプトはローカルの `~/.claude/projects` 配下のみを走査するため、対応する tmux ペインも常にローカル |
| チャットの質問カード・回答 | 対応 | **実質非対応** | 経路自体にサーバータイプのゲートは無い（hook は任意のハブへ curl し、ペイン解決も `TmuxClient` 経由でリモートに届く）。ただしカード表示のゲートがセッション末尾状態を要求し、その読み取りがローカル限定のため、実質的にローカルサーバーでのみ成立する |

つまり**稼働検知そのものはリモート（agent 型）でも Tier 0〜3 で機能し**、Tier 4 と
チャット系（トランスクリプト表示・質問カード・チャット回答）はローカル限定です。
リモートの agent 型サーバーでは、supervisor（Tier 0）と hook（Tier 1）の配線が稼働検知の
精度をそのまま決めます。

> `WindowSessionResolver` のコメントにある「tier1 / tier2 / tier3」は*セッション解決*の優先順位
> （ウィンドウ紐付け / タスク紐付け / cwd 照合）を指し、本ドキュメントの稼働検知 Tier とは
> 別の番号体系です。

## 12. E2E カバレッジ

`npm run e2e`（完全隔離ハーネス・LLM 非依存の fake エージェント・実 UI 経由アサーション）が
以下を恒久的に固定します。

| シナリオ | 守っている性質 |
|---|---|
| Tier 0 リアルタイム | working タイトル → 3秒以内に稼働化、idle で消灯＋`completed` 完了行 |
| AskUserQuestion 待機 | 応答待ち画面は blocked として稼働し続け完了行を作らない → 解消で `completed` 完了行（blocked 精緻化） |
| 上位 idle の非上書き | 完了後にトランスクリプトを新鮮に保っても再点灯しない（ラダー保証） |
| リスポーン非点灯 | housekeeping のみのセッションでは稼働も完了も出ない |
| 中断非完了 | 中断マーカー終端では完了行が生成されない（reason=`interrupted`） |
| 削除プルーン | ウィンドウ削除で完了行が即時消える（reason=`deleted`） |
| チャット回答 | チャットの選択肢タップで AskUserQuestion に回答できる |
| スモーク | ログイン → プロジェクト作成 → ウィンドウ登録 → 一覧表示の基本導線 |

対応するスペック: `e2e/specs/activity.spec.ts`、`e2e/specs/question-answer.spec.ts`、
`e2e/specs/smoke.spec.ts`。
