// Nhật ký các lần chạy AI: .studio/runs/<id>/ {prompt.md, answer.md, proposal.md, run.json} — không vào git.
import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR } from './config';

export interface RunRecord {
  id: string;
  step: string;
  target: string;
  modelId: string;
  provider: string;
  machine?: string;
  startedAt: string;
  finishedAt?: string;
  estInputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costReported?: boolean;
  status: 'running' | 'done' | 'error' | 'applied' | 'discarded' | 'handed-off';
  error?: string;
  outputFile?: string;
}

export function runsDir(root: string): string {
  return path.join(root, STUDIO_DIR, 'runs');
}

export function newRunId(step: string, target: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}_${step}_${target.replace(/[^\w-]+/g, '-')}`;
}

export function runPath(root: string, id: string, file = ''): string {
  return path.join(runsDir(root), id, file);
}

export function writeRun(root: string, rec: RunRecord, files: Record<string, string> = {}): void {
  const dir = runPath(root, rec.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, 'utf8');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec, null, 2), 'utf8');
}

export function readRuns(root: string): RunRecord[] {
  const dir = runsDir(root);
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const id of ids) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, id, 'run.json'), 'utf8')));
    } catch {
      /* bỏ qua thư mục hỏng */
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface CostSummary {
  runs: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, number>;
  byStep: Record<string, number>;
}

export function summarizeCost(runs: RunRecord[], since?: Date): CostSummary {
  const s: CostSummary = { runs: 0, usd: 0, inputTokens: 0, outputTokens: 0, byModel: {}, byStep: {} };
  for (const r of runs) {
    if (since && new Date(r.startedAt) < since) continue;
    if (r.inputTokens === undefined) continue;
    s.runs++;
    const c = r.costUsd ?? 0;
    s.usd += c;
    s.inputTokens += r.inputTokens ?? 0;
    s.outputTokens += r.outputTokens ?? 0;
    s.byModel[r.modelId] = (s.byModel[r.modelId] ?? 0) + c;
    s.byStep[r.step] = (s.byStep[r.step] ?? 0) + c;
  }
  return s;
}
