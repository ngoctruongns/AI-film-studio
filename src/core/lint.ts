// Soát nhất quán không cần AI: giây cảnh, trần tập, mã lời, @[TÊN], từ cấm.
import * as fs from 'fs';
import { formatDuration } from './markdown';
import { ProjectModel } from './scanner';

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
    const cap = p.episodeCapSeconds;
    if (cap && ep.sceneSeconds > cap && ep.files['readme']) {
      issues.push({ file: ep.files['readme'], line: 0, severity: 'warning', message: `${ep.id}: tổng giây các cảnh ${formatDuration(ep.sceneSeconds)} vượt trần ${formatDuration(cap)}` });
    }

    // Danh bạ @[TÊN] của tập
    let refs: Set<string> | undefined;
    const refFile = ep.files['references'];
    if (refRe && refFile) {
      refs = new Set<string>();
      for (const l of lines(refFile)) for (const m of l.matchAll(refRe)) refs.add(m[1]);
    }

    for (const seg of ep.segments) {
      if (seg.dropped) continue;
      const sceneCodes = new Set(seg.scenes.map((s) => s.code));
      for (const sc of seg.scenes) {
        if (sc.status === 'dropped') continue;
        if (sc.segment !== seg.code) {
          issues.push({ file: sc.file, line: sc.line, severity: 'error', message: `Cảnh ${sc.code} nằm trong phân đoạn ${seg.code}` });
        }
        if (sc.seconds !== undefined && (sc.seconds < min || sc.seconds > max)) {
          issues.push({ file: sc.file, line: sc.line, severity: 'warning', message: `Cảnh ${sc.code}: ${sc.seconds} s ngoài khoảng ${min}–${max} s` });
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
