// ⑨ Tạo ảnh · ⑩ Tạo video (17/11/2026): mục "## <cảnh>" của <X>_prompt.md chia theo tiểu mục "### …":
//   ảnh  = "### Ảnh k · `EP01_A08_I0`"            (key frame — ⑨)
//   web  = "### Ảnh mạng k · `EP01_A08_W1` — …"   (ảnh tìm trên mạng — ⑨, có sửa hay không)
//   video= "### Video · Seedance …" · "### BK · …" (⑩) · tiểu mục khác (điểm chấm…) đi theo ⑩
// Trạng thái ghi ở đầu tiêu đề: "### ✅ Ảnh 1 · …" đạt · "### ❌ …" loại · không có = chưa làm. AI chỉ viết lại tiểu mục chưa đạt của phần mình.
// Ảnh nạp của video chia 2 loại: chung (ảnh @[TÊN] / EPxx_REF_… làm ở cấp tập · dự án) · riêng (EPxx_<cảnh>_… của phân đoạn / cảnh khác trong tập).
import * as fs from 'fs';
import * as path from 'path';
import { splitLines } from './markdown';

export type PartKind = 'anh' | 'web' | 'video' | 'other';
export type PartStatus = 'done' | 'dropped' | 'todo';
export type Step = 'anh' | 'video';

export interface ScenePart {
  title: string;
  kind: PartKind;
  status: PartStatus;
  /** dòng tiêu đề trong mục (0 = dòng "## <cảnh>") */
  line: number;
  /** tên file trong tiêu đề (trong `…`) — ảnh / clip mà tiểu mục này tạo ra */
  names: string[];
  text: string;
}

export interface SceneSplit {
  head: string;
  /** phần chung trước tiểu mục đầu (cách làm, cài đặt) */
  intro: string;
  parts: ScenePart[];
}

const STATUS_RE = /^(\s*(?:[✅❌⬜⏸⭐]️?\s*)*)/u;

export function partKind(title: string): PartKind {
  if (/ảnh mạng|_W\d/iu.test(title)) return 'web';
  if (/video|seedance|\bBK\b|clip|blockout/iu.test(title)) return 'video';
  if (/(^|[\s·⭐⏸✅❌])ảnh(?=[\s·]|$)|_I\d|key ?frame|khung (đầu|cuối)/iu.test(title)) return 'anh';
  return 'other';
}

export function partStatus(title: string): PartStatus {
  const lead = STATUS_RE.exec(title)?.[1] ?? '';
  return lead.includes('✅') ? 'done' : lead.includes('❌') ? 'dropped' : 'todo';
}

export const stepOf = (k: PartKind): Step => (k === 'anh' || k === 'web' ? 'anh' : 'video');

/** Tách mục cảnh (bắt đầu bằng dòng tiêu đề "## <cảnh> …") thành phần chung + các tiểu mục cấp ngay dưới. */
export function splitScene(section: string): SceneSplit {
  const lines = splitLines(section.replace(/\s+$/, ''));
  const lvl = /^(#+)\s/.exec(lines[0] ?? '')?.[1].length ?? 2;
  const subRe = new RegExp(`^#{${lvl + 1}}\\s+(.*)$`);
  const starts: number[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && i > 0 && subRe.test(l)) starts.push(i);
  });
  const intro = lines.slice(1, starts[0] ?? lines.length).join('\n').replace(/\s+$/, '');
  const parts = starts.map((s, k) => {
    const title = subRe.exec(lines[s])![1].trim();
    return {
      title,
      kind: partKind(title),
      status: partStatus(title),
      line: s,
      names: [...title.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()),
      text: lines.slice(s, starts[k + 1] ?? lines.length).join('\n').replace(/\s+$/, ''),
    };
  });
  return { head: lines[0] ?? '', intro, parts };
}

export function joinScene(s: SceneSplit): string {
  return [s.head, s.intro, ...s.parts.map((p) => p.text)].filter((x) => x.trim() !== '').join('\n\n') + '\n';
}

/** Ghép bản AI của bước `step` vào mục hiện tại: giữ nguyên phần của bước kia + tiểu mục ✅ / ❌ của bước này;
 *  tiểu mục chưa đạt của bước này lấy theo bản AI. Phần chung (intro) do ⑨ viết — ⑩ giữ intro cũ (trống thì nhận của AI). */
