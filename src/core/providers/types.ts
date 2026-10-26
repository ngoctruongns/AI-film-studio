export type ProviderId = 'claude-code' | 'anthropic' | 'openai' | 'openai-compatible' | 'gemini';

export interface ModelConfig {
  id: string;
  title?: string;
  provider: ProviderId;
  model?: string;
  apiBase?: string;
  secret?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
  /** USD / 1 triệu token */
  price?: { input?: number; output?: number };
  extraArgs?: string[];
}

export interface ChatRequest {
  model: ModelConfig;
  system: string;
  prompt: string;
  /** Thư mục làm việc (gốc dự án) — claude-code đọc CLAUDE.md ở đây */
  cwd: string;
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Chi phí do nhà cung cấp báo (true) hay tool tự ước tính (false) */
  costReported?: boolean;
}

export interface Provider {
  id: ProviderId;
  /** Provider tự nạp hướng dẫn dự án (CLAUDE.md) → ContextBuilder bỏ phần "lõi dự án" để đỡ token */
  loadsProjectInstructions: boolean;
  needsKey: boolean;
  complete(req: ChatRequest): Promise<ChatResult>;
}

export function estimateCost(m: ModelConfig, input: number, output: number): number | undefined {
  if (!m.price) return undefined;
  return (input * (m.price.input ?? 0) + output * (m.price.output ?? 0)) / 1e6;
}
