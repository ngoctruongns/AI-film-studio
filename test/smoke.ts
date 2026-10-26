// Chạy thử phần lõi (không cần VS Code) trên một dự án thật:
//   npm test -- <đường dẫn dự án>     (mặc định ../../.. = repo phim chứa thư mục tool)
import * as path from 'path';
import { loadStudioConfig } from '../src/core/config';
import { scanProject } from '../src/core/scanner';
import { lintProject } from '../src/core/lint';
import { scanNotes } from '../src/core/notes';
import { loadLedger, nextSceneCode, nextSegmentCode, syncLedger } from '../src/core/codes';
import { buildPrompt, resolveStep } from '../src/core/context';
import { applyManagedBlock } from '../src/core/gitignore';
import { formatDuration } from '../src/core/markdown';

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '../../../../..'));
const cfg = loadStudioConfig(root);
const t0 = Date.now();
const model = scanProject(cfg);
console.log(`Dự án: ${cfg.project.name} · quét ${Date.now() - t0} ms · ${model.episodes.length} tập · media: ${model.mediaFound ? model.mediaRoot : 'không thấy'}`);

for (const ep of model.episodes) {
  const segs = ep.segments.filter((s) => !s.dropped);
  const scenes = segs.flatMap((s) => s.scenes);
  console.log(
    `${ep.id} ${ep.legacy ? '(cấu trúc cũ)' : ''} phân đoạn ${segs.length} · cảnh ${scenes.length} · giây cảnh ${formatDuration(ep.sceneSeconds)} · dự kiến ${formatDuration(ep.plannedSeconds)} · phát hành ${ep.releaseDate?.toISOString().slice(0, 10) ?? '—'}`,
  );
  if (ep.id === 'EP01') {
    for (const s of ep.segments) {
      console.log(`   ${s.code}${s.dropped ? ' ❌' : ''} ${s.name.slice(0, 40)} · ${s.scenes.length} cảnh · files: ${Object.keys(s.files).join(',')} · lời ${s.lineCodes.length} · ${s.status ?? '?'}`);
    }
    const k = ep.segments.find((s) => s.code === 'K');
    console.log('   K02 =', JSON.stringify(k?.scenes.find((c) => c.code === 'K02'), null, 0).slice(0, 300));
  }
}

const issues = lintProject(model);
console.log(`\nLint: ${issues.length} vấn đề`);
for (const i of issues.slice(0, 8)) console.log(`  [${i.severity}] ${path.relative(root, i.file)}:${i.line + 1} ${i.message}`);

const notes = scanNotes(root, cfg.project);
console.log(`\nGhi chú: @C ${notes.filter((n) => n.kind === 'todo').length} · @T ${notes.filter((n) => n.kind === 'question').length}`);

const ledger = loadLedger(path.join(root, '.studio/ma-da-cap.json'));
syncLedger(model, ledger);
console.log(`\nMã kế tiếp EP01: phân đoạn ${nextSegmentCode(ledger, 'EP01')} · cảnh F ${nextSceneCode(ledger, 'EP01', 'F')} · cảnh K ${nextSceneCode(ledger, 'EP01', 'K')}`);

for (const [stepId, target] of [
  ['chia-canh', { ep: 'EP01', seg: 'K' }],
  ['prompt', { ep: 'EP01', seg: 'K', scene: 'K02' }],
  ['kich-ban', { ep: 'EP01', seg: 'A' }],
] as const) {
  const step = cfg.pipeline.steps.find((s) => s.id === stepId)!;
  const rs = resolveStep(model, step, target);
  const bp = buildPrompt(model, rs, '', false);
  const bpc = buildPrompt(model, rs, '', true);
  console.log(`\n${rs.title} · cổng ${rs.gate.ok ? 'mở' : 'ĐÓNG: ' + rs.gate.reasons.join('; ')}`);
  for (const f of [...rs.inputs, ...(rs.output ? [rs.output] : [])]) {
    console.log(`   ${f.role === 'output' ? '→' : '·'} ${f.label} ${f.exists ? (f.found ? `✓ ${f.text?.length ?? 0} ký tự @dòng ${f.line + 1}` : '✗ không thấy mục') : '✗ chưa có file'}`);
  }
  console.log(`   token ≈ ${bp.estInputTokens} (model khác) · ≈ ${bpc.estInputTokens} (Claude Code tự đọc CLAUDE.md)`);
}

const gi = applyManagedBlock('a\nb\n', ['x/']);
console.log('\n.gitignore khối:\n' + gi + '---\nchạy lại không đổi: ' + (applyManagedBlock(gi, ['x/']) === gi));
