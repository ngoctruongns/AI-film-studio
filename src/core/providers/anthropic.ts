// Anthropic Messages API (cần khóa API — dùng trên laptop cá nhân).
import { ChatRequest, ChatResult, Provider, estimateCost } from './types';

export class AnthropicProvider implements Provider {
  id = 'anthropic' as const;
  loadsProjectInstructions = false;
  needsKey = true;

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!req.apiKey) throw new Error('Chưa đặt khóa API Anthropic (lệnh "AI Film Studio: Đặt khóa API cho model").');
    const base = req.model.apiBase ?? 'https://api.anthropic.com';
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model.model ?? 'claude-sonnet-5-5',
        max_tokens: req.model.maxOutputTokens ?? 16000,
        // Lõi dự án + hướng dẫn bước ít đổi → đánh dấu cache để các lần chạy liên tiếp rẻ hơn
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.prompt }],
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${j?.error?.message ?? JSON.stringify(j).slice(0, 500)}`);
    const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const u = j.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { text, inputTokens: input, outputTokens: u.output_tokens, costUsd: estimateCost(req.model, input, u.output_tokens ?? 0), costReported: false };
  }
}
