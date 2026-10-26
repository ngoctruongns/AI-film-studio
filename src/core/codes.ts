// Cấp mã phân đoạn / cảnh. Luật: mã đã cấp không đổi, bỏ thì KHÔNG dùng lại, chèn thì lấy mã kế tiếp chưa dùng.
// Mã đã bỏ có thể không còn trong file nào → giữ sổ .studio/ma-da-cap.json.
import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR } from './config';
import { ProjectModel } from './scanner';

export interface Ledger {
  /** EP01 → { segments: ['A','B',…], scenes: { F: [1,2,…] } } */
  episodes: Record<string, { segments: string[]; scenes: Record<string, number[]> }>;
}

export function ledgerPath(model: ProjectModel): string {
  return path.join(model.config.root, model.config.project.codes.ledger ?? `${STUDIO_DIR}/ma-da-cap.json`);
}

export function loadLedger(file: string): Ledger {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
  } catch {
    return { episodes: {} };
  }
}

function addUnique<T>(arr: T[], v: T): boolean {
  if (arr.includes(v)) return false;
  arr.push(v);
  return true;
}

function entry(ledger: Ledger, ep: string) {
  return (ledger.episodes[ep] ??= { segments: [], scenes: {} });
}

/** Ghi mọi mã đang thấy trong dự án vào sổ. Trả về true nếu sổ thay đổi. */
export function syncLedger(model: ProjectModel, ledger: Ledger): boolean {
  let changed = false;
  for (const ep of model.episodes) {
    if (ep.legacy && !ep.segments.length) continue;
    const e = entry(ledger, ep.id);
    for (const seg of ep.segments) {
      changed = addUnique(e.segments, seg.code) || changed;
      const nums = (e.scenes[seg.code] ??= []);
      for (const sc of seg.scenes) changed = addUnique(nums, sc.num) || changed;
      for (const l of seg.lineCodes) {
        const m = /^([A-Z])(\d{2})_/.exec(l);
        if (m && m[1] === seg.code && Number(m[2]) > 0) changed = addUnique(nums, Number(m[2])) || changed;
      }
      nums.sort((a, b) => a - b);
    }
    e.segments.sort();
  }
  return changed;
}

export function saveLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/** Chữ kế tiếp sau chữ lớn nhất đã dùng (đang tới E → F). */
export function nextSegmentCode(ledger: Ledger, ep: string): string | undefined {
  const used = entry(ledger, ep).segments;
  const max = used.reduce((m, c) => Math.max(m, c.charCodeAt(0)), 'A'.charCodeAt(0) - 1);
  return max >= 'Z'.charCodeAt(0) ? undefined : String.fromCharCode(max + 1);
}

/** Số kế tiếp sau số lớn nhất đã dùng (A03 – A35 – A04). */
export function nextSceneCode(ledger: Ledger, ep: string, seg: string): string | undefined {
  const used = entry(ledger, ep).scenes[seg] ?? [];
  const n = used.reduce((m, x) => Math.max(m, x), 0) + 1;
  return n > 99 ? undefined : `${seg}${String(n).padStart(2, '0')}`;
}

export function reserveSegment(ledger: Ledger, ep: string, code: string): void {
  addUnique(entry(ledger, ep).segments, code);
}

export function reserveScene(ledger: Ledger, ep: string, code: string): void {
  const m = /^([A-Z])(\d{2})$/.exec(code);
  if (!m) return;
  const e = entry(ledger, ep);
  addUnique(e.segments, m[1]);
  addUnique((e.scenes[m[1]] ??= []), Number(m[2]));
}
