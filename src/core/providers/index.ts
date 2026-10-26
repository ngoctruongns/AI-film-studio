import { AnthropicProvider } from './anthropic';
import { ClaudeCodeProvider } from './claudeCode';
import { NotImplementedProvider, Provider, ProviderId } from './types';

export * from './types';
export { findClaudeCli } from './claudeCode';

/** OpenAI, OpenAI-compatible (Ollama / llama.cpp / LM Studio / OpenRouter), Gemini: mới có khung — làm ở pha P1b. */
export function createProvider(id: ProviderId, opts: { claudeCli: string }): Provider {
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeProvider(opts.claudeCli);
    case 'anthropic':
      return new AnthropicProvider();
    default:
      return new NotImplementedProvider(id);
  }
}
