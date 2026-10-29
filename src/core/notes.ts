// Gom ghi chú trong mọi file .md (quy ước 29/10/2026 — QUY-UOC-MA-SO.md §Ghi chú):
//   /*@C … */  người dùng → AI (việc cần làm) · /*@T … */  AI → người dùng (câu hỏi, góp ý thêm / bớt / sửa) — một hay nhiều dòng
//   dạng một dòng cũ '@C: …' / '@T: …' vẫn đọc · <!-- @tool … --> do tool ghi (trạng thái), không gom.
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig } from './config';

export interface Note {
  kind: 'todo' | 'question';
  file: string;
  line: number;
  text: string;
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'out', '.studio']);

export function listMarkdown(root: string, exclude: string[] = []): string[] {
  const ex = exclude.map((e) => e.replace(/\/+$/, ''));
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ex.some((x) => rel === x || rel.startsWith(x + '/'))) continue;
      if (e.isDirectory()) {
        if (!ALWAYS_SKIP.has(e.name)) walk(abs);
      } else if (e.name.endsWith('.md')) out.push(abs);
    }
  };
  walk(root);
  return out;
}

export function scanNotes(root: string, p: ProjectConfig): Note[] {
  const notes: Note[] = [];
  const { todo, question } = p.notes;
  for (const file of listMarkdown(root, p.notes.exclude)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(todo) && !text.includes(question) && !text.includes('/*@')) continue;
    // khối /*@C … */ · /*@T … */ (nhiều dòng được)
    for (const m of text.matchAll(/\/\*@([CT])\b:?([\s\S]*?)\*\//g)) {
      const line = text.slice(0, m.index).split(/\r?\n/).length - 1;
      const body = m[2].replace(/[*`|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      notes.push({ kind: m[1] === 'C' ? 'todo' : 'question', file, line, text: body });
    }
    text.split(/\r?\n/).forEach((l, i) => {
      if (l.includes('/*@')) return;                   // đã tính ở khối trên
      // '✅ @C (ngày): đã làm …' là ghi chú đã xử lý — bỏ qua
      if (l.includes(todo) && !/✅\s*@C/.test(l)) notes.push({ kind: 'todo', file, line: i, text: snippet(l, todo) });
      if (l.includes(question)) notes.push({ kind: 'question', file, line: i, text: snippet(l, question) });
    });
  }
  return notes;
}

function snippet(line: string, marker: string): string {
  const i = line.indexOf(marker);
  return line.slice(i + marker.length).replace(/[*`|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}
