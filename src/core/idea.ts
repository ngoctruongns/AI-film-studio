// Bước ① Ý tưởng + phong cách: một file .md, mỗi ô của form là một mục "## <nhãn>".
// Sửa trong tool là chính; sửa tay cũng được — giữ nguyên các tiêu đề ##.
import { splitLines } from './markdown';

export interface IdeaField {
  /** tiêu đề mục ## trong file — cũng là nhãn ô trong form */
  label: string;
  /** text = ô chữ nhiều dòng · choice = chọn một (vẫn gõ được giá trị khác) */
  kind?: 'text' | 'choice';
  choices?: string[];
  hint?: string;
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
  if (!head) head = `# ${cfg.title ?? 'Ý tưởng + phong cách'}\n\n> AI Film Studio ghi file này (bước ①). Sửa trong tool; sửa tay thì giữ nguyên các tiêu đề ##.`;
  const old = readIdea(original ?? '', cfg);
  const known = new Set(cfg.fields.map((f) => f.label));
  const parts = [head];
  for (const f of cfg.fields) parts.push(`## ${f.label}\n\n${(values[f.label] ?? old[f.label] ?? '').trim()}`);
  for (const [k, v] of Object.entries(old)) if (!known.has(k)) parts.push(`## ${k}\n\n${v}`);
  return parts.join('\n\n') + '\n';
}
