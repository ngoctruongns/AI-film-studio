// Soát prompt video (Seedance) theo luật rút từ thử nghiệm — cấu hình ở mục `promptLint` của .studio/project.yaml.
// Prompt video = khối ``` có 【Cảnh k】 / 【Đoạn k】 hoặc [Shot k] (prompt tiếng Anh, D-28). Bảng Nạp = dòng **Nạp:** gần nhất phía trên khối, cùng mục (heading).
import { splitLines } from './markdown';

export interface PromptLintConfig {
  /** khuyến khích ≤ maxRefs file nạp — vượt chỉ là cảnh báo (Trường thử 8–9 ảnh vẫn ổn, 28/10/2026) */
  maxRefs?: number;
  /** giới hạn cứng của nền tảng (Seedance 2.0 / mini: 9 ảnh) — vượt là lỗi */
  hardMaxRefs?: number;
  /** regex: tham chiếu nhiều góc không được nạp cho video, vd. '@\\[DC_' */
  multiViewRef?: string;
  /** tên nhân vật — lần đầu nhắc phải khai báo "…, người như @EP01_REF_<TÊN>_GOC, là TÊN" */
  names?: string[];
  /** từ chỉ vận động máy — một 【Cảnh】 chỉ một vận động */
  cameraMoves?: string[];
  /** danh từ đếm được — "bốn quả", "6 cỗ" làm AI sinh nhiều vật cùng lúc */
  countNouns?: string[];
  /** bỏ qua luật theo mã, vd. ['P10'] */
  off?: string[];
}

