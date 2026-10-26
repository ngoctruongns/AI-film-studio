// Duyệt theo cấp — đổi ký hiệu trạng thái trong bảng thay người gõ tay:
//   cảnh      → dòng cảnh trong <X>_canh.md
//   phân đoạn → dòng phân đoạn trong README tập + mọi cảnh của phân đoạn
//   tập       → mọi phân đoạn + mọi cảnh của tập
// Dòng đã bỏ (❌) không đụng. Bỏ duyệt → về "chờ duyệt".
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig, StatusKey, STATUS_ORDER, parseStatus } from './config';
import { columnIndex, parseTables, splitLines, splitRow, stripMd } from './markdown';
import { Episode, ProjectModel, Segment } from './scanner';
import { formatRow } from './tableEdit';

export type ApproveLevel = 'scene' | 'segment' | 'episode';

export interface CellChange {
  file: string;
  line: number;
  /** chỉ số cột trạng thái */
  col: number;
  code: string;
  before: string;
  after: string;
}

/** Ô trạng thái mới: thay ký hiệu ĐẦU TIÊN tại chỗ + bỏ chữ trạng thái đi liền ("chờ duyệt"…), giữ phần ghi chú.
 *  "⬜ chờ duyệt · D01 đã render" → "✅ D01 đã render" · "kịch bản ⬜" → "kịch bản ✅" · "" → "✅" */
export function setStatusText(cell: string, to: StatusKey, p: ProjectConfig): string {
  const sym = p.status[to][0];
  const label = to === 'review' ? ' chờ duyệt' : '';
  const text = cell.trim();
  const all = STATUS_ORDER.flatMap((k) => p.status[k] ?? []);
  const first = all.map((s) => ({ s, i: text.indexOf(s) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0];
  if (!first) return text ? `${sym}${label} · ${text}` : `${sym}${label}`;
  const before = text.slice(0, first.i);
  let after = text.slice(first.i + first.s.length);
  const cut = after.replace(/^\s*(chờ duyệt|đang viết|chưa làm|đã duyệt|duyệt|treo)\b/i, '');
  if (cut !== after) after = cut.replace(/^\s*[·—–:-]\s*/, ' ');
  after = after.replace(/^\s+/, ' ');
  return `${before}${sym}${label}${after && label && !after.startsWith(' ·') ? ' ·' : ''}${after}`.replace(/\s+/g, ' ').trim();
}

/** Đổi trạng thái các dòng có mã trong `codes` của bảng có cột mã + cột trạng thái. Trả về thay đổi (chưa ghi). */
export function planTable(file: string, codeColumn: string, statusColumn: string, codes: Set<string> | 'all', to: StatusKey, p: ProjectConfig, rowCode?: RegExp): CellChange[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = splitLines(text);
  const out: CellChange[] = [];
  for (const t of parseTables(text)) {
    const ci = columnIndex(t, codeColumn);
    const si = columnIndex(t, statusColumn);
    if (ci < 0 || si < 0) continue;
    for (const r of t.rows) {
      const code = stripMd(r.cells[ci] ?? '').replace(/~/g, '').trim();
      if (!code || (rowCode && !rowCode.test(code))) continue;
      if (codes !== 'all' && !codes.has(code)) continue;
      const cur = r.cells[si] ?? '';
      const st = parseStatus(cur, p.status);
      if (st === 'dropped' || /~~/.test(r.cells[ci] ?? '')) continue;
      if (st === to) continue;
      const cells = splitRow(lines[r.line]);
      while (cells.length < t.headers.length) cells.push('');
      cells[si] = setStatusText(cur, to, p);
      out.push({ file, line: r.line, col: si, code, before: cur, after: cells[si] });
      lines[r.line] = formatRow(cells);
    }
  }
  return out;
}

export interface ApprovePlan {
  level: ApproveLevel;
  label: string;
  to: StatusKey;
  changes: CellChange[];
}

export function planApprove(model: ProjectModel, level: ApproveLevel, ep: Episode, seg?: Segment, scene?: string, to: StatusKey = 'done'): ApprovePlan {
  const p = model.config.project;
  const st = p.sceneTable;
  const segTable = p.episode.segmentTable;
  const sceneRe = new RegExp(p.codes.scene);
  const changes: CellChange[] = [];
  const segsOf = level === 'episode' ? ep.segments.filter((s) => !s.dropped) : seg ? [seg] : [];
  if (level === 'scene' && seg && scene && seg.files[st.file]) {
    changes.push(...planTable(seg.files[st.file], st.codeColumn, st.statusColumn ?? 'Trạng thái', new Set([scene]), to, p, sceneRe));
  } else {
    // dòng phân đoạn trong README tập
    if (segTable && ep.files[segTable.file]) {
      const codes = new Set(segsOf.map((s) => s.code));
      changes.push(...planTable(ep.files[segTable.file], segTable.codeColumn, segTable.statusColumn ?? 'Trạng thái', codes, to, p, new RegExp(`^${p.codes.segment}$`)));
    }
    for (const s of segsOf) {
      if (s.files[st.file]) changes.push(...planTable(s.files[st.file], st.codeColumn, st.statusColumn ?? 'Trạng thái', 'all', to, p, sceneRe));
    }
  }
  const label = level === 'scene' ? `cảnh ${scene}` : level === 'segment' ? `phân đoạn ${seg?.code}` : `tập ${ep.id}`;
  return { level, label, to, changes };
}

/** Ghi các thay đổi: đọc lại file, chỉ thay ô trạng thái của từng dòng. Ô đã bị sửa khác đi từ lúc lập kế hoạch → bỏ qua dòng đó. */
export function applyPlan(plan: ApprovePlan): { files: string[]; skipped: string[] } {
  const byFile = new Map<string, CellChange[]>();
  for (const c of plan.changes) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const skipped: string[] = [];
  for (const [file, list] of byFile) {
    const lines = splitLines(fs.readFileSync(file, 'utf8'));
    for (const c of list) {
      const cells = splitRow(lines[c.line] ?? '');
      if ((cells[c.col] ?? '').trim() !== c.before.trim()) {
        skipped.push(c.code);
        continue;
      }
      cells[c.col] = c.after;
      lines[c.line] = formatRow(cells);
    }
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
  }
  return { files: [...byFile.keys()].map((f) => path.basename(f)), skipped };
}
