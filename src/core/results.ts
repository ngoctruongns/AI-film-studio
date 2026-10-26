// Kết quả tạo hình (bước ⑦): file media theo mã cảnh + sổ kết quả <X>_ket-qua.md (tool tự quản file này).
import * as fs from 'fs';
import * as path from 'path';
import { columnIndex, findTable, splitLines, stripMd } from './markdown';

export interface MediaFile {
  abs: string;
  name: string;
  /** I · V · R · A · L · E */
  kind: string;
  /** số sau loại: _V3 → 3 · _R1_I0 → 1 */
  num: number;
  /** _R1_I0 → 'I0' (ảnh con của video tham chiếu) */
  sub?: string;
  draft?: number;
  ext: string;
  type: 'image' | 'video' | 'audio' | 'other';
  mtime: number;
  /** nằm trong repo (seedance_clip/) hay thư mục media ngoài */
  inRepo: boolean;
}

const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VID = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUD = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac']);

/** Tên file theo mã: EP01_K02_V3.mp4 · EP01_F02_R1_I0.png · F02_R1.mp4 (seedance_clip, không tiền tố tập) · EP01_F02_I0-v2.png */
export function parseMediaName(name: string, ep: string, scene: string): Omit<MediaFile, 'abs' | 'mtime' | 'inRepo'> | undefined {
  const ext = path.extname(name).toLowerCase();
  const base = name.slice(0, name.length - ext.length);
  const m = new RegExp(`^(?:${ep}_)?${scene}_([IVRALE])(\\d+)(?:_([IV]\\d+))?(?:-v(\\d+))?$`).exec(base);
  if (!m) return undefined;
  return {
    name,
    kind: m[1],
    num: Number(m[2]),
    sub: m[3],
    draft: m[4] ? Number(m[4]) : undefined,
    ext,
    type: IMG.has(ext) ? 'image' : VID.has(ext) ? 'video' : AUD.has(ext) ? 'audio' : 'other',
  };
}

export function listSceneMedia(dirs: { dir: string; inRepo: boolean }[], ep: string, scene: string): MediaFile[] {
  const out: MediaFile[] = [];
  const walk = (dir: string, inRepo: boolean, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, inRepo, depth + 1);
      else {
        const p = parseMediaName(e.name, ep, scene);
        if (p) out.push({ ...p, abs, inRepo, mtime: fs.statSync(abs).mtimeMs });
      }
    }
  };
  for (const d of dirs) walk(d.dir, d.inRepo, 0);
  const order = 'RIVLAE';
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.num - b.num || (a.draft ?? 0) - (b.draft ?? 0) || a.name.localeCompare(b.name));
}

/** Tên file mới cho một loại media. I/L/A: số người chọn · V/R: số kế tiếp. Trùng tên → thêm -v<n> (bản nháp). */
export function mediaTargetName(existing: MediaFile[], ep: string, scene: string, kind: string, num: number | undefined, ext: string): string {
  const same = existing.filter((f) => f.kind === kind && !f.sub);
  const n = num ?? same.reduce((m, f) => Math.max(m, f.num), 0) + 1;
  const base = `${ep}_${scene}_${kind}${n}`;
  const taken = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!taken.has(`${base}${ext}`.toLowerCase())) return `${base}${ext}`;
  for (let v = 2; ; v++) if (!taken.has(`${base}-v${v}${ext}`.toLowerCase())) return `${base}-v${v}${ext}`;
}

// ------------------------------------------------------------------ sổ kết quả

export const RESULT_HEADERS = ['Cảnh', 'Lần sinh', 'Bản chốt', 'Model video', 'Lỗi / ghi chú', 'Cập nhật'];

export interface SceneResult {
  scene: string;
  attempts?: number;
  chosen: string;
  model: string;
  note: string;
  updated: string;
}

export function parseResults(text: string): Map<string, SceneResult> {
  const out = new Map<string, SceneResult>();
  const t = findTable(text, ['Cảnh', 'Lần sinh']);
  if (!t) return out;
  const col = (n: string) => columnIndex(t, n);
  for (const r of t.rows) {
    const scene = stripMd(r.cells[col('Cảnh')] ?? '');
    if (!scene) continue;
    const n = Number(stripMd(r.cells[col('Lần sinh')] ?? ''));
    out.set(scene, {
      scene,
      attempts: Number.isFinite(n) && n > 0 ? n : undefined,
      chosen: stripMd(r.cells[col('Bản chốt')] ?? ''),
      model: stripMd(r.cells[col('Model')] ?? ''),
      note: (r.cells[col('ghi chú')] ?? '').trim(),
      updated: stripMd(r.cells[col('Cập nhật')] ?? ''),
    });
  }
  return out;
}

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

function rowLine(r: SceneResult): string {
  return `| ${[r.scene, r.attempts ?? '', r.chosen, r.model, r.note, r.updated].map((x) => cell(String(x))).join(' | ')} |`;
}

/** Ghi / cập nhật dòng của một cảnh. File chưa có thì tạo khung. */
export function upsertResult(text: string | undefined, segName: string, r: SceneResult, sceneOrder: string[]): string {
  if (!text || !findTable(text, ['Cảnh', 'Lần sinh'])) {
    const head = text?.trim()
      ? text.replace(/\s*$/, '\n\n')
      : `# ${segName} — kết quả tạo hình *(AI Film Studio ghi — sửa tay được)*\n\n` +
        `> Mỗi cảnh một dòng: số lần sinh video AI, bản chốt, lỗi gặp phải. Dùng để đo "số lần sinh lại để được một clip dùng được".\n\n`;
    return `${head}| ${RESULT_HEADERS.join(' | ')} |\n|${RESULT_HEADERS.map(() => '---').join('|')}|\n${rowLine(r)}\n`;
  }
  const lines = splitLines(text);
  const t = findTable(text, ['Cảnh', 'Lần sinh'])!;
  const ci = columnIndex(t, 'Cảnh');
  const hit = t.rows.find((x) => stripMd(x.cells[ci] ?? '') === r.scene);
  if (hit) lines[hit.line] = rowLine(r);
  else {
    // chèn theo thứ tự chiếu của bảng cảnh; cảnh không có trong bảng cảnh thì thêm cuối
    const end = t.line + 2 + t.rows.length;
    const pos = sceneOrder.indexOf(r.scene);
    let at = end;
    if (pos >= 0 && t.rows.length) {
      const after = [...t.rows].reverse().find((x) => {
        const p = sceneOrder.indexOf(stripMd(x.cells[ci] ?? ''));
        return p >= 0 && p < pos;
      });
      at = after ? after.line + 1 : t.rows[0].line;
    }
    lines.splice(at, 0, rowLine(r));
  }
  return lines.join('\n');
}
