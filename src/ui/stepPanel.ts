// Tab của một ĐỐI TƯỢNG (dự án / tập / phân đoạn / cảnh): trên cùng overview + sơ đồ các bước của cấp đó, bấm bước nào
// thì nội dung bước đó hiện bên dưới (lần đầu: bước 1). Mỗi đối tượng một tab, mở lại thì nhảy về tab cũ.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STATUS_LABEL, Scope, StepSpec, statusSymbol } from '../core/config';
import { ApproveLevel, applyPlan, planApprove } from '../core/approve';
import { formatDuration } from '../core/markdown';
import { ResolvedStep, StepTarget, buildPrompt, extractOutput, mergeOutput, resolveStep, targetKey } from '../core/context';
import { ModelConfig, estimateCost } from '../core/providers';
import { MediaFile, listSceneMedia, mediaTargetName, upsertResult } from '../core/results';
import { RunRecord, newRunId, readRuns, runPath, writeRun } from '../core/runs';
import { fill, findEpisode, findScene, findSegment } from '../core/scanner';
import { scanBlender } from '../core/blender';
import { gotoShotInBlender } from './blenderPanel';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { handleOpen, renderMarkdown, shell } from './webview';

interface PanelState {
  /** bước đang hiện — trống thì lấy bước đầu của cấp */
  stepId?: string;
  target: StepTarget;
}

