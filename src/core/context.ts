// Ghép ngữ cảnh cho một bước: giải đường dẫn, kiểm cổng, dựng prompt, ước tính token, ghép kết quả vào file.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FileRef, STUDIO_DIR, StatusKey, StepSpec, STATUS_LABEL, parseStatus } from './config';
import { applySelect, columnIndex, findSection, findTable, replaceSection, stripMd } from './markdown';
import { scanBlender } from './blender';
import { readRuns } from './runs';
import { Placeholders, ProjectModel, fill, findEpisode, findScene, findSegment, placeholdersFor } from './scanner';

export interface StepTarget {
  ep?: string;
  seg?: string;
  scene?: string;
}

export interface ResolvedFile {
  ref: FileRef;
  role: 'input' | 'output';
  label: string;
  abs: string;
  rel: string;
  exists: boolean;
  /** Đoạn được chọn (select) có trong file không */
  found: boolean;
  line: number;
  text?: string;
  /** đầu vào ảo (git, nhật ký chạy) — không có file để mở */
  virtual?: boolean;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e: any) {
    return `(git lỗi: ${String(e.message).slice(0, 200)})`;
  }
}

function virtualSource(model: ProjectModel, src: NonNullable<FileRef['source']>, ph: Placeholders): { label: string; text: string } {
  const root = model.config.root;
  switch (src) {
    case 'blender-scene': {
      const ep = findEpisode(model, ph.ep);
      if (!ep) return { label: 'Blender của cảnh', text: '(không rõ tập)' };
      const bm = scanBlender(model, ep);
      const shots = bm.shots.filter((s) => s.scene === ph.scene);
      const files = [...new Set(shots.map((s) => s.file))].map((f) => bm.files.find((x) => x.name === f));
      const text = shots.length
        ? [
            ...shots.map((s) => `- shot ${s.code} · ${s.file} · camera ${s.camera ?? '?'} · frame ${s.start}–${s.end} (${((s.end - s.start + 1) / bm.cfg.fps).toFixed(1)} s, nguồn ${s.source})`),
            ...files.filter(Boolean).map((f) => `- ${f!.name}: ${f!.rel ?? 'dựng tại máy'} · script ${f!.scripts.join(', ') || '—'} · hướng dẫn ${f!.guides.join(', ') || '—'}`),
          ].join('\n')
        : `(${ph.scene} chưa có shot Blender nào — marker = mã cảnh, camera ${bm.cfg.cameraPrefix}${ph.scene})`;
      return { label: `Blender của ${ph.scene}`, text };
    }
    case 'git-diff-stat':
      return { label: 'git diff --stat (chưa stage)', text: git(root, ['diff', '--stat']) || '(không có thay đổi chưa stage)' };
    case 'git-status':
      return { label: 'git status --short', text: git(root, ['status', '--short']) || '(sạch)' };
    case 'runs-today': {
      const today = new Date().toISOString().slice(0, 10);
      const runs = readRuns(root).filter((r) => r.startedAt.startsWith(today));
      const text = runs.length
        ? runs.map((r) => `- ${r.startedAt.slice(11, 16)} · ${r.step} · ${r.target} · ${r.modelId} · ${r.status}${r.outputFile ? ' → ' + r.outputFile : ''}`).join('\n')
        : '(hôm nay chưa chạy AI qua tool)';
      return { label: 'Các lần chạy AI hôm nay', text };
    }
  }
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export interface ResolvedStep {
  step: StepSpec;
  target: StepTarget;
  title: string;
  ph: Placeholders;
  inputs: ResolvedFile[];
  output?: ResolvedFile;
  gate: GateResult;
}

export function targetKey(t: StepTarget): string {
  return [t.ep, t.seg, t.scene].filter(Boolean).join('·') || 'dự án';
}

export function resolveRef(model: ProjectModel, ref: FileRef, ph: Placeholders, role: 'input' | 'output'): ResolvedFile {
  if (ref.source) {
    const v = virtualSource(model, ref.source, ph);
    const text = ref.maxChars && v.text.length > ref.maxChars ? v.text.slice(0, ref.maxChars) + '\n…(cắt bớt)' : v.text;
    return { ref, role, label: ref.label ?? v.label, abs: '', rel: `(${ref.source})`, exists: true, found: true, line: 0, text, virtual: true };
  }
  const relPath = fill(ref.path, ph);
  const abs = path.isAbsolute(relPath) ? relPath : path.join(model.config.root, relPath);
  const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const select = ref.select ? fill(ref.select, ph) : undefined;
  let text: string | undefined;
  let found = exists;
  let line = 0;
  if (exists) {
    const full = fs.readFileSync(abs, 'utf8');
    const sel = applySelect(full, select);
    found = !!sel;
    text = sel?.text;
    line = sel?.line ?? 0;
    if (text && ref.maxChars && text.length > ref.maxChars) text = text.slice(0, ref.maxChars) + '\n…(cắt bớt)';
  }
  const label = ref.label ? fill(ref.label, ph) : relPath + (select ? ` § ${select.split(':').slice(1).join(':')}` : '');
  return { ref: { ...ref, path: relPath, select }, role, label, abs, rel: relPath, exists, found, line, text };
}

function checkGate(model: ProjectModel, step: StepSpec, ph: Placeholders): GateResult {
  const reasons: string[] = [];
  const g = step.gate;
  if (!g) return { ok: true, reasons };
  for (const f of g.exists ?? []) {
    const p = fill(f, ph);
    if (!fs.existsSync(path.join(model.config.root, p))) reasons.push(`Chưa có ${p}`);
  }
  if (g.table && g.require) {
    const file = path.join(model.config.root, fill(g.table.file, ph));
    const row = fill(g.table.row, ph);
    let status: StatusKey | undefined;
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const t = findTable(text, [g.table.column]);
      if (t) {
        const ci = columnIndex(t, g.table.column);
        const r = t.rows.find((r) => r.cells.some((c) => stripMd(c) === row));
        if (r) status = parseStatus(r.cells[ci] ?? '', model.config.project.status);
      }
    }
    if (status !== g.require) {
      reasons.push(`${row} ở ${fill(g.table.file, ph)} đang "${status ? STATUS_LABEL[status] : 'không rõ'}", cần "${STATUS_LABEL[g.require]}"`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function resolveStep(model: ProjectModel, step: StepSpec, target: StepTarget): ResolvedStep {
  const ep = findEpisode(model, target.ep);
  const seg = findSegment(ep, target.seg);
  const scene = findScene(seg, target.scene);
  const ph = placeholdersFor(model, ep, seg, scene);
  if (!seg && target.seg) ph.X = target.seg;
  if (!scene && target.scene) ph.scene = target.scene;
  const inputs = (step.inputs ?? []).map((r) => resolveRef(model, r, ph, 'input'));
  const output = step.output ? resolveRef(model, step.output, ph, 'output') : undefined;
  const title = `${step.no} ${step.title} · ${targetKey(target)}`;
  return { step, target, title, ph, inputs, output, gate: checkGate(model, step, ph) };
}

// ---------------------------------------------------------------- prompt

export const BEGIN = '<<<BEGIN>>>';
export const END = '<<<END>>>';

export interface BuiltPrompt {
  system: string;
  prompt: string;
  estInputTokens: number;
}

/** Ước lượng token tiếng Việt có dấu: ~2,4 ký tự / token (thô, chỉ để báo trước) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.4);
}

function coreContext(model: ProjectModel): string {
  const parts: string[] = [];
  for (const ref of model.config.project.coreContext ?? []) {
    const r = resolveRef(model, ref, { root: model.config.root }, 'input');
    if (r.text) parts.push(`### ${r.label}\n${r.text}`);
  }
  return parts.join('\n\n');
}

export function buildPrompt(model: ProjectModel, rs: ResolvedStep, request: string, providerLoadsInstructions: boolean): BuiltPrompt {
  const tplFile = rs.step.prompt ? path.join(model.config.root, STUDIO_DIR, rs.step.prompt) : undefined;
  const tpl = tplFile && fs.existsSync(tplFile) ? fs.readFileSync(tplFile, 'utf8') : `Làm bước "${rs.step.title}".`;

  const inputs = rs.inputs
    .filter((f) => f.text)
    .map((f) => `<file path="${f.rel}"${f.ref.select ? ` select="${f.ref.select}"` : ''}>\n${f.text}\n</file>`)
    .join('\n\n');
  const missing = rs.inputs.filter((f) => !f.text && !f.ref.optional).map((f) => f.label);
  const out = rs.output;
  const current = out?.text ? `<hien-tai path="${out.rel}">\n${out.text}\n</hien-tai>` : '(chưa có — viết mới)';

  const vars: Record<string, string> = {
    target: targetKey(rs.target),
    step: `${rs.step.no} ${rs.step.title}`,
    inputs: inputs || '(không có)',
    missing: missing.length ? missing.join(', ') : '(không)',
    output: out ? out.label : '(không ghi file)',
    current,
    request: request.trim() || '(không có yêu cầu thêm)',
    ...Object.fromEntries(Object.entries(rs.ph).filter(([, v]) => v !== undefined)),
  } as Record<string, string>;
  const body = tpl.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all);

  const rules = [
    `Bạn đang làm một bước trong pipeline làm phim "${model.config.project.name}".`,
    out
      ? `Trả về DUY NHẤT nội dung mới của "${out.label}" giữa hai dòng ${BEGIN} và ${END}. Không giải thích bên ngoài khối. ` +
        `Điều cần người quyết thì ghi ngay trong nội dung bằng dòng "@T: …".`
      : 'Trả lời ngắn gọn bằng tiếng Việt.',
  ].join('\n');
  const core = providerLoadsInstructions ? '' : coreContext(model);
  const system = core ? `${rules}\n\n## LÕI DỰ ÁN\n${core}` : rules;
  return { system, prompt: body, estInputTokens: estimateTokens(system + body) };
}

export function extractOutput(answer: string): string {
  const b = answer.indexOf(BEGIN);
  const e = answer.lastIndexOf(END);
  let t = b >= 0 && e > b ? answer.slice(b + BEGIN.length, e) : answer;
  t = t.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
  return t.trim() + '\n';
}

/** Nội dung file đầy đủ sau khi ghép kết quả (để mở diff với file hiện tại). */
export function mergeOutput(rs: ResolvedStep, newContent: string): string {
  const out = rs.output!;
  const full = out.exists ? fs.readFileSync(out.abs, 'utf8') : '';
  const mode = rs.step.output?.mode ?? 'replace';
  if (mode === 'replace' || !out.ref.select?.startsWith('heading:')) return newContent;
  const sec = findSection(full, out.ref.select.slice('heading:'.length));
  if (mode === 'insert' && sec) {
    // chèn ngay dưới tiêu đề mục, sau các dòng trống / trích dẫn '>' đi liền tiêu đề
    const lines = full.split(/\r?\n/);
    let at = sec.start + 1;
    while (at < sec.end && (lines[at].trim() === '' || lines[at].trim().startsWith('>'))) at++;
    return [...lines.slice(0, at), ...newContent.replace(/\s+$/, '').split('\n'), '', ...lines.slice(at)].join('\n');
  }
  if (sec) return replaceSection(full, sec, newContent);
  return (full.replace(/\s*$/, '') + '\n\n' + newContent).replace(/^\s+/, '');
}
