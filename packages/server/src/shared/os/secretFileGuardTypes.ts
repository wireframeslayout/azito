/** `inspect` の結果。ok=false のときは、何が違うか（summary）と直し方（fix）を返す。 */
export type SecretFileInspection =
  | { ok: true }
  | { ok: false; summary: string; fix: string };

export type SecretPathKind = 'file' | 'dir';

/**
 * ハブ自身のマシンにある秘密ファイル（master.key・トークン・.env・DB など）を「所有者だけ」に保つ方針。
 * OS ごとに実装が違う（Unix は mode 600 / 700、Windows は現在のユーザーだけを許可する保護 DACL）。
 * 作成（書き込み・修復）と検査（auth doctor）が同じ方針を使うよう、両方をここに置く。
 * プロセスの入口で `createSecretFileGuard(hostEnv.platform)` から 1 つ作って渡す（共有コードで process.platform は読まない）。
 */
export interface SecretFileGuard {
  /** 検査の表示用: `operator.env の${policyDescription}` の形で使う（Unix は「パーミッションが 0600」）。 */
  readonly policyDescription: string;
  /** ディレクトリを作り（無ければ）、所有者だけにする。既存のディレクトリも同じ方針に直す。 */
  ensureProtectedDir(dir: string): void;
  /**
   * 秘密の中身を書く（新規・置き換え）。中身を書く前に保護を済ませる。保護できなければ中身を書かずに投げる。
   * 親ディレクトリが無ければ作る（Windows では、そのとき作ったディレクトリも保護する）。
   */
  writeSecretFile(filePath: string, content: string): void;
  /** 追記する。ファイルが無ければ、保護した空ファイルを作ってから書く。 */
  appendSecretFile(filePath: string, content: string): void;
  /** 既存のファイルを所有者だけにする。失敗は投げる（無いファイルも投げる）。 */
  protectFile(filePath: string): void;
  /**
   * 起動時の修復: 既存のファイルが緩ければ直す。無いファイルは何もしない。
   * Unix は従来どおり chmod の失敗を握る（他人所有のファイルなどでも起動を止めない。緩さは auth doctor が報告する）。
   * Windows は修復に失敗したら投げる。
   */
  repairFile(filePath: string): void;
  /** 方針どおりかを確かめる（auth doctor 用）。存在しないパスは呼び出し側で先に除く。 */
  inspect(targetPath: string, kind: SecretPathKind): SecretFileInspection;
}
