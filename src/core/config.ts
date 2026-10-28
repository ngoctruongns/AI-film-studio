// Cấu hình dự án phim — đọc từ <projectRoot>/.studio/*.yaml.
// Mọi thứ riêng của một dự án (tên thư mục, mẫu tên file, cột bảng, ký hiệu) nằm ở đây,
// để tool dùng được cho dự án phim khác mà không sửa mã.
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import type { AttemptLogConfig } from './attempts';
import type { EpisodeListConfig } from './episodeList';
import type { IdeaConfig } from './idea';
import type { ResourceGroup } from './resources';
import type { PromptLintConfig } from './promptLint';

export const STUDIO_DIR = '.studio';

export type StatusKey = 'todo' | 'writing' | 'review' | 'done' | 'hold' | 'dropped';
export const STATUS_ORDER: StatusKey[] = ['todo', 'writing', 'review', 'done', 'hold', 'dropped'];

export interface TableSpec {
  /** Khóa file (trong segment.files / episode.files) hoặc đường dẫn tương đối */
  file: string;
  codeColumn: string;
  secondsColumn?: string;
  statusColumn?: string;
  nameColumn?: string;
  orderColumn?: string;
}

export interface ScriptSpec {
  id: string;
  label: string;
  /** Lệnh shell; placeholder: {root} {episodeDir} {segmentDir} {ep} {X} {scene} */
  command: string;
  /** Hiện nút ở tab của các bước này */
  steps?: string[];
}

export interface ProjectConfig {
  name: string;
  version: number;
  episodeCapSeconds?: number;
  paths: {
    episodes: string;
    media?: string;
    /** Thư mục media phụ trong repo, quét thêm theo mã cảnh (vd. '{episodeDir}/seedance_clip') */
    sceneMedia?: string[];
  };
  episode: {
    dirPattern: string;
    exclude?: string[];
    template?: string;
    /** Định dạng tên thư mục khi tạo tập mới: {nn} {slug} */
    dirFormat?: string;
    /** Khóa → đường dẫn tương đối trong thư mục tập */
    files: Record<string, string>;
    segmentTable?: TableSpec;
  };
  segment: {
    dir: string;
    dirPattern: string;
    /** Khóa → mẫu tên file, {X} = mã phân đoạn */
    files: Record<string, string>;
    /** Thư mục mẫu của một phân đoạn (trong template tập), mã mẫu là 'A' */
    template?: string;
  };
  /** suggest: gợi ý cho ô của lưới bảng cảnh — tên cột → danh sách giá trị */
  sceneTable: TableSpec & {
    minSeconds?: number;
    maxSeconds?: number;
    suggest?: Record<string, string[]>;
    /** lựa chọn của ô Trạng thái trong lưới (giá trị ghi vào file · nhãn hiện) — không có thì ô gõ tự do */
    statusChoices?: { value: string; label: string }[];
    /** độ rộng mặc định của cột trong lưới (px), theo tên cột */
    columnWidths?: Record<string, number>;
  };
  codes: {
    segment: string;
    scene: string;
    line: string;
    reference?: string;
    media?: string;
    ledger?: string;
  };
  status: Record<StatusKey, string[]>;
  notes: {
    todo: string;
    question: string;
    include?: string[];
    exclude?: string[];
  };
  release?: {
    firstDate: string;
    everyDays: number;
    firstEpisode: number;
  };
  /** Tài nguyên dự án — tài liệu dùng chung, gom theo nhóm — core/resources.ts */
  resources?: ResourceGroup[];
  /** bước ①: form ý tưởng + phong cách — core/idea.ts */
  idea?: IdeaConfig;
  /** bước ②: file kịch bản tóm tắt cả phim (sửa trong tab) */
  synopsis?: string;
  /** bước ②: danh sách tập — mã sản xuất EPnn + số phát hành TAPnn — core/episodeList.ts */
  episodeList?: EpisodeListConfig;
  /** ⑦ lưới bảng lời <X>_loi.md */
  linesTable?: { codeColumn: string; nameColumn?: string; statusColumn?: string; columnWidths?: Record<string, number>; suggest?: Record<string, string[]> };
  /** ⑨ prompt của cảnh + ảnh dùng chung — core/scenePrompts.ts */
  scenePrompts?: import('./scenePrompts').ScenePromptConfig;
  forbiddenWords?: string[];
  /** soát prompt video — core/promptLint.ts */
  promptLint?: PromptLintConfig;
  /** sổ thử nghiệm — core/attempts.ts */
  attemptLog?: AttemptLogConfig;
  gitignore?: string[];
  scripts?: ScriptSpec[];
  /** File nạp làm "lõi dự án" cho model không tự đọc repo */
  coreContext?: { path: string; select?: string; maxChars?: number }[];
}

export type Scope = 'project' | 'episode' | 'segment' | 'scene';

