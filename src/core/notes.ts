// Gom ghi chú '@C:' (việc cho AI) và '@T:' (câu hỏi cho người) trong mọi file .md.
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
    if (!text.includes(todo) && !text.includes(question)) continue;
    text.split(/\r?\n/).forEach((l, i) => {
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
