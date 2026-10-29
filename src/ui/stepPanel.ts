import { exec } from 'child_process';
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
import { Mark, appendAttempt, parseMark } from '../core/attempts';
import { RunRecord, newRunId, readRuns, runPath, writeRun } from '../core/runs';
import { episodeLabel, fill, findEpisode, findScene, findSegment } from '../core/scanner';
import { episodeDuration, readIdea, writeIdea } from '../core/idea';
import { outlineStatus, stripOutlineStatus, withOutlineStatus } from '../core/outline';
import { isResource } from '../core/resources';
import { scenePrompts } from '../core/scenePrompts';
import { TableProtect, lockedRows, protectSections, protectTable } from '../core/protect';
import { EPISODE_CODE_RE } from '../core/episodeList';
import { mergeSegmentTable, setSegmentStatus } from '../core/segmentTable';
import { slugify } from '../core/episodeList';
import { createSegmentDir } from './commands';
import { GRID_BODY, GridController, finalizeCodes, finalizeEpisodeList, gridClientJs } from './gridPanel';
import { CHAT_BODY, CHAT_JS, ChatController } from './chat';
import { scanBlender } from '../core/blender';
import { gotoShotInBlender } from './blenderPanel';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { handleOpen, renderMarkdown, shell } from './webview';

interface PanelState {
  /** bước đang hiện — trống thì lấy bước đầu của cấp */
  stepId?: string;
  target: StepTarget;
  /** ③ Dàn ý ở cấp dự án: tập đang sửa */
  olEp?: string;
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
  /** lần chạy cho đối tượng khác tab (③ Dàn ý ở tab dự án chạy cho từng tập) → bước + đối tượng của nó */
  private runTargets = new Map<string, { step: StepSpec; target: StepTarget }>();
  /** khung chat cuối trang */
  private chat: ChatController;
  private shown?: number;
  /** lưới bảng cảnh nằm trong tab (bước ⑥ Phân cảnh) */
  private gridCtl?: GridController;
  private gridKind?: 'scenes' | 'lines' | 'episodes';
  private readonly subs: vscode.Disposable[] = [];

  /** Mở tab của đối tượng; có stepId thì chọn luôn bước đó */
  static open(studio: Studio, models: ModelRegistry, stepId: string | undefined, target: StepTarget, autoRun = false): void {
    const key = targetKey(target);
    const existing = this.panels.get(key);
    if (existing) {
      if (stepId && stepId !== existing.state.stepId) existing.select(stepId);
      existing.panel.reveal();
      if (autoRun) existing.startRuns(false, false);
      return;
    }
    const icon = { project: '📁', episode: '🎬', segment: '▤', scene: '◆' }[scopeOf(target)];
    const ep = target.ep && studio.model ? findEpisode(studio.model, target.ep) : undefined;
    const label = ep ? key.replace(ep.id, ep.release ?? ep.id) : key;
    const panel = vscode.window.createWebviewPanel(this.viewType, `${icon} ${label}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: StepPanel.roots(studio),
    });
    const sp = new StepPanel(panel, studio, models, { stepId, target });
    if (autoRun) sp.startRuns(false, false);
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
    this.chat = new ChatController(studio, key, (m) => this.panel.webview.postMessage(m), () => this.chatContext());
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

  /** bước + đối tượng của một lần chạy (mặc định: bước đang mở của tab) */
  private rsOf(id: string): ResolvedStep | undefined {
    const t = this.runTargets.get(id);
    return t && this.studio.model ? resolveStep(this.studio.model, t.step, t.target) : this.resolve();
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
    if (ep) crumbs.push({ label: ep.release ?? ep.id, target: { ep: ep.id } });
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
      links.push({ cmd: 'dashboard', label: '📊 Trạng thái dự án' }, { cmd: 'episodes', label: '▦ Danh sách tập' }, { cmd: 'settings', label: '⚙ Cài đặt AI' });
    } else if (scope === 'episode' && ep) {
      title = episodeLabel(ep, ' · ');
      facts.push({ k: 'Mã sản xuất', v: ep.id });
      const segs = ep.segments.filter((x) => !x.dropped);
      const scenes = segs.flatMap((x) => x.scenes).filter((c) => c.status !== 'dropped');
      facts.push({ k: 'Phân đoạn', v: count(segs) }, { k: 'Cảnh', v: count(scenes) });
      const dur = episodeDuration(model.config.root, model.config.project.idea, model.config.project.episodeCapSeconds);
      facts.push({ k: 'Giây cảnh', v: `${formatDuration(ep.sceneSeconds)}${dur.text ? ` / khung ${dur.text}` : dur.max ? ` / trần ${formatDuration(dur.max)}` : ''}` });
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

  // ------------------------------------------------------------------ ngữ cảnh cho khung chat cuối trang
  private chatContext(): { label: string; text: string } {
    if (!this.studio.model) return { label: 'chưa nạp dự án', text: '' };
    const o = this.overview();
    const rs = this.resolve();
    const out: string[] = [];
    out.push(`- Đối tượng: ${o.crumbs.map((c) => c.label).join(' › ')} — **${o.title}**`);
    if (o.facts.length) out.push(`- Số liệu: ${o.facts.map((f) => `${f.k}: ${f.v}`).join(' · ')}`);
    const steps = this.steps();
    if (steps.length) out.push(`- Các bước của cấp này: ${steps.map((x) => `${x.no} ${x.title}`).join(' → ')}`);
    if (rs) {
      out.push(`- Bước đang mở: **${rs.step.no} ${rs.step.title}** (${rs.step.executor === 'human' ? 'người làm' : rs.step.executor === 'chat' ? 'có nút AI' : 'agent'})${rs.step.description ? ` — ${rs.step.description}` : ''}`);
      const files = [...rs.inputs, ...(rs.output ? [rs.output] : [])].filter((f) => f.rel && !f.virtual);
      if (files.length) out.push(`- File liên quan:\n${files.map((f) => `  - \`${f.rel}\`${f.ref.select ? ` (${f.ref.select})` : ''} — ${f.role === 'output' ? 'đầu ra' : f.label}${f.exists ? '' : ' · chưa có'}`).join('\n')}`);
      // nội dung đang mở: ô sửa của trang (dàn ý, kịch bản…) hoặc file đầu ra của bước
      const ed: any = this.editorVm(rs.step.view ?? []);
      const main = ed?.text ?? ed?.rows ?? (rs.output?.text || '');
      const name = ed?.kind === 'outlines' ? `dàn ý ${ed.cur ?? ''} (${ed.file ?? ''})` : ed?.file ?? rs.output?.rel ?? '';
      if (main) out.push(`\n### Nội dung đang mở — ${name}\n\n${main}`);
      if (ed?.kind === 'outlines') out.push(`\n### Trạng thái dàn ý các tập\n${ed.rows.map((r: any) => `- ${r.code} ${r.release} ${r.name}: ${r.status}`).join('\n')}`);
    }
    return { label: `${o.title}${rs ? ` · ${rs.step.no} ${rs.step.title}` : ''}`, text: out.join('\n') };
  }

