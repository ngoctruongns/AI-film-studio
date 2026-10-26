// Quản lý Blender của một tập: file .blend nào, script nào dựng, hướng dẫn nào, shot (marker) nào chạy từ frame nào tới frame nào → cảnh nào.
// Ba nguồn, ưu tiên từ trên xuống:
//   blender   — quét thật từ Blender (socket addon MCP hoặc Blender dòng lệnh) → .studio/blender/<tập>/<file>.json
//   so        — sổ SO-BLENDER.md của tập (người sửa tay được)
//   huong-dan — bảng 'Cảnh | Frame' trong các file hướng dẫn render
import * as fs from 'fs';
import * as path from 'path';
import { ProjectConfig, STUDIO_DIR } from './config';
import { columnIndex, parseTables, stripMd } from './markdown';
import { Episode, ProjectModel, fill, placeholdersFor } from './scanner';

export interface BlenderConfig {
  /** thư mục đặt .blend của tập */
  dirs: string[];
  /** thư mục .blend dùng chung (thư viện, bối cảnh) — chỉ hiện khi được nhắc trong script / hướng dẫn của tập */
  sharedDirs?: string[];
  scripts: string[];
  guides: string[];
  /** sổ của tập */
  register: string;
  fps: number;
  cameraPrefix: string;
  /** giá trị cột Cách của bảng cảnh cần Blender */
  methods: string[];
  methodColumn?: string;
  /** lệnh render một shot bằng Blender dòng lệnh: {blender} {file} {start} {end} {shot} {scene} */
  renderCommand?: string;
  /** lệnh lưu file đang mở trong Blender (máy khác) về repo: {file} = đường dẫn đích trong repo */
  pullCommand?: string;
}

export const DEFAULT_BLENDER: BlenderConfig = {
  dirs: ['{episodeDir}/blender'],
  sharedDirs: [],
  scripts: ['{episodeDir}/blender_script'],
  guides: ['{episodeDir}/blender', '{episodeDir}/blender_script'],
  register: '{episodeDir}/blender/SO-BLENDER.md',
  fps: 24,
  cameraPrefix: 'CAM_',
  methods: ['V2', 'BL', 'V6'],
  methodColumn: 'Cách',
  renderCommand: '"{blender}" -b "{file}" -s {start} -e {end} -o "//render/{shot}_R1_" -a',
};

export function blenderConfig(p: ProjectConfig): BlenderConfig {
  return { ...DEFAULT_BLENDER, ...((p as any).blender ?? {}) };
}

/** Kết quả quét một file trong Blender (script DUMP_PY in ra) */
export interface BlendIndex {
  file: string;
  blender?: string;
  scene?: string;
  fps?: number;
  frame_start?: number;
  frame_end?: number;
  resolution?: [number, number, number];
  engine?: string;
  output?: string;
  camera?: string | null;
  markers: { name: string; frame: number; camera?: string | null }[];
  cameras?: string[];
  scannedAt?: string;
  via?: string;
}

export interface BlendFile {
  name: string;
  stem: string;
  abs?: string;
  rel?: string;
  /** có trong thư mục (false = chỉ được nhắc tới — dựng tại máy, không lên git) */
  present: boolean;
  shared: boolean;
  size?: number;
  mtime?: number;
  scripts: string[];
  guides: string[];
  buildScripts: string[];
  index?: BlendIndex;
}

export type ShotSource = 'blender' | 'so' | 'huong-dan';

export interface Shot {
  /** tên shot = tên marker (F01, F01_2…) */
  code: string;
  /** mã cảnh (F01) */
  scene: string;
  file: string;
  camera?: string;
  start: number;
  end: number;
  source: ShotSource;
  /** file nguồn + dòng (sổ / hướng dẫn) */
  from?: string;
  line?: number;
  out?: string;
  note?: string;
  /** các nguồn khác cho cùng shot mà frame khác */
  conflicts: { source: ShotSource; start: number; end: number; from?: string }[];
}

export interface BlenderIssue {
  severity: 'warning' | 'info';
  scene?: string;
  shot?: string;
  message: string;
}

