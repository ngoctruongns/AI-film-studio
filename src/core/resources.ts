// Tài nguyên dự án: tài liệu dùng chung cả dự án (sử liệu, quy trình, pipeline, kiến thức làm phim), gom theo nhóm.
// File thuộc tài nguyên thì tab tập / phân đoạn / cảnh không liệt kê trong "File liên quan" — AI vẫn được nạp khi chạy bước.
import * as fs from 'fs';
import * as path from 'path';

export interface ResourceItem {
  /** một file (tương đối gốc dự án) */
  path?: string;
  /** cả thư mục — các file .md bên trong, sâu 2 cấp */
  dir?: string;
  label?: string;
}

export interface ResourceGroup {
  group: string;
  items: ResourceItem[];
}

export interface ResourceFile {
  label: string;
  rel: string;
  abs: string;
  exists: boolean;
}

export interface ResourceEntry {
  label: string;
  /** file đơn → một phần tử; thư mục → các file bên trong */
  files: ResourceFile[];
  dir?: string;
}

function mdFiles(dir: string, depth: number): string[] {
  let out: string[] = [];
  let ents: fs.Dirent[] = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) out = out.concat(mdFiles(p, depth - 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function listResources(root: string, groups: ResourceGroup[] = []): { group: string; entries: ResourceEntry[] }[] {
  return groups.map((g) => ({
    group: g.group,
    entries: (g.items ?? []).map((it) => {
      if (it.dir) {
        const abs = path.join(root, it.dir);
        const files = mdFiles(abs, 2).map((f) => {
          const rel = norm(path.relative(root, f));
          return { label: norm(path.relative(abs, f)).replace(/\.md$/i, ''), rel, abs: f, exists: true };
        });
        return { label: it.label ?? it.dir, files, dir: abs };
      }
      const rel = norm(it.path ?? '');
      const abs = path.join(root, rel);
      return { label: it.label ?? path.basename(rel), files: [{ label: it.label ?? path.basename(rel), rel, abs, exists: fs.existsSync(abs) }] };
    }),
  }));
}

/** đường dẫn (tương đối gốc) có thuộc tài nguyên dự án không */
export function isResource(rel: string, groups: ResourceGroup[] = []): boolean {
  const r = norm(rel);
  return groups.some((g) =>
    (g.items ?? []).some((it) => (it.path && norm(it.path) === r) || (it.dir && r.startsWith(norm(it.dir).replace(/\/?$/, '/')))),
  );
}