export function scopeOf(t: StepTarget): Scope {
  return t.scene ? 'scene' : t.seg ? 'segment' : t.ep ? 'episode' : 'project';
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

  /** yêu cầu thêm / model / model so sánh — riêng cho từng bước */
  private requests = new Map<string, string>();
  private modelIds = new Map<string, string>();
  private compareIds = new Map<string, string>();
  /** các lần chạy của tab này (mới nhất đầu) — chạy song song được để so sánh model */
  private runs: RunRecord[] = [];
  private aborts = new Map<string, AbortController>();
  private shown?: number;
  private readonly subs: vscode.Disposable[] = [];

  /** Mở tab của đối tượng; có stepId thì chọn luôn bước đó */
  static open(studio: Studio, models: ModelRegistry, stepId: string | undefined, target: StepTarget): void {
    const key = targetKey(target);
    const existing = this.panels.get(key);
    if (existing) {
      if (stepId && stepId !== existing.state.stepId) existing.select(stepId);
      existing.panel.reveal();
      return;
    }
    const icon = { project: '📁', episode: '🎬', segment: '▤', scene: '◆' }[scopeOf(target)];
    const panel = vscode.window.createWebviewPanel(this.viewType, `${icon} ${key}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: StepPanel.roots(studio),
    });
    new StepPanel(panel, studio, models, { stepId, target });
  }

  static revive(panel: vscode.WebviewPanel, studio: Studio, models: ModelRegistry, state: PanelState | undefined): void {
    if (!state?.target) {
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
    const key = targetKey(state.target);
    StepPanel.panels.set(key, this);
    if (!state.stepId || !this.steps().some((x) => x.id === state.stepId)) state.stepId = this.steps()[0]?.id;
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

  /** các bước của cấp này, theo thứ tự trong pipeline.yaml */
  private steps(): StepSpec[] {
    const scope = scopeOf(this.state.target);
    return (this.studio.config?.pipeline.steps ?? []).filter((x) => x.scope === scope);
  }

  private get stepId(): string {
    return this.state.stepId ?? '';
  }

  private get request(): string {
    return this.requests.get(this.stepId) ?? '';
  }

  select(stepId: string): void {
    this.state.stepId = stepId;
    this.shown = undefined;
    this.post();
  }

  private resolve(): ResolvedStep | undefined {
    const step = this.studio.config?.pipeline.steps.find((s) => s.id === this.state.stepId);
    if (!step || !this.studio.model) return undefined;
    return resolveStep(this.studio.model, step, this.state.target);
  }

  private model(): ModelConfig | undefined {
    const id = this.modelIds.get(this.stepId);
    return (id && this.models.get(id)) || this.models.forStep(this.stepId);
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

  // ------------------------------------------------------------------ overview + sơ đồ bước
  private nodes() {
    const t = this.state.target;
    const ep = this.studio.model && findEpisode(this.studio.model, t.ep);
    const seg = findSegment(ep, t.seg);
    const scene = findScene(seg, t.scene);
    return { ep, seg, scene };
  }

  private overview() {
    const model = this.studio.model!;
    const st = model.config.project.status;
    const scope = scopeOf(this.state.target);
    const { ep, seg, scene } = this.nodes();
    const crumbs: { label: string; target?: StepTarget }[] = [{ label: model.config.project.name, target: {} }];
    if (ep) crumbs.push({ label: ep.id, target: { ep: ep.id } });
    if (seg) crumbs.push({ label: seg.code, target: { ep: ep!.id, seg: seg.code } });
    if (scene) crumbs.push({ label: scene.code });
    const facts: { k: string; v: string }[] = [];
    const links: { cmd: string; arg?: string; label: string }[] = [];
    const count = (list: { status?: string }[]) => `${list.length}${list.length ? ` (✅ ${list.filter((x) => x.status === 'done').length})` : ''}`;
    let title = model.config.project.name;
    let status: string | undefined;
    let approve: { level: ApproveLevel; label: string; done: boolean } | undefined;
    if (scope === 'project') {
      const live = model.episodes.filter((e) => !e.legacy);
      facts.push({ k: 'Tập', v: `${model.episodes.length} (${live.length} đã vào cấu trúc mới)` });
      facts.push({ k: 'Cảnh', v: count(live.flatMap((e) => e.segments.flatMap((s) => s.scenes))) });
      const next = model.episodes.find((e) => e.releaseDate && e.releaseDate >= new Date());
      if (next) facts.push({ k: 'Phát hành kế tiếp', v: `${next.id} · ${next.releaseDate!.toLocaleDateString('vi-VN')}` });
      links.push({ cmd: 'dashboard', label: '📊 Tổng quan' }, { cmd: 'settings', label: '⚙ Cài đặt AI' });
    } else if (scope === 'episode' && ep) {
      title = `${ep.id} · ${ep.slug.replace(/-/g, ' ')}`;
      const segs = ep.segments.filter((x) => !x.dropped);
      const scenes = segs.flatMap((x) => x.scenes).filter((c) => c.status !== 'dropped');
      facts.push({ k: 'Phân đoạn', v: count(segs) }, { k: 'Cảnh', v: count(scenes) });
      facts.push({ k: 'Giây cảnh', v: `${formatDuration(ep.sceneSeconds)}${model.config.project.episodeCapSeconds ? ` / trần ${formatDuration(model.config.project.episodeCapSeconds)}` : ''}` });
      if (ep.releaseDate) facts.push({ k: 'Phát hành', v: ep.releaseDate.toLocaleDateString('vi-VN') });
      links.push({ cmd: 'openBlender', label: '🧊 Blender của tập' });
      if (ep.files['readme']) links.push({ cmd: 'openFile', arg: ep.files['readme'], label: 'README tập' });
      approve = { level: 'episode', label: `tập ${ep.id}`, done: segs.length > 0 && segs.every((x) => x.status === 'done') && scenes.every((c) => c.status === 'done') };
    } else if (scope === 'segment' && ep && seg) {
      title = `${seg.code} · ${seg.name}`;
      status = seg.statusText;
      const scenes = seg.scenes.filter((c) => c.status !== 'dropped');
      facts.push({ k: 'Trạng thái', v: `${statusSymbol(seg.status, st)} ${seg.status ? STATUS_LABEL[seg.status] : '—'}` });
      facts.push({ k: 'Cảnh', v: count(scenes) });
      facts.push({ k: 'Giây', v: `${scenes.reduce((a, c) => a + (c.seconds ?? 0), 0)} s cảnh${seg.plannedSeconds ? ` / dự kiến ${seg.plannedSeconds} s` : ''}` });
      if (seg.files['canh']) links.push({ cmd: 'grid', label: '▦ Bảng cảnh dạng lưới' });
      links.push({ cmd: 'openBlender', label: '🧊 Blender' });
      if (seg.dir) links.push({ cmd: 'reveal', arg: seg.dir, label: 'thư mục' });
      approve = { level: 'segment', label: `phân đoạn ${seg.code}`, done: seg.status === 'done' && scenes.every((c) => c.status === 'done') };
    } else if (scope === 'scene' && seg && scene) {
      title = `${scene.code}${scene.seconds ? ` · ${scene.seconds} s` : ''}`;
      facts.push({ k: 'Trạng thái', v: `${statusSymbol(scene.status, st)} ${scene.status ? STATUS_LABEL[scene.status] : '—'}` });
      facts.push({ k: 'Hình', v: scene.title });
      links.push({ cmd: 'openFile', arg: `${scene.file}#${scene.line}`, label: `dòng ${scene.code} trong ${seg.code}_canh.md` });
      links.push({ cmd: 'grid', label: '▦ Bảng cảnh' }, { cmd: 'openBlender', label: '🧊 Blender' });
      approve = { level: 'scene', label: `cảnh ${scene.code}`, done: scene.status === 'done' };
    }
    return { scope, title, status, crumbs, facts, links, approve };
  }

  private stepStates() {
    const model = this.studio.model!;
    const { scene } = this.nodes();
    return this.steps().map((x) => {
      const r = resolveStep(model, x, this.state.target);
      let state: 'done' | 'todo' | 'locked' | 'none' = 'none';
      if (!r.gate.ok) state = 'locked';
      else if (r.output) state = r.output.exists && r.output.found ? 'done' : 'todo';
      else if (x.view?.includes('media')) state = scene?.result ? 'done' : 'todo';
      return { id: x.id, no: x.no, title: x.title, executor: x.executor, state, model: x.executor === 'chat' ? this.models.forStep(x.id)?.id : undefined };
    });
  }

  // ------------------------------------------------------------------ view model
  private vm() {
    if (!this.studio.model) return { error: this.studio.error ?? 'Chưa nạp dự án' };
    const overview = this.overview();
    const steps = this.stepStates();
    const rs = this.resolve();
    if (!rs) return { overview, steps, current: this.stepId, target: this.state.target, error: steps.length ? `Không thấy bước "${this.stepId}"` : 'Cấp này chưa có bước nào trong .studio/pipeline.yaml' };
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
    let blender: object | undefined;
    if (ep && !ep.legacy && rs.target.scene) {
      const bm = scanBlender(this.studio.model!, ep);
      const shots = bm.shots.filter((s) => s.scene === rs.target.scene);
      blender = {
        shots: shots.map((s) => ({ code: s.code, file: s.file, camera: s.camera, start: s.start, end: s.end, source: s.source, conflict: s.conflicts.length > 0, seconds: (s.end - s.start + 1) / bm.cfg.fps })),
        fileAbs: Object.fromEntries(bm.files.filter((f) => f.abs).map((f) => [f.name, f.abs])),
        issues: bm.issues.filter((i) => i.scene === rs.target.scene).map((i) => i.message),
      };
    }
    return {
      overview,
      steps,
      current: this.stepId,
      request: this.request,
      title: rs.title,
      blender,
      step: rs.step,
      target: rs.target,
      gate: rs.gate,
      files,
      notes,
      models: this.models.list().map((x) => ({ id: x.id, title: x.title ?? x.id })),
      model: m?.id,
      compare: this.compareIds.get(this.stepId),
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
      runs: this.runs.filter((r) => r.step === rs.step.id),
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
        this.requests.set(m.step ?? this.stepId, String(m.text ?? ''));
        return this.post();
      case 'model':
        this.modelIds.set(this.stepId, m.id);
        return this.post();
      case 'compare':
        if (m.id) this.compareIds.set(this.stepId, m.id);
        else this.compareIds.delete(this.stepId);
        return this.post();
      case 'selectStep':
        return this.select(String(m.id));
      case 'approve':
        return this.approve(m.undo === true);
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
          case 'dashboard':
            return vscode.commands.executeCommand('aiFilmStudio.openDashboard');
          case 'target':
            return StepPanel.open(this.studio, this.models, undefined, JSON.parse(m.arg));
          case 'openFile': {
            const [f, line] = String(m.arg).split('#');
            return handleOpen({ path: f, line: Number(line ?? 0) });
          }
          case 'reveal':
            return vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.arg));
          case 'openBlender':
            return vscode.commands.executeCommand('aiFilmStudio.openBlender', { ep: this.state.target.ep });
          case 'blenderGoto': {
            const [file, start, end, cam] = String(m.arg).split('|');
            return gotoShotInBlender(this.studio, file, Number(start), Number(end), cam || undefined);
          }
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
      const cid = this.compareIds.get(this.stepId);
      const c = cid && this.models.get(cid);
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

  // ------------------------------------------------------------------ duyệt theo cấp
  private async approve(undo: boolean): Promise<void> {
    const model = this.studio.model;
    const ov = model && this.overview();
    const { ep, seg, scene } = this.nodes();
    if (!model || !ov?.approve || !ep) return;
    const plan = planApprove(model, ov.approve.level, ep, seg, scene?.code, undo ? 'review' : 'done');
    if (!plan.changes.length) {
      vscode.window.showInformationMessage(`${ov.approve.label}: không có dòng nào cần đổi.`);
      return;
    }
    const files = [...new Set(plan.changes.map((c) => path.basename(c.file)))];
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && plan.changes.some((c) => c.file === d.uri.fsPath));
    if (dirty.length) {
      vscode.window.showWarningMessage(`${dirty.map((d) => path.basename(d.uri.fsPath)).join(', ')} đang có thay đổi chưa lưu — lưu trước rồi duyệt.`);
      return;
    }
    const codes = plan.changes.map((c) => c.code);
    const ok = await vscode.window.showInformationMessage(
      `${undo ? 'Bỏ duyệt' : 'Duyệt'} ${plan.label}: đổi trạng thái ${codes.length} dòng (${codes.slice(0, 12).join(', ')}${codes.length > 12 ? '…' : ''}) trong ${files.join(', ')}?`,
      { modal: true },
      undo ? 'Bỏ duyệt' : 'Duyệt',
    );
    if (!ok) return;
    const res = applyPlan(plan);
    vscode.window.showInformationMessage(
      `${undo ? 'Đã bỏ duyệt' : 'Đã duyệt'} ${plan.label} (${codes.length - res.skipped.length} dòng)${res.skipped.length ? ` · bỏ qua ${res.skipped.join(', ')} (ô vừa bị sửa)` : ''}. Xem bằng git diff.`,
    );
    this.studio.refresh();
  }

  // ------------------------------------------------------------------ html
  private html(): string {
    return shell(
      this.panel.webview,
      'Bước',
      `<style>
        .ov { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start; margin-top:10px }
        .crumbs { font-size:.9em } .crumbs a { margin-right:2px }
        .facts { display:flex; flex-wrap:wrap; gap:4px 18px; margin-top:4px } .facts b { color:var(--vscode-descriptionForeground); font-weight:normal }
        .stepper { display:flex; flex-wrap:wrap; align-items:center; gap:2px 4px; border:2px solid var(--vscode-focusBorder); border-radius:6px; padding:8px 10px; margin:10px 0 6px }
        .stepper .st { background:transparent; color:var(--vscode-foreground); border:1px solid transparent; padding:4px 10px; border-radius:14px; cursor:pointer; font:inherit }
        .stepper .st:hover { border-color:var(--vscode-focusBorder) }
        .stepper .st.cur { background:var(--vscode-button-background); color:var(--vscode-button-foreground); font-weight:600 }
        .stepper .st .mk { margin-left:4px; font-size:.85em }
        .stepper .st.done .mk { color:var(--vscode-testing-iconPassed, #3c3) }
        .stepper .st.cur .mk { color:inherit }
        .stepper .ar { color:var(--vscode-descriptionForeground) }
        .appr { font-weight:600 }
      </style>
      <div id="overview"></div>
      <div id="stepper" class="stepper"></div>
      <div id="head"></div>
      <div id="body">
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
      </div>
      </div>`,
      CLIENT_JS,
    );
  }
}

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let lastStep = null;
let t;
$('req').addEventListener('input', () => { clearTimeout(t); const step = lastStep; t = setTimeout(() =>
  vscode.postMessage({ type: 'request', step, text: $('req').value }), 400); });
