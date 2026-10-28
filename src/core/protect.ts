// "AI chỉ tạo lại cái CHƯA duyệt" (Trường 28/10/2026): sau khi AI trả bản đề xuất, tool khôi phục NGUYÊN VĂN mọi phần đã duyệt —
// dòng bảng (cảnh, câu lời, tập) hoặc mục "## [X]" (phân đoạn trong kịch bản chi tiết). Không phụ thuộc AI có nghe lời hay không.
import { columnIndex, splitLines, stripMd } from './markdown';
import { readGrid, writeGrid, GridRow } from './tableEdit';

/** bảng: các dòng đã duyệt giữ nguyên · sections: các mục ## [X] đã duyệt giữ nguyên */
export type ProtectKind = 'scenes' | 'lines' | 'episodes' | 'segments';

export interface TableProtect {
  codeColumn: string;
  codeRe: RegExp;
  statusColumn?: string;
  /** dòng có ký hiệu này trong ô trạng thái = đã duyệt */
  lockSymbols: string[];
}

const codeOf = (cell: string) => stripMd(cell ?? '').replace(/~/g, '').trim();

/** mã các dòng đã duyệt trong bảng của file gốc */
export function lockedRows(original: string, t: TableProtect): string[] {
  const g = readGrid(original, t.codeColumn, t.codeRe);
  if (!g) return [];
  const si = columnIndex({ line: 0, headers: g.headers, rows: [] }, t.statusColumn);
  if (si < 0) return [];
  return g.rows.filter((r) => t.lockSymbols.some((s) => (r.cells[si] ?? '').includes(s))).map((r) => codeOf(r.cells[g.codeIndex]));
}

/** Đặt lại các dòng đã duyệt vào bảng của bản đề xuất (thay dòng cùng mã; AI xóa mất thì chèn lại sau dòng đứng trước nó ở bản gốc). */
export function protectTable(original: string, proposed: string, t: TableProtect, locked: string[]): { text: string; restored: string[] } {
  if (!locked.length) return { text: proposed, restored: [] };
  const go = readGrid(original, t.codeColumn, t.codeRe);
  const gp = readGrid(proposed, t.codeColumn, t.codeRe);
  if (!go || !gp) return { text: proposed, restored: [] };
  const width = gp.headers.length;
  // khớp cột theo tên (AI có thể đổi thứ tự / thêm cột)
  const map = gp.headers.map((h) => columnIndex({ line: 0, headers: go.headers, rows: [] }, h));
  const origRow = new Map(go.rows.map((r) => [codeOf(r.cells[go.codeIndex]), r]));
  const rows: GridRow[] = gp.rows.map((r) => ({ line: -1, cells: r.cells.slice() }));
  const restored: string[] = [];
  for (const code of locked) {
    const o = origRow.get(code);
    if (!o) continue;
    const cells = Array.from({ length: width }, (_, i) => (map[i] >= 0 ? o.cells[map[i]] ?? '' : ''));
    const k = rows.findIndex((r) => codeOf(r.cells[gp.codeIndex]) === code);
    if (k >= 0) {
      if (rows[k].cells.join('|') !== cells.join('|')) restored.push(code);
      rows[k] = { line: -1, cells };
    } else {
      // chèn sau dòng đứng trước nó ở bản gốc (nếu còn), không thì cuối bảng
      const oi = go.rows.indexOf(o);
      const prev = go.rows.slice(0, oi).reverse().map((r) => codeOf(r.cells[go.codeIndex])).find((c) => rows.some((r) => codeOf(r.cells[gp.codeIndex]) === c));
      const at = prev ? rows.findIndex((r) => codeOf(r.cells[gp.codeIndex]) === prev) + 1 : rows.length;
      rows.splice(at, 0, { line: -1, cells });
      restored.push(code);
    }
  }
  return { text: writeGrid(gp, rows), restored };
}

interface Sec {
  code: string;
  start: number;
  end: number;
}

/** mục "## [X] …" (cả "## ~~[X]~~") → khoảng dòng tới mục ##/# kế tiếp */
function sections(lines: string[]): Sec[] {
  const out: Sec[] = [];
  let fence = false;
  const heads: { i: number; code?: string }[] = [];
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) return;
    if (/^#{1,2}\s/.test(l)) heads.push({ i, code: /^##\s+(?:~~)?\[([A-Z])\]/.exec(l)?.[1] });
  });
  heads.forEach((h, k) => {
    if (h.code) out.push({ code: h.code, start: h.i, end: k + 1 < heads.length ? heads[k + 1].i : lines.length });
  });
  return out;
}

/** Đặt lại nguyên văn các mục ## [X] đã duyệt vào bản đề xuất. */
export function protectSections(original: string, proposed: string, locked: string[]): { text: string; restored: string[] } {
  if (!locked.length) return { text: proposed, restored: [] };
  const ol = splitLines(original);
  let pl = splitLines(proposed);
  const os = sections(ol);
  const restored: string[] = [];
  for (const code of locked) {
    const o = os.find((s) => s.code === code);
    if (!o) continue;
    const block = ol.slice(o.start, o.end);
    const ps = sections(pl);
    const p = ps.find((s) => s.code === code);
    if (p) {
      if (pl.slice(p.start, p.end).join('\n') !== block.join('\n')) restored.push(code);
      pl = [...pl.slice(0, p.start), ...block, ...pl.slice(p.end)];
    } else {
      // AI bỏ mất → chèn sau mục đứng trước nó ở bản gốc, không thì cuối file
      const prev = os.slice(0, os.indexOf(o)).reverse().find((s) => ps.some((x) => x.code === s.code));
      const after = prev ? ps.find((x) => x.code === prev.code)!.end : pl.length;
      pl = [...pl.slice(0, after), ...block, ...pl.slice(after)];
      restored.push(code);
    }
  }
  return { text: pl.join('\n'), restored };
}
