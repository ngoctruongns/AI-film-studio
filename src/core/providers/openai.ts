// OpenAI Chat Completions — dùng chung cho OpenAI và mọi server tương thích (Ollama, llama.cpp server, LM Studio, OpenRouter, vLLM).
import { ChatRequest, ChatResult, Provider, estimateCost } from './types';

export class OpenAIProvider implements Provider {
  loadsProjectInstructions = false;
  constructor(
    public id: 'openai' | 'openai-compatible',
    public needsKey: boolean,
  ) {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (this.needsKey && !req.apiKey) throw new Error('Chưa đặt khóa API OpenAI (Cài đặt AI → Khóa API).');
    const base = (req.model.apiBase ?? (this.id === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434/v1')).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (req.apiKey) headers['authorization'] = `Bearer ${req.apiKey}`;
    const body: Record<string, unknown> = {
      model: req.model.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
    };
    if (req.model.maxOutputTokens) body[this.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.model.maxOutputTokens;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
    } catch (e: any) {
      if (req.signal?.aborted) throw new Error('Đã hủy');
      throw new Error(`Không kết nối được ${base}: ${e.cause?.code ?? e.message}`);
    }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${j?.error?.message ?? JSON.stringify(j).slice(0, 500)}`);
    const text = j.choices?.[0]?.message?.content ?? '';
    const u = j.usage ?? {};
    return {
      text,
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      costUsd: estimateCost(req.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0),
      costReported: false,
    };
  }
}
