// Bước ⑨ Prompt ảnh + video của một cảnh: mục "## <cảnh> · …" trong <X>_prompt.md + prompt của mọi ảnh tham chiếu @[TÊN] cảnh đó nạp
// (tìm khối "**@[TÊN]**" trong các file prompt dùng chung của tập) + các cảnh khác cũng dùng ảnh đó.
import * as fs from 'fs';
import * as path from 'path';
import { parseHeadings, splitLines } from './markdown';
import { Episode } from './scanner';

export interface ScenePromptConfig {
  /** file prompt dùng chung, có {episodeDir} — vd. '{episodeDir}/tham-chieu/anh-tham-chieu_prompt.md' */
  shared: string[];
  /** tiền tố ảnh cắt từ tấm khác (DON_, DC_) — không có prompt riêng thì thử tên gốc */
  aliasPrefixes?: string[];
}

export interface PromptBlock {
  /** tương đối gốc dự án */
  file: string;
  line: number;
  text: string;
}

export interface SharedRef {
  name: string;
  /** khối prompt tìm được (theo tên chính hoặc tên gốc) */
  prompt?: PromptBlock & { via: string };
  /** cảnh khác trong tập cũng nạp ảnh này */
  usedIn: string[];
}

export interface ScenePrompts {
  scene?: PromptBlock;
  refs: SharedRef[];
}

const REF_RE = /@\[([A-Z0-9_]+)\]/g;
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

/** mục có tiêu đề BẮT ĐẦU bằng mã cảnh (không lấy nhầm "F02-F06" trong tiêu đề F02) */
export function sceneSection(text: string, code: string): { line: number; text: string } | undefined {
  const lines = splitLines(text);
  const heads = parseHeadings(text);
  const re = new RegExp(`^[*_~\\s]*${code}(?!\\d)`);
  const i = heads.findIndex((h) => re.test(h.text));
  if (i < 0) return undefined;
  const h = heads[i];
  const next = heads.slice(i + 1).find((x) => x.level <= h.level);
  return { line: h.line, text: lines.slice(h.line, next ? next.line : lines.length).join('\n').trim() };
}

/** "**@[TÊN]**" đầu dòng → khối tới dòng "**@[" kế tiếp hoặc tiêu đề */
export function sharedPromptIndex(text: string): Map<string, { line: number; text: string }> {
  const lines = splitLines(text);
  const out = new Map<string, { line: number; text: string }>();
  let inFence = false;
  const starts: { line: number; names: string[] }[] = [];
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) return;
    if (/^\s*\*\*@\[/.test(l)) starts.push({ line: i, names: [...l.matchAll(/\*\*@\[([A-Z0-9_]+)\]\*\*/g)].map((m) => m[1]) });
    else if (/^#{1,6}\s/.test(l)) starts.push({ line: i, names: [] });
  });
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const block = lines.slice(s.line, end).join('\n').trim();
    for (const n of s.names) if (!out.has(n)) out.set(n, { line: s.line, text: block });
  });
  return out;
}

function aliases(name: string, prefixes: string[]): string[] {
  let base = name;
  for (const p of prefixes) if (base.startsWith(p)) base = base.slice(p.length);
  return [...new Set([name, ...prefixes.map((p) => p + base), base])];
}

export function scenePrompts(root: string, ep: Episode, segCode: string, scene: string, cfg: ScenePromptConfig | undefined): ScenePrompts {
  const rel = (f: string) => path.relative(root, f).replace(/\\/g, '/');
  const seg = ep.segments.find((s) => s.code === segCode);
  const pf = seg?.files['prompt'];
  const own = pf ? sceneSection(read(pf), scene) : undefined;
  const result: ScenePrompts = { scene: own && pf ? { file: rel(pf), line: own.line, text: own.text } : undefined, refs: [] };
  if (!own) return result;
  const prefixes = cfg?.aliasPrefixes ?? ['DON_', 'DC_'];
  const index: { file: string; map: Map<string, { line: number; text: string }> }[] = (cfg?.shared ?? []).map((f) => {
    const abs = path.join(root, f.replace('{episodeDir}', ep.relDir));
    return { file: rel(abs), map: sharedPromptIndex(read(abs)) };
  });
  // mọi mục cảnh trong các file prompt của tập — để biết cảnh nào khác cũng dùng ảnh
  const sections: { code: string; text: string }[] = [];
  for (const s of ep.segments) {
    const t = s.files['prompt'] ? read(s.files['prompt']) : '';
    if (t) for (const c of s.scenes) {
      const sec = sceneSection(t, c.code);
      if (sec) sections.push({ code: c.code, text: sec.text });
    }
  }
  const names = [...new Set([...own.text.matchAll(REF_RE)].map((m) => m[1]))];
  for (const name of names) {
    const al = aliases(name, prefixes);
    let prompt: SharedRef['prompt'];
    for (const a of al) {
      const hit = index.find((x) => x.map.has(a));
      if (hit) {
        const b = hit.map.get(a)!;
        prompt = { file: hit.file, line: b.line, text: b.text, via: a };
        break;
      }
    }
    const usedIn = sections.filter((x) => x.code !== scene && al.some((a) => x.text.includes(`@[${a}]`))).map((x) => x.code);
    result.refs.push({ name, prompt, usedIn });
  }
  return result;
}
