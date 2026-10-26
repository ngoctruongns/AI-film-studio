// Tab một bước công việc: (bước, đối tượng) — vd. (④ Chia cảnh, EP01·K). Mỗi cặp một tab, mở lại thì nhảy về tab cũ.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STATUS_LABEL } from '../core/config';
import { ResolvedStep, StepTarget, buildPrompt, extractOutput, mergeOutput, resolveStep, targetKey } from '../core/context';
import { estimateCost } from '../core/providers';
import { RunRecord, newRunId, readRuns, runPath, writeRun } from '../core/runs';
import { fill, findEpisode, findScene, findSegment } from '../core/scanner';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { esc, handleOpen, renderMarkdown, shell } from './webview';

interface PanelState {
  stepId: string;
  target: StepTarget;
}

export class StepPanel {
  static readonly viewType = 'aiFilmStudio.step';
  private static panels = new Map<string, StepPanel>();

  private request = '';
  private modelId?: string;
  private run?: RunRecord;
  private abort?: AbortController;
  private shown?: number;
  private readonly subs: vscode.Disposable[] = [];

  static open(studio: Studio, models: ModelRegistry, stepId: string, target: StepTarget): void {
    const key = `${stepId}|${targetKey(target)}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const step = studio.config?.pipeline.steps.find((s) => s.id === stepId);
    const panel = vscode.window.createWebviewPanel(this.viewType, `${step?.no ?? ''} ${targetKey(target)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    new StepPanel(panel, studio, models, { stepId, target });
  }

  static revive(panel: vscode.WebviewPanel, studio: Studio, models: ModelRegistry, state: PanelState | undefined): void {
    if (!state?.stepId) {
      panel.dispose();
      return;
    }
    new StepPanel(panel, studio, models, state);
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private studio: Studio,
    private models: ModelRegistry,
    private state: PanelState,
  ) {
    const key = `${state.stepId}|${targetKey(state.target)}`;
    StepPanel.panels.set(key, this);
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.html();
    this.subs.push(
      studio.onDidChange(() => this.post()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e)))),
    );
    panel.onDidDispose(() => {
      this.abort?.abort();
      StepPanel.panels.delete(key);
      this.subs.forEach((s) => s.dispose());
    });
  }

  private resolve(): ResolvedStep | undefined {
    const step = this.studio.config?.pipeline.steps.find((s) => s.id === this.state.stepId);
    if (!step || !this.studio.model) return undefined;
    return resolveStep(this.studio.model, step, this.state.target);
  }

  private model() {
    return (this.modelId && this.models.get(this.modelId)) || this.models.forStep(this.state.stepId);
  }

  // ------------------------------------------------------------------ view model
  private vm() {
    const rs = this.resolve();
    if (!rs) return { error: this.studio.error ?? `Không thấy bước "${this.state.stepId}" trong .studio/pipeline.yaml` };
    const m = this.model();
    const files = [...rs.inputs, ...(rs.output ? [rs.output] : [])].map((f, i) => ({
      i,
      label: f.label,
      abs: f.abs,
      rel: f.rel,
      role: f.role,
      exists: f.exists,
      found: f.found,
      line: f.line,
      optional: !!f.ref.optional,
      chars: f.text?.length ?? 0,
    }));
    const fileSet = new Set(files.map((f) => f.abs));
    const notes = this.studio.notes.filter((n) => fileSet.has(n.file)).map((n) => ({ ...n, rel: this.studio.rel(n.file) }));

    let estimate: { tokens: number; usd?: number; cap: number } | undefined;
    if (m && rs.step.executor !== 'human') {
      const bp = buildPrompt(this.studio.model!, rs, this.request, this.models.provider(m).loadsProjectInstructions);
      estimate = { tokens: bp.estInputTokens, usd: estimateCost(m, bp.estInputTokens, 0), cap: this.studio.settings.get<number>('maxInputTokens') ?? 60000 };
    }
    const scripts = (this.studio.config!.project.scripts ?? []).filter((s) => rs.step.scripts?.includes(s.id)).map((s) => ({ id: s.id, label: s.label }));
    const ep = findEpisode(this.studio.model!, rs.target.ep);
    const scene = findScene(findSegment(ep, rs.target.seg), rs.target.scene);
    const recent = readRuns(this.studio.root!)
      .filter((r) => r.step === rs.step.id && r.target === targetKey(rs.target))
      .slice(0, 5);
    return {
      title: rs.title,
      step: rs.step,
      target: rs.target,
      gate: rs.gate,
      files,
      notes,
      models: this.models.list().map((x) => ({ id: x.id, title: x.title ?? x.id })),
      model: m?.id,
      estimate,
      scripts,
      scene: scene && {
        code: scene.code,
        seconds: scene.seconds,
        status: scene.status ? STATUS_LABEL[scene.status] : '',
        title: scene.title,
        media: scene.media,
      },
      run: this.run,
      recent,
      hasOutput: !!rs.output,
      outputExists: !!rs.output?.exists,
    };
  }

  private post(): void {
    this.panel.webview.postMessage({ type: 'state', vm: this.vm() });
    if (this.shown !== undefined) this.showFile(this.shown);
  }

  // ------------------------------------------------------------------ messages
  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.post();
      case 'open':
        return handleOpen(m);
      case 'request':
        this.request = String(m.text ?? '');
        return this.post();
      case 'model':
        this.modelId = m.id;
        return this.post();
      case 'cmd':
        switch (m.cmd) {
          case 'show':
            return this.showFile(Number(m.arg));
          case 'showPrompt':
            return this.showPrompt();
          case 'run':
            return this.runAi(m.arg === 'skip');
          case 'cancel':
            this.abort?.abort();
            return;
          case 'diff':
            return this.openDiff();
          case 'apply':
            return this.apply();
          case 'discard':
            return this.discard();
          case 'handoff':
            return this.handoff();
          case 'script':
            return this.script(m.arg);
          case 'create':
            return this.createOutput();
        }
    }
  }

  private async showFile(i: number): Promise<void> {
    const rs = this.resolve();
    const f = rs && [...rs.inputs, ...(rs.output ? [rs.output] : [])][i];
    if (!f) return;
    this.shown = i;
    const html = f.text !== undefined ? await renderMarkdown(this.studio, f.text, f.abs) : `<p class="muted">${f.exists ? 'Không thấy mục được chọn trong file.' : 'Chưa có file.'}</p>`;
    this.panel.webview.postMessage({ type: 'rendered', i, label: f.label, abs: f.abs, line: f.line, html });
  }

  private async showPrompt(): Promise<void> {
    const rs = this.resolve();
    const m = this.model();
    if (!rs || !m) return;
    const bp = buildPrompt(this.studio.model!, rs, this.request, this.models.provider(m).loadsProjectInstructions);
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `<!-- Prompt sẽ gửi cho ${m.id} · ≈ ${bp.estInputTokens} token -->\n\n# SYSTEM\n\n${bp.system}\n\n# PROMPT\n\n${bp.prompt}`,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  private async runAi(skipGate: boolean): Promise<void> {
    const rs = this.resolve();
    const m = this.model();
    if (!rs || !m) return;
    if (this.run?.status === 'running') return;
    if (!rs.gate.ok && !skipGate) {
      vscode.window.showWarningMessage(`Cổng chưa mở: ${rs.gate.reasons.join('; ')}`);
      return;
    }
    const provider = this.models.provider(m);
    const bp = buildPrompt(this.studio.model!, rs, this.request, provider.loadsProjectInstructions);
    const cap = this.studio.settings.get<number>('maxInputTokens') ?? 60000;
    if (bp.estInputTokens > cap) {
      const ok = await vscode.window.showWarningMessage(
        `Ngữ cảnh ≈ ${bp.estInputTokens} token, vượt trần ${cap}. Vẫn gửi?`,
        { modal: true },
        'Gửi',
      );
      if (ok !== 'Gửi') return;
    }
    const apiKey = provider.needsKey ? await this.models.apiKey(m) : undefined;
    if (provider.needsKey && !apiKey) {
      vscode.window.showErrorMessage(`Model ${m.id} cần khóa API — chạy lệnh "AI Film Studio: Đặt khóa API cho model".`);
      return;
    }
    const root = this.studio.root!;
    const rec: RunRecord = {
      id: newRunId(rs.step.id, targetKey(rs.target)),
      step: rs.step.id,
      target: targetKey(rs.target),
      modelId: m.id,
      provider: m.provider,
      machine: this.studio.settings.get<string>('machineProfile') || undefined,
      startedAt: new Date().toISOString(),
      estInputTokens: bp.estInputTokens,
      status: 'running',
      outputFile: rs.output?.rel,
    };
    this.run = rec;
    writeRun(root, rec, { 'prompt.md': `# SYSTEM\n\n${bp.system}\n\n# PROMPT\n\n${bp.prompt}` });
    this.post();
    this.abort = new AbortController();
    try {
      const res = await provider.complete({
        model: m,
        system: bp.system,
        prompt: bp.prompt,
        cwd: root,
        apiKey,
        signal: this.abort.signal,
      });
      Object.assign(rec, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        costReported: res.costReported,
      });
      const files: Record<string, string> = { 'answer.md': res.text };
      if (rs.output) files['proposal.md'] = mergeOutput(rs, extractOutput(res.text));
      writeRun(root, rec, files);
      this.post();
      if (rs.output) await this.openDiff();
      else await this.openAnswer();
    } catch (e: any) {
      Object.assign(rec, { status: 'error', finishedAt: new Date().toISOString(), error: String(e.message ?? e) });
      writeRun(root, rec);
      this.post();
      vscode.window.showErrorMessage(`${m.id}: ${rec.error}`);
    } finally {
      this.abort = undefined;
    }
  }

  private proposal(): string | undefined {
    if (!this.run || !this.studio.root) return undefined;
    const p = runPath(this.studio.root, this.run.id, 'proposal.md');
    return fs.existsSync(p) ? p : undefined;
  }

  private async openAnswer(): Promise<void> {
    if (!this.run) return;
    const p = runPath(this.studio.root!, this.run.id, 'answer.md');
    if (fs.existsSync(p)) await vscode.window.showTextDocument(vscode.Uri.file(p), { viewColumn: vscode.ViewColumn.Beside });
  }

  private async openDiff(): Promise<void> {
    const rs = this.resolve();
    const prop = this.proposal();
    if (!rs?.output || !prop) return;
    if (!rs.output.exists) {
      await vscode.window.showTextDocument(vscode.Uri.file(prop), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(rs.output.abs),
      vscode.Uri.file(prop),
      `${path.basename(rs.output.abs)} ↔ đề xuất ${this.run!.modelId} (sửa được bên phải trước khi Nhận)`,
      { viewColumn: vscode.ViewColumn.Beside, preview: false },
    );
  }

  private async apply(): Promise<void> {
    const rs = this.resolve();
    const prop = this.proposal();
    if (!rs?.output || !prop || !this.run) return;
    // Bản đề xuất có thể đã được sửa tay trong diff → lưu trước khi chép
    const propDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === prop);
    if (propDoc?.isDirty) await propDoc.save();
    const targetDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === rs.output!.abs);
    if (targetDoc?.isDirty) {
      vscode.window.showWarningMessage(`${path.basename(rs.output.abs)} đang có thay đổi chưa lưu — lưu hoặc bỏ trước khi Nhận.`);
      return;
    }
    fs.mkdirSync(path.dirname(rs.output.abs), { recursive: true });
    fs.writeFileSync(rs.output.abs, fs.readFileSync(prop, 'utf8'), 'utf8');
    this.run.status = 'applied';
    writeRun(this.studio.root!, this.run);
    vscode.window.showInformationMessage(`Đã ghi ${rs.output.rel}. Xem bằng git diff — tool không git add.`);
    this.studio.refresh();
  }

  private discard(): void {
    if (!this.run) return;
    this.run.status = 'discarded';
    writeRun(this.studio.root!, this.run);
    this.run = undefined;
    this.post();
  }

  /** Bước agent (Blender…): ghi prompt ra file rồi mở Claude Code tương tác trong terminal — quyền vẫn do người duyệt. */
  private async handoff(): Promise<void> {
    const rs = this.resolve();
    if (!rs) return;
    const bp = buildPrompt(this.studio.model!, rs, this.request, true);
    const root = this.studio.root!;
    const rec: RunRecord = {
      id: newRunId(rs.step.id, targetKey(rs.target)),
      step: rs.step.id,
      target: targetKey(rs.target),
      modelId: 'claude-code (tương tác)',
      provider: 'claude-code',
      startedAt: new Date().toISOString(),
      estInputTokens: bp.estInputTokens,
      status: 'handed-off',
    };
    writeRun(root, rec, { 'prompt.md': bp.prompt });
    const rel = this.studio.rel(runPath(root, rec.id, 'prompt.md'));
    const term = vscode.window.createTerminal({ name: `Claude · ${rs.title}`, cwd: root });
    term.show();
    term.sendText(`"${this.models.claudeCli()}" "Đọc file ${rel} và làm theo."`);
  }

  private script(id: string): void {
    const rs = this.resolve();
    const s = this.studio.config?.project.scripts?.find((x) => x.id === id);
    if (!rs || !s) return;
    const term = vscode.window.createTerminal({ name: `Script · ${s.label}`, cwd: this.studio.root });
    term.show();
    term.sendText(fill(s.command, rs.ph));
  }

  private async createOutput(): Promise<void> {
    const rs = this.resolve();
    if (!rs?.output || rs.output.exists) return;
    fs.mkdirSync(path.dirname(rs.output.abs), { recursive: true });
    fs.writeFileSync(rs.output.abs, '', 'utf8');
    this.studio.refresh();
    await handleOpen({ path: rs.output.abs });
  }

  // ------------------------------------------------------------------ html
  private html(): string {
    return shell(
      this.panel.webview,
      'Bước',
      `<div id="head"></div>
      <div class="row" style="align-items:flex-start;gap:16px;margin-top:8px">
        <div class="col" style="flex:1 1 340px;min-width:280px">
          <h2>File liên quan</h2><div id="files"></div>
          <div id="notes"></div>
          <div id="scripts"></div>
        </div>
        <div class="col" style="flex:2 1 480px;min-width:300px">
          <h2 id="pvTitle">Xem nhanh <span class="muted">(bấm một file bên trái)</span></h2>
          <div id="pv" class="md"><p class="muted">—</p></div>
        </div>
      </div>
      <div id="ai">
        <h2>AI</h2>
        <div class="row"><label>Model <select id="model"></select></label><span id="est" class="muted"></span>
          <button class="link" data-cmd="showPrompt">Xem prompt gửi đi</button></div>
        <p class="muted" style="margin:6px 0 2px">Yêu cầu thêm (ghi chú sửa, ý mới…)</p>
        <textarea id="req" placeholder="vd. thêm cảnh Lê Lợi nhìn Tây Đô cháy · rút còn 6 cảnh · @C trong file đã ghi rõ…"></textarea>
        <div class="row" style="margin-top:6px" id="actions"></div>
        <div id="run" style="margin-top:8px"></div>
        <div id="recent"></div>
      </div>`,
      CLIENT_JS,
    );
  }
}

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let st = vscode.getState() || {};
$('req').value = st.request || '';
let t;
$('req').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => {
  vscode.setState({ ...vscode.getState(), request: $('req').value });
  vscode.postMessage({ type: 'request', text: $('req').value }); }, 400); });
