import { AnthropicProvider } from './anthropic';
import { ClaudeCodeProvider } from './claudeCode';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import { Provider, ProviderId } from './types';

export * from './types';
export { findClaudeCli } from './claudeCode';

export const PROVIDERS: { id: ProviderId; label: string; needsKey: boolean; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code (CLI)', needsKey: false, hint: 'Không cần khóa — dùng đăng nhập của Claude Code. model: opus / sonnet / haiku hoặc tên đầy đủ' },
  { id: 'anthropic', label: 'Anthropic API', needsKey: true, hint: 'model: claude-opus-5-5, claude-sonnet-5-5…' },
  { id: 'openai', label: 'OpenAI API', needsKey: true, hint: 'model: tên model của OpenAI' },
  { id: 'openai-compatible', label: 'Local / tương thích OpenAI', needsKey: false, hint: 'Ollama http://localhost:11434/v1 · llama.cpp http://localhost:8080/v1 · LM Studio http://localhost:1234/v1 · OpenRouter (cần khóa)' },
  { id: 'gemini', label: 'Google Gemini', needsKey: true, hint: 'model: gemini-2.5-flash, gemini-2.5-pro…' },
];

export function createProvider(id: ProviderId, opts: { claudeCli: string }): Provider {
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeProvider(opts.claudeCli);
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider('openai', true);
    case 'openai-compatible':
      return new OpenAIProvider('openai-compatible', false);
    case 'gemini':
      return new GeminiProvider();
  }
}
