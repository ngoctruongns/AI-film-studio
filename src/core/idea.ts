// Bước ① Ý tưởng + phong cách: một file .md, mỗi ô của form là một mục "## <nhãn>".
// Sửa trong tool là chính; sửa tay cũng được — giữ nguyên các tiêu đề ##.
import * as fs from 'fs';
import * as path from 'path';
import { splitLines } from './markdown';

export interface IdeaField {
  /** tiêu đề mục ## trong file — cũng là nhãn ô trong form */
  label: string;
  /** text = ô chữ nhiều dòng · choice = chọn một (vẫn gõ được giá trị khác) */
  kind?: 'text' | 'choice';
  choices?: string[];
  hint?: string;
  /** tên biến cho prompt AI: {{key}} = nội dung ô (vd. thoiLuong) — tool cũng đọc ô key 'thoiLuong' làm khung thời lượng tập */
  key?: string;
}

export interface IdeaConfig {
  file: string;
  title?: string;
  fields: IdeaField[];
}

/** mục ## → nội dung (đã cắt khoảng trắng đầu cuối) */
export function readIdea(text: string, cfg: IdeaConfig): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (cur !== undefined) out[cur] = buf.join('\n').trim();
  };
  for (const line of splitLines(text)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith('###')) {
      flush();
      cur = cfg.fields.find((f) => f.label.toLowerCase() === m[1].toLowerCase())?.label ?? m[1];
      buf = [];
    } else if (cur !== undefined) buf.push(line);
  }
  flush();
  return out;
}

/** Ghi lại file: mục có trong form thay nội dung, mục lạ (người tự thêm) giữ nguyên ở cuối. Phần đầu file (trước mục ## đầu) giữ nguyên. */
export function writeIdea(original: string | undefined, values: Record<string, string>, cfg: IdeaConfig): string {
  const lines = splitLines(original ?? '');
  const first = lines.findIndex((l) => /^##\s/.test(l) && !l.startsWith('###'));
  let head = (first >= 0 ? lines.slice(0, first) : lines).join('\n').trim();
  if (!head) head = `# ${cfg.title ?? 'Ý tưởng + phong cách'}`;   // hướng dẫn dùng tool ở 📖 Tài liệu hướng dẫn, không ghi vào file nội dung
  const old = readIdea(original ?? '', cfg);
  const known = new Set(cfg.fields.map((f) => f.label));
  const parts = [head];
  for (const f of cfg.fields) parts.push(`## ${f.label}\n\n${(values[f.label] ?? old[f.label] ?? '').trim()}`);
  for (const [k, v] of Object.entries(old)) if (!known.has(k)) parts.push(`## ${k}\n\n${v}`);
  return parts.join('\n\n') + '\n';
}

/** "15–20 phút" · "15-20′" · "20 phút" · "45'" · "1 giờ" → giây. Hai số = khung min–max; một số = trần. */
export function parseDuration(text: string): { min?: number; max?: number } {
  const t = (text ?? '').toLowerCase().replace(',', '.');
  const unit = /giờ|tiếng|\bh\b/.test(t) ? 3600 : /giây|\bs\b|″|"/.test(t) && !/phút|′|'/.test(t) ? 1 : 60;
  const n = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Math.round(Number(m[0]) * unit));
  if (!n.length) return {};
  if (n.length === 1) return { max: n[0] };
  return { min: Math.min(n[0], n[1]), max: Math.max(n[0], n[1]) };
}

/** Giá trị các ô có key trong file ý tưởng (đọc lại mỗi lần — file nhỏ) */
export function ideaVars(root: string, cfg: IdeaConfig | undefined): Record<string, string> {
  if (!cfg) return {};
  const f = path.join(root, cfg.file);
  const v = readIdea(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', cfg);
  const out: Record<string, string> = {};
  for (const x of cfg.fields) if (x.key) out[x.key] = (v[x.label] ?? '').trim();
  return out;
}

/** Khung thời lượng một tập: ô "thoiLuong" của form ① — chưa đặt thì dùng episodeCapSeconds (trần) của project.yaml */
export function episodeDuration(root: string, cfg: IdeaConfig | undefined, fallbackCap?: number): { text: string; min?: number; max?: number } {
  const text = ideaVars(root, cfg)['thoiLuong'] ?? '';
  const d = parseDuration(text);
  return { text, min: d.min, max: d.max ?? fallbackCap };
}