export interface PromptIssue {
  line: number;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

/** Tên luật — dùng cho thống kê "luật nào hay vi phạm nhất" */
export const PROMPT_RULES: Record<string, string> = {
  P1: 'nạp nhiều file (> khuyến khích / > giới hạn)',
  P2: 'thẻ @ (tên file) chưa có trong bảng Nạp',
  P3: 'file nạp không được nhắc trong prompt',
  P4: 'có mốc giây',
  P5: 'nạp ảnh nhiều góc cho video',
  P6: 'một cảnh nhiều vận động máy',
  P7: 'tên nhân vật chưa khai báo',
  P8: 'tên nhân vật chỉ nhắc một lần',
  P9: 'con số đếm vật',
  P10: 'thiếu câu mở / khối ràng buộc',
};

const NUM = '(?:\\d+|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|mấy chục|hàng chục|two|three|four|five|six|seven|eight|nine|ten)';
/** tiêu đề một cảnh trong khối prompt: 【Cảnh k】 【Đoạn k】 (Việt) · [Shot k] (Anh) */
const SHOT_RE = /^(?:【(?:Cảnh|Đoạn)\s*\d+】|\[Shot\s*\d+\])/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** khớp cả từ (chữ Việt có dấu — \b của JS không dùng được) */
const word = (w: string) => `(?<![\\p{L}\\d])${esc(w)}(?![\\p{L}\\d])`;

interface Refs {
  line: number;
  /** thẻ → nội dung mục nạp. Thẻ = tên file đầy đủ ('EP01_F03_R1_I0', 28/10/2026) hoặc kiểu cũ 'Image1' */
  ids: Map<string, string>;
  /** mục "tùy chọn" — được nhắc trong prompt, không bắt buộc */
  optional: Set<string>;
}

/** clip (không phải ảnh): .mp4 · …_R1 · Video1 */
const isClip = (id: string, part: string) => /\.mp4/.test(part) || /_R\d+$/.test(id) || /^Video\d+$/.test(id);

function parseNap(l: string, i: number): Refs | undefined {
  const k = l.indexOf('Nạp:');
  if (k < 0) return undefined;
  const ids = new Map<string, string>();
  const optional = new Set<string>();
  for (const part of l.slice(k + 4).split(' · ')) {
    const opt = /tùy chọn/.test(part);
    const old = /(?:\*\*)?\s*(?:\(tùy chọn\s+)?\b(Image|Video|Audio)(\d+)\b/.exec(part);
    const file = /`([A-Za-z0-9][A-Za-z0-9_]*)(?:\.(?:png|jpe?g|webp|mp4|mov|wav|mp3))?`/.exec(part);
    const id = old ? old[1] + old[2] : file?.[1];
    if (!id) continue;
    if (opt) optional.add(id);
    else ids.set(id, part);
  }
  return ids.size || optional.size ? { line: i, ids, optional } : undefined;
}

export function lintPromptText(text: string, cfg: PromptLintConfig): PromptIssue[] {
  const out: PromptIssue[] = [];
  const off = new Set(cfg.off ?? []);
  const push = (rule: string, line: number, severity: PromptIssue['severity'], message: string) => {
    if (!off.has(rule)) out.push({ rule, line, severity, message: `[${rule}] ${message}` });
  };
  const maxRefs = cfg.maxRefs ?? 5;
  const multi = cfg.multiViewRef ? new RegExp(cfg.multiViewRef) : undefined;
  const moves = (cfg.cameraMoves ?? []).map((w) => ({ w, re: new RegExp(word(w), 'iu') }));
  const countRe = cfg.countNouns?.length ? new RegExp(`(?<![\\p{L}\\d])${NUM}\\s+(?:${cfg.countNouns.map(esc).join('|')})(?![\\p{L}])`, 'giu') : undefined;
  const secRe = /\d+(?:[,.]\d+)?\s*(?:[–-]\s*\d+(?:[,.]\d+)?\s*)?(?:giây|seconds?\b|s\b)|giây\s+(?:thứ\s+)?\d|\bat\s+\d+(?:\.\d+)?\s*s\b/iu;

  const lines = splitLines(text);
  let refs: Refs | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) refs = undefined;
    if (!l.startsWith('```')) {
      const r = l.includes('Nạp:') ? parseNap(l, i) : undefined;
      if (l.includes('Nạp:')) refs = r; // dòng Nạp của ảnh (không có ImageN) → xóa bảng cũ
      // "Nạp ảnh:" = đầu vào SeeDream (ảnh), được nạp tấm đối chiếu nhiều góc — chỉ soát dòng Nạp của video
      if (r && !/Nạp ảnh/.test(l)) {
        const imgs = [...r.ids].filter(([k, part]) => !isClip(k, part)).length;
        if (cfg.hardMaxRefs && imgs > cfg.hardMaxRefs) push('P1', i, 'error', `Nạp ${imgs} ảnh — vượt giới hạn ${cfg.hardMaxRefs} ảnh của model; dùng Seedance 2.5 hoặc bớt ảnh`);
        else if (r.ids.size > maxRefs) push('P1', i, 'warning', `Nạp ${r.ids.size} file — khuyến khích ≤ ${maxRefs}. Nhiều hơn vẫn được (clip dài cần giữ vị trí, bối cảnh) — nếu AI lẫn vai trò các ảnh thì bớt ảnh phụ trợ, giữ key frame`);
        if (multi) for (const [id, part] of r.ids) if (multi.test(part)) push('P5', i, 'warning', `${id} là ảnh nhiều góc — video chỉ nạp ảnh một góc (DON_…), không thì sinh thêm người / "người sinh đôi"`);
      }
      continue;
    }
    // khối ```
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('```')) j++;
    const body = lines.slice(i + 1, j);
    // khung mẫu có ô giữ chỗ [ … ] (không phải @[TÊN]) → bỏ qua
    const isTemplate = body.some((b) => /(?<!@)\[(?!Shot\s*\d+\])[^\]]{3,}\]/.test(b));
    const isVideo = !isTemplate && body.some((b) => SHOT_RE.test(b.trim()));
    if (isVideo) lintVideoBlock(body, i + 1);
    i = j;
  }
  return out;

  function lintVideoBlock(body: string[], first: number) {
    // P2 / P3 — tham chiếu khớp bảng Nạp
    const used = new Set<string>();
    body.forEach((b, k) => {
      for (const m of b.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)) {
        const id = m[1];
        used.add(id);
        if (!refs) continue;
        if (!refs.ids.has(id) && !refs.optional.has(id)) push('P2', first + k, 'error', `@${id} không có trong bảng Nạp (dòng ${refs.line + 1}) — thẻ @ phải đúng tên file tải lên`);
      }
    });
    if (!refs) push('P2', first - 1, 'warning', 'Prompt video không có dòng **Nạp:** phía trên — không biết tải ảnh theo thứ tự nào');
    else for (const id of refs.ids.keys()) if (!used.has(id)) push('P3', refs.line, 'info', `${id} có trong Nạp nhưng prompt không nhắc @${id} — ghi rõ vai trò của nó`);

    // P10 — câu mở + ràng buộc
    const firstText = body.find((b) => b.trim());
    if (!body.some((b) => /^Thực hiện video|Generate the video/i.test(b.trim()))) push('P10', first, 'info', 'Prompt video nên có câu "Generate the video shot by shot: …" (bản Việt: "Thực hiện video lần lượt theo các cảnh sau.")');
    if (!body.some((b) => /^(?:Ràng buộc|Constraints)/.test(b.trim()))) push('P10', first, 'info', 'Thiếu dòng "Constraints: 1. … 2. …" (Ràng buộc) ở cuối');

    body.forEach((b, k) => {
      const ln = first + k;
      const noSpeech = b.replace(/\{[^}]*\}/g, '');
      // P4 — mốc giây (D-25)
      if (secRe.test(noSpeech)) push('P4', ln, 'warning', 'Có mốc giây — bỏ đi, chỉ để thứ tự 【Cảnh k】 + Duration (nhanh / chậm chỉnh speed khi dựng)');
      // P6 — một cảnh một vận động máy (chỉ xét dòng tiêu đề 【Cảnh】)
      if (SHOT_RE.test(b.trim()) && moves.length) {
        const hit = moves.filter((m) => m.re.test(b)).map((m) => m.w);
        if (hit.length > 1) push('P6', ln, 'info', `Một cảnh có ${hit.length} vận động máy (${hit.join(', ')}) — model chỉ làm một, hình mất ổn định; tách thành hai cảnh`);
      }
      // P9 — con số đếm vật
      if (countRe) for (const m of noSpeech.matchAll(countRe)) push('P9', ln, 'info', `"${m[0]}" — đếm số làm AI sinh nhiều vật cùng lúc; mỗi sự việc một 【Cảnh】 có key frame giữ chỗ`);
    });

    // P7 / P8 — tên nhân vật như biến
    for (const name of cfg.names ?? []) {
      const re = new RegExp(word(name), 'u');
      const hits = body.map((b, k) => ({ k, t: b.replace(/\{[^}]*\}/g, '') })).filter((x) => re.test(x.t));
      if (!hits.length) continue;
      const decl = new RegExp(`(?:là|is|as)\\s+${esc(name)}`, 'u');
      const h0 = hits[0];
      const ctx = (body[h0.k - 1] ?? '') + ' ' + h0.t;
      if (!decl.test(ctx.replace(/\s+/g, ' ')) || !/@[A-Za-z][A-Za-z0-9_]+/.test(ctx)) {
        push('P7', first + h0.k, 'warning', `"${name}" dùng trước khi khai báo — lần đầu viết "<vị trí, dáng, áo>, người như @EP01_REF_<TÊN>_GOC, là ${name}"`);
      } else if (hits.length === 1) {
        push('P8', first + h0.k, 'info', `"${name}" chỉ nhắc một lần — không cần đặt tên, tả là đủ`);
      }
    }
  }
}