$('model').addEventListener('change', () => vscode.postMessage({ type: 'model', id: $('model').value }));
$('cmp').addEventListener('change', () => vscode.postMessage({ type: 'compare', id: $('cmp').value }));
document.addEventListener('click', (e) => {
  const sb = e.target.closest('[data-step]');
  if (sb) vscode.postMessage({ type: 'selectStep', id: sb.dataset.step });
  const ab = e.target.closest('[data-approve]');
  if (ab) vscode.postMessage({ type: 'approve', undo: ab.dataset.approve === 'undo' });
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

function renderTop(vm) {
  const o = vm.overview;
  if (!o) { $('overview').innerHTML = ''; $('stepper').hidden = true; return; }
  const crumbs = o.crumbs.map((c, i) => c.target && i < o.crumbs.length - 1
    ? '<a data-cmd="target" data-arg="' + esc(JSON.stringify(c.target)) + '">' + esc(c.label) + '</a>' : '<b>' + esc(c.label) + '</b>').join(' › ');
  const facts = o.facts.map((f) => '<span><b>' + esc(f.k) + ':</b> ' + esc(f.v) + '</span>').join('');
  const links = o.links.map((l) => '<button class="link" data-cmd="' + esc(l.cmd) + '"' + (l.arg ? ' data-arg="' + esc(l.arg) + '"' : '') + '>' + esc(l.label) + '</button>').join('');
  let appr = '';
  if (o.approve) appr = o.approve.done
    ? '<div class="col" style="align-items:flex-end"><span class="ok appr">✅ ' + esc(o.approve.label) + ' đã duyệt</span><button class="sec" data-approve="undo">Bỏ duyệt</button></div>'
    : '<button class="appr" data-approve="do" title="đổi trạng thái thành ✅ cho ' + esc(o.approve.label) + (o.approve.level === 'scene' ? '' : ' và mọi cảnh bên trong') + '">✅ Duyệt ' + esc(o.approve.label) + '</button>';
  $('overview').innerHTML = '<div class="ov"><div style="flex:1 1 400px"><div class="crumbs muted">' + crumbs + '</div><h1 style="margin:2px 0">' + esc(o.title) + '</h1>'
    + '<div class="facts">' + facts + '</div><div style="margin-top:4px">' + links + '</div></div>' + appr + '</div>';
  const mk = { done: '✓', locked: '🔒', todo: '', none: '' };
  $('stepper').hidden = !vm.steps.length;
  $('stepper').innerHTML = vm.steps.map((x, i) => (i ? '<span class="ar">→</span>' : '')
    + '<button class="st ' + x.state + (x.id === vm.current ? ' cur' : '') + '" data-step="' + esc(x.id) + '" title="' + esc(x.title + (x.model ? ' · ' + x.model : '') + (x.state === 'locked' ? ' · cổng chưa mở' : '')) + '">'
    + esc(x.no) + ' ' + esc(shortTitle(x.title)) + (mk[x.state] ? '<span class="mk">' + mk[x.state] + '</span>' : '') + '</button>').join('');
}
function shortTitle(t) { return String(t).replace(/\s*[—(].*$/, '').replace(/^Kịch bản chi tiết$/, 'Kịch bản'); }

function render(vm) {
  renderTop(vm);
  if (vm.current !== lastStep) { lastStep = vm.current; $('req').value = vm.request || ''; $('pv').innerHTML = '<p class="muted">—</p>'; $('pvTitle').innerHTML = 'Xem nhanh <span class="muted">(bấm "xem" một file bên trái)</span>'; }
  vscode.setState({ target: vm.target || (vscode.getState() || {}).target, stepId: vm.current });
  $('body').hidden = !!vm.error;
  if (vm.error) { $('head').innerHTML = '<p class="err">' + esc(vm.error) + '</p>'; return; }
  const ex = { human: 'người làm', chat: 'AI văn bản', agent: 'Claude Code (agent)' }[vm.step.executor];
  let h = '<h2 style="margin-top:6px">' + esc(vm.step.no + ' ' + vm.step.title) + '</h2><div class="muted">' + ex + (vm.step.description ? ' · ' + esc(vm.step.description) : '') + '</div>';
  if (vm.blender) {
    const b = vm.blender;
    h += '<div class="card" style="margin-top:8px">🧊 <b>Blender</b> <button class="link" data-cmd="openBlender">tab Blender của tập</button>'
      + (b.shots.length ? '<table style="margin-top:4px"><tr><th>Shot</th><th>File</th><th>Camera</th><th>Frame</th><th>Giây</th><th></th></tr>' + b.shots.map((x) =>
        '<tr><td>' + esc(x.code) + '</td><td>' + (b.fileAbs[x.file] ? '<a data-open="' + esc(b.fileAbs[x.file]) + '">' + esc(x.file) + '</a>' : esc(x.file)) + '</td><td>' + esc(x.camera || '') + '</td>'
        + '<td>' + x.start + ' – ' + x.end + (x.conflict ? ' <span class="err">⚠</span>' : '') + ' <span class="badge">' + esc(x.source) + '</span></td><td>' + x.seconds.toFixed(1) + '</td>'
        + '<td><button class="link" data-cmd="blenderGoto" data-arg="' + esc([x.file, x.start, x.end, x.camera || ''].join('|')) + '">xem trong Blender</button></td></tr>').join('') + '</table>'
        : ' <span class="muted">chưa có shot nào</span>')
      + b.issues.map((i) => '<div class="muted">ℹ ' + esc(i) + '</div>').join('') + '</div>';
  }
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
