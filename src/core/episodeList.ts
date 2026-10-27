// Danh sách tập (bước ②): một bảng, mỗi dòng một tập.
// Hai loại số: mã SẢN XUẤT EPnn (cấp một lần, không đổi, bỏ thì không dùng lại — như mã cảnh)
// và số PHÁT HÀNH TAPnn (tool đánh lại theo thứ tự dòng, bỏ qua tập bỏ / chờ — luôn tăng dần khi ra mắt).
// Ô phát hành "↑ …" = gộp vào tập phát hành của dòng trên (một TAP gồm nhiều EP). releaseFixed: số cố định (EP00 → TAP00).
import { columnIndex, findTable, isStruck, stripMd } from './markdown';

export interface EpisodeListConfig {
  /** đường dẫn tương đối gốc dự án */
  file: string;
  codeColumn: string;
  releaseColumn: string;
  nameColumn: string;
  statusColumn: string;
  /** cột chữ dài (ô nhiều dòng trong lưới) */
  summaryColumn?: string;
  /** tiền tố số phát hành, vd. TAP → TAP01 */
  releasePrefix: string;
  /** ký hiệu trạng thái KHÔNG đánh số phát hành (bỏ, chờ) */
  noRelease?: string[];
  /** số phát hành cố định theo mã, vd. { EP00: 'TAP00' } — teaser */
  releaseFixed?: Record<string, string>;
  statusChoices?: { value: string; label: string }[];
  columnWidths?: Record<string, number>;
}

export const EPISODE_CODE_RE = /^EP\d{2,}$/;
/** dấu gộp vào tập phát hành ở dòng trên */
export const MERGE_MARK = '↑';

export interface EpisodeRow {
  code: string;
  release?: string;
  name: string;
  statusText: string;
  /** không vào lịch phát hành (bỏ hoặc chờ) */
  unreleased: boolean;
  dropped: boolean;
  order: number;
  line: number;
}

export function episodeCode(n: number): string {
  return `EP${String(n).padStart(2, '0')}`;
}

function releaseCode(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(2, '0')}`;
}

function skipped(status: string, cfg: EpisodeListConfig): boolean {
  return (cfg.noRelease ?? ['❌', '⏸']).some((s) => status.includes(s));
}

/** Đánh lại số phát hành cho các dòng (sửa tại chỗ). headers = tiêu đề bảng. */
export function numberReleases(headers: string[], rows: { cells: string[] }[], cfg: EpisodeListConfig): void {
  const t = { line: 0, headers, rows: [] };
  const ci = columnIndex(t, cfg.codeColumn);
  const ri = columnIndex(t, cfg.releaseColumn);
  const si = columnIndex(t, cfg.statusColumn);
  if (ri < 0) return;
  let n = 0;
  let last = '';
  for (const r of rows) {
    const code = stripMd(r.cells[ci] ?? '').replace(/~/g, '');
    const off = isStruck(r.cells[ci] ?? '') || skipped(r.cells[si] ?? '', cfg) || !EPISODE_CODE_RE.test(code);
    const merge = (r.cells[ri] ?? '').trim().startsWith(MERGE_MARK);
    if (off) r.cells[ri] = '—';
    else if (cfg.releaseFixed?.[code]) r.cells[ri] = cfg.releaseFixed[code];
    else if (merge && last) r.cells[ri] = `${MERGE_MARK} ${last}`;
    else r.cells[ri] = last = releaseCode(cfg.releasePrefix, ++n);
  }
}

export function readEpisodeList(text: string, cfg: EpisodeListConfig): EpisodeRow[] {
  const t = findTable(text, [cfg.codeColumn, cfg.releaseColumn]);
  if (!t) return [];
  const ci = columnIndex(t, cfg.codeColumn);
  const ri = columnIndex(t, cfg.releaseColumn);
  const ni = columnIndex(t, cfg.nameColumn);
  const si = columnIndex(t, cfg.statusColumn);
  const out: EpisodeRow[] = [];
  t.rows.forEach((r, i) => {
    const raw = r.cells[ci] ?? '';
    const code = stripMd(raw).replace(/~/g, '');
    if (!EPISODE_CODE_RE.test(code)) return;
    const statusText = si >= 0 ? stripMd(r.cells[si] ?? '') : '';
    const release = ri >= 0 ? stripMd(r.cells[ri] ?? '').replace(MERGE_MARK, '').trim() : '';
    out.push({
      code,
      release: /\d/.test(release) ? release : undefined,
      name: ni >= 0 ? stripMd(r.cells[ni] ?? '') : '',
      statusText,
      unreleased: isStruck(raw) || skipped(statusText, cfg),
      dropped: isStruck(raw) || statusText.includes('❌'),
      order: i,
      line: r.line,
    });
  });
  return out;
}

/** Mã kế tiếp sau mã lớn nhất đã dùng (ở sổ mã, thư mục, bảng, hoặc vừa cấp trong lưới). */
export function nextEpisodeCode(used: Iterable<string>): string {
  let max = 0;
  for (const c of used) {
    const m = /^EP(\d+)$/.exec(c.replace(/\*/g, '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return episodeCode(max + 1);
}

/** Tên tập → tên thư mục không dấu nối gạch: "Lời cha già" → "Loi-Cha-Gia" */
export function slugify(name: string): string {
  return stripMd(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('-');
}
