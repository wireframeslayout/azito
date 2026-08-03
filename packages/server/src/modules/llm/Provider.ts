export type ProviderType = 'openai' | 'anthropic' | 'custom';

export interface LlmProvider {
  id: string;
  name: string;
  type: ProviderType;
  apiKey: string | null;
  baseUrl: string | null;
  createdAt: string;
}

export interface IProviderRepository {
  findAll(): LlmProvider[];
  findById(id: string): LlmProvider | null;
  create(data: Omit<LlmProvider, 'createdAt'>): void;
  update(id: string, data: Partial<LlmProvider>): void;
  delete(id: string): void;
}