export function mergeScenePart(current: string | undefined, proposed: string, step: Step): { text: string; kept: string[] } {
  const p = splitScene(proposed);
  if (!current?.trim()) {
    p.parts = p.parts.filter((x) => stepOf(x.kind) === step);
    return { text: joinScene(p), kept: [] };
  }
  const c = splitScene(current);
  const locked = c.parts.filter((x) => stepOf(x.kind) === step && x.status !== 'todo');
  const key = (x: ScenePart) => x.names[0] ?? x.title.replace(STATUS_RE, '');
  const lockedKeys = new Set(locked.map(key));
  const fresh = p.parts.filter((x) => stepOf(x.kind) === step && !lockedKeys.has(key(x)));
  // thứ tự: ⑨ (ảnh mạng → key frame) rồi ⑩; trong mỗi bước: tiểu mục giữ lại trước, mới của AI sau
  const mine = [...locked, ...fresh];
  const other = c.parts.filter((x) => stepOf(x.kind) !== step);
  const order = (xs: ScenePart[]) => [...xs.filter((x) => x.kind === 'web'), ...xs.filter((x) => x.kind === 'anh'), ...xs.filter((x) => x.kind === 'video'), ...xs.filter((x) => x.kind === 'other')];
  const parts = order(step === 'anh' ? [...mine, ...other] : [...other, ...mine]);
  const intro = step === 'anh' && p.intro.trim() ? p.intro : c.intro || p.intro;
  return { text: joinScene({ head: c.head || p.head, intro, parts }), kept: locked.map(key) };
}

/** Đổi trạng thái ở đầu tiêu đề tiểu mục: "### Ảnh 1 · …" ↔ "### ✅ Ảnh 1 · …" */
export function setPartStatus(headingLine: string, to: PartStatus): string {
  const m = /^(#+\s+)(.*)$/.exec(headingLine);
  if (!m) return headingLine;
  const rest = m[2].replace(/^\s*(?:[✅❌⬜]️?\s*)+/u, '');
  return m[1] + (to === 'done' ? '✅ ' : to === 'dropped' ? '❌ ' : '') + rest;
}

export interface LoadRef {
  /** tên gọi trong prompt: EP01_A08_I0 · EP01_REF_DON_VANTHE · @[THANG_LONG_CONG] → THANG_LONG_CONG */
  name: string;
  group: 'chung' | 'rieng';
  /** cảnh của ảnh riêng (A08) */
  scene?: string;
}

/** Ảnh / clip một tiểu mục nạp: dòng "**Nạp…**" + mọi @tên trong tiểu mục. Chia 2 loại: chung (tập / dự án) · riêng (phân đoạn / cảnh khác). */
export function loadRefs(text: string, ep: string): LoadRef[] {
  const seen = new Map<string, LoadRef>();
  const add = (name: string) => {
    name = name.replace(/[`*.,;:)]+$/, '');
    if (!name || seen.has(name)) return;
    const own = new RegExp(`^${ep}_([A-Z]\\d{2})_`).exec(name);
    if (/_REF_/.test(name) || !/^EP\d+_/.test(name)) seen.set(name, { name, group: 'chung' });
    else if (own) seen.set(name, { name, group: 'rieng', scene: own[1] });
    else seen.set(name, { name, group: 'chung' });
  };
  const nap = splitLines(text).filter((l) => /^\s*\*\*\s*Nạp/i.test(l));
  for (const l of nap) for (const m of l.matchAll(/`(EP\d+_[A-Z0-9_]+)`|@\[([A-Z0-9_]+)\]/g)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(/@(EP\d+_[A-Z0-9_]+)|@\[([A-Z0-9_]+)\]/g)) add(m[1] ?? m[2]);
  return [...seen.values()];
}

/** Chỉ mục file media theo tên không đuôi (EP01_A08_I0 → đường dẫn) — tìm trong các thư mục media (sâu tối đa 5). */
export function mediaIndex(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const ok = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i;
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (ok.test(e.name)) {
        const base = e.name.replace(/\.[^.]+$/, '');
        const prev = out.get(base);
        if (!prev || fs.statSync(abs).mtimeMs > fs.statSync(prev).mtimeMs) out.set(base, abs);
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

/** Tìm file của một tên nạp: đúng tên · EPxx_REF_<TÊN> / EPxx_REF_DON_ / DC_ (ảnh @[TÊN]) */
export function findMedia(idx: Map<string, string>, name: string, ep: string, aliasPrefixes: string[] = ['DON_', 'DC_']): string | undefined {
  if (idx.has(name)) return idx.get(name);
  for (const pre of ['', ...aliasPrefixes]) {
    const k = `${ep}_REF_${pre}${name}`;
    if (idx.has(k)) return idx.get(k);
  }
  return undefined;
}
