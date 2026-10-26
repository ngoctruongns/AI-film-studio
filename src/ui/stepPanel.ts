// Tab một bước công việc: (bước, đối tượng) — vd. (④ Chia cảnh, EP01·K). Mỗi cặp một tab, mở lại thì nhảy về tab cũ.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STATUS_LABEL } from '../core/config';
import { ResolvedStep, StepTarget, buildPrompt, extractOutput, mergeOutput, resolveStep, targetKey } from '../core/context';
import { ModelConfig, estimateCost } from '../core/providers';
import { MediaFile, listSceneMedia, mediaTargetName, upsertResult } from '../core/results';
import { RunRecord, newRunId, readRuns, runPath, writeRun } from '../core/runs';
import { fill, findEpisode, findScene, findSegment } from '../core/scanner';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { handleOpen, renderMarkdown, shell } from './webview';

interface PanelState {
  stepId: string;
  target: StepTarget;
}

const MEDIA_KINDS = [
  { kind: 'I', label: 'Ảnh _I (I0 khung đầu · I9 khung cuối · I1–I8 giữa)', askNum: true },
  { kind: 'V', label: 'Video AI _V (lần sinh kế tiếp)', askNum: false },
  { kind: 'R', label: 'Video tham chiếu _R (previs / phim mẫu)', askNum: false },
  { kind: 'L', label: 'Lời đã thu _L', askNum: true },
  { kind: 'A', label: 'Âm thanh _A', askNum: true },
];

export class StepPanel {
  static readonly viewType = 'aiFilmStudio.step';
  private static panels = new Map<string, StepPanel>();

  private request = '';
  private modelId?: string;
  private compareId?: string;
  /** các lần chạy của tab này (mới nhất đầu) — chạy song song được để so sánh model */
  private runs: RunRecord[] = [];
  private aborts = new Map<string, AbortController>();
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
      localResourceRoots: StepPanel.roots(studio),
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