export interface BlenderModel {
  ep: string;
  cfg: BlenderConfig;
  files: BlendFile[];
  shots: Shot[];
  issues: BlenderIssue[];
  registerFile: string;
  registerExists: boolean;
  indexDir: string;
}

export const SHOT_RE = /\b([A-Z]\d{2})((?:_\d+|_GOC\d+)?)\b/;

/** Script chạy TRONG Blender: in ra một dòng 'AFS_JSON:{…}' mô tả file đang mở. Không sửa gì trong file. */
export const DUMP_PY = `
import bpy, json
sc = bpy.context.scene
r = sc.render
out = {
  "file": bpy.data.filepath, "blender": bpy.app.version_string, "scene": sc.name,
  "fps": round(r.fps / (r.fps_base or 1), 3), "frame_start": sc.frame_start, "frame_end": sc.frame_end,
  "resolution": [r.resolution_x, r.resolution_y, r.resolution_percentage], "engine": r.engine, "output": r.filepath,
  "camera": sc.camera.name if sc.camera else None,
  "markers": sorted([{"name": m.name, "frame": m.frame, "camera": m.camera.name if m.camera else None} for m in sc.timeline_markers], key=lambda m: m["frame"]),
  "cameras": sorted(o.name for o in bpy.data.objects if o.type == 'CAMERA'),
}
print("AFS_JSON:" + json.dumps(out, ensure_ascii=False))
`;

/** Script chạy TRONG Blender: đưa máy tới một shot để xem (preview range + camera), không đổi frame_start/end của file. */
export function gotoShotPy(start: number, end: number, camera?: string): string {
  return `
import bpy
sc = bpy.context.scene
sc.use_preview_range = True
sc.frame_preview_start = ${start}
sc.frame_preview_end = ${end}
sc.frame_current = ${start}
cam = bpy.data.objects.get(${JSON.stringify(camera ?? '')})
if cam and cam.type == 'CAMERA':
    sc.camera = cam
print("AFS_OK:" + (bpy.data.filepath or "(chưa lưu)"))
`;
}

export function parseDump(stdout: string): BlendIndex | undefined {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('AFS_JSON:'));
  if (!line) return undefined;
  return JSON.parse(line.slice('AFS_JSON:'.length));
}

export function indexDir(model: ProjectModel, ep: string): string {
  return path.join(model.config.root, STUDIO_DIR, 'blender', ep);
}

