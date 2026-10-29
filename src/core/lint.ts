// Soát nhất quán không cần AI: giây cảnh, trần tập, mã lời, @[TÊN], từ cấm.
import * as fs from 'fs';
import { columnIndex, formatDuration, parseTables } from './markdown';
import { scanBlender } from './blender';
import { ProjectModel, listMd } from './scanner';
import { lintPromptText } from './promptLint';
import { episodeDuration } from './idea';

export interface Issue {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

export function lintProject(model: ProjectModel): Issue[] {
  const p = model.config.project;
  const issues: Issue[] = [];
  const min = p.sceneTable.minSeconds ?? 0;
  const max = p.sceneTable.maxSeconds ?? Infinity;
  const refRe = p.codes.reference ? new RegExp(p.codes.reference, 'g') : undefined;
  const forbidden = (p.forbiddenWords ?? []).map((w) => w.toLowerCase());

  for (const ep of model.episodes) {
    if (ep.legacy) continue;
    // khung thời lượng tập: ô "Thời lượng mỗi tập" của form ① (dự phòng: episodeCapSeconds)
    const dur = episodeDuration(model.config.root, p.idea, p.episodeCapSeconds);
    if (dur.max && ep.sceneSeconds > dur.max && ep.files['readme']) {
      issues.push({ file: ep.files['readme'], line: 0, severity: 'warning', message: `${ep.id}: tổng giây các cảnh ${formatDuration(ep.sceneSeconds)} vượt trần ${formatDuration(dur.max)}${dur.text ? ` (khung ${dur.text})` : ''}` });
    }
    // thiếu: chỉ báo khi mọi phân đoạn đã chia cảnh (đang làm dở thì tổng còn thấp là thường)
    const live = ep.segments.filter((s) => !s.dropped);
    if (dur.min && live.length && live.every((s) => s.scenes.length) && ep.sceneSeconds < dur.min && ep.files['readme']) {
      issues.push({ file: ep.files['readme'], line: 0, severity: 'warning', message: `${ep.id}: tổng giây các cảnh ${formatDuration(ep.sceneSeconds)} dưới khung ${dur.text} (tối thiểu ${formatDuration(dur.min)})` });
    }

    // Danh bạ @[TÊN] của tập
    let refs: Set<string> | undefined;
    const refFile = ep.files['references'];
    if (refRe && refFile) {
      refs = new Set<string>();
      for (const l of lines(refFile)) for (const m of l.matchAll(refRe)) refs.add(m[1]);
    }

    // Blender: cảnh cần Blender chưa có frame, frame lệch nguồn, chồng frame → đặt ở dòng cảnh
    const scenesByCode = new Map(ep.segments.flatMap((s) => s.scenes.map((c) => [c.code, c] as const)));
    for (const bi of scanBlender(model, ep).issues) {
      const sc = bi.scene ? scenesByCode.get(bi.scene) : undefined;
      if (sc) issues.push({ file: sc.file, line: sc.line, severity: bi.severity, message: `Blender: ${bi.message}` });
    }

    for (const seg of ep.segments) {
      if (seg.dropped) continue;
      const sceneCodes = new Set(seg.scenes.map((s) => s.code));
      // bảng lưới chỉ sửa được BẢNG ĐẦU của _canh.md → nhiều bảng cảnh là ẩn mất cảnh
      const canh = seg.files[p.sceneTable.file];
      if (canh) {
        const tabs = parseTables(fs.readFileSync(canh, 'utf8')).filter((t) => columnIndex(t, p.sceneTable.codeColumn) >= 0 && columnIndex(t, p.sceneTable.secondsColumn) >= 0);
        if (tabs.length > 1) issues.push({ file: canh, line: tabs[1].line, severity: 'warning', message: `Có ${tabs.length} bảng cảnh — bảng lưới chỉ sửa bảng đầu; gộp thành một bảng theo thứ tự chiếu` });
      }
      for (const sc of seg.scenes) {
        if (sc.status === 'dropped') continue;
        if (sc.segment !== seg.code) {
          issues.push({ file: sc.file, line: sc.line, severity: 'error', message: `Cảnh ${sc.code} nằm trong phân đoạn ${seg.code}` });
        }
        if (sc.seconds !== undefined && (sc.seconds < min || sc.seconds > max)) {
          issues.push({ file: sc.file, line: sc.line, severity: 'warning', message: `Cảnh ${sc.code}: ${sc.seconds} s ngoài khoảng ${min}–${max} s` });
        }
      }

      // prompt video (Seedance) — mọi file .md của phân đoạn có khối 【Cảnh k】
      if (p.promptLint && seg.dir) {
        for (const f of listMd(seg.dir)) {
          const text = fs.readFileSync(f, 'utf8');
          if (!/【(?:Cảnh|Đoạn)/.test(text)) continue;
          for (const pi of lintPromptText(text, p.promptLint)) issues.push({ file: f, line: pi.line, severity: pi.severity, message: pi.message });
        }
      }

      const lineRe = new RegExp(p.codes.line, 'g');
      for (const [key, file] of Object.entries(seg.files)) {
        lines(file).forEach((l, i) => {
          if (key === 'loi') {
            for (const m of l.matchAll(lineRe)) {
              const scene = /^([A-Z]\d{2})_/.exec(m[0])?.[1];
              if (scene && !scene.endsWith('00') && sceneCodes.size && !sceneCodes.has(scene) && scene.startsWith(seg.code)) {
                issues.push({ file, line: i, severity: 'warning', message: `${m[0]}: cảnh ${scene} không có trong bảng cảnh` });
              }
            }
          }
          if (refRe && refs) {
            for (const m of l.matchAll(refRe)) {
              if (!refs.has(m[1])) issues.push({ file, line: i, severity: 'warning', message: `@[${m[1]}] chưa có trong danh bạ tham chiếu của ${ep.id}` });
            }
          }
          if (key === 'prompt' && forbidden.length) {
            const low = l.toLowerCase();
            for (const w of forbidden) {
              if (low.includes(w)) issues.push({ file, line: i, severity: 'info', message: `Có từ cấm "${w}" — kiểm tra đây là câu phủ định` });
            }
          }
        });
      }
    }
  }
  return issues;
}
