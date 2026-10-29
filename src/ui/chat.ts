// Khung chat với AI ở cuối mỗi trang (tab đối tượng, Trạng thái dự án, Blender của tập) — Trường 29/10/2026.
// Trang tự đưa ngữ cảnh (đối tượng, bước, file liên quan, nội dung đang mở); log lưu ở .studio/runs/chat/<trang>.json (ngoài git).
// Chat chỉ TRẢ LỜI — không ghi file; việc có quy trình (lưu, đánh mã…) để nút của tool làm, việc AI có khuôn sẵn để nút ✨ của bước.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { coreContext } from '../core/context';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { renderMarkdown } from './webview';

interface Turn {
  role: 'user' | 'ai' | 'error';
  text: string;
  model?: string;
  at: string;
}

/** ngữ cảnh trang: label = tên trang trong log · text = mô tả trang + nội dung đang mở (markdown) */
export type ChatContext = () => { label: string; text: string };

const MAX_CONTEXT = 24000;   // ký tự nội dung trang gửi kèm
const MAX_HISTORY = 8;       // số lượt hỏi–đáp trước gửi kèm

export class ChatController {
  /** registry model dùng chung — gán một lần lúc kích hoạt extension */
  static models?: ModelRegistry;
  private log: Turn[] = [];
  private abort?: AbortController;
  private busy = '';
  private modelId?: string;

  constructor(
    private studio: Studio,
    /** khóa trang — tên file log (vd. "du-an", "EP01", "EP01·F·F02", "blender·EP01") */
    private key: string,
    private post: (m: any) => void,
    private context: ChatContext,
  ) {
    try {
      this.log = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch {
      this.log = [];
    }
  }

  private file(): string {
    return path.join(this.studio.root ?? '.', '.studio', 'runs', 'chat', `${this.key.replace(/[^\w.·-]+/g, '_') || 'trang'}.json`);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(this.log, null, 1), 'utf8');
  }

  private asMarkdown(): string {
    return this.log
      .map((t) => (t.role === 'user' ? `### 🧑 Hỏi *(${t.at})*\n\n${t.text}` : t.role === 'ai' ? `### ✨ AI · ${t.model ?? ''} *(${t.at})*\n\n${t.text}` : `> ❌ ${t.text}`))
      .join('\n\n---\n\n');
  }

  async render(): Promise<void> {
    const reg = ChatController.models;
    const models = reg?.list().map((m) => ({ id: m.id, title: m.title ?? m.id })) ?? [];
    const model = this.modelId ?? reg?.forStep('chat')?.id ?? models[0]?.id;
    const html = this.log.length ? await renderMarkdown(this.studio, this.asMarkdown(), path.join(this.studio.root ?? '.', 'x.md')) : '';
    this.post({ type: 'chat', html, busy: this.busy, models, model, n: this.log.length });
  }

  async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'chatReady':
        return this.render();
      case 'chatModel':
        this.modelId = String(m.id);
        return;
      case 'chatClear':
        this.log = [];
        this.save();
        return this.render();
      case 'chatCopy': {
        const md = this.asMarkdown();
        await vscode.env.clipboard.writeText(md);
        vscode.window.showInformationMessage(`Đã chép log chat (${md.length} ký tự).`);
        return;
      }
      case 'chatStop':
        this.abort?.abort();
        return;
      case 'chatSend':
        return this.send(String(m.text ?? '').trim(), m.model ? String(m.model) : undefined);
    }
  }

  private async send(text: string, modelId?: string): Promise<void> {
    if (!text || this.busy) return;
    const reg = ChatController.models;
    const model = this.studio.model;
    const m = reg && ((modelId && reg.get(modelId)) || reg.forStep('chat') || reg.list()[0]);
    if (!reg || !m || !model) return void vscode.window.showWarningMessage('Chưa có model AI — mở ⚙ Cài đặt AI.');
    this.modelId = m.id;
    const provider = reg.provider(m);
    const apiKey = await reg.apiKey(m);
    if (provider.needsKey && !apiKey) return void vscode.window.showErrorMessage(`Model ${m.id} cần khóa API — mở Cài đặt AI để dán khóa.`);
    const ctx = this.context();
    const history = this.log.filter((t) => t.role !== 'error').slice(-MAX_HISTORY * 2);
    this.log.push({ role: 'user', text, at: new Date().toLocaleString('vi-VN') });
    this.save();
    const core = provider.loadsProjectInstructions ? '' : coreContext(model);
    const system = [
      `Bạn là trợ lý AI trong tool AI Film Studio của dự án phim "${model.config.project.name}". Trả lời tiếng Việt, bằng markdown, ngắn gọn, đúng trọng tâm.`,
      'Chỉ trả lời / đề xuất — KHÔNG tự sửa file. Đề xuất sửa nội dung thì đưa đoạn văn bản đề xuất để tác giả tự dán, hoặc chỉ ra nút ✨ của bước nên dùng.',
      'Ngữ cảnh của trang đang mở ở mục "Trang đang mở". Cần thêm thì nêu đường dẫn file muốn xem.',
      core ? `\n## LÕI DỰ ÁN\n${core}` : '',
    ].join('\n');
    const page = ctx.text.length > MAX_CONTEXT ? ctx.text.slice(0, MAX_CONTEXT) + '\n…(cắt bớt)' : ctx.text;
    const prompt = [
      `## Trang đang mở: ${ctx.label}\n\n${page}`,
      history.length ? `## Hội thoại trước trên trang này\n\n${history.map((t) => `**${t.role === 'user' ? 'Tác giả' : 'AI'}:** ${t.text}`).join('\n\n')}` : '',
      `## Câu hỏi của tác giả\n\n${text}`,
    ].filter(Boolean).join('\n\n');
    this.abort = new AbortController();
    this.busy = `⏳ ${m.id} đang nghĩ…`;
    await this.render();
    try {
      const res = await provider.complete({
        model: m, system, prompt, cwd: this.studio.root!, apiKey, signal: this.abort.signal,
        onProgress: (p) => {
          this.busy = `⏳ ${m.id}: ${p}`;
          void this.render();
        },
      });
      this.log.push({ role: 'ai', text: res.text.trim(), model: m.id, at: new Date().toLocaleString('vi-VN') });
    } catch (e: any) {
      this.log.push({ role: 'error', text: String(e?.message ?? e), at: new Date().toLocaleString('vi-VN') });
    } finally {
      this.abort = undefined;
      this.busy = '';
      this.save();
      await this.render();
    }
  }
}

