// Danh sách model của MÁY NÀY (settings) + gán model theo bước (.studio/models.yaml, ghi đè bằng settings).
import * as vscode from 'vscode';
import { ModelConfig, Provider, createProvider, findClaudeCli } from '../core/providers';
import { Studio } from './studio';

export class ModelRegistry {
  constructor(private studio: Studio, private secrets: vscode.SecretStorage) {}

  list(): ModelConfig[] {
    return this.studio.settings.get<ModelConfig[]>('models') ?? [];
  }

  get(id: string): ModelConfig | undefined {
    return this.list().find((m) => m.id === id);
  }

  /** stepModels (máy này) → models.yaml steps → fallback → default → model đầu tiên */
  forStep(stepId: string): ModelConfig | undefined {
    const local = this.studio.settings.get<Record<string, string>>('stepModels') ?? {};
    const cfg = this.studio.config?.models;
    const order = [local[stepId], cfg?.steps?.[stepId], ...(cfg?.fallback ?? []), cfg?.default].filter(Boolean) as string[];
    for (const id of order) {
      const m = this.get(id);
      if (m) return m;
    }
    return this.list()[0];
  }

  claudeCli(): string {
    return findClaudeCli(this.studio.settings.get<string>('claudePath') || undefined);
  }

  provider(m: ModelConfig): Provider {
    return createProvider(m.provider, { claudeCli: this.claudeCli() });
  }

  secretKey(m: ModelConfig): string {
    return `aiFilmStudio.key.${m.secret ?? m.provider}`;
  }

  async apiKey(m: ModelConfig): Promise<string | undefined> {
    return this.secrets.get(this.secretKey(m));
  }
}