export interface FileRef {
  /** Đường dẫn tương đối gốc dự án, có placeholder {episodeDir} {segmentDir} {ep} {T} {X} {scene} */
  path: string;
  /** Đầu vào ảo (không phải file): git-diff-stat · git-status · runs-today · blender-scene (shot / file Blender của cảnh) */
  source?: 'git-diff-stat' | 'git-status' | 'runs-today' | 'blender-scene';
  /** 'heading:<chữ>' — mục có tiêu đề chứa chữ · 'row:<mã>' — các dòng bảng chứa mã */
  select?: string;
  label?: string;
  maxChars?: number;
  optional?: boolean;
}

export interface StepGate {
  /** Ô bảng phải đạt trạng thái: file + mã dòng + cột */
  table?: { file: string; row: string; column: string };
  /** Các file phải có */
  exists?: string[];
  require?: StatusKey;
}

export interface StepSpec {
  id: string;
  no: string;
  title: string;
  scope: Scope;
  /** human = Trường làm, tool chỉ mở file · chat = model văn bản · agent = Claude Code có công cụ */
  executor: 'human' | 'chat' | 'agent';
  description?: string;
  inputs?: FileRef[];
  /** replace = cả file · section = thay mục 'heading:…' · insert = chèn ngay dưới tiêu đề mục (sau dòng trích dẫn) */
  output?: FileRef & { mode?: 'replace' | 'section' | 'insert' };
  /** Phần giao diện thêm trong tab: media = lưới ảnh/clip + ghi kết quả · grid = lưới bảng cảnh ngay trong tab ·
   *  idea = form ý tưởng + phong cách · synopsis = sửa kịch bản tóm tắt + danh sách tập ·
   *  outline = sửa dàn ý tập (file đầu vào thứ nhất) · section = sửa mục đầu ra (kịch bản phân đoạn) · lines = lưới bảng lời trong tab ·
   *  prompts = prompt cảnh + ảnh dùng chung, nút chép · render = key frame / clip render + ảnh render của cảnh · segments = bảng phân đoạn của tập: duyệt từng dòng + "Phân cảnh" */
  view?: ('media' | 'grid' | 'lines' | 'idea' | 'synopsis' | 'outline' | 'segments' | 'section' | 'prompts' | 'render')[];
  /** nút chuyển sang bước sau và chạy AI luôn, vd. ③ Dàn ý → "Tạo phân đoạn" → ④ */
  next?: { step: string; label: string };
  /** AI chỉ tạo lại cái CHƯA duyệt: sau khi AI trả bản đề xuất, tool khôi phục nguyên văn phần đã duyệt (core/protect.ts).
   *  scenes / lines / episodes = dòng bảng · segments = mục ## [X] · segment / scene = cả bước khóa khi đối tượng đã duyệt */
  protect?: 'scenes' | 'lines' | 'episodes' | 'segments' | 'segment' | 'scene';
  /** chữ trên nút chạy AI (mặc định "Chạy"), vd. "Chia tập" */
  runLabel?: string;
  gate?: StepGate;
  /** Đường dẫn mẫu prompt, tương đối thư mục .studio/ */
  prompt?: string;
  scripts?: string[];
}

export interface PipelineConfig {
  steps: StepSpec[];
}

export interface ModelsConfig {
  default: string;
  fallback?: string[];
  steps?: Record<string, string>;
}

export interface StudioConfig {
  root: string;
  project: ProjectConfig;
  pipeline: PipelineConfig;
  models: ModelsConfig;
}

function readYaml<T>(file: string): T {
  return YAML.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function hasStudio(root: string): boolean {
  return fs.existsSync(path.join(root, STUDIO_DIR, 'project.yaml'));
}

export function loadStudioConfig(root: string): StudioConfig {
  const dir = path.join(root, STUDIO_DIR);
  const project = readYaml<ProjectConfig>(path.join(dir, 'project.yaml'));
  const pipelineFile = path.join(dir, 'pipeline.yaml');
  const modelsFile = path.join(dir, 'models.yaml');
  const pipeline = fs.existsSync(pipelineFile) ? readYaml<PipelineConfig>(pipelineFile) : { steps: [] };
  const models = fs.existsSync(modelsFile) ? readYaml<ModelsConfig>(modelsFile) : { default: 'claude-code' };
  return { root, project, pipeline, models };
}

/** Ký hiệu → trạng thái. Lấy ký hiệu xuất hiện SỚM NHẤT trong chuỗi. */
export function parseStatus(text: string, status: ProjectConfig['status']): StatusKey | undefined {
  let best: { key: StatusKey; pos: number } | undefined;
  for (const key of STATUS_ORDER) {
    for (const sym of status[key] ?? []) {
      const pos = text.indexOf(sym);
      if (pos >= 0 && (!best || pos < best.pos)) best = { key, pos };
    }
  }
  return best?.key;
}

export function statusSymbol(key: StatusKey | undefined, status: ProjectConfig['status']): string {
  return key ? status[key]?.[0] ?? '' : '';
}

export const STATUS_LABEL: Record<StatusKey, string> = {
  todo: 'chưa làm',
  writing: 'đang viết',
  review: 'chờ duyệt',
  done: 'duyệt',
  hold: 'treo',
  dropped: 'bỏ',
};