/** HTML khung chat — đặt cuối trang */
export const CHAT_BODY = `
<div id="chatBox" style="margin-top:20px">
<h2>💬 Trao đổi với AI <span class="muted">— AI có sẵn ngữ cảnh trang này (đối tượng, bước, file liên quan, nội dung đang mở) · chỉ trả lời, không tự sửa file</span></h2>
<div class="row" style="margin-bottom:6px"><span class="muted">Log</span><button class="sec" id="chatCopy" title="chép toàn bộ log (markdown)">Copy</button><button class="sec" id="chatClear" title="xóa sạch log của trang này">Clear</button><span id="chatN" class="muted"></span></div>
<div id="chatLog" class="md" style="min-height:48px;max-height:55vh"></div>
<textarea id="chatText" style="margin-top:6px;min-height:70px" placeholder="Hỏi AI về trang này… (Ctrl+Enter để gửi)"></textarea>
<div class="row" style="margin-top:4px"><button id="chatSend">✨ Gửi</button><select id="chatModel" title="model trả lời"></select><button class="sec" id="chatStop" hidden>Dừng</button><span id="chatBusy" class="muted"></span></div>
</div>`;

/** JS khung chat trong webview — tin gửi đi gắn __chat */
export const CHAT_JS = `(function () {
const $c = (id) => document.getElementById(id);
const post = (m) => vscode.postMessage(Object.assign({ __chat: true }, m));
const escC = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
window.addEventListener('message', (e) => {
  const m = e.data; if (m.type !== 'chat') return;
  const log = $c('chatLog');
  log.innerHTML = m.html || '<p class="muted">Chưa có trao đổi nào trên trang này.</p>';
  log.scrollTop = log.scrollHeight;
  $c('chatN').textContent = m.n ? m.n + ' mục' : '';
  $c('chatBusy').textContent = m.busy || '';
  $c('chatSend').disabled = !!m.busy; $c('chatStop').hidden = !m.busy;
  const sel = $c('chatModel'), cur = sel.value || m.model;
  sel.innerHTML = (m.models || []).map((x) => '<option value="' + escC(x.id) + '">' + escC(x.title) + '</option>').join('');
  if (cur) sel.value = cur;
});
const send = () => { const t = $c('chatText').value.trim(); if (!t) return; post({ type: 'chatSend', text: t, model: $c('chatModel').value }); $c('chatText').value = ''; vscode.setState(Object.assign({}, vscode.getState() || {}, { chatDraft: '' })); };
document.addEventListener('click', (e) => {
  if (e.target.id === 'chatSend') send();
  if (e.target.id === 'chatClear') post({ type: 'chatClear' });
  if (e.target.id === 'chatCopy') post({ type: 'chatCopy' });
  if (e.target.id === 'chatStop') post({ type: 'chatStop' });
});
document.addEventListener('change', (e) => { if (e.target.id === 'chatModel') post({ type: 'chatModel', id: e.target.value }); });
document.addEventListener('keydown', (e) => { if (e.target.id === 'chatText' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
// giữ câu đang gõ dở khi trang vẽ lại (Trạng thái dự án vẽ lại cả trang mỗi lần quét)
try { const d = (vscode.getState() || {}).chatDraft; if (d) $c('chatText').value = d; } catch (e) {}
document.addEventListener('input', (e) => { if (e.target.id === 'chatText') vscode.setState(Object.assign({}, vscode.getState() || {}, { chatDraft: e.target.value })); });
post({ type: 'chatReady' });
})();`;