  /** Webview chỉ được đọc ảnh trong repo dự án + thư mục media */
  private static roots(studio: Studio): vscode.Uri[] {
    const r = [studio.root, studio.model?.mediaRoot].filter((x): x is string => !!x && fs.existsSync(x));
    return r.map((x) => vscode.Uri.file(x));
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private studio: Studio,
    private models: ModelRegistry,
    private state: PanelState,
  ) {
    const key = `${state.stepId}|${targetKey(state.target)}`;
    StepPanel.panels.set(key, this);
    panel.webview.options = { enableScripts: true, localResourceRoots: StepPanel.roots(studio) };
    // đăng ký nhận tin TRƯỚC khi gán html — tin 'ready' của webview không bị lỡ
    this.subs.push(
      studio.onDidChange(() => this.post()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e)))),
    );
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      this.aborts.forEach((a) => a.abort());
      StepPanel.panels.delete(key);
      this.subs.forEach((s) => s.dispose());
    });
  }

  private resolve(): ResolvedStep | undefined {
    const step = this.studio.config?.pipeline.steps.find((s) => s.id === this.state.stepId);
    if (!step || !this.studio.model) return undefined;
    return resolveStep(this.studio.model, step, this.state.target);
  }

  private model(): ModelConfig | undefined {
    return (this.modelId && this.models.get(this.modelId)) || this.models.forStep(this.state.stepId);
  }

  private mediaDirs(rs: ResolvedStep): { dir: string; inRepo: boolean }[] {
    const dirs: { dir: string; inRepo: boolean }[] = [];
    const mr = this.studio.model?.mediaRoot;
    if (mr && fs.existsSync(mr)) dirs.push({ dir: mr, inRepo: false });
    for (const d of this.studio.config?.project.paths.sceneMedia ?? []) {
      const abs = this.studio.abs(fill(d, rs.ph));
      if (fs.existsSync(abs)) dirs.push({ dir: abs, inRepo: true });
    }
    return dirs;
  }

  private sceneMedia(rs: ResolvedStep): MediaFile[] {
    if (!rs.target.ep || !rs.target.scene) return [];
    return listSceneMedia(this.mediaDirs(rs), rs.target.ep, rs.target.scene);
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
      virtual: !!f.virtual,
      chars: f.text?.length ?? 0,
    }));
    const fileSet = new Set(files.map((f) => f.abs).filter(Boolean));
    const notes = this.studio.notes.filter((n) => fileSet.has(n.file)).map((n) => ({ ...n, rel: this.studio.rel(n.file) }));

    let estimate: { tokens: number; usd?: number; cap: number } | undefined;
    if (m && rs.step.executor !== 'human') {
      const bp = buildPrompt(this.studio.model!, rs, this.request, this.models.provider(m).loadsProjectInstructions);
      estimate = { tokens: bp.estInputTokens, usd: estimateCost(m, bp.estInputTokens, 0), cap: this.studio.settings.get<number>('maxInputTokens') ?? 60000 };
    }
    const scripts = (this.studio.config!.project.scripts ?? []).filter((s) => rs.step.scripts?.includes(s.id)).map((s) => ({ id: s.id, label: s.label }));
    const ep = findEpisode(this.studio.model!, rs.target.ep);
    const seg = findSegment(ep, rs.target.seg);
    const scene = findScene(seg, rs.target.scene);
    const recent = readRuns(this.studio.root!)
      .filter((r) => r.step === rs.step.id && r.target === targetKey(rs.target))
      .slice(0, 6);
    const view = rs.step.view ?? [];
    let media: object | undefined;
    if (view.includes('media') || (rs.step.scope === 'scene' && rs.target.scene)) {
      const files = this.sceneMedia(rs).map((f) => ({
        name: f.name,
        abs: f.abs,
        kind: f.kind,
        num: f.num,
        sub: f.sub,
        type: f.type,
        inRepo: f.inRepo,
        src: f.type === 'image' ? this.panel.webview.asWebviewUri(vscode.Uri.file(f.abs)).toString() : undefined,
      }));
      media = {
        full: view.includes('media'),
        files,
        root: this.studio.model?.mediaRoot,
        rootFound: this.studio.model?.mediaFound,
        result: scene?.result,
        videos: files.filter((f) => f.kind === 'V').map((f) => f.name),
      };
    }
    return {
      title: rs.title,
      step: rs.step,
      target: rs.target,
      gate: rs.gate,
      files,
      notes,
      models: this.models.list().map((x) => ({ id: x.id, title: x.title ?? x.id })),
      model: m?.id,
      compare: this.compareId,
      estimate,
      scripts,
      grid: view.includes('grid') && !!seg?.files['canh'],
      scene: scene && {
        code: scene.code,
        seconds: scene.seconds,
        status: scene.status ? STATUS_LABEL[scene.status] : '',
        title: scene.title,
      },
      media,
      runs: this.runs,
      recent,
      hasOutput: !!rs.output,
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
      case 'compare':
        this.compareId = m.id || undefined;
        return this.post();
      case 'saveResult':
        return this.saveResult(m.result);
      case 'cmd':
        switch (m.cmd) {
          case 'show':
            return this.showFile(Number(m.arg));
          case 'showPrompt':
            return this.showPrompt();
          case 'run':
            return this.startRuns(m.arg === 'skip', false);
          case 'runCompare':
            return this.startRuns(m.arg === 'skip', true);
          case 'cancel':
            this.aborts.get(m.arg)?.abort();
            return;
          case 'diff':
            return this.openDiff(m.arg);
          case 'answer':
            return this.openAnswer(m.arg);
          case 'apply':
            return this.apply(m.arg);
          case 'discard':
            return this.discard(m.arg);
          case 'handoff':
            return this.handoff();
          case 'script':
            return this.script(m.arg);
          case 'create':
            return this.createOutput();
          case 'grid':
            return vscode.commands.executeCommand('aiFilmStudio.editSceneTable', { ep: this.state.target.ep, seg: this.state.target.seg });
          case 'import':
            return this.importMedia();
          case 'openMedia':
            return vscode.env.openExternal(vscode.Uri.file(m.arg)).then(() => undefined);
          case 'revealMedia':
            return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.arg));
          case 'settings':
            return vscode.commands.executeCommand('aiFilmStudio.openSettings');
        }
    }
  }

  private async showFile(i: number): Promise<void> {
    const rs = this.resolve();
    const f = rs && [...rs.inputs, ...(rs.output ? [rs.output] : [])][i];
    if (!f) return;
    this.shown = i;
    const html = f.virtual
      ? `<pre>${(f.text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
      : f.text !== undefined
        ? await renderMarkdown(this.studio, f.text, f.abs)
        : `<p class="muted">${f.exists ? 'Không thấy mục được chọn trong file.' : 'Chưa có file.'}</p>`;
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

  private async startRuns(skipGate: boolean, compare: boolean): Promise<void> {
    const rs = this.resolve();
    const main = this.model();
    if (!rs || !main) return;
    if (!rs.gate.ok && !skipGate) {
      vscode.window.showWarningMessage(`Cổng chưa mở: ${rs.gate.reasons.join('; ')}`);
      return;
    }
    const list = [main];
    if (compare) {
      const c = this.compareId && this.models.get(this.compareId);
      if (!c || c.id === main.id) {
        vscode.window.showWarningMessage('Chọn model thứ hai (khác model chính) ở ô "So sánh với".');
        return;
      }
      list.push(c);
    }
    // hỏi trần token một lần cho cả nhóm
    const cap = this.studio.settings.get<number>('maxInputTokens') ?? 60000;
    const est = Math.max(...list.map((m) => buildPrompt(this.studio.model!, rs, this.request, this.models.provider(m).loadsProjectInstructions).estInputTokens));
    if (est > cap) {
      const ok = await vscode.window.showWarningMessage(`Ngữ cảnh ≈ ${est} token, vượt trần ${cap}. Vẫn gửi?`, { modal: true }, 'Gửi');
      if (ok !== 'Gửi') return;
    }
    await Promise.all(list.map((m) => this.runOne(rs, m)));
  }

  private async runOne(rs: ResolvedStep, m: ModelConfig): Promise<void> {
    const provider = this.models.provider(m);
    const bp = buildPrompt(this.studio.model!, rs, this.request, provider.loadsProjectInstructions);
    const apiKey = await this.models.apiKey(m);
    if (provider.needsKey && !apiKey) {
      vscode.window.showErrorMessage(`Model ${m.id} cần khóa API — mở Cài đặt AI để dán khóa.`);
      return;
    }
    const root = this.studio.root!;
    const rec: RunRecord = {
      id: newRunId(rs.step.id, `${targetKey(rs.target)}_${m.id}`),
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
    this.runs.unshift(rec);
    writeRun(root, rec, { 'prompt.md': `# SYSTEM\n\n${bp.system}\n\n# PROMPT\n\n${bp.prompt}` });
    this.post();
    const abort = new AbortController();
    this.aborts.set(rec.id, abort);
    try {
      const res = await provider.complete({ model: m, system: bp.system, prompt: bp.prompt, cwd: root, apiKey, signal: abort.signal });
      Object.assign(rec, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        costReported: res.costReported,
      });
      const files: Record<string, string> = { 'answer.md': res.text };
      if (rs.output) files['proposal.md'] = mergeOutput(this.resolve() ?? rs, extractOutput(res.text));
      writeRun(root, rec, files);
      this.post();
      // chạy một model: mở diff ngay · so sánh: người bấm "Xem diff" từng bản
      if (this.runs.filter((r) => r.status === 'running').length === 0 && this.runs.filter((r) => r.status === 'done').length === 1) {
        if (rs.output) await this.openDiff(rec.id);
        else await this.openAnswer(rec.id);
      }
    } catch (e: any) {
      Object.assign(rec, { status: 'error', finishedAt: new Date().toISOString(), error: String(e.message ?? e) });
      writeRun(root, rec);
      this.post();
    } finally {
      this.aborts.delete(rec.id);
    }
  }

  private run(id: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  private proposal(id: string): string | undefined {
    const p = runPath(this.studio.root!, id, 'proposal.md');
    return fs.existsSync(p) ? p : undefined;
  }

  private async openAnswer(id: string): Promise<void> {
    const p = runPath(this.studio.root!, id, 'answer.md');
    if (fs.existsSync(p)) await vscode.window.showTextDocument(vscode.Uri.file(p), { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  private async openDiff(id: string): Promise<void> {
    const rs = this.resolve();
    const prop = this.proposal(id);
    if (!rs?.output || !prop) return;
    if (!rs.output.exists) {
      await vscode.window.showTextDocument(vscode.Uri.file(prop), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(rs.output.abs),
      vscode.Uri.file(prop),
      `${path.basename(rs.output.abs)} ↔ ${this.run(id)?.modelId ?? 'đề xuất'} (sửa được bên phải trước khi Nhận)`,
      { viewColumn: vscode.ViewColumn.Beside, preview: false },
    );
  }

  private async apply(id: string): Promise<void> {
    const rs = this.resolve();
    const prop = this.proposal(id);
    const rec = this.run(id);
    if (!rs?.output || !prop || !rec) return;
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
    rec.status = 'applied';
    writeRun(this.studio.root!, rec);
    vscode.window.showInformationMessage(`Đã ghi ${rs.output.rel} (bản của ${rec.modelId}). Xem bằng git diff — tool không git add.`);
    this.studio.refresh();
  }

  private discard(id: string): void {
    const rec = this.run(id);
    if (!rec) return;
    if (rec.status === 'done') {
      rec.status = 'discarded';
      writeRun(this.studio.root!, rec);
    }
    this.runs = this.runs.filter((r) => r.id !== id);
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
    this.post();
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

  // ------------------------------------------------------------------ media + kết quả (bước ⑦)

  /** Chép file tải về (Dreamina…) vào thư mục media, đổi tên theo mã. Không xóa / di chuyển file gốc. */
  private async importMedia(): Promise<void> {
    const rs = this.resolve();
    const mr = this.studio.model?.mediaRoot;
    if (!rs?.target.ep || !rs.target.scene || !mr) return;
    if (!fs.existsSync(mr)) {
      const ok = await vscode.window.showWarningMessage(`Thư mục media ${mr} chưa có. Tạo mới?`, { modal: true }, 'Tạo', 'Chọn thư mục khác');
      if (ok === 'Chọn thư mục khác') return vscode.commands.executeCommand('aiFilmStudio.openSettings').then(() => undefined);
      if (ok !== 'Tạo') return;
      fs.mkdirSync(mr, { recursive: true });
    }
    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: `Nhập cho ${rs.target.scene}` });
    if (!picks?.length) return;
    const destDir = path.join(mr, rs.target.ep, rs.target.seg ?? '');
    fs.mkdirSync(destDir, { recursive: true });
    const done: string[] = [];
    for (const uri of picks) {
      const kind = await vscode.window.showQuickPick(
        MEDIA_KINDS.map((k) => ({ label: k.label, k })),
        { placeHolder: `${path.basename(uri.fsPath)} là loại gì?` },
      );
      if (!kind) continue;
      let num: number | undefined;
      if (kind.k.askNum) {
        const v = await vscode.window.showInputBox({
          prompt: `Số của ${rs.target.scene}_${kind.k.kind}… (vd. ${kind.k.kind === 'I' ? '0 = khung đầu, 9 = khung cuối' : '1'})`,
          validateInput: (x) => (/^\d{1,2}$/.test(x) ? undefined : 'Nhập số'),
        });
        if (v === undefined) continue;
        num = Number(v);
      }
      const existing = this.sceneMedia(rs);
      const name = mediaTargetName(existing, rs.target.ep, rs.target.scene, kind.k.kind, num, path.extname(uri.fsPath).toLowerCase());
      fs.copyFileSync(uri.fsPath, path.join(destDir, name), fs.constants.COPYFILE_EXCL);
      done.push(name);
    }
    if (done.length) vscode.window.showInformationMessage(`Đã chép: ${done.join(', ')} → ${destDir}`);
    this.studio.refresh();
  }

  private saveResult(r: { attempts?: string; chosen?: string; model?: string; note?: string }): void {
    const rs = this.resolve();
    const ep = rs && findEpisode(this.studio.model!, rs.target.ep);
    const seg = findSegment(ep, rs?.target.seg);
    if (!rs?.target.scene || !seg?.dir) return;
    const pattern = this.studio.config!.project.segment.files['ket-qua'] ?? '{X}_ket-qua.md';
    const file = path.join(seg.dir, pattern.replace(/\{X\}/g, seg.code));
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const n = Number(r.attempts);
    const next = upsertResult(
      cur,
      `${seg.code} · ${seg.name}`,
      {
        scene: rs.target.scene,
        attempts: Number.isFinite(n) && n > 0 ? n : undefined,
        chosen: r.chosen ?? '',
        model: r.model ?? '',
        note: r.note ?? '',
        updated: new Date().toISOString().slice(0, 10),
      },
      seg.scenes.map((s) => s.code),
    );
    fs.writeFileSync(file, next, 'utf8');
    vscode.window.showInformationMessage(`Đã ghi kết quả ${rs.target.scene} vào ${this.studio.rel(file)}.`);
    this.studio.refresh();
  }

  // ------------------------------------------------------------------ html
  private html(): string {
    return shell(
      this.panel.webview,
      'Bước',
      `<div id="head"></div>
      <div id="media"></div>
      <div class="row" style="align-items:flex-start;gap:16px;margin-top:8px">
        <div class="col" style="flex:1 1 340px;min-width:280px">
          <h2>File liên quan</h2><div id="files"></div>
          <div id="tools"></div>
          <div id="notes"></div>
          <div id="scripts"></div>
        </div>
        <div class="col" style="flex:2 1 480px;min-width:300px">
          <h2 id="pvTitle">Xem nhanh <span class="muted">(bấm "xem" một file bên trái)</span></h2>
          <div id="pv" class="md"><p class="muted">—</p></div>
        </div>
      </div>
      <div id="ai">
        <h2>AI <button class="link" data-cmd="settings">cài đặt model</button></h2>
        <div class="row"><label>Model <select id="model"></select></label>
          <label id="cmpWrap">So sánh với <select id="cmp"></select></label>
          <span id="est" class="muted"></span>
          <button class="link" data-cmd="showPrompt">Xem prompt gửi đi</button></div>
        <p class="muted" style="margin:6px 0 2px">Yêu cầu thêm (ghi chú sửa, ý mới…)</p>
        <textarea id="req" placeholder="vd. thêm cảnh Lê Lợi nhìn Tây Đô cháy · rút còn 6 cảnh · @C trong file đã ghi rõ…"></textarea>
        <div class="row" style="margin-top:6px" id="actions"></div>
        <div id="runs" class="col" style="margin-top:8px"></div>
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
$('cmp').addEventListener('change', () => vscode.postMessage({ type: 'compare', id: $('cmp').value }));
if (st.request) vscode.postMessage({ type: 'request', text: st.request });
document.addEventListener('click', (e) => {
  if (e.target.closest('#saveResult')) vscode.postMessage({ type: 'saveResult', result: {
    attempts: $('rAttempts').value, chosen: $('rChosen').value, model: $('rModel').value, note: $('rNote').value } });
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') render(m.vm);
  if (m.type === 'rendered') {
    $('pvTitle').innerHTML = esc(m.label) + (m.abs ? ' <button class="link" data-open="' + esc(m.abs) + '" data-line="' + m.line + '">sửa</button>'
      + '<button class="link" data-open="' + esc(m.abs) + '" data-how="preview">preview đầy đủ</button>' : '');
    $('pv').innerHTML = m.html;
  }
});

function renderMedia(md, scene) {
  if (!md) return '';
  const kinds = { R: 'Tham chiếu', I: 'Ảnh', V: 'Video AI', L: 'Lời', A: 'Âm thanh', E: 'Hiệu ứng' };
  const items = md.files.map((f) => {
    const label = esc(f.name) + (f.inRepo ? ' <span class="badge">repo</span>' : '');
    const body = f.src ? '<img src="' + esc(f.src) + '" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block">'
      : '<div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:var(--vscode-editorWidget-background)">' + (f.type === 'video' ? '🎬' : f.type === 'audio' ? '🔊' : '📄') + '</div>';
    return '<div class="card" style="width:200px;padding:4px">' + body + '<div style="font-size:.85em;word-break:break-all">' + label + '</div>'
      + '<button class="link" data-cmd="openMedia" data-arg="' + esc(f.abs) + '">mở</button><button class="link" data-cmd="revealMedia" data-arg="' + esc(f.abs) + '">thư mục</button></div>';
  }).join('');
  let h = '<h2>Media của ' + esc(scene) + ' <span class="muted">' + (md.rootFound ? esc(md.root) : 'không thấy thư mục media ' + esc(md.root || '') + ' — đặt trong Cài đặt AI') + '</span></h2>'
    + '<div class="row"><button data-cmd="import">Nhập file… (đổi tên theo mã)</button><span class="muted">chép file tải về vào thư mục media, file gốc giữ nguyên</span></div>'
    + '<div class="row" style="align-items:flex-start;margin-top:8px">' + (items || '<span class="muted">Chưa có file nào mang mã ' + esc(scene) + '.</span>') + '</div>';
  if (md.full) {
    const r = md.result || {};
    const nV = md.videos.length;
    h += '<h2>Ghi kết quả</h2><table>'
      + '<tr><th>Số lần sinh</th><td><input id="rAttempts" type="number" min="0" style="width:80px" value="' + esc(r.attempts ?? (nV || '')) + '"> <span class="muted">' + nV + ' file _V trong thư mục media</span></td></tr>'
      + '<tr><th>Bản chốt</th><td><input id="rChosen" list="vList" size="30" value="' + esc(r.chosen) + '" placeholder="vd. V3 — hoặc để trống"><datalist id="vList">' + md.videos.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist></td></tr>'
      + '<tr><th>Model video</th><td><input id="rModel" list="mList" size="30" value="' + esc(r.model) + '"><datalist id="mList"><option value="Seedance 2.0 mini"><option value="Seedance 2.0"><option value="Seedance 2.5"><option value="SeeDream 5.0 Pro"><option value="GPT Image 2.5"></datalist></td></tr>'
      + '<tr><th>Lỗi / ghi chú</th><td><textarea id="rNote" style="min-height:48px">' + esc(r.note) + '</textarea></td></tr>'
      + '</table><div class="row" style="margin-top:6px"><button id="saveResult">Lưu kết quả</button>' + (r.updated ? '<span class="muted">ghi lần cuối ' + esc(r.updated) + '</span>' : '') + '</div>';
  }
  return h;
}

function render(vm) {
  if (vm.error) { $('head').innerHTML = '<p class="err">' + esc(vm.error) + '</p>'; return; }
  vscode.setState({ ...vscode.getState(), stepId: vm.step.id, target: vm.target });
  const ex = { human: 'người làm', chat: 'AI văn bản', agent: 'Claude Code (agent)' }[vm.step.executor];
  let h = '<h1>' + esc(vm.title) + '</h1><div class="muted">' + ex + (vm.step.description ? ' · ' + esc(vm.step.description) : '') + '</div>';
  if (vm.scene) h += '<div class="card" style="margin-top:8px"><b>' + esc(vm.scene.code) + '</b> · ' + (vm.scene.seconds ?? '?') + ' s · ' + esc(vm.scene.status) + '<br>' + esc(vm.scene.title) + '</div>';
  if (!vm.gate.ok) h += '<p class="warn">🔒 Cổng chưa mở: ' + vm.gate.reasons.map(esc).join(' · ') + '</p>';
  $('head').innerHTML = h;
  $('media').innerHTML = renderMedia(vm.media, vm.target.scene);

  $('files').innerHTML = '<table>' + vm.files.map((f) => {
    const state = f.virtual ? '<span class="muted">' + f.chars + ' ký tự</span>'
      : !f.exists ? (f.optional ? '<span class="muted">không có</span>' : '<span class="err">chưa có</span>')
      : !f.found ? '<span class="err">không thấy mục</span>' : '<span class="muted">' + f.chars + ' ký tự</span>';
    let btn = '';
    if (f.virtual) btn = '<button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button>';
    else if (f.exists) btn = '<button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button>'
      + '<button class="link" data-open="' + esc(f.abs) + '" data-line="' + f.line + '">sửa</button>';
    else if (f.role === 'output') btn = '<button class="link" data-cmd="create">tạo file</button>';
    return '<tr><td>' + (f.role === 'output' ? '→ ' : '') + esc(f.label) + '</td><td>' + state + '</td><td style="white-space:nowrap">' + btn + '</td></tr>';
  }).join('') + '</table>';
  $('tools').innerHTML = vm.grid ? '<div style="margin-top:8px"><button class="sec" data-cmd="grid">▦ Sửa bảng cảnh dạng lưới</button></div>' : '';

  $('notes').innerHTML = vm.notes.length ? '<h2>Ghi chú trong các file này</h2>' + vm.notes.map((n) =>
    '<div><span class="badge">' + (n.kind === 'todo' ? '@C' : '@T') + '</span> <a data-open="' + esc(n.file) + '" data-line="' + n.line + '">'
    + esc(n.text) + '</a></div>').join('') : '';
  $('scripts').innerHTML = vm.scripts.length ? '<h2>Script</h2>' + vm.scripts.map((s) =>
    '<button class="sec" data-cmd="script" data-arg="' + esc(s.id) + '">▶ ' + esc(s.label) + '</button> ').join('') : '';

  $('ai').hidden = vm.step.executor === 'human';
  const opt = (cur, empty) => (empty ? '<option value="">' + empty + '</option>' : '') + vm.models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.title) + '</option>').join('');
  $('model').innerHTML = opt(vm.model);
  $('cmp').innerHTML = opt(vm.compare, '(không)');
  $('model').disabled = vm.step.executor === 'agent';
  $('cmpWrap').hidden = vm.step.executor !== 'chat' || vm.models.length < 2;
  $('est').innerHTML = vm.estimate ? '<span class="' + (vm.estimate.tokens > vm.estimate.cap ? 'err' : '') + '">ngữ cảnh ≈ ' + vm.estimate.tokens.toLocaleString('vi-VN') + ' token</span>'
      + (vm.estimate.usd !== undefined ? ' · ≈ ' + vm.estimate.usd.toFixed(3) + ' USD tiền vào' : '') : '';
  let a = '';
  if (vm.step.executor === 'agent') a = '<button data-cmd="handoff">Giao cho Claude Code (terminal)</button>';
  else if (vm.hasOutput) {
    const skip = vm.gate.ok ? '' : 'skip';
    a = '<button data-cmd="run" data-arg="' + skip + '">' + (vm.gate.ok ? 'Chạy' : 'Chạy (bỏ qua cổng)') + '</button>'
      + (vm.compare ? ' <button class="sec" data-cmd="runCompare" data-arg="' + skip + '">Chạy cả 2 để so sánh</button>' : '');
  }
  $('actions').innerHTML = a;

  $('runs').innerHTML = vm.runs.map((x) => {
    const tok = x.inputTokens !== undefined ? ' · ' + x.inputTokens + ' → ' + x.outputTokens + ' token' : ' · ≈ ' + x.estInputTokens + ' token vào';
    const cost = x.costUsd !== undefined ? ' · ' + x.costUsd.toFixed(3) + ' USD' + (x.costReported ? '' : ' (ước tính)') : '';
    const label = { running: '⏳ đang chạy…', done: '✅ xong', error: '❌ lỗi', applied: '✅ đã ghi vào file', discarded: 'đã bỏ', 'handed-off': '↗ đã giao Claude Code' }[x.status] || x.status;
    let b = '';
    if (x.status === 'running') b = '<button class="sec" data-cmd="cancel" data-arg="' + esc(x.id) + '">Hủy</button>';
    if (x.status === 'done') b = vm.hasOutput ? '<button data-cmd="diff" data-arg="' + esc(x.id) + '">Xem diff</button><button data-cmd="apply" data-arg="' + esc(x.id) + '">Nhận</button>'
      : '<button data-cmd="answer" data-arg="' + esc(x.id) + '">Xem trả lời</button>';
    if (x.status !== 'running') b += '<button class="sec" data-cmd="discard" data-arg="' + esc(x.id) + '">' + (x.status === 'done' ? 'Bỏ' : 'Ẩn') + '</button>';
    return '<div class="card"><b>' + esc(x.modelId) + '</b> · ' + label + tok + cost
      + (x.error ? '<div class="err">' + esc(x.error) + '</div>' : '')
      + '<div class="row" style="margin-top:6px">' + b + (x.status === 'done' && vm.hasOutput ? '<span class="muted">Nhận một phần: sửa bản bên phải trong diff rồi bấm Nhận</span>' : '') + '</div></div>';
  }).join('');
  $('recent').innerHTML = vm.recent.length ? '<h2>Lần chạy gần đây</h2><table>' + vm.recent.map((x) =>
    '<tr><td>' + esc(x.startedAt.slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(x.modelId) + '</td><td>' + esc(x.status) + '</td><td>'
    + (x.costUsd !== undefined ? x.costUsd.toFixed(3) + ' USD' : '') + '</td></tr>').join('') + '</table>' : '';
}
vscode.postMessage({ type: 'ready' });
`;