export function saveIndex(model: ProjectModel, ep: string, idx: BlendIndex): string {
  const dir = indexDir(model, ep);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(idx.file.replace(/\\/g, '/')).replace(/\.blend$/i, '') || 'chua-luu';
  const file = path.join(dir, `${stem}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...idx, scannedAt: idx.scannedAt ?? new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return file;
}

function listFiles(dir: string, re: RegExp, depth = 2): string[] {
  const out: string[] = [];
  const walk = (d: string, k: number) => {
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (k < depth && !['__pycache__', 'render', '_gis', 'node_modules'].includes(e.name)) walk(abs, k + 1);
      } else if (re.test(e.name)) out.push(abs);
    }
  };
  walk(dir, 0);
  return out.sort();
}

function read(f: string): string {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

const GUIDE_WORDS = new Set(['huong', 'dan', 'render', 'video', 'bo', 'cuc', 'tri', 'kb', 'readme', 'notes', 'blender']);

function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function blendMentions(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of text.matchAll(/([\w.-]+)\.blend\b/g)) {
    const n = `${x[1]}.blend`;
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return m;
}

function parseFrames(cell: string): [number, number] | undefined {
  const m = /(\d+)\s*[–—-]\s*(\d+)/.exec(stripMd(cell));
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Bảng có cột Cảnh/Shot/Mã + Frame → shot. Cột File (nếu có) chỉ file; không có thì dùng file chính của tài liệu. */
function shotsFromTables(text: string, defaultFile: string | undefined, source: ShotSource, from: string, camPrefix: string): Shot[] {
  const camRe = new RegExp(`${camPrefix.replace(/[^\w]/g, '\\$&')}([A-Z]\\d{2}(?:_\\d+|_GOC\\d+)?)\\b`);
  const out: Shot[] = [];
  for (const t of parseTables(text)) {
    const fi = columnIndex(t, 'Frame');
    const ci = ['Shot', 'Cảnh', 'Mã'].map((c) => columnIndex(t, c)).find((i) => i >= 0) ?? -1;
    if (fi < 0 || ci < 0) continue;
    const fileI = columnIndex(t, 'File');
    const camI = columnIndex(t, 'Camera');
    const outI = columnIndex(t, 'Ra');
    const noteI = columnIndex(t, 'Ghi chú');
    const sceneI = columnIndex(t, 'Cảnh');
    for (const r of t.rows) {
      const raw = stripMd(r.cells[ci] ?? '');
      // dòng gộp nhiều cảnh (vd. "E01 … · E02 …" — khoảng frame của cả video) không phải một shot
      if (new Set([...raw.matchAll(/\b[A-Z]\d{2}\b/g)].map((x) => x[0])).size > 1) continue;
      const m = SHOT_RE.exec(raw);
      const fr = parseFrames(r.cells[fi] ?? '');
      if (!m || !fr) continue;
      const file = fileI >= 0 ? stripMd(r.cells[fileI] ?? '').replace(/\s.*$/, '') : defaultFile;
      if (!file) continue;
      const sceneCell = sceneI >= 0 && sceneI !== ci ? SHOT_RE.exec(stripMd(r.cells[sceneI] ?? ''))?.[1] : undefined;
      // "E01 · `CAM_E01_2`" → shot E01_2 (tên camera = mã shot, QUY-UOC-MA-SO §2)
      const cam = camRe.exec(r.cells.map(stripMd).join(' '));
      const code = cam && cam[1].startsWith(m[1]) ? cam[1] : m[1] + m[2];
      out.push({
        code,
        scene: sceneCell ?? m[1],
        file: file.endsWith('.blend') ? file : `${file}.blend`,
        camera: (camI >= 0 ? stripMd(r.cells[camI] ?? '') : '') || (cam ? `${camPrefix}${cam[1]}` : undefined),
        start: fr[0],
        end: fr[1],
        source,
        from,
        line: r.line,
        out: outI >= 0 ? (r.cells[outI] ?? '').trim() || undefined : undefined,
        note: noteI >= 0 ? (r.cells[noteI] ?? '').trim() || undefined : undefined,
        conflicts: [],
      });
    }
  }
  return out;
}

function shotsFromIndex(idx: BlendIndex, file: string, cfg: BlenderConfig): Shot[] {
  const ms = [...idx.markers].sort((a, b) => a.frame - b.frame);
  const out: Shot[] = [];
  ms.forEach((mk, i) => {
    const m = SHOT_RE.exec(mk.name);
    if (!m || m[0] !== mk.name.trim()) return;
    const end = i + 1 < ms.length ? ms[i + 1].frame - 1 : idx.frame_end ?? mk.frame;
    const camGuess = `${cfg.cameraPrefix}${mk.name}`;
    out.push({
      code: mk.name.trim(),
      scene: m[1],
      file,
      camera: mk.camera ?? (idx.cameras?.includes(camGuess) ? camGuess : undefined),
      start: mk.frame,
      end,
      source: 'blender',
      from: `Blender ${idx.blender ?? ''} · ${idx.scannedAt?.slice(0, 10) ?? ''}`.trim(),
      conflicts: [],
    });
  });
  return out;
}

export function scanBlender(model: ProjectModel, ep: Episode): BlenderModel {
  const root = model.config.root;
  const cfg = blenderConfig(model.config.project);
  const ph = placeholdersFor(model, ep);
  const abs = (p: string) => path.join(root, fill(p, ph));
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');

  // ---- file .blend của tập + script + hướng dẫn
  const files = new Map<string, BlendFile>();
  const add = (name: string, f: Partial<BlendFile>) => {
    const cur = files.get(name) ?? { name, stem: name.replace(/\.blend$/i, ''), present: false, shared: false, scripts: [], guides: [], buildScripts: [] };
    files.set(name, Object.assign(cur, f));
    return cur;
  };
  for (const d of cfg.dirs) {
    for (const f of listFiles(abs(d), /\.blend$/i, 1)) {
      const st = fs.statSync(f);
      add(path.basename(f), { abs: f, rel: rel(f), present: true, size: st.size, mtime: st.mtimeMs });
    }
  }
  const scripts = cfg.scripts.flatMap((d) => listFiles(abs(d), /\.(py|sh|bat)$/i));
  const guides = cfg.guides.flatMap((d) => listFiles(abs(d), /\.md$/i, 1)).filter((g) => !g.endsWith(path.basename(fill(cfg.register, ph))));
  const shared = new Map<string, string>();
  for (const d of cfg.sharedDirs ?? []) for (const f of listFiles(abs(d), /\.blend$/i, 1)) shared.set(path.basename(f), f);

  const mentionTarget = (name: string) => {
    if (files.has(name)) return files.get(name)!;
    const s = shared.get(name);
    if (s) {
      const st = fs.statSync(s);
      return add(name, { abs: s, rel: rel(s), present: true, shared: true, size: st.size, mtime: st.mtimeMs });
    }
    return undefined;
  };
  for (const s of scripts) {
    const text = read(s);
    for (const [name] of blendMentions(text)) {
      let f = mentionTarget(name);
      // file chỉ được nhắc trong script dựng (.sh/.bat hoặc script ghi file) mà không có → "dựng tại máy"
      if (!f && /save_as_mainfile|\.blend["']|SAVE|LUU/i.test(text)) f = add(name, {});
      if (!f) continue;
      if (/\.(sh|bat)$/i.test(s)) f.buildScripts.push(rel(s));
      else if (!f.scripts.includes(rel(s))) f.scripts.push(rel(s));
    }
  }
  // file chính của một hướng dẫn: tên trùng nhiều nhất (HUONG-DAN_…-THAN-CO-PHAO ↔ than_co_phao_ho), rồi mới tới số lần nhắc
  const guideMain = new Map<string, string | undefined>();
  for (const g of guides) {
    const ment = blendMentions(read(g));
    const gt = new Set(tokens(path.basename(g, '.md')).filter((t) => !GUIDE_WORDS.has(t)));
    let best: string | undefined;
    let bestScore = -1;
    for (const [name, n] of ment) {
      const f = mentionTarget(name);
      if (!f) continue;
      if (!f.guides.includes(rel(g))) f.guides.push(rel(g));
      const st = tokens(f.stem);
      const overlap = st.filter((t) => gt.has(t)).length;
      const score = overlap * 100 - (st.length - overlap) * 10 + n;
      if (score > bestScore) [best, bestScore] = [name, score];
    }
    guideMain.set(g, best);
  }

  // ---- index đã quét bằng Blender
  const idxDir = indexDir(model, ep.id);
  for (const j of listFiles(idxDir, /\.json$/i, 0)) {
    try {
      const idx: BlendIndex = JSON.parse(read(j));
      const name = path.basename(idx.file.replace(/\\/g, '/')) || path.basename(j, '.json') + '.blend';
      const f = mentionTarget(name) ?? add(name, {});
      f.index = idx;
    } catch {
      /* json hỏng — bỏ qua */
    }
  }

  // ---- shot theo ba nguồn
  const registerFile = abs(cfg.register);
  const bySource: Record<ShotSource, Shot[]> = {
    blender: [...files.values()].flatMap((f) => (f.index ? shotsFromIndex(f.index, f.name, cfg) : [])),
    so: fs.existsSync(registerFile) ? shotsFromTables(read(registerFile), undefined, 'so', rel(registerFile), cfg.cameraPrefix) : [],
    'huong-dan': guides.flatMap((g) => shotsFromTables(read(g), guideMain.get(g), 'huong-dan', rel(g), cfg.cameraPrefix)),
  };
  const merged = new Map<string, Shot>();
  const key = (s: Shot) => `${s.file}|${s.code}`;
  for (const src of ['blender', 'so', 'huong-dan'] as ShotSource[]) {
    for (const s of bySource[src]) {
      const k = key(s);
      const cur = merged.get(k);
      if (!cur) {
        merged.set(k, s);
        if (!files.has(s.file)) add(s.file, {});
        continue;
      }
      // cột người ghi (Ra, Ghi chú, Camera) lấy từ sổ khi nguồn cao hơn không có
      cur.out ??= s.out;
      cur.note ??= s.note;
      cur.camera ??= s.camera;
      if (s.start !== cur.start || s.end !== cur.end) cur.conflicts.push({ source: s.source, start: s.start, end: s.end, from: s.from });
    }
  }
  const sceneOrder = ep.segments.flatMap((sg) => sg.scenes.map((c) => c.code));
  const shots = [...merged.values()].sort((a, b) => {
    const ia = sceneOrder.indexOf(a.scene);
    const ib = sceneOrder.indexOf(b.scene);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.file.localeCompare(b.file) || a.start - b.start;
  });

  // ---- soát
  const issues: BlenderIssue[] = [];
  const fps = cfg.fps;
  const scenes = ep.segments.filter((s) => !s.dropped).flatMap((s) => s.scenes.map((c) => ({ c, seg: s })));
  const methodCache = new Map<string, ReturnType<typeof parseTables>>();
  const methodsRe = new RegExp(`\\b(${cfg.methods.map((m) => m.replace(/[^\w]/g, '')).join('|')})\\b`);
  for (const { c } of scenes) {
    if (c.status === 'dropped') continue;
    const mine = shots.filter((s) => s.scene === c.code);
    const method = sceneMethod(methodCache, c.file, c.line, cfg);
    if (!mine.length && method && methodsRe.test(method)) {
      issues.push({ severity: 'info', scene: c.code, message: `${c.code} làm bằng ${method.split(/[ (]/)[0]} nhưng chưa có frame Blender nào` });
    }
    if (mine.length && c.seconds) {
      const sec = mine.reduce((a, s) => a + (s.end - s.start + 1), 0) / fps;
      if (Math.abs(sec - c.seconds) > 0.6) issues.push({ severity: 'info', scene: c.code, message: `${c.code}: Blender ${sec.toFixed(1)} s ≠ bảng cảnh ${c.seconds} s` });
    }
  }
  for (const s of shots) {
    if (s.conflicts.length) {
      issues.push({ severity: 'warning', shot: s.code, scene: s.scene, message: `${s.code} (${s.file}): ${s.source} ${s.start}–${s.end} ≠ ${s.conflicts.map((c) => `${c.source} ${c.start}–${c.end}`).join(', ')}` });
    }
    if (sceneOrder.length && !sceneOrder.includes(s.scene)) issues.push({ severity: 'info', shot: s.code, message: `${s.code} (${s.file}) không có trong bảng cảnh nào của ${ep.id}` });
  }
  const byFile = new Map<string, Shot[]>();
  for (const s of shots) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  for (const [f, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start <= sorted[i - 1].end) {
        issues.push({ severity: 'warning', shot: sorted[i].code, message: `${f}: ${sorted[i - 1].code} (${sorted[i - 1].start}–${sorted[i - 1].end}) chồng ${sorted[i].code} (${sorted[i].start}–${sorted[i].end})` });
      }
    }
  }
  for (const f of files.values()) {
    if (f.index?.fps && Math.abs(f.index.fps - fps) > 0.01) issues.push({ severity: 'warning', message: `${f.name}: fps ${f.index.fps} ≠ ${fps}` });
  }

  return {
    ep: ep.id,
    cfg,
    files: [...files.values()].sort((a, b) => Number(b.present) - Number(a.present) || a.name.localeCompare(b.name)),
    shots,
    issues,
    registerFile,
    registerExists: fs.existsSync(registerFile),
    indexDir: idxDir,
  };
}

/** Ô "Cách" của một dòng cảnh */
function sceneMethod(cache: Map<string, ReturnType<typeof parseTables>>, file: string, line: number, cfg: BlenderConfig): string | undefined {
  let tables = cache.get(file);
  if (!tables) cache.set(file, (tables = parseTables(read(file))));
  for (const t of tables) {
    const mi = columnIndex(t, cfg.methodColumn ?? 'Cách');
    const r = t.rows.find((x) => x.line === line);
    if (r && mi >= 0) return stripMd(r.cells[mi] ?? '');
  }
  return undefined;
}

// ------------------------------------------------------------------ sổ SO-BLENDER.md

const cell = (s: string | number | undefined) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();

export function renderRegister(bm: BlenderModel, epTitle: string, sceneSeconds: (scene: string) => number | undefined): string {
  const fps = bm.cfg.fps;
  const kb = (n?: number) => (n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
  const lines: string[] = [
    `# ${epTitle} — sổ Blender *(AI Film Studio ghi · cột **Ra** và **Ghi chú** sửa tay được, ghi lại không mất)*`,
    '',
    `> Frame theo timeline của từng file, ${fps} fps. Nguồn: **blender** = quét thật từ file · **so** = ghi tay trong sổ này · **huong-dan** = bảng`,
    `> trong file hướng dẫn render. Sửa frame thì sửa trong Blender (marker = mã shot) rồi quét lại; file chưa quét thì sửa thẳng cột Frame ở đây.`,
    '',
    '## File .blend',
    '',
    '| File | Có ở repo | Cỡ | Script dựng | Hướng dẫn | Quét Blender |',
    '|---|---|---|---|---|---|',
  ];
  for (const f of bm.files) {
    lines.push(
      `| ${cell(f.rel ? `\`${f.rel}\`` : f.name)} | ${f.present ? (f.shared ? 'dùng chung' : 'có') : `không — dựng tại máy${f.buildScripts.length ? ` (${f.buildScripts.map((s) => `\`${path.basename(s)}\``).join(', ')})` : ''}`} | ${kb(f.size)} | ${cell(f.scripts.map((s) => `\`${path.basename(s)}\``).join(', '))} | ${cell(f.guides.map((g) => `\`${path.basename(g)}\``).join(', '))} | ${f.index ? cell(`${f.index.scannedAt?.slice(0, 10) ?? ''} · ${f.index.markers.length} marker · ${f.index.frame_start}–${f.index.frame_end}`) : '—'} |`,
    );
  }
  lines.push('', '## Shot ↔ cảnh', '', '| Cảnh | Shot | File | Camera | Frame | Giây | Ra | Nguồn | Ghi chú |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of bm.shots) {
    const sec = (s.end - s.start + 1) / fps;
    const tab = sceneSeconds(s.scene);
    lines.push(
      `| ${s.scene} | ${s.code} | ${cell(s.file)} | ${cell(s.camera)} | ${s.start} – ${s.end} | ${sec.toFixed(1)}${tab !== undefined && Math.abs(tab - sec) > 0.6 ? ` ⚠ bảng ${tab}` : ''} | ${cell(s.out)} | ${s.source}${s.conflicts.length ? ' ⚠' : ''} | ${cell(s.note)} |`,
    );
  }
  if (bm.issues.length) {
    lines.push('', '## Cần xem', '');
    for (const i of bm.issues) lines.push(`- ${i.severity === 'warning' ? '⚠' : 'ℹ'} ${i.message}`);
  }
  return lines.join('\n') + '\n';
}

export function renderCommandFor(bm: BlenderModel, s: Shot, file: BlendFile | undefined, blenderPath: string): string | undefined {
  if (!file?.abs || !bm.cfg.renderCommand) return undefined;
  return bm.cfg.renderCommand
    .replace(/\{blender\}/g, blenderPath || 'blender')
    .replace(/\{file\}/g, file.abs)
    .replace(/\{start\}/g, String(s.start))
    .replace(/\{end\}/g, String(s.end))
    .replace(/\{shot\}/g, s.code)
    .replace(/\{scene\}/g, s.scene);
}
