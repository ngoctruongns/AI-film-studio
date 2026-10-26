// Quét thư mục dự án → mô hình tập / phân đoạn / cảnh. Chỉ đọc, không ghi gì.
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig, StatusKey, StudioConfig, parseStatus } from './config';
import { columnIndex, findTable, isStruck, parseSeconds, parseTables, stripMd } from './markdown';

export interface Scene {
  code: string;
  segment: string;
  num: number;
  seconds?: number;
  status?: StatusKey;
  statusText: string;
  title: string;
  /** file _canh.md (tuyệt đối) và dòng 0-based */
  file: string;
  line: number;
  /** số file media theo loại: V (video AI), I (ảnh), R (tham chiếu), L (lời), A (âm) */
  media: Record<string, number>;
}

export interface Segment {
  code: string;
  slug: string;
  name: string;
  dir?: string;
  relDir?: string;
  order: number;
  plannedSeconds?: number;
  status?: StatusKey;
  statusText: string;
  dropped: boolean;
  /** khóa file → đường dẫn tuyệt đối (chỉ file đang có) */
  files: Record<string, string>;
  scenes: Scene[];
  lineCodes: string[];
  readmeLine?: number;
}

export interface Episode {
  id: string;
  num: number;
  slug: string;
  dir: string;
  relDir: string;
  files: Record<string, string>;
  segments: Segment[];
  /** chưa chuyển sang cấu trúc phân đoạn */
  legacy: boolean;
  plannedSeconds: number;
  sceneSeconds: number;
  releaseDate?: Date;
}

export interface ProjectModel {
  config: StudioConfig;
  episodes: Episode[];
  mediaRoot?: string;
  mediaFound: boolean;
  scannedAt: Date;
}

export interface Placeholders {
  root?: string;
  episodeDir?: string;
  segmentDir?: string;
  ep?: string;
  T?: string;
  X?: string;
  scene?: string;
}

export function fill(template: string, ph: Placeholders): string {
  return template.replace(/\{(\w+)\}/g, (all, k: keyof Placeholders) => (ph[k] !== undefined ? String(ph[k]) : all));
}

export function placeholdersFor(model: ProjectModel, ep?: Episode, seg?: Segment, scene?: Scene): Placeholders {
  return {
    root: model.config.root,
    episodeDir: ep?.relDir,
    segmentDir: seg?.relDir,
    ep: ep?.id,
    T: ep ? `T${String(ep.num).padStart(2, '0')}` : undefined,
    X: seg?.code,
    scene: scene?.code,
  };
}

function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

