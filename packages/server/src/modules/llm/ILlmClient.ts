/**
 * 内部分析用(ペイン分類・計画抽出・オーケストレーション判断など)に使う LLM 実行クライアントの抽象。
 * 具象実装は CodexExecClient(codex exec CLI 経由)。
 */
export interface ILlmClient {
  exec(prompt: string): Promise<string>;
}