$('model').addEventListener('change', () => vscode.postMessage({ type: 'model', id: $('model').value }));
if (st.request) vscode.postMessage({ type: 'request', text: st.request });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') render(m.vm);
  if (m.type === 'rendered') {
    $('pvTitle').innerHTML = esc(m.label) + ' <button class="link" data-open="' + esc(m.abs) + '" data-line="' + m.line + '">sửa</button>'
      + '<button class="link" data-open="' + esc(m.abs) + '" data-how="preview">preview đầy đủ</button>';
    $('pv').innerHTML = m.html;
  }
});

function render(vm) {
  if (vm.error) { $('head').innerHTML = '<p class="err">' + esc(vm.error) + '</p>'; return; }
  vscode.setState({ ...vscode.getState(), stepId: vm.step.id, target: vm.target });
  const ex = { human: 'người làm', chat: 'AI văn bản', agent: 'Claude Code (agent)' }[vm.step.executor];
  let h = '<h1>' + esc(vm.title) + '</h1><div class="muted">' + ex + (vm.step.description ? ' · ' + esc(vm.step.description) : '') + '</div>';
  if (vm.scene) {
    const md = Object.entries(vm.scene.media).map(([k, n]) => k + ' ' + n).join(' · ') || 'chưa có file media';
    h += '<div class="card" style="margin-top:8px"><b>' + esc(vm.scene.code) + '</b> · ' + (vm.scene.seconds ?? '?') + ' s · ' + esc(vm.scene.status)
      + '<br>' + esc(vm.scene.title) + '<br><span class="muted">Media: ' + esc(md) + '</span></div>';
  }
  if (!vm.gate.ok) h += '<p class="warn">🔒 Cổng chưa mở: ' + vm.gate.reasons.map(esc).join(' · ') + '</p>';
  $('head').innerHTML = h;

  $('files').innerHTML = '<table>' + vm.files.map((f) => {
    const state = !f.exists ? (f.optional ? '<span class="muted">không có</span>' : '<span class="err">chưa có</span>')
      : !f.found ? '<span class="err">không thấy mục</span>' : '<span class="muted">' + f.chars + ' ký tự</span>';
    const btn = f.exists ? '<button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button>'
      + '<button class="link" data-open="' + esc(f.abs) + '" data-line="' + f.line + '">sửa</button>'
      : (f.role === 'output' ? '<button class="link" data-cmd="create">tạo file</button>' : '');
    return '<tr><td>' + (f.role === 'output' ? '→ ' : '') + esc(f.label) + '</td><td>' + state + '</td><td style="white-space:nowrap">' + btn + '</td></tr>';
  }).join('') + '</table>';

  $('notes').innerHTML = vm.notes.length ? '<h2>Ghi chú trong các file này</h2>' + vm.notes.map((n) =>
    '<div><span class="badge">' + (n.kind === 'todo' ? '@C' : '@T') + '</span> <a data-open="' + esc(n.file) + '" data-line="' + n.line + '">'
    + esc(n.text) + '</a></div>').join('') : '';
  $('scripts').innerHTML = vm.scripts.length ? '<h2>Script</h2>' + vm.scripts.map((s) =>
    '<button class="sec" data-cmd="script" data-arg="' + esc(s.id) + '">▶ ' + esc(s.label) + '</button> ').join('') : '';

  $('ai').hidden = vm.step.executor === 'human';
  $('model').innerHTML = vm.models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === vm.model ? ' selected' : '') + '>' + esc(m.title) + '</option>').join('');
  $('model').disabled = vm.step.executor === 'agent';
  if (vm.estimate) {
    const over = vm.estimate.tokens > vm.estimate.cap;
    $('est').innerHTML = '<span class="' + (over ? 'err' : '') + '">ngữ cảnh ≈ ' + vm.estimate.tokens.toLocaleString('vi-VN') + ' token</span>'
      + (vm.estimate.usd !== undefined ? ' · ≈ ' + vm.estimate.usd.toFixed(3) + ' USD tiền vào' : '');
  }
  const running = vm.run && vm.run.status === 'running';
  let a = '';
  if (vm.step.executor === 'agent') a = '<button data-cmd="handoff">Giao cho Claude Code (terminal)</button>';
  else if (vm.hasOutput) {
    a = running ? '<button class="sec" data-cmd="cancel">Hủy</button>'
      : '<button data-cmd="run"' + (vm.gate.ok ? '' : ' disabled') + '>Chạy</button>'
        + (vm.gate.ok ? '' : ' <button class="sec" data-cmd="run" data-arg="skip">Chạy (bỏ qua cổng)</button>');
  }
  $('actions').innerHTML = a;

  let r = '';
  if (vm.run) {
    const x = vm.run;
    const tok = x.inputTokens !== undefined ? ' · ' + x.inputTokens + ' → ' + x.outputTokens + ' token' : '';
    const cost = x.costUsd !== undefined ? ' · ' + x.costUsd.toFixed(3) + ' USD' + (x.costReported ? '' : ' (ước tính)') : '';
    const label = { running: '⏳ đang chạy ' + esc(x.modelId) + '…', done: '✅ xong', error: '❌ lỗi: ' + esc(x.error), applied: '✅ đã ghi vào file', discarded: 'đã bỏ' }[x.status] || x.status;
    r = '<div class="card">' + label + tok + cost;
    if (x.status === 'done' && vm.hasOutput) r += '<div class="row" style="margin-top:6px"><button data-cmd="diff">Xem diff</button><button data-cmd="apply">Nhận</button><button class="sec" data-cmd="discard">Bỏ</button>'
      + '<span class="muted">Nhận một phần: sửa bản bên phải trong diff rồi bấm Nhận</span></div>';
    r += '</div>';
  }
  $('run').innerHTML = r;
  $('recent').innerHTML = vm.recent.length ? '<h2>Lần chạy gần đây</h2><table>' + vm.recent.map((x) =>
    '<tr><td>' + esc(x.startedAt.slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(x.modelId) + '</td><td>' + esc(x.status) + '</td><td>'
    + (x.costUsd !== undefined ? x.costUsd.toFixed(3) + ' USD' : '') + '</td></tr>').join('') + '</table>' : '';
}
vscode.postMessage({ type: 'ready' });
`;
