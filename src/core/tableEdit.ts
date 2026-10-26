// Sửa bảng cảnh dạng lưới: đọc bảng có cột mã, ghi lại đúng các dòng của bảng đó — phần còn lại của file giữ nguyên từng ký tự.
import { MdTable, columnIndex, parseTables, splitLines, splitRow, stripMd } from './markdown';

export interface GridRow {
  /** dòng gốc trong file (-1 = dòng mới) */
  line: number;
  cells: string[];
}

export interface Grid {
  headers: string[];
  codeIndex: number;
  /** dòng tiêu đề bảng (0-based) */
  line: number;
  rows: GridRow[];
  /** nội dung file lúc đọc — để phát hiện file bị sửa ở chỗ khác trong lúc đang sửa lưới */
  original: string;
}

export function readGrid(text: string, codeColumn: string, codeRe: RegExp): Grid | undefined {
  const t: MdTable | undefined = parseTables(text).find((x) => {
    const ci = columnIndex(x, codeColumn);
    return ci >= 0 && x.rows.some((r) => codeRe.test(stripMd(r.cells[ci] ?? '')));
  });
  if (!t) return undefined;
  const width = t.headers.length;
  return {
    headers: t.headers,
    codeIndex: columnIndex(t, codeColumn),
    line: t.line,
    rows: t.rows.map((r) => ({ line: r.line, cells: Array.from({ length: width }, (_, i) => r.cells[i] ?? '') })),
    original: text,
  };
}

export function formatCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
}

export function formatRow(cells: string[]): string {
  return `| ${cells.map(formatCell).join(' | ')} |`;
}

/** Ghép lưới mới vào file: thay khối dòng của bảng. Dòng không đổi giữ nguyên văn bản gốc. */
export function writeGrid(grid: Grid, rows: GridRow[]): string {
  const lines = splitLines(grid.original);
  const start = grid.line + 2;
  const end = start + grid.rows.length;
  const out = rows.map((r) => {
    if (r.line >= 0) {
      const orig = lines[r.line];
      const same = splitRow(orig);
      if (same.length === r.cells.length && same.every((c, i) => c === r.cells[i].trim())) return orig;
    }
    return formatRow(r.cells);
  });
  return [...lines.slice(0, start), ...out, ...lines.slice(end)].join('\n');
}
