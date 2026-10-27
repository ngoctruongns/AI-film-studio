// Sổ thử nghiệm: mỗi LẦN SINH một dòng (bảng "Nhật ký lần sinh" trong bất kỳ file .md nào của phân đoạn — <X>_ket-qua.md,
// file bài thử…) → thống kê: số lần sinh để được clip dùng được, credit / giây dùng được, tiêu chí nào hay hỏng nhất.
import { columnIndex, parseTables, splitLines, stripMd } from './markdown';

export interface AttemptLogConfig {
  /** tên các tiêu chí chấm ①②③… — cột ① ứng với phần tử đầu */
  criteria?: string[];
}

export const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
export const ATTEMPT_HEADERS = (n: number) => ['Ngày', 'Cảnh', 'Bản', 'Model', 'Lần', 'Credit', 'Giây', ...CIRCLED.slice(0, n), 'Dùng được', 'Nhận xét'];

export type Mark = 'ok' | 'warn' | 'bad' | undefined;

export interface Attempt {
  file: string;
  line: number;
  date: string;
  scene: string;
  variant: string;
  model: string;
  n?: number;
  credit?: number;
  seconds?: number;
  marks: Mark[];
  usable: Mark;
  note: string;
}

export function parseMark(s: string): Mark {
  const t = stripMd(s).toLowerCase();
  if (!t) return undefined;
  if (/✅|^có|^đạt|^ok|^x$|^y/.test(t)) return 'ok';
  if (/⚠|^tạm|^~/.test(t)) return 'warn';
  if (/❌|^không|^hỏng|^no|^n$/.test(t)) return 'bad';
  return undefined;
}

