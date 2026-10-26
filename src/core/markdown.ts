// Đọc file .md mức vừa đủ: bảng GFM (có số dòng), mục theo tiêu đề, chọn đoạn.
// Không dùng parser nặng — file phim viết tay, bảng một dòng một hàng, thế là đủ.

export interface MdTable {
  /** Dòng tiêu đề bảng (0-based) */
  line: number;
  headers: string[];
  rows: MdRow[];
}

export interface MdRow {
  line: number;
  cells: string[];
}

export interface MdHeading {
  line: number;
  level: number;
  text: string;
}

export interface MdSection {
  heading: MdHeading;
  /** [start, end) theo dòng, start = dòng tiêu đề */
  start: number;
  end: number;
  text: string;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Tách ô của một dòng bảng; bỏ qua '|' nằm trong `code` hoặc có '\' đứng trước. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode && s[i - 1] !== '\\') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function fencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = [];
  let open = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) {
      inFence.push(true);
      open = !open;
      continue;
    }
    inFence.push(open);
  }
  return inFence;
}

export function parseTables(text: string): MdTable[] {
  const lines = splitLines(text);
  const fence = fencedLines(lines);
  const tables: MdTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (fence[i] || !lines[i].trim().startsWith('|') || !SEPARATOR.test(lines[i + 1])) continue;
    const table: MdTable = { line: i, headers: splitRow(lines[i]).map(stripMd), rows: [] };
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|') && !fence[j]; j++) {
      table.rows.push({ line: j, cells: splitRow(lines[j]) });
    }
    tables.push(table);
    i = j - 1;
  }
  return tables;
}

/** Bỏ đánh dấu markdown thường gặp trong ô: **đậm**, *nghiêng*, `code`, ~~gạch~~, [link](..) */
export function stripMd(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/~~/g, '')
    .trim();
}

export function isStruck(s: string): boolean {
  return /~~.*~~/.test(s);
}

export function columnIndex(table: MdTable, name: string | undefined): number {
  if (!name) return -1;
  const n = name.toLowerCase();
  let idx = table.headers.findIndex((h) => h.toLowerCase() === n);
  if (idx < 0) idx = table.headers.findIndex((h) => h.toLowerCase().includes(n));
  return idx;
}

/** Bảng đầu tiên có đủ các cột yêu cầu */
export function findTable(text: string, required: string[]): MdTable | undefined {
  return parseTables(text).find((t) => required.every((c) => columnIndex(t, c) >= 0));
}

export function parseHeadings(text: string): MdHeading[] {
  const lines = splitLines(text);
  const fence = fencedLines(lines);
  const out: MdHeading[] = [];
  lines.forEach((l, i) => {
    const m = !fence[i] && /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ line: i, level: m[1].length, text: m[2].trim() });
  });
  return out;
}

/** Mục đầu tiên có tiêu đề chứa `needle` (bỏ qua mục bị gạch ~~ ~~), tới tiêu đề cùng cấp hoặc cao hơn. */
export function findSection(text: string, needle: string): MdSection | undefined {
  const lines = splitLines(text);
  const heads = parseHeadings(text);
  const idx = heads.findIndex((h) => h.text.replace(/~~.*?~~/g, '').includes(needle));
  if (idx < 0) return undefined;
  const h = heads[idx];
  let end = lines.length;
  for (let k = idx + 1; k < heads.length; k++) {
    if (heads[k].level <= h.level) {
      end = heads[k].line;
      break;
    }
  }
  return { heading: h, start: h.line, end, text: lines.slice(h.line, end).join('\n') };
}

export function replaceSection(text: string, section: MdSection, newText: string): string {
  const lines = splitLines(text);
  const body = newText.replace(/\s+$/, '');
  return [...lines.slice(0, section.start), ...splitLines(body), '', ...lines.slice(section.end)].join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function codeRegex(code: string): RegExp {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^0-9]|$)`);
}

/** Dòng bảng thuộc mã: ô đầu chứa mã (K02 khớp K02, K02_L1) hoặc có một ô đúng bằng mã (cột Mã ở giữa bảng). */
export function rowMatches(cells: string[], code: string): boolean {
  return codeRegex(code).test(stripMd(cells[0] ?? '')) || cells.some((c) => stripMd(c) === code);
}

/** Từ mọi bảng: giữ tiêu đề + các dòng thuộc mã. */
export function selectRows(text: string, code: string): string {
  const lines = splitLines(text);
  const parts: string[] = [];
  for (const t of parseTables(text)) {
    const hits = t.rows.filter((r) => rowMatches(r.cells, code));
    if (!hits.length) continue;
    parts.push([lines[t.line], lines[t.line + 1], ...hits.map((r) => lines[r.line])].join('\n'));
  }
  return parts.join('\n\n');
}

/** Áp `select` của FileRef: 'heading:<chữ>' · 'row:<mã>' · không có = cả file */
export function applySelect(text: string, select: string | undefined): { text: string; line: number } | undefined {
  if (!select) return { text, line: 0 };
  const [kind, ...rest] = select.split(':');
  const arg = rest.join(':');
  if (kind === 'heading') {
    const s = findSection(text, arg);
    return s ? { text: s.text, line: s.start } : undefined;
  }
  if (kind === 'row') {
    const t = selectRows(text, arg);
    if (!t) return undefined;
    const line = splitLines(text).findIndex((l) => l.trim().startsWith('|') && rowMatches(splitRow(l), arg));
    return { text: t, line: Math.max(line, 0) };
  }
  return { text, line: 0 };
}

/** Giây trong ô: "22" · "~50" · "8–10" (lấy số đầu) · "1′30″" */
export function parseSeconds(cell: string): number | undefined {
  const s = stripMd(cell);
  const mm = /(\d+)\s*[′']\s*(\d+)?/.exec(s);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2] ?? 0);
  const m = /(\d+(?:[.,]\d+)?)/.exec(s);
  return m ? Number(m[1].replace(',', '.')) : undefined;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}′${String(s).padStart(2, '0')}″`;
}
