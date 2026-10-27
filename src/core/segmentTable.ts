// Bảng phân đoạn của tập (README tập): đổi trạng thái một dòng, nhận dòng mới từ kịch bản chi tiết AI viết (bước ④).
import { columnIndex, findTable, splitLines, stripMd } from './markdown';
import { readGrid, writeGrid } from './tableEdit';

const SEG_RE = /^(~~)?[A-Z](~~)?$/;
const STATUS_HEAD = /^(✅|⬜|👀|✍|⏸|🧪|❌|⛔)\s*(đã duyệt|chưa duyệt|chờ duyệt)?\s*[—·-]?\s*/u;

/** thay ký hiệu trạng thái đầu ô, giữ phần ghi chú phía sau: "👀 chờ duyệt — chia 26/10" → "✅ chia 26/10" */
export function setStatusCell(cell: string, sym: string): string {
  const rest = cell.trim().replace(STATUS_HEAD, '').trim();
  return rest ? `${sym} ${rest}` : sym;
}

export function setSegmentStatus(readme: string, cols: { code: string; status: string }, code: string, sym: string): string | undefined {
  const g = readGrid(readme, cols.code, SEG_RE);
  if (!g) return undefined;
  const si = columnIndex({ line: 0, headers: g.headers, rows: [] }, cols.status);
  if (si < 0) return undefined;
  const rows = g.rows.map((r) => ({ line: r.line, cells: r.cells.slice() }));
  const r = rows.find((x) => stripMd(x.cells[g.codeIndex]).replace(/~/g, '') === code);
  if (!r) return undefined;
  r.cells[si] = setStatusCell(r.cells[si], sym);
  return writeGrid(g, rows);
}

/**
 * Nhận bảng phân đoạn trong kịch bản chi tiết (AI viết) vào README tập: mã chưa có → thêm dòng (khớp cột theo tên);
 * README chưa có bảng → chép nguyên bảng vào mục "## Phân đoạn". Dòng đã có trong README giữ nguyên.
 */
export function mergeSegmentTable(readme: string, script: string, cols: { code: string; name: string }): { text: string; added: string[] } {
  const src = findTable(script, [cols.code, cols.name]);
  if (!src) return { text: readme, added: [] };
  const sci = columnIndex(src, cols.code);
  const srcRows = src.rows.filter((r) => SEG_RE.test(stripMd(r.cells[sci] ?? '')));
  const g = readGrid(readme, cols.code, SEG_RE);
  if (!g) {
    const lines = splitLines(script);
    const block = lines.slice(src.line, src.line + 2 + src.rows.length).join('\n');
    const text = `${readme.replace(/\s*$/, '')}\n\n## Phân đoạn\n\n${block}\n`;
    return { text, added: srcRows.map((r) => stripMd(r.cells[sci]).replace(/~/g, '')) };
  }
  const have = new Set(g.rows.map((r) => stripMd(r.cells[g.codeIndex]).replace(/~/g, '')));
  const rows = g.rows.map((r) => ({ line: r.line, cells: r.cells.slice() }));
  const added: string[] = [];
  // dòng tổng (không có mã) giữ ở cuối
  const tail = rows.length && !SEG_RE.test(stripMd(rows[rows.length - 1].cells[g.codeIndex] ?? '')) ? rows.pop() : undefined;
  for (const r of srcRows) {
    const code = stripMd(r.cells[sci]).replace(/~/g, '');
    if (have.has(code)) continue;
    rows.push({ line: -1, cells: g.headers.map((h) => { const i = columnIndex(src, h); return i >= 0 ? r.cells[i] ?? '' : ''; }) });
    added.push(code);
  }
  if (tail) rows.push(tail);
  return { text: added.length ? writeGrid(g, rows) : readme, added };
}