const num = (s: string | undefined) => {
  const v = Number(stripMd(s ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return stripMd(s ?? '') && Number.isFinite(v) ? v : undefined;
};

/** Mọi dòng có Cảnh trong các bảng có cột Cảnh · Lần · Dùng được */
export function parseAttempts(text: string, file: string): Attempt[] {
  const out: Attempt[] = [];
  for (const t of parseTables(text)) {
    const c = (n: string) => columnIndex(t, n);
    if (c('Cảnh') < 0 || c('Lần') < 0 || c('Dùng được') < 0) continue;
    const markCols = CIRCLED.map((k) => t.headers.findIndex((h) => h.trim() === k)).filter((x) => x >= 0);
    for (const r of t.rows) {
      const scene = stripMd(r.cells[c('Cảnh')] ?? '');
      if (!/^[A-Z]\d{2}$/.test(scene)) continue;
      const cell = (n: string) => (c(n) >= 0 ? r.cells[c(n)] ?? '' : '');
      out.push({
        file,
        line: r.line,
        date: stripMd(cell('Ngày')),
        scene,
        variant: stripMd(cell('Bản')),
        model: stripMd(cell('Model')),
        n: num(cell('Lần')),
        credit: num(cell('Credit')),
        seconds: num(cell('Giây')),
        marks: markCols.map((k) => parseMark(r.cells[k] ?? '')),
        usable: parseMark(cell('Dùng được')),
        note: (cell('Nhận xét') || cell('ghi chú')).trim(),
      });
    }
  }
  // dòng chưa điền gì (chỉ có mã cảnh + model) không tính là một lần sinh
  return out.filter((a) => a.usable || a.marks.some(Boolean) || a.credit !== undefined || a.note);
}

export interface SceneStat {
  scene: string;
  attempts: number;
  usable: number;
  /** lần sinh thứ mấy thì ra bản dùng được đầu tiên */
  firstUsable?: number;
  credit: number;
}

export interface GroupStat {
  key: string;
  attempts: number;
  usable: number;
  credit: number;
  usableSeconds: number;
}

export interface AttemptStats {
  total: number;
  usable: number;
  scenes: SceneStat[];
  /** trung bình số lần sinh tới bản dùng được đầu tiên (chỉ cảnh đã có bản dùng được) */
  avgToUsable?: number;
  /** cảnh chưa có bản dùng được */
  failing: SceneStat[];
  byModel: GroupStat[];
  credit: number;
  /** credit / giây clip dùng được */
  creditPerUsableSecond?: number;
  /** tiêu chí → số lần ❌ / ⚠️ */
  criteria: { label: string; bad: number; warn: number }[];
}

export function attemptStats(rows: Attempt[], criteria: string[] = []): AttemptStats {
  const byScene = new Map<string, Attempt[]>();
  for (const a of rows) byScene.set(a.scene, [...(byScene.get(a.scene) ?? []), a]);
  const scenes: SceneStat[] = [...byScene.entries()].map(([scene, as]) => {
    const i = as.findIndex((a) => a.usable === 'ok');
    return {
      scene,
      attempts: as.length,
      usable: as.filter((a) => a.usable === 'ok').length,
      firstUsable: i >= 0 ? i + 1 : undefined,
      credit: as.reduce((s, a) => s + (a.credit ?? 0), 0),
    };
  });
  const done = scenes.filter((s) => s.firstUsable);
  const group = (key: (a: Attempt) => string): GroupStat[] => {
    const m = new Map<string, GroupStat>();
    for (const a of rows) {
      const k = key(a) || '(chưa ghi)';
      const g = m.get(k) ?? { key: k, attempts: 0, usable: 0, credit: 0, usableSeconds: 0 };
      g.attempts++;
      g.credit += a.credit ?? 0;
      if (a.usable === 'ok') {
        g.usable++;
        g.usableSeconds += a.seconds ?? 0;
      }
      m.set(k, g);
    }
    return [...m.values()].sort((x, y) => y.attempts - x.attempts);
  };
  const credit = rows.reduce((s, a) => s + (a.credit ?? 0), 0);
  const usableSeconds = rows.filter((a) => a.usable === 'ok').reduce((s, a) => s + (a.seconds ?? 0), 0);
  const nCrit = Math.max(criteria.length, ...rows.map((a) => a.marks.length), 0);
  return {
    total: rows.length,
    usable: rows.filter((a) => a.usable === 'ok').length,
    scenes,
    avgToUsable: done.length ? done.reduce((s, x) => s + x.firstUsable!, 0) / done.length : undefined,
    failing: scenes.filter((s) => !s.firstUsable),
    byModel: group((a) => a.model),
    credit,
    creditPerUsableSecond: usableSeconds && credit ? credit / usableSeconds : undefined,
    criteria: Array.from({ length: nCrit }, (_, k) => ({
      label: `${CIRCLED[k]} ${criteria[k] ?? ''}`.trim(),
      bad: rows.filter((a) => a.marks[k] === 'bad').length,
      warn: rows.filter((a) => a.marks[k] === 'warn').length,
    })).sort((x, y) => y.bad + y.warn / 2 - (x.bad + x.warn / 2)),
  };
}

const cellText = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

export interface NewAttempt {
  scene: string;
  variant: string;
  model: string;
  credit?: number;
  seconds?: number;
  marks: Mark[];
  usable: Mark;
  note: string;
}

const MARK_SYM: Record<string, string> = { ok: '✅', warn: '⚠️', bad: '❌' };

/** Thêm một dòng vào bảng "Nhật ký lần sinh" (tạo bảng nếu chưa có). Số "Lần" = số dòng của cảnh đó + 1. */
export function appendAttempt(text: string | undefined, segName: string, a: NewAttempt, criteria: string[], date = new Date()): string {
  const nCrit = Math.max(criteria.length, a.marks.length);
  const heads = ATTEMPT_HEADERS(nCrit);
  const prev = text ? parseAttempts(text, '').filter((x) => x.scene === a.scene).length : 0;
  const row = `| ${[
    date.toISOString().slice(0, 10),
    a.scene,
    a.variant,
    a.model,
    String(prev + 1),
    a.credit ?? '',
    a.seconds ?? '',
    ...Array.from({ length: nCrit }, (_, k) => (a.marks[k] ? MARK_SYM[a.marks[k]!] : '')),
    a.usable ? MARK_SYM[a.usable] : '',
    a.note,
  ]
    .map((x) => cellText(String(x)))
    .join(' | ')} |`;
  const legend = criteria.length ? `> Tiêu chí: ${criteria.map((c, k) => `${CIRCLED[k]} ${c}`).join(' · ')} — chấm ✅ đạt · ⚠️ tạm · ❌ hỏng.\n\n` : '';
  const table = `## Nhật ký lần sinh\n\n${legend}| ${heads.join(' | ')} |\n|${heads.map(() => '---').join('|')}|\n${row}\n`;
  if (!text?.trim()) {
    return `# ${segName} — kết quả tạo hình *(AI Film Studio ghi — sửa tay được)*\n\n${table}`;
  }
  const t = parseTables(text).find((x) => columnIndex(x, 'Cảnh') >= 0 && columnIndex(x, 'Lần') >= 0 && columnIndex(x, 'Dùng được') >= 0);
  if (!t) return text.replace(/\s*$/, '\n\n') + table;
  const lines = splitLines(text);
  lines.splice(t.rows.length ? t.rows[t.rows.length - 1].line + 1 : t.line + 2, 0, row);
  return lines.join('\n');
}
