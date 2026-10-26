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

  async setApiKey(): Promise<void> {
    const needing = this.list().filter((m) => this.provider(m).needsKey);
    const names = [...new Set(needing.map((m) => m.secret ?? m.provider))];
    if (!names.length) {
      vscode.window.showInformationMessage('Chưa có model nào cần khóa API. Thêm model (anthropic / openai / gemini…) vào setting aiFilmStudio.models trước.');
      return;
    }
    const name = await vscode.window.showQuickPick(names, { placeHolder: 'Khóa API cho nhà cung cấp nào?' });
    if (!name) return;
    const key = await vscode.window.showInputBox({ prompt: `Khóa API "${name}" (lưu trong SecretStorage của VS Code, không vào settings, không vào git)`, password: true });
    if (key === undefined) return;
    if (key) await this.secrets.store(`aiFilmStudio.key.${name}`, key);
    else await this.secrets.delete(`aiFilmStudio.key.${name}`);
    vscode.window.showInformationMessage(key ? `Đã lưu khóa "${name}".` : `Đã xóa khóa "${name}".`);
  }

  async test(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      this.list().map((m) => ({ label: m.id, description: `${m.provider}${m.model ? ' · ' + m.model : ''}`, m })),
      { placeHolder: 'Thử model nào?' },
    );
    if (!pick) return;
    const m = pick.m;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Thử ${m.id}…` }, async () => {
      try {
        const r = await this.provider(m).complete({
          model: m,
          system: 'Trả lời đúng một chữ.',
          prompt: 'Trả lời: OK',
          cwd: this.studio.root ?? process.cwd(),
          apiKey: await this.apiKey(m),
        });
        const cost = r.costUsd !== undefined ? ` · ${r.costUsd.toFixed(4)} USD` : '';
        vscode.window.showInformationMessage(`${m.id}: "${r.text.trim().slice(0, 60)}" · ${r.inputTokens ?? '?'}→${r.outputTokens ?? '?'} token${cost}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`${m.id}: ${e.message}`);
      }
    });
  }
}