function readIf(file: string | undefined): string | undefined {
  try {
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function parseScenes(text: string, file: string, seg: string, p: ProjectConfig): Scene[] {
  const st = p.sceneTable;
  const re = new RegExp(p.codes.scene);
  const scenes: Scene[] = [];
  const seen = new Set<string>();
  for (const t of parseTables(text)) {
    const ci = columnIndex(t, st.codeColumn);
    if (ci < 0) continue;
    const si = columnIndex(t, st.secondsColumn);
    const ki = columnIndex(t, st.statusColumn);
    const ni = columnIndex(t, st.nameColumn);
    for (const r of t.rows) {
      const code = stripMd(r.cells[ci] ?? '');
      const m = re.exec(code);
      if (!m || m[0] !== code || seen.has(code)) continue;
      seen.add(code);
      const statusText = ki >= 0 ? r.cells[ki] ?? '' : '';
      const struck = isStruck(r.cells[ci] ?? '');
      scenes.push({
        code,
        segment: m[1],
        num: Number(m[2]),
        seconds: si >= 0 ? parseSeconds(r.cells[si] ?? '') : undefined,
        status: struck ? 'dropped' : parseStatus(statusText, p.status),
        statusText: stripMd(statusText),
        title: ni >= 0 ? stripMd(r.cells[ni] ?? '').replace(/\s+/g, ' ').slice(0, 140) : '',
        file,
        line: r.line,
        media: {},
      });
    }
  }
  return scenes;
}

function parseLineCodes(text: string | undefined, p: ProjectConfig): string[] {
  if (!text) return [];
  const re = new RegExp(p.codes.line, 'g');
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

/** Đếm file media theo mã: EP01_F02_V3.mp4 → scene F02, loại V */
function scanMedia(root: string, pattern: string): Map<string, Record<string, number>> {
  const re = new RegExp(pattern);
  const out = new Map<string, Record<string, number>>();
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else {
        const m = re.exec(e.name);
        if (!m) continue;
        const key = `EP${m[1]}_${m[2]}`;
        const rec = out.get(key) ?? {};
        rec[m[3]] = (rec[m[3]] ?? 0) + 1;
        out.set(key, rec);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function scanProject(config: StudioConfig, mediaRootOverride?: string): ProjectModel {
  const p = config.project;
  const root = config.root;
  const epRoot = path.join(root, p.paths.episodes);
  const epRe = new RegExp(p.episode.dirPattern);
  const segRe = new RegExp(p.segment.dirPattern);
  const exclude = new Set(p.episode.exclude ?? []);

  const mediaSetting = mediaRootOverride || p.paths.media;
  const mediaRoot = mediaSetting ? path.resolve(root, mediaSetting) : undefined;
  const mediaFound = !!mediaRoot && fs.existsSync(mediaRoot);
  const media = mediaFound && p.codes.media ? scanMedia(mediaRoot!, p.codes.media) : new Map();

  const episodes: Episode[] = [];
  for (const name of listDirs(epRoot)) {
    if (exclude.has(name)) continue;
    const m = epRe.exec(name);
    if (!m) continue;
    const dir = path.join(epRoot, name);
    const num = Number(m[1]);
    const id = `EP${String(num).padStart(2, '0')}`;
    const files: Record<string, string> = {};
    for (const [k, f] of Object.entries(p.episode.files)) {
      const abs = path.join(dir, f);
      if (fs.existsSync(abs)) files[k] = abs;
    }

    // Bảng phân đoạn trong README tập (thứ tự chiếu, tên, giây dự kiến, trạng thái)
    const segInfo = new Map<string, { order: number; name: string; seconds?: number; statusText: string; dropped: boolean; line: number }>();
    const st = p.episode.segmentTable;
    if (st) {
      const text = readIf(path.join(dir, p.episode.files[st.file] ?? st.file));
      const t = text ? findTable(text, [st.codeColumn]) : undefined;
      if (t) {
        const ci = columnIndex(t, st.codeColumn);
        const oi = columnIndex(t, st.orderColumn);
        const ni = columnIndex(t, st.nameColumn);
        const si = columnIndex(t, st.secondsColumn);
        const ki = columnIndex(t, st.statusColumn);
        const codeRe = new RegExp(`^${p.codes.segment}$`);
        t.rows.forEach((r, i) => {
          const raw = r.cells[ci] ?? '';
          const code = stripMd(raw).replace(/~/g, '');
          if (!codeRe.test(code)) return;
          const statusText = ki >= 0 ? r.cells[ki] ?? '' : '';
          segInfo.set(code, {
            order: oi >= 0 && /\d/.test(r.cells[oi] ?? '') ? Number(stripMd(r.cells[oi])) : 100 + i,
            name: ni >= 0 ? stripMd(r.cells[ni] ?? '') : '',
            seconds: si >= 0 ? parseSeconds(r.cells[si] ?? '') : undefined,
            statusText,
            dropped: isStruck(raw) || parseStatus(statusText, p.status) === 'dropped',
            line: r.line,
          });
        });
      }
    }

    const segments: Segment[] = [];
    const segDirRoot = path.join(dir, p.segment.dir);
    const haveSegDir = fs.existsSync(segDirRoot);
    for (const sname of haveSegDir ? listDirs(segDirRoot) : []) {
      const sm = segRe.exec(sname);
      if (!sm) continue;
      const code = sm[1];
      const sdir = path.join(segDirRoot, sname);
      const sfiles: Record<string, string> = {};
      for (const [k, pat] of Object.entries(p.segment.files)) {
        const abs = path.join(sdir, pat.replace(/\{X\}/g, code));
        if (fs.existsSync(abs)) sfiles[k] = abs;
      }
      const sceneFile = sfiles[p.sceneTable.file];
      const sceneText = readIf(sceneFile);
      const info = segInfo.get(code);
      const scenes = sceneText ? parseScenes(sceneText, sceneFile!, code, p) : [];
      for (const sc of scenes) sc.media = media.get(`${id}_${sc.code}`) ?? {};
      segments.push({
        code,
        slug: sm[2],
        name: info?.name || sm[2].replace(/-/g, ' '),
        dir: sdir,
        relDir: rel(root, sdir),
        order: info?.order ?? 1000 + code.charCodeAt(0),
        plannedSeconds: info?.seconds,
        status: info ? parseStatus(info.statusText, p.status) : undefined,
        statusText: info ? stripMd(info.statusText) : '',
        dropped: info?.dropped ?? false,
        files: sfiles,
        scenes,
        lineCodes: parseLineCodes(readIf(sfiles['loi']), p),
        readmeLine: info?.line,
      });
      segInfo.delete(code);
    }
    // Phân đoạn có trong README nhưng chưa có thư mục (gồm cả mã đã bỏ)
    for (const [code, info] of segInfo) {
      segments.push({
        code,
        slug: '',
        name: info.name,
        order: info.order,
        plannedSeconds: info.seconds,
        status: info.dropped ? 'dropped' : parseStatus(info.statusText, p.status),
        statusText: stripMd(info.statusText),
        dropped: info.dropped,
        files: {},
        scenes: [],
        lineCodes: [],
        readmeLine: info.line,
      });
    }
    segments.sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));

    const live = segments.filter((s) => !s.dropped);
    const ep: Episode = {
      id,
      num,
      slug: m[2],
      dir,
      relDir: rel(root, dir),
      files,
      segments,
      legacy: !haveSegDir,
      plannedSeconds: live.reduce((a, s) => a + (s.plannedSeconds ?? 0), 0),
      sceneSeconds: live.reduce((a, s) => a + s.scenes.filter((c) => c.status !== 'dropped').reduce((b, c) => b + (c.seconds ?? 0), 0), 0),
    };
    if (p.release) {
      const d = new Date(p.release.firstDate);
      d.setDate(d.getDate() + (num - p.release.firstEpisode) * p.release.everyDays);
      if (num >= p.release.firstEpisode) ep.releaseDate = d;
    }
    episodes.push(ep);
  }
  episodes.sort((a, b) => a.num - b.num);
  return { config, episodes, mediaRoot, mediaFound, scannedAt: new Date() };
}

export function findEpisode(model: ProjectModel, id: string | undefined): Episode | undefined {
  return model.episodes.find((e) => e.id === id);
}

export function findSegment(ep: Episode | undefined, code: string | undefined): Segment | undefined {
  return ep?.segments.find((s) => s.code === code);
}

export function findScene(seg: Segment | undefined, code: string | undefined): Scene | undefined {
  return seg?.scenes.find((s) => s.code === code);
}
