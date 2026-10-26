// Google Gemini — generateContent (REST, khóa API của Google AI Studio).
import { ChatRequest, ChatResult, Provider, estimateCost } from './types';

export class GeminiProvider implements Provider {
  id = 'gemini' as const;
  loadsProjectInstructions = false;
  needsKey = true;

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!req.apiKey) throw new Error('Chưa đặt khóa API Gemini (Cài đặt AI → Khóa API).');
    const base = (req.model.apiBase ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const model = req.model.model ?? 'gemini-2.5-flash';
    let res: Response;
    try {
      res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          ...(req.model.maxOutputTokens ? { generationConfig: { maxOutputTokens: req.model.maxOutputTokens } } : {}),
        }),
      });
    } catch (e: any) {
      if (req.signal?.aborted) throw new Error('Đã hủy');
      throw new Error(`Không kết nối được Gemini: ${e.cause?.code ?? e.message}`);
    }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${j?.error?.message ?? JSON.stringify(j).slice(0, 500)}`);
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    if (!text && j.candidates?.[0]?.finishReason) throw new Error(`Gemini dừng: ${j.candidates[0].finishReason}`);
    const u = j.usageMetadata ?? {};
    return {
      text,
      inputTokens: u.promptTokenCount,
      outputTokens: u.candidatesTokenCount,
      costUsd: estimateCost(req.model, u.promptTokenCount ?? 0, u.candidatesTokenCount ?? 0),
      costReported: false,
    };
  }
}