  // ------------------------------------------------------------------ view model
  private vm() {
    if (!this.studio.model) return { error: this.studio.error ?? 'Chưa nạp dự án' };
    const overview = this.overview();
    const steps = this.stepStates();
    const rs = this.resolve();
    if (!rs) return { overview, steps, current: this.stepId, target: this.state.target, error: steps.length ? `Không thấy bước "${this.stepId}"` : 'Cấp này chưa có bước nào trong .studio/pipeline.yaml' };
    const m = this.model();
    // tài liệu dùng chung (Tài nguyên dự án) không liệt kê ở tab tập / phân đoạn / cảnh — AI vẫn đọc
    const res = this.studio.config!.project.resources;
    const all = [...rs.inputs, ...(rs.output ? [rs.output] : [])];
    const shared = rs.step.scope === 'project' ? [] : all.filter((f) => f.role !== 'output' && !f.virtual && f.rel && isResource(f.rel, res));
    const files = all.map((f, i) => ({
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
      shared: shared.includes(f),
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
    if (view.includes('media') || view.includes('render')) {
      // ⑩ Blender: chỉ ảnh / clip render tham chiếu (_R) — ảnh, video AI không đưa vào tool (28/10/2026)
      const files = this.sceneMedia(rs).filter((f) => !view.includes('render') || f.kind === 'R').map((f) => ({
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
        renderOnly: view.includes('render'),
        files,
        root: this.studio.model?.mediaRoot,
        rootFound: this.studio.model?.mediaFound,
        result: scene?.result,
        videos: files.filter((f) => f.kind === 'V').map((f) => f.name),
        criteria: this.studio.config?.project.attemptLog?.criteria ?? [],
        seconds: scene?.seconds,
        logged: seg?.attempts.filter((a) => a.scene === rs.target.scene).length ?? 0,
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
      editor: this.editorVm(view),
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
      grid: (view.includes('grid') && !!seg?.files['canh']) || (view.includes('lines') && !!seg?.files['loi']) || (view.includes('synopsis') && !!this.studio.config?.project.episodeList),
      gridKind: view.includes('lines') ? 'lines' : view.includes('synopsis') ? 'episodes' : 'scenes',
      scene: scene && {
        code: scene.code,
        seconds: scene.seconds,
        status: scene.status ? STATUS_LABEL[scene.status] : '',
        title: scene.title,
      },
      media,
      runs: this.runs.filter((r) => r.step === rs.step.id || this.runTargets.has(r.id)),
      batch: view.includes('outlines'),
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
    if (m.__chat) return this.chat.onMessage(m);
    if (m.__grid) {
      const t = this.state.target;
      const view = this.resolve()?.step.view ?? [];
      const kind = view.includes('lines') ? 'lines' : view.includes('synopsis') ? 'episodes' : 'scenes';
      if (!t.seg && kind !== 'episodes') return;
      if (!this.gridCtl || this.gridKind !== kind) {
        this.gridCtl = new GridController(this.studio, (x) => this.panel.webview.postMessage(x), t.ep, t.seg, kind);
        this.gridKind = kind;
      }
      return this.gridCtl.onMessage(m);
    }
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
      case 'logAttempt':
        return this.logAttempt(m.a);
      case 'saveIdea':
        return this.saveIdea(m.values ?? {});  // khóa = số thứ tự ô trong form
      case 'saveSynopsis':
        return this.saveSynopsis(String(m.text ?? ''));
      case 'saveOutline':
        return this.saveOutline(String(m.text ?? ''), m.next === true);
      case 'olPick':
        this.state.olEp = String(m.ep ?? '');
        return this.post();
      case 'saveOutlineOf':
        return this.saveOutlineOf(String(m.ep ?? ''), String(m.text ?? ''), m.done === undefined ? undefined : m.done === true, m.next === true);
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text ?? ''));
        return void vscode.window.showInformationMessage(`Đã chép ${m.label ? m.label + ' — ' : ''}${String(m.text ?? '').length} ký tự.`);
      case 'saveSection':
        return this.saveSection(String(m.text ?? ''), m.next === true);
      case 'segStatus':
        return this.saveSegStatus(m.changes ?? {});
      case 'phanCanh':
        return this.phanCanh();
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
          case 'episodes':
            return vscode.commands.executeCommand('aiFilmStudio.editEpisodeList');
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

  async startRuns(skipGate: boolean, compare: boolean): Promise<void> {
    const rs = this.resolve();
    const main = this.model();
    if (!rs || !main) return;
    if (rs.step.view?.includes('outlines')) return this.suggestOutlines(main);
    const lk = this.lock(rs);
    if (lk.blocked) return void vscode.window.showWarningMessage(lk.blocked);
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
    const lk = this.lock(rs);
    const request = lk.codes.length ? `${this.request}\n\n⭐ ĐÃ DUYỆT — giữ NGUYÊN VĂN, không viết lại (tool sẽ tự khôi phục): ${lk.codes.join(', ')}. Chỉ tạo lại các mục chưa duyệt, theo ghi chú của chúng.`.trim() : this.request;
    const bp = buildPrompt(this.studio.model!, rs, request, provider.loadsProjectInstructions);
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
    if (rs.step.id !== this.stepId || targetKey(rs.target) !== targetKey(this.state.target)) this.runTargets.set(rec.id, { step: rs.step, target: rs.target });
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
      if (rs.output) {
        const merged = mergeOutput(resolveStep(this.studio.model!, rs.step, rs.target), extractOutput(res.text));
        const pr = lk.apply(merged);
        files['proposal.md'] = pr.text;
        if (pr.restored.length) vscode.window.showInformationMessage(`AI sửa vào phần đã duyệt — tool khôi phục nguyên văn: ${pr.restored.join(', ')}.`);
      }
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
    const rs = this.rsOf(id);
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
    const rs = this.rsOf(id);
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
    // ② Chia tập: xóa tập ❌ bỏ, cấp mã cho tập MỚI, đánh lại TAP
    if (rs.step.protect === 'episodes') {
      const f = finalizeEpisodeList(this.studio);
      if (f && (f.removed.length || f.added.length)) {
        vscode.window.showInformationMessage(`Danh sách tập: ${f.removed.length ? 'xóa tập bỏ ' + f.removed.join(', ') : ''}${f.removed.length && f.added.length ? ' · ' : ''}${f.added.length ? 'cấp mã mới ' + f.added.join(', ') : ''} — đã đánh lại TAP.`);
      }
    }
    // ⑥ / ⑦: tool cấp mã cảnh / số câu cho dòng mới AI ghi "MỚI" / "<cảnh>_L?", rồi tự chạy script đi kèm (chú thích mã · tổng hợp lời)
    if ((rs.step.protect === 'scenes' || rs.step.protect === 'lines') && rs.target.ep && rs.target.seg) {
      const added = finalizeCodes(this.studio, rs.target.ep, rs.target.seg, rs.step.protect);
      if (added.length) vscode.window.showInformationMessage(`Tool cấp mã mới: ${added.join(', ')}.`);
      for (const id of rs.step.protect === 'scenes' ? ['chu-thich-ma'] : ['tong-hop-loi']) await this.scriptQuiet(id, rs);
    }
    if (rs.step.view?.some((v) => ['grid', 'lines', 'synopsis'].includes(v))) this.gridCtl?.load();
    // ④ kịch bản chi tiết: bảng phân đoạn AI viết → nhận dòng mới vào README tập (mục con trên cây)
    if (rs.step.view?.includes('segments')) {
      const { ep } = this.nodes();
      const t = this.studio.model?.config.project.episode.segmentTable;
      if (ep && t) {
        const readme = ep.files['readme'] ?? path.join(ep.dir, this.studio.model!.config.project.episode.files['readme'] ?? 'README.md');
        const old = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : `# ${ep.id} — mục lục phân đoạn\n`;
        const r = mergeSegmentTable(old, fs.readFileSync(rs.output.abs, 'utf8'), { code: t.codeColumn, name: t.nameColumn ?? 'Phân đoạn' });
        if (r.added.length) {
          fs.writeFileSync(readme, r.text, 'utf8');
          vscode.window.showInformationMessage(`Bảng phân đoạn: thêm ${r.added.join(', ')} (⬜ chưa duyệt) vào ${this.studio.rel(readme)}.`);
        }
      }
    }
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

  /** chạy script của dự án (project.yaml scripts) ngầm, không mở terminal — dùng sau khi Nhận; lỗi thì báo + vẫn còn nút chạy tay */
  private scriptQuiet(id: string, rs: ResolvedStep): Promise<void> {
    const s = this.studio.config?.project.scripts?.find((x) => x.id === id);
    if (!s) return Promise.resolve();
    const cmd = fill(s.command, resolveStep(this.studio.model!, rs.step, rs.target).ph);
    return new Promise((done) =>
      exec(cmd, { cwd: this.studio.root, timeout: 120000 }, (err, _out, errOut) => {
        if (err) vscode.window.showWarningMessage(`Script "${s.label}" lỗi (${String(errOut || err.message).trim().slice(0, 200)}) — chạy tay bằng nút script.`);
        done();
      }),
    );
  }

  private script(id: string): void {
    const rs = this.resolve();
    const s = this.studio.config?.project.scripts?.find((x) => x.id === id);
    if (!rs || !s) return;
    const term = vscode.window.createTerminal({ name: `Script · ${s.label}`, cwd: this.studio.root });
    term.show();
    term.sendText(fill(s.command, rs.ph));
  }

  // ------------------------------------------------------------------ chỉ tạo lại cái chưa duyệt
  /** phần đã duyệt của bước này: mã bị khóa + hàm khôi phục bản đề xuất · blocked = cả bước khóa (đối tượng đã duyệt) */
  private lock(rs: ResolvedStep): { codes: string[]; blocked?: string; apply: (proposed: string) => { text: string; restored: string[] } } {
    const none = { codes: [] as string[], apply: (t: string) => ({ text: t, restored: [] as string[] }) };
    const kind = rs.step.protect;
    const model = this.studio.model;
    if (!kind || !model) return none;
    const p = model.config.project;
    const { ep, seg, scene } = this.nodes();
    // đã duyệt + đã bỏ (giữ dòng gạch) đều khóa
    const done = [...(p.status.done ?? ['✅']), ...(p.status.dropped ?? [])];
    if (kind === 'segment' && seg?.status === 'done') return { ...none, blocked: `Phân đoạn ${seg.code} đã duyệt — bỏ duyệt ở tab tập ④ trước khi cho AI viết lại.` };
    if (kind === 'scene' && scene?.status === 'done') return { ...none, blocked: `Cảnh ${scene.code} đã duyệt — bỏ duyệt trước khi cho AI viết lại.` };
    if (kind === 'segment' || kind === 'scene') return none;
    if (kind === 'outline') {
      const t = rs.output?.exists ? fs.readFileSync(rs.output.abs, 'utf8') : '';
      return outlineStatus(t) === 'done' ? { ...none, blocked: `Dàn ý ${rs.target.ep} đã duyệt — bỏ duyệt trước khi cho AI gợi ý.` } : none;
    }
    const original = rs.output?.exists ? fs.readFileSync(rs.output.abs, 'utf8') : '';
    if (!original) return none;
    if (kind === 'segments') {
      const codes = (ep?.segments ?? []).filter((x) => x.status === 'done' || x.dropped).map((x) => x.code);
      return { codes, apply: (t) => protectSections(original, t, codes) };
    }
    let t: TableProtect | undefined;
    if (kind === 'scenes') t = { codeColumn: p.sceneTable.codeColumn, codeRe: new RegExp(p.codes.scene), statusColumn: p.sceneTable.statusColumn, lockSymbols: done };
    if (kind === 'lines') {
      const L = p.linesTable ?? { codeColumn: 'Mã', statusColumn: 'Trạng thái' };
      t = { codeColumn: L.codeColumn, codeRe: new RegExp(`^${p.codes.line}$`), statusColumn: L.statusColumn, lockSymbols: [...done, '✍'] };
    }
    // tập: chỉ khóa ✅ — tập ❌ bỏ thì AI / tool xóa khỏi danh sách (29/10/2026)
    if (kind === 'episodes' && p.episodeList) t = { codeColumn: p.episodeList.codeColumn, codeRe: EPISODE_CODE_RE, statusColumn: p.episodeList.statusColumn, lockSymbols: p.status.done ?? ['✅'] };
    if (!t) return none;
    const tt = t;
    const codes = lockedRows(original, tt);
    return { codes, apply: (x) => protectTable(original, x, tt, codes) };
  }

  // ------------------------------------------------------------------ form ① ý tưởng + phong cách · ② kịch bản tóm tắt + danh sách tập
  private editorVm(view: string[]) {
    const p = this.studio.model!.config.project;
    const read = (rel: string) => (this.studio.exists(rel) ? fs.readFileSync(this.studio.abs(rel), 'utf8') : '');
    if (view.includes('idea') && p.idea) {
      return { kind: 'idea', file: p.idea.file, fields: p.idea.fields, values: readIdea(read(p.idea.file), p.idea) };
    }
    if (view.includes('outline')) {
      const rs = this.resolve();
      const f = rs?.inputs[0];
      const text = f?.abs && fs.existsSync(f.abs) ? fs.readFileSync(f.abs, 'utf8') : '';
      return { kind: 'outline', file: f?.rel, text: stripOutlineStatus(text), status: outlineStatus(text), next: rs?.step.next };
    }
    if (view.includes('outlines')) return this.outlinesVm();
    if (view.includes('prompts')) {
      const { ep, seg, scene } = this.nodes();
      if (!ep || !seg || !scene) return undefined;
      const b = scenePrompts(this.studio.root!, ep, seg.code, scene.code, p.scenePrompts);
      return { kind: 'prompts', scene: scene.code, file: seg.files['prompt'] ? this.studio.rel(seg.files['prompt']) : undefined, own: b.scene, refs: b.refs };
    }
    if (view.includes('render')) {
      const rs = this.resolve();
      const f = rs?.inputs.find((x) => x.ref.select?.startsWith('row:') && /render/.test(x.rel));
      return { kind: 'render', file: f?.rel, line: f?.line ?? 0, rows: f?.exists && f.found ? f.text ?? '' : '' };
    }
    if (view.includes('section')) {
      const rs = this.resolve();
      const o = rs?.output;
      const { seg } = this.nodes();
      const text = o?.exists && o.found ? o.text ?? '' : `## [${seg?.code ?? ''}] ${seg?.name ?? ''}\n\n`;
      return { kind: 'section', file: o?.rel, line: o?.line ?? 0, found: !!o?.found, text, next: rs?.step.next };
    }
    if (view.includes('segments')) {
      const { ep } = this.nodes();
      const st = p.status;
      const scriptText = ep?.files['script'] ? fs.readFileSync(ep.files['script'], 'utf8') : '';
      const lineOf = (code: string) => Math.max(0, scriptText.split(/\r?\n/).findIndex((l) => /^#{1,3}\s/.test(l) && l.includes(`[${code}]`)));
      return {
        kind: 'segments',
        ep: ep?.id,
        readme: ep?.files['readme'] ? this.studio.rel(ep.files['readme']) : undefined,
        script: ep?.files['script'],
        choices: p.sceneTable.statusChoices ?? [{ value: '✅', label: 'Đã duyệt' }, { value: '⬜', label: 'Chưa duyệt' }],
        segments: (ep?.segments ?? []).map((x) => ({
          code: x.code,
          name: x.name,
          seconds: x.plannedSeconds,
          status: x.status === 'done' ? '✅' : '⬜',
          note: x.statusText,
          dropped: x.dropped,
          scenes: x.scenes.length,
          hasDir: !!x.dir,
          sym: statusSymbol(x.status, st),
          line: lineOf(x.code),
        })),
      };
    }
    if (view.includes('synopsis')) {
      return { kind: 'synopsis', file: p.synopsis, text: p.synopsis ? read(p.synopsis) : '', runLabel: this.resolve()?.step.runLabel };
    }
    return undefined;
  }

  private saveIdea(byIndex: Record<string, string>): void {
    const cfg = this.studio.model?.config.project.idea;
    if (!cfg) return;
    const values: Record<string, string> = {};
    cfg.fields.forEach((f, i) => {
      if (byIndex[i] !== undefined) values[f.label] = String(byIndex[i]);
    });
    const abs = this.studio.abs(cfg.file);
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, writeIdea(old, values, cfg), 'utf8');
    vscode.window.showInformationMessage(`Đã lưu ${cfg.file}. Xem bằng git diff.`);
    this.studio.refresh();
  }

  private saveOutline(text: string, next: boolean): void {
    const rs = this.resolve();
    const f = rs?.inputs[0];
    if (!rs || !f?.abs) return;
    fs.mkdirSync(path.dirname(f.abs), { recursive: true });
    const old = fs.existsSync(f.abs) ? fs.readFileSync(f.abs, 'utf8') : '';
    fs.writeFileSync(f.abs, withOutlineStatus(text, outlineStatus(old) === 'done'), 'utf8');
    this.studio.refresh();
    if (!next || !rs.step.next) return void vscode.window.showInformationMessage(`Đã lưu ${f.rel}.`);
    // ③ → ④: chuyển bước và cho AI chạy luôn
    this.select(rs.step.next.step);
    this.startRuns(false, false);
  }

  /** file dàn ý của một tập — theo đầu vào đầu tiên của bước cấp tập có view "outline" (pipeline.yaml: {episodeDir}/dan-y.md) */
  private outlineFile(epId: string): { abs: string; rel: string; step: StepSpec } | undefined {
    const model = this.studio.model;
    const step = this.studio.config?.pipeline.steps.find((s) => s.scope === 'episode' && s.view?.includes('outline'));
    const ep = model && findEpisode(model, epId);
    if (!model || !step || !ep) return undefined;
    const f = resolveStep(model, step, { ep: ep.id }).inputs[0];
    return f?.abs ? { abs: f.abs, rel: f.rel, step } : undefined;
  }

  /** ③ Dàn ý ở cấp dự án: bảng mọi tập (trạng thái dàn ý) + nội dung dàn ý của tập đang chọn */
  private outlinesVm() {
    const model = this.studio.model!;
    const read = (abs?: string) => (abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
    const rows = model.episodeList.filter((r) => !r.dropped).map((r) => {
      const f = this.outlineFile(r.code);
      const text = read(f?.abs);
      return { code: r.code, release: r.unreleased ? '' : r.release ?? '', name: r.name, hasDir: !!f, file: f?.rel, status: outlineStatus(text), chars: stripOutlineStatus(text).trim().length };
    });
    const cur = rows.find((r) => r.code === this.state.olEp) ?? rows.find((r) => r.hasDir) ?? rows[0];
    const f = cur && this.outlineFile(cur.code);
    const text = read(f?.abs);
    return { kind: 'outlines', rows, cur: cur?.code, name: cur?.name, file: f?.rel, hasDir: !!f, text: stripOutlineStatus(text), status: outlineStatus(text), next: f?.step.next };
  }

  /** ③ Dàn ý ở tab dự án → "Gợi ý dàn ý": AI chạy bước ③ của từng tập chưa duyệt (chưa có → viết mới · có → góp ý thêm / bớt / sửa câu).
   *  Hỏi trước: tập đang chọn hay mọi tập chưa duyệt, kèm ước tính token. Mỗi tập một thẻ kết quả trong tab này (Xem diff / Nhận riêng). */
  private async suggestOutlines(m: ModelConfig): Promise<void> {
    const model = this.studio.model!;
    const step = this.studio.config?.pipeline.steps.find((s) => s.scope === 'episode' && s.view?.includes('outline') && s.output);
    if (!step) return void vscode.window.showWarningMessage('pipeline.yaml: bước ③ Dàn ý của tập chưa có output + prompt.');
    const rows = this.outlinesVm().rows.filter((r) => r.hasDir && r.status !== 'done');
    if (!rows.length) return void vscode.window.showInformationMessage('Mọi tập đều đã duyệt dàn ý — bỏ duyệt tập nào thì AI mới gợi ý cho tập đó.');
    const loads = this.models.provider(m).loadsProjectInstructions;
    const est = (ep: string) => buildPrompt(model, resolveStep(model, step, { ep }), this.request, loads).estInputTokens;
    const cur = rows.find((r) => r.code === this.state.olEp);
    const all = `Cả ${rows.length} tập chưa duyệt`;
    const one = cur ? `Chỉ ${cur.code}` : undefined;
    const total = rows.reduce((a, r) => a + est(r.code), 0);
    const pick = await vscode.window.showInformationMessage(
      `Gợi ý dàn ý (${m.id}) — tập chưa có dàn ý thì AI viết mới, tập có mà chưa duyệt thì AI góp ý (thêm · sửa câu; chỗ nên bớt ghi /*@T … */). Tập ✅ không đụng.\n`
        + rows.map((r) => `${r.code} ${r.status === 'none' ? 'viết mới' : 'góp ý'}`).join(' · ')
        + `\n≈ ${Math.round(total / rows.length).toLocaleString('vi-VN')} token / tập · cả ${rows.length} tập ≈ ${total.toLocaleString('vi-VN')} token${cur ? ` · riêng ${cur.code} ≈ ${est(cur.code).toLocaleString('vi-VN')}` : ''}.`,
      { modal: true },
      ...(one ? [one] : []),
      all,
    );
    if (!pick) return;
    const eps = pick === one ? [cur!.code] : rows.map((r) => r.code);
    // tối đa 2 tập chạy cùng lúc — đỡ nghẽn Claude CLI / giới hạn API
    const queue = [...eps];
    const worker = async () => {
      for (let ep = queue.shift(); ep; ep = queue.shift()) await this.runOne(resolveStep(model, step, { ep }), m);
    };
    await Promise.all([worker(), worker()]);
  }

  /** lưu dàn ý một tập từ tab dự án · done: đổi trạng thái duyệt (undefined = giữ) · next: mở tab tập → ④ AI chia phân đoạn */
  private saveOutlineOf(epId: string, text: string, done: boolean | undefined, next: boolean): void {
    const f = this.outlineFile(epId);
    if (!f) return void vscode.window.showWarningMessage(`Tập ${epId} chưa có thư mục — tạo ở ▦ Danh sách tập (nút 📁).`);
    const old = fs.existsSync(f.abs) ? fs.readFileSync(f.abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(f.abs), { recursive: true });
    fs.writeFileSync(f.abs, withOutlineStatus(text, done ?? outlineStatus(old) === 'done'), 'utf8');
    this.state.olEp = epId;
    this.studio.refresh();
    if (next && f.step.next) return StepPanel.open(this.studio, this.models, f.step.next.step, { ep: epId }, true);
    vscode.window.showInformationMessage(`${done === true ? 'Đã duyệt' : done === false ? 'Bỏ duyệt' : 'Đã lưu'} dàn ý ${epId} — ${f.rel}.`);
  }

  /** ⑤ Kịch bản phân đoạn: ghi lại đúng mục [X] trong kịch bản chi tiết của tập; next → sang ⑥ và AI tạo phân cảnh */
  private saveSection(text: string, next: boolean): void {
    const rs = this.resolve();
    if (!rs?.output) return;
    fs.mkdirSync(path.dirname(rs.output.abs), { recursive: true });
    fs.writeFileSync(rs.output.abs, mergeOutput(rs, text.replace(/\s*$/, '\n')), 'utf8');
    this.studio.refresh();
    if (!next || !rs.step.next) return void vscode.window.showInformationMessage(`Đã lưu mục ${rs.output.ref.select?.replace('heading:', '') ?? ''} trong ${rs.output.rel}.`);
    this.select(rs.step.next.step);
    this.startRuns(false, false);
  }

  /** đổi trạng thái phân đoạn trong bảng README tập — changes: mã → ký hiệu */
  private saveSegStatus(changes: Record<string, string>): void {
    const { ep } = this.nodes();
    const readme = ep?.files['readme'];
    const t = this.studio.model?.config.project.episode.segmentTable;
    if (!readme || !t) return;
    let text = fs.readFileSync(readme, 'utf8');
    const done: string[] = [];
    for (const [code, sym] of Object.entries(changes)) {
      const nt = setSegmentStatus(text, { code: t.codeColumn, status: t.statusColumn ?? 'Trạng thái' }, code, sym);
      if (nt !== undefined) (text = nt), done.push(`${code} ${sym}`);
    }
    fs.writeFileSync(readme, text, 'utf8');
    vscode.window.showInformationMessage(`Đã đổi trạng thái: ${done.join(' · ') || '(không dòng nào)'} — ${this.studio.rel(readme)}.`);
    this.studio.refresh();
  }

  /** "Phân cảnh": phân đoạn đã duyệt mà chưa có cảnh → tạo mục con (thư mục từ mẫu) + mở tab ⑤ và cho AI chia cảnh luôn */
  private async phanCanh(): Promise<void> {
    const { ep } = this.nodes();
    if (!ep || !this.studio.model) return;
    const todo = ep.segments.filter((x) => !x.dropped && x.status === 'done' && !x.scenes.length);
    if (!todo.length) return void vscode.window.showInformationMessage('Không có phân đoạn nào đã duyệt mà chưa chia cảnh.');
    const ok = await vscode.window.showInformationMessage(
      `Tạo mục con + AI chia cảnh cho ${todo.length} phân đoạn: ${todo.map((x) => x.code).join(', ')}? Mỗi phân đoạn mở một tab, xem diff rồi Nhận.`,
      { modal: true },
      'Phân cảnh',
    );
    if (ok !== 'Phân cảnh') return;
    for (const x of todo) if (!x.dir) createSegmentDir(this.studio, ep, x.code, slugify(x.name).toLowerCase() || x.code.toLowerCase());
    this.studio.refresh();
    for (const x of todo) StepPanel.open(this.studio, this.models, 'chia-canh', { ep: ep.id, seg: x.code }, true);
  }

  private saveSynopsis(text: string): void {
    const rel = this.studio.model?.config.project.synopsis;
    if (!rel) return;
    const abs = this.studio.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text.replace(/\s*$/, '\n'), 'utf8');
    vscode.window.showInformationMessage(`Đã lưu ${rel}. Xem bằng git diff.`);
    this.studio.refresh();
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

  /** Sổ thử nghiệm: thêm một dòng "Nhật ký lần sinh" vào <X>_ket-qua.md */
  private logAttempt(a: { variant?: string; model?: string; credit?: string; seconds?: string; marks?: string[]; usable?: string; note?: string }): void {
    const rs = this.resolve();
    const ep = rs && findEpisode(this.studio.model!, rs.target.ep);
    const seg = findSegment(ep, rs?.target.seg);
    if (!rs?.target.scene || !seg?.dir) return;
    const pattern = this.studio.config!.project.segment.files['ket-qua'] ?? '{X}_ket-qua.md';
    const file = path.join(seg.dir, pattern.replace(/\{X\}/g, seg.code));
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const n = (s?: string) => (s && Number.isFinite(Number(s.replace(',', '.'))) ? Number(s.replace(',', '.')) : undefined);
    const next = appendAttempt(
      cur,
      `${seg.code} · ${seg.name}`,
      {
        scene: rs.target.scene,
        variant: a.variant ?? '',
        model: a.model ?? '',
        credit: n(a.credit),
        seconds: n(a.seconds),
        marks: (a.marks ?? []).map((x) => parseMark(x) as Mark),
        usable: parseMark(a.usable ?? ''),
        note: a.note ?? '',
      },
      this.studio.config!.project.attemptLog?.criteria ?? [],
    );
    fs.writeFileSync(file, next, 'utf8');
    vscode.window.showInformationMessage(`Đã ghi một lần sinh ${rs.target.scene} vào ${this.studio.rel(file)}.`);
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
      <div id="editor"></div>
      <div id="gridHost" class="card" style="margin-top:8px" hidden>${GRID_BODY}</div>
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
      </div>${CHAT_BODY}`,
      CLIENT_JS + gridClientJs(true) + CHAT_JS,
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
  if (e.target.closest('#logAttempt')) vscode.postMessage({ type: 'logAttempt', a: {
    variant: $('aVar').value, model: $('aModel').value, credit: $('aCredit').value, seconds: $('aSec').value,
    marks: [...document.querySelectorAll('.aMark')].map((x) => x.value), usable: $('aUse').value, note: $('aNote').value } });
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
  let h = '<h2>' + (md.renderOnly ? 'Ảnh / clip render Blender của ' : 'Media của ') + esc(scene) + ' <span class="muted">' + (md.rootFound ? esc(md.root) : 'không thấy thư mục media ' + esc(md.root || '') + ' — đặt trong Cài đặt AI') + '</span></h2>'
    + (md.renderOnly ? '<p class="muted">File <code>' + esc(scene) + '_R…</code> (clip, key frame) trong thư mục media và seedance_clip/ của tập. Render bằng script ▶ bên dưới.</p>'
      : '<div class="row"><button data-cmd="import">Nhập file… (đổi tên theo mã)</button><span class="muted">chép file tải về vào thư mục media, file gốc giữ nguyên</span></div>')
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
    const sel = (cls, id) => '<select' + (cls ? ' class="' + cls + '"' : '') + (id ? ' id="' + id + '"' : '') + '><option value=""></option><option value="✅">✅</option><option value="⚠️">⚠️</option><option value="❌">❌</option></select>';
    h += '<h2>Ghi một lần sinh <span class="muted">— sổ thử nghiệm · đã ghi ' + (md.logged || 0) + ' lần cho ' + esc(scene) + ' · thống kê ở Trạng thái dự án</span></h2><table>'
      + '<tr><th>Bản / model</th><td><input id="aVar" size="12" placeholder="vd. A, 3 cảnh"> <input id="aModel" list="mList" size="20" value="' + esc(r.model || 'Seedance 2.0 mini') + '"></td></tr>'
      + '<tr><th>Credit · giây</th><td><input id="aCredit" type="number" min="0" style="width:80px" placeholder="credit"> <input id="aSec" type="number" min="0" step="0.5" style="width:70px" value="' + esc(md.seconds ?? '') + '"> s</td></tr>'
      + (md.criteria || []).map((c, k) => '<tr><th>' + '①②③④⑤⑥⑦⑧⑨'[k] + ' ' + esc(c) + '</th><td>' + sel('aMark') + '</td></tr>').join('')
      + '<tr><th>Dùng được?</th><td>' + sel('', 'aUse') + '</td></tr>'
      + '<tr><th>Nhận xét</th><td><textarea id="aNote" style="min-height:40px"></textarea></td></tr>'
      + '</table><div class="row" style="margin-top:6px"><button id="logAttempt">+ Ghi lần sinh</button></div>';
  }
  return h;
}

// ① form ý tưởng + phong cách · ② kịch bản tóm tắt + danh sách tập. Đang sửa dở (chưa lưu) thì không vẽ lại — giữ chữ đang gõ.
let edKey = null, edDirty = false, gridOn = null;
function renderEditor(ed) {
  const key = ed ? ed.kind + '|' + JSON.stringify(ed) : null;
  if (ed && edDirty && edKey && edKey.split('|')[0] === ed.kind) return;
  if (key === edKey && ed) return;
  edKey = key; edDirty = false;
  if (!ed) { $('editor').innerHTML = ''; return; }
  const dirtyMark = '<span id="edDirty" class="err"></span>';
  if (ed.kind === 'prompts') {
    let h = '<h2>Prompt của cảnh ' + esc(ed.scene) + ' <span class="muted">' + (ed.own ? 'mục trong <a data-open="' + esc(ed.own.file) + '" data-line="' + ed.own.line + '">' + esc(ed.own.file) + '</a>' : '') + '</span></h2>';
    h += ed.own ? '<div class="card">' + mdBlocks(ed.own.text, 'prompt ' + ed.scene) + '</div>' : '<p class="muted">Chưa có mục ' + esc(ed.scene) + ' trong ' + esc(ed.file || 'file prompt của phân đoạn') + ' — bấm Chạy ở mục AI để viết.</p>';
    if (ed.refs.length) h += '<h2>Ảnh tham chiếu cảnh này nạp <span class="muted">' + ed.refs.length + ' ảnh · prompt tìm trong tham-chieu/ của tập</span></h2>'
      + ed.refs.map((r) => '<div class="card" style="margin-top:6px"><b>@[' + esc(r.name) + ']</b>'
        + (r.usedIn.length ? ' <span class="muted">· cũng dùng ở ' + r.usedIn.map(esc).join(', ') + '</span>' : ' <span class="muted">· chỉ cảnh này</span>')
        + (r.prompt ? (r.prompt.via !== r.name ? ' <span class="muted">· cắt từ @[' + esc(r.prompt.via) + ']</span>' : '') + ' <a data-open="' + esc(r.prompt.file) + '" data-line="' + r.prompt.line + '">' + esc(r.prompt.file) + '</a>' + mdBlocks(r.prompt.text, '@[' + r.prompt.via + ']')
          : ' <span class="err">chưa thấy prompt</span>') + '</div>').join('');
    $('editor').innerHTML = h;
    return;
  }
  if (ed.kind === 'render') {
    const rows = String(ed.rows || '').split('\\n').filter((l) => l.trim().startsWith('|'));
    $('editor').innerHTML = '<h2>Key frame · clip render <span class="muted">' + (ed.file ? 'dòng trong <a data-open="' + esc(ed.file) + '" data-line="' + ed.line + '">' + esc(ed.file) + '</a>' : '') + '</span></h2>'
      + (rows.length ? '<table>' + rows.map((l) => '<tr>' + l.trim().replace(/^\\||\\|$/g, '').split('|').map((c) => '<td>' + inlineMd(c.trim()) + '</td>').join('') + '</tr>').join('') + '</table>'
        : '<p class="muted">Chưa có dòng nào của cảnh này trong sổ render của phân đoạn.</p>');
    return;
  }
  if (ed.kind === 'section') {
    window._secOrig = ed.text;
    $('editor').innerHTML = '<h2>Kịch bản của phân đoạn <span class="muted">' + (ed.file ? 'mục trong <a data-open="' + esc(ed.file) + '" data-line="' + ed.line + '">' + esc(ed.file) + '</a>' : '') + (ed.found ? '' : ' · chưa có mục này — lưu là thêm vào cuối file') + '</span></h2>'
      + '<p class="muted">Xác định nội dung chính của phân đoạn (ý đồ · cảnh trí · hành động · sử liệu · thời lượng). Lưu là ghi lại đúng mục này trong kịch bản chi tiết của tập.</p>'
      + '<textarea id="secText" style="min-height:300px;font-family:var(--vscode-editor-font-family)">' + esc(splitNote(ed.text).body) + '</textarea>'
      + '<h3 style="margin:10px 0 4px">Ghi chú của phân đoạn <span class="muted">— ý sửa cho AI; bấm Tạo phân cảnh / Tạo phân đoạn là AI làm theo ghi chú (chỉ phần chưa duyệt)</span></h3>'
      + '<textarea id="secNote" style="min-height:110px;font-family:var(--vscode-editor-font-family)" placeholder="vd. thêm cảnh … · bỏ … · rút ngắn …">' + esc(splitNote(ed.text).note) + '</textarea>'
      + '<div class="row" style="margin-top:6px"><button class="sec" id="saveSec">Lưu kịch bản phân đoạn</button>' + dirtyMark
      + (ed.next ? '<button id="secNext" title="lưu → sang bước sau → AI chạy luôn">✨ ' + esc(ed.next.label) + '</button><span class="muted">lưu → sang ⑥ → AI chia cảnh (xem diff rồi Nhận, lưới cập nhật)</span>' : '') + '</div>';
    return;
  }
  if (ed.kind === 'outlines') {
    const lab = { done: '<span class="ok">✅ đã duyệt</span>', todo: '⬜ chưa duyệt', none: '<span class="muted">— chưa có</span>' };
    let h = '<h2>Dàn ý từng tập <span class="muted">chọn một tập → sửa ở khung bên dưới · mỗi tập một file <code>EPISODES/EPxx/dan-y.md</code></span></h2>'
      + '<table id="olList"><tr><th>Mã</th><th>Phát hành</th><th>Tên tập</th><th>Dàn ý</th><th>Độ dài</th></tr>'
      + ed.rows.map((r) => '<tr class="olRow' + (r.code === ed.cur ? ' cur' : '') + '" data-ep="' + esc(r.code) + '" style="cursor:pointer' + (r.code === ed.cur ? ';outline:2px solid var(--vscode-focusBorder)' : '') + (r.hasDir ? '' : ';opacity:.5') + '">'
        + '<td>' + esc(r.code) + '</td><td>' + esc(r.release || '—') + '</td><td>' + esc(r.name) + '</td><td>' + (r.hasDir ? lab[r.status] : '<span class="muted">chưa có thư mục</span>') + '</td><td>' + (r.chars ? r.chars + ' ký tự' : '') + '</td></tr>').join('')
      + '</table><div id="olWarn" class="err"></div>';
    if (ed.cur) {
      h += '<h2 style="margin-top:14px">' + esc(ed.cur) + ' · ' + esc(ed.name) + ' <span class="muted">' + (ed.file ? '<a data-open="' + esc(ed.file) + '">' + esc(ed.file) + '</a> · ' : '') + (ed.hasDir ? lab[ed.status] : '') + '</span></h2>';
      if (!ed.hasDir) h += '<p class="muted">Tập này chưa có thư mục — tạo ở <b>▦ Danh sách tập</b> (nút 📁) rồi viết dàn ý.</p>';
      else h += '<textarea id="olAllText" data-ep="' + esc(ed.cur) + '" style="min-height:360px;font-family:var(--vscode-editor-font-family)">' + esc(ed.text) + '</textarea>'
        + '<div class="row" style="margin-top:6px"><button class="sec" id="olAllSave">Lưu dàn ý</button>'
        + (ed.status === 'done' ? '<button class="sec" id="olAllUndo">Bỏ duyệt</button>' : '<button id="olAllAppr" title="lưu + đánh dấu dàn ý đã duyệt">✅ Duyệt dàn ý</button>') + dirtyMark
        + (ed.next ? '<button id="olAllNext" title="lưu dàn ý → mở tab tập ở ④ → AI chia phân đoạn">✨ ' + esc(ed.next.label) + '</button><span class="muted">lưu → mở tab tập → AI chia phân đoạn (xem diff rồi Nhận)</span>' : '') + '</div>';
    }
    $('editor').innerHTML = h;
    return;
  }
  if (ed.kind === 'outline') {
    $('editor').innerHTML = '<h2>Dàn ý <span class="muted">' + (ed.file ? '<a data-open="' + esc(ed.file) + '">' + esc(ed.file) + '</a>' : '') + (ed.status === 'done' ? ' · <span class="ok">✅ đã duyệt</span>' : '') + '</span></h2>'
      + '<textarea id="olText" style="min-height:360px;font-family:var(--vscode-editor-font-family)">' + esc(ed.text) + '</textarea>'
      + '<div class="row" style="margin-top:6px"><button class="sec" id="saveOl">Lưu dàn ý</button>' + dirtyMark
      + (ed.next ? '<button id="olNext" title="lưu dàn ý → chuyển sang bước sau → AI chạy luôn">✨ ' + esc(ed.next.label) + '</button><span class="muted">lưu dàn ý → sang ④ → AI chia phân đoạn (xem diff rồi Nhận)</span>' : '') + '</div>';
    return;
  }
  if (ed.kind === 'segments') {
    $('editor').innerHTML = '<h2>Phân đoạn của tập <span class="muted">' + (ed.readme ? 'bảng trong <a data-open="' + esc(ed.readme) + '">' + esc(ed.readme) + '</a>' : '') + '</span></h2>'
      + '<p class="muted">AI chia phân đoạn bằng nút <b>✨ Tạo phân đoạn</b> ở mục AI bên dưới (xem diff → Nhận: phân đoạn mới vào bảng, ⬜ chưa duyệt). Đọc · sửa (<b>xem</b> mở đúng mục trong kịch bản) · chọn <b>Đã duyệt</b> → <b>Lưu trạng thái</b> → <b>🎬 Phân cảnh</b>.</p>'
      + '<div id="segList">' + segTable(ed) + '</div>'
      + '<div class="row" style="margin-top:6px"><button class="sec" id="saveSeg">Lưu trạng thái</button>' + dirtyMark
      + '<button id="phanCanh" title="phân đoạn đã duyệt mà chưa có cảnh → tool tạo mục con + AI chia cảnh">✨ Phân cảnh</button><span class="muted">tạo mục con cho phân đoạn đã duyệt + AI chia cảnh luôn</span></div>';
    return;
  }
  if (ed.kind === 'idea') {
    $('editor').innerHTML = '<p class="muted">Lưu vào <a data-open="' + esc(ed.file) + '">' + esc(ed.file) + '</a> — AI đọc file này ở các bước sau.</p><table style="width:100%">'
      + ed.fields.map((f, k) => {
        const v = ed.values[f.label] ?? '';
        let input;
        if (f.kind === 'choice') {
          const opts = (f.choices || []).slice(); if (v && !opts.includes(v)) opts.unshift(v);
          input = '<select class="ideaF" data-k="' + k + '"><option value=""></option>' + opts.map((o) => '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>'
            + ' <input class="ideaO" data-k="' + k + '" size="30" placeholder="hoặc gõ loại khác…">';
        } else input = '<textarea class="ideaF" data-k="' + k + '" style="min-height:' + (f.hint && /dài/.test(f.hint) ? 200 : 110) + 'px">' + esc(v) + '</textarea>';
        return '<tr><th style="width:170px;vertical-align:top">' + esc(f.label) + (f.hint ? '<div class="muted" style="font-weight:normal">' + esc(f.hint) + '</div>' : '') + '</th><td>' + input + '</td></tr>';
      }).join('') + '</table><div class="row" style="margin-top:6px"><button id="saveIdea">Lưu ý tưởng + phong cách</button>' + dirtyMark + '</div>';
    return;
  }
  $('editor').innerHTML = '<h2>Kịch bản tóm tắt <span class="muted">' + (ed.file ? '<a data-open="' + esc(ed.file) + '">' + esc(ed.file) + '</a>' : 'chưa cấu hình synopsis trong project.yaml') + '</span></h2>'
    + '<textarea id="synText" style="min-height:280px;font-family:var(--vscode-editor-font-family)">' + esc(ed.text) + '</textarea>'
    + '<div class="row" style="margin-top:6px"><button id="saveSyn">Lưu kịch bản tóm tắt</button>' + dirtyMark
    + (ed.runLabel ? '<button data-cmd="run" data-arg="" title="AI đọc ý tưởng + kịch bản tóm tắt + danh sách hiện tại → đề xuất danh sách tập mới; xem diff rồi Nhận">✨ ' + esc(ed.runLabel) + '</button><span class="muted">AI đề xuất → Xem diff → Nhận → sửa tiếp trong lưới</span>' : '') + '</div>'
    + '<p class="muted" style="margin-top:10px"><b>Chia tập</b>: AI giữ nguyên tập ✅ Duyệt · chia lại, viết lại tên + tóm tắt cho tập ⬜ Chưa duyệt · xóa tập ❌ Bỏ · viết tóm tắt cho tập chưa có → tool đánh lại TAP. '
    + 'Sửa tay ngay trong lưới dưới đây: ô tên / tóm tắt / trạng thái · ▲▼ đổi thứ tự · <b>+</b> thêm tập · 🗑 xóa tập ❌ · nhớ bấm <b>Lưu</b> của lưới. Mã <b>EP</b> = mã sản xuất (không đổi) · <b>TAP</b> = số phát hành.</p>';
}
// markdown gọn: khối code (ba dấu huyền) thành <pre> có nút 📋 chép, chữ thường giữ đậm / code
// mục "### Ghi chú [X]" ở cuối phân đoạn ↔ ô Ghi chú riêng
function splitNote(t) {
  const m = /\\n### Ghi chú[^\\n]*\\n/.exec(String(t));
  if (!m) return { body: String(t).replace(/\\s+$/, ''), note: '', head: null };
  return { body: String(t).slice(0, m.index).replace(/\\s+$/, ''), note: String(t).slice(m.index + m[0].length).trim(), head: m[0].trim() };
}
function joinNote(body, note, code, head) {
  const n = String(note).trim();
  return String(body).replace(/\\s+$/, '') + (n || head ? '\\n\\n' + (head || '### Ghi chú [' + code + ']') + '\\n\\n' + n : '') + '\\n';
}
function inlineMd(t) { return esc(t).replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>'); }
let copyN = 0; const copyText = {};
function mdBlocks(text, label) {
  const out = []; let buf = [], code = null;
  for (const l of String(text).split('\\n')) {
    if (/^\\s*\\x60\\x60\\x60/.test(l)) {
      if (code === null) { if (buf.length) out.push('<p>' + buf.map(inlineMd).join('<br>') + '</p>'); buf = []; code = []; }
      else { const k = 'c' + (++copyN); copyText[k] = code.join('\\n');
        out.push('<div style="position:relative"><button class="sec" data-copy="' + k + '" data-label="' + esc(label) + '" style="position:absolute;right:4px;top:4px">📋 chép</button><pre style="white-space:pre-wrap;padding-right:80px">' + esc(code.join('\\n')) + '</pre></div>'); code = null; }
      continue;
    }
    if (code !== null) code.push(l); else if (/^#{1,6}\\s/.test(l)) { if (buf.length) out.push('<p>' + buf.map(inlineMd).join('<br>') + '</p>'); buf = []; out.push('<h3>' + inlineMd(l.replace(/^#+\\s*/, '')) + '</h3>'); } else if (l.trim()) buf.push(l); else if (buf.length) { out.push('<p>' + buf.map(inlineMd).join('<br>') + '</p>'); buf = []; }
  }
  if (buf.length) out.push('<p>' + buf.map(inlineMd).join('<br>') + '</p>');
  return out.join('');
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) vscode.postMessage({ type: 'copy', text: copyText[c.dataset.copy], label: c.dataset.label });
});
function segTable(ed) {
  if (!ed.segments.length) return '<p class="muted">Chưa có phân đoạn — bấm ✨ Tạo phân đoạn.</p>';
  return '<table><tr><th>Mã</th><th>Phân đoạn</th><th>~Giây</th><th>Trạng thái</th><th>Cảnh</th><th></th></tr>' + ed.segments.map((x) =>
    '<tr' + (x.dropped ? ' style="opacity:.5"' : '') + '><td><b>' + esc(x.code) + '</b></td><td>' + esc(x.name) + '<div class="muted" style="font-size:.85em">' + esc(x.note) + '</div></td><td>' + esc(x.seconds ?? '') + '</td><td>'
    + (x.dropped ? '❌ bỏ' : '<select class="segSt" data-code="' + esc(x.code) + '" data-orig="' + esc(x.status) + '">' + ed.choices.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === x.status ? ' selected' : '') + '>' + esc(o.value + ' ' + o.label) + '</option>').join('') + '</select>')
    + '</td><td>' + (x.scenes ? x.scenes + ' cảnh' : x.hasDir ? '<span class="muted">chưa chia</span>' : '<span class="muted">chưa có mục con</span>') + '</td><td>'
    + (ed.script ? '<button class="link" data-open="' + esc(ed.script) + '" data-line="' + x.line + '">xem</button>' : '')
    + (x.hasDir ? '<button class="link" data-cmd="target" data-arg="' + esc(JSON.stringify({ ep: ed.ep, seg: x.code })) + '">mở</button>' : '') + '</td></tr>').join('') + '</table>';
}
document.addEventListener('input', (e) => {
  if (e.target.closest('#editor') && (e.target.matches('.ideaF, .ideaO, #synText, #olText, #olAllText, #secText, #secNote'))) { edDirty = true; const d = $('edDirty'); if (d) d.textContent = ' ● chưa lưu'; }
});
document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('select.ideaF, select.segSt')) { edDirty = true; const d = $('edDirty'); if (d) d.textContent = ' ● chưa lưu'; }
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'saveIdea') {
    const values = {};
    document.querySelectorAll('.ideaF').forEach((x) => {
      const k = +x.dataset.k, other = document.querySelector('.ideaO[data-k="' + k + '"]');
      values[k] = other && other.value.trim() ? other.value.trim() : x.value;
    });
    edDirty = false; edKey = null;
    vscode.postMessage({ type: 'saveIdea', values: values, byIndex: true });
  }
  if (e.target.id === 'saveSec' || e.target.id === 'secNext') {
    const head = splitNote(window._secOrig || '').head, code = ((window._secOrig || '').match(/\\[([A-Z])\\]/) || [])[1] || '';
    edDirty = false; edKey = null;
    vscode.postMessage({ type: 'saveSection', text: joinNote($('secText').value, $('secNote').value, code, head), next: e.target.id === 'secNext' });
  }
  const olRow = e.target.closest && e.target.closest('.olRow');
  if (olRow && !olRow.classList.contains('cur')) {
    if (edDirty) { $('olWarn').innerHTML = 'Dàn ý ' + esc($('olAllText').dataset.ep) + ' đang sửa dở — bấm <b>Lưu dàn ý</b> trước, hoặc <a id="olDiscard" data-ep="' + esc(olRow.dataset.ep) + '">bỏ thay đổi và chuyển</a>.'; return; }
    edKey = null; vscode.postMessage({ type: 'olPick', ep: olRow.dataset.ep });
  }
  if (e.target.id === 'olDiscard') { edDirty = false; edKey = null; vscode.postMessage({ type: 'olPick', ep: e.target.dataset.ep }); }
  if (['olAllSave', 'olAllAppr', 'olAllUndo', 'olAllNext'].includes(e.target.id)) {
    const t = $('olAllText');
    edDirty = false; edKey = null;
    vscode.postMessage({ type: 'saveOutlineOf', ep: t.dataset.ep, text: t.value, done: e.target.id === 'olAllAppr' ? true : e.target.id === 'olAllUndo' ? false : undefined, next: e.target.id === 'olAllNext' });
  }
  if (e.target.id === 'saveOl' || e.target.id === 'olNext') { edDirty = false; edKey = null; vscode.postMessage({ type: 'saveOutline', text: $('olText').value, next: e.target.id === 'olNext' }); }
  if (e.target.id === 'saveSeg') {
    const changes = {};
    document.querySelectorAll('.segSt').forEach((x) => { if (x.value !== x.dataset.orig) changes[x.dataset.code] = x.value; });
    edDirty = false; edKey = null; vscode.postMessage({ type: 'segStatus', changes });
  }
  if (e.target.id === 'phanCanh') vscode.postMessage({ type: 'phanCanh' });
  if (e.target.id === 'saveSyn') { edDirty = false; edKey = null; vscode.postMessage({ type: 'saveSynopsis', text: $('synText').value }); }
});

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
  renderEditor(vm.editor);
  // ⑥ Phân cảnh: lưới bảng cảnh ngay trong tab
  $('gridHost').hidden = !vm.grid;
  const gk = vm.grid ? vm.gridKind : null;
  if (gk && gk !== gridOn) window.gridReload();
  gridOn = gk;

  const sh = vm.files.filter((f) => f.shared);
  $('files').innerHTML = '<table>' + vm.files.filter((f) => !f.shared).map((f) => {
    const state = f.virtual ? '<span class="muted">' + f.chars + ' ký tự</span>'
      : !f.exists ? (f.optional ? '<span class="muted">không có</span>' : '<span class="err">chưa có</span>')
      : !f.found ? '<span class="err">không thấy mục</span>' : '<span class="muted">' + f.chars + ' ký tự</span>';
    let btn = '';
    if (f.virtual) btn = '<button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button>';
    else if (f.exists) btn = '<button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button>'
      + '<button class="link" data-open="' + esc(f.abs) + '" data-line="' + f.line + '">sửa</button>';
    else if (f.role === 'output') btn = '<button class="link" data-cmd="create">tạo file</button>';
    return '<tr><td>' + (f.role === 'output' ? '→ ' : '') + esc(f.label) + '</td><td>' + state + '</td><td style="white-space:nowrap">' + btn + '</td></tr>';
  }).join('') + '</table>'
    + (sh.length ? '<details class="muted" style="margin-top:4px"><summary>📚 + ' + sh.length + ' tài liệu dùng chung — ở Tài nguyên dự án, AI vẫn đọc khi chạy</summary>'
      + sh.map((f) => '<div>' + esc(f.label) + ' <button class="link" data-cmd="show" data-arg="' + f.i + '">xem</button></div>').join('') + '</details>' : '');
  $('tools').innerHTML = vm.grid ? '<div style="margin-top:8px"><button class="link" data-cmd="grid">▦ mở lưới ở tab riêng</button></div>' : '';

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
  if (vm.step.executor === 'agent') a = '<button data-cmd="handoff" title="AI agent: mở Claude Code trong terminal">🤖 Giao cho Claude Code (terminal)</button>';
  else if (vm.hasOutput || vm.batch) {
    const skip = vm.gate.ok ? '' : 'skip';
    // ✨ = nút có AI (quy ước toàn tool) — nút không dấu là việc tool tự làm
    a = '<button data-cmd="run" data-arg="' + skip + '" title="chạy AI">✨ ' + esc(vm.step.runLabel || 'Chạy AI') + (vm.gate.ok ? '' : ' (bỏ qua cổng)') + '</button>'
      + (vm.compare ? ' <button class="sec" data-cmd="runCompare" data-arg="' + skip + '">✨ Chạy cả 2 để so sánh</button>' : '');
  }
  $('actions').innerHTML = a;

  $('runs').innerHTML = vm.runs.map((x) => {
    const tok = x.inputTokens !== undefined ? ' · ' + x.inputTokens + ' → ' + x.outputTokens + ' token' : ' · ≈ ' + x.estInputTokens + ' token vào';
    const cost = x.costUsd !== undefined ? ' · ' + x.costUsd.toFixed(3) + ' USD' + (x.costReported ? '' : ' (ước tính)') : '';
    const label = { running: '⏳ đang chạy…', done: '✅ xong', error: '❌ lỗi', applied: '✅ đã ghi vào file', discarded: 'đã bỏ', 'handed-off': '↗ đã giao Claude Code' }[x.status] || x.status;
    let b = '';
    if (x.status === 'running') b = '<button class="sec" data-cmd="cancel" data-arg="' + esc(x.id) + '">Hủy</button>';
    const out = vm.hasOutput || !!x.outputFile;
    if (x.status === 'done') b = out ? '<button data-cmd="diff" data-arg="' + esc(x.id) + '">Xem diff</button><button data-cmd="apply" data-arg="' + esc(x.id) + '">Nhận</button>'
      : '<button data-cmd="answer" data-arg="' + esc(x.id) + '">Xem trả lời</button>';
    if (x.status !== 'running') b += '<button class="sec" data-cmd="discard" data-arg="' + esc(x.id) + '">' + (x.status === 'done' ? 'Bỏ' : 'Ẩn') + '</button>';
    return '<div class="card">' + (vm.batch ? '<b>' + esc(String(x.target).split('·')[0]) + '</b> · ' : '') + '<b>' + esc(x.modelId) + '</b> · ' + label + tok + cost
      + (x.error ? '<div class="err">' + esc(x.error) + '</div>' : '')
      + '<div class="row" style="margin-top:6px">' + b + (x.status === 'done' && out ? '<span class="muted">Nhận một phần: sửa bản bên phải trong diff rồi bấm Nhận</span>' : '') + '</div></div>';
  }).join('');
  $('recent').innerHTML = vm.recent.length ? '<h2>Lần chạy gần đây</h2><table>' + vm.recent.map((x) =>
    '<tr><td>' + esc(x.startedAt.slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(x.modelId) + '</td><td>' + esc(x.status) + '</td><td>'
    + (x.costUsd !== undefined ? x.costUsd.toFixed(3) + ' USD' : '') + '</td></tr>').join('') + '</table>' : '';
}
vscode.postMessage({ type: 'ready' });
`;
