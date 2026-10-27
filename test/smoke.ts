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
import { nextEpisodeCode, numberReleases, slugify } from '../src/core/episodeList';
import { readIdea, writeIdea } from '../src/core/idea';
import { isResource, listResources } from '../src/core/resources';

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

// ---------------------------------------------------------------- soát prompt video (P1–P10) — prompt cố tình sai
import { lintPromptText } from '../src/core/promptLint';
import { appendAttempt, attemptStats, parseAttempts } from '../src/core/attempts';
{
  const bad = [
    '## F99 · thử',
    '**Nạp:** Image1 `F99_I0` · Image2 `F99_I1` · Image3 `@[DC_LINH_MINH]` · Image4 `a` · Image5 `b` · Image6 `c`',
    '```',
    'Lính chạy trên bãi.',
    '0–2 giây: như @Image1, Trương Phụ phi ngựa tới.',
    '【Cảnh 1】 như @Image2 · máy lùi rồi nâng lên cao',
    'Bốn quả đạn rơi xuống, Trương Phụ giơ gươm, @Image7 cháy.',
    '```',
    '## F98 · đúng',
    '**Nạp:** Image1 `F98_I0` · Image2 `@[TRUONGPHU_GOC]`',
    '```',
    'Thực hiện video lần lượt theo các cảnh sau. Bố trí: viên tướng Minh giữa khung, người như @Image2, là',
    'Trương Phụ.',
    '【Cảnh 1】 như @Image1 · trung cảnh · đứng yên',
    'Trương Phụ giơ gươm hô: {Hai quả cũng chém! 3 giây!}',
    'Ràng buộc: 1. Không chữ.',
    '```',
  ].join('\n');
  const cfgL = { maxRefs: 5, multiViewRef: '@\\[DC_', names: ['Trương Phụ'], cameraMoves: ['lùi', 'nâng'], countNouns: ['quả'] };
  const got = lintPromptText(bad, cfgL);
  const rules = (from: number, to: number) => [...new Set(got.filter((g) => g.line >= from && g.line <= to).map((g) => g.rule))].sort();
  const want = ['P1', 'P10', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P9'];
  const f99 = rules(0, 8);
  const f98 = rules(9, 99);
  console.log(`\nSoát prompt: F99 (sai) → ${f99.join(',')} ${JSON.stringify(f99) === JSON.stringify(want) ? '✓' : '✗ thiếu ' + want.filter((w) => !f99.includes(w))}`);
  console.log(`Soát prompt: F98 (đúng — tên khai báo xuống dòng, số trong thoại) → ${f98.length ? '✗ ' + got.filter((g) => g.line >= 9).map((g) => g.message).join(' | ') : '✓ không báo'}`);
  if (JSON.stringify(f99) !== JSON.stringify(want) || f98.length) process.exitCode = 1;

  // sổ thử nghiệm
  const crit = ['dáng', 'đạn', 'thứ tự'];
  let log = appendAttempt(undefined, 'F · thử', { scene: 'F02', variant: 'A', model: '2.0 mini', credit: 40, seconds: 4, marks: ['bad', 'ok', 'warn'], usable: 'bad', note: 'đơ' }, crit, new Date('2026-10-28'));
  log = appendAttempt(log, 'F · thử', { scene: 'F02', variant: 'A', model: '2.0 mini', credit: 40, seconds: 4, marks: ['ok', 'ok', 'ok'], usable: 'ok', note: '' }, crit, new Date('2026-10-28'));
  log = appendAttempt(log, 'F · thử', { scene: 'F06', variant: '5 cảnh', model: '2.0', credit: 90, seconds: 5, marks: ['ok', 'bad', 'bad'], usable: 'bad', note: '' }, crit, new Date('2026-10-28'));
  const rows = parseAttempts(log, 'x.md');
  const st = attemptStats(rows, crit);
  const okLog = rows.length === 3 && rows[1].n === 2 && st.avgToUsable === 2 && st.failing.map((s) => s.scene).join() === 'F06' && st.creditPerUsableSecond === 170 / 4;
  console.log(`Sổ thử nghiệm: ${rows.length} lần · tới bản dùng được ${st.avgToUsable} lần · chưa đạt ${st.failing.map((s) => s.scene)} · ${st.creditPerUsableSecond} credit/giây · hay hỏng: ${st.criteria[0].label} ${okLog ? '✓' : '✗'}`);
  if (!okLog) process.exitCode = 1;

  // danh sách tập: mã EP cố định, số phát hành TAP đánh lại theo thứ tự dòng, bỏ qua ❌ / ⏸
  const L = cfg.project.episodeList ?? { file: '', codeColumn: 'Mã', releaseColumn: 'Phát hành', nameColumn: 'Tên tập', statusColumn: 'Trạng thái', releasePrefix: 'TAP' };
  const hdr = ['Mã', 'Phát hành', 'Tên tập', 'Trạng thái'];
  const er = [['**EP01**', '', 'A', '✅'], ['**EP03**', '', 'B', '❌ bỏ'], ['**EP02**', '', 'C', '⬜'], ['**EP04**', '', 'D', '⏸ chờ'], ['**EP05**', '', 'E', '✅']].map((cells) => ({ cells }));
  numberReleases(hdr, er, L);
  const rel = er.map((r) => r.cells[1]).join(',');
  const okRel = rel === 'TAP01,—,TAP02,—,TAP03' && nextEpisodeCode(['EP01', 'EP07', 'EP03']) === 'EP08' && nextEpisodeCode(['EP99']) === 'EP100' && slugify('Liều mình cứu chúa') === 'Lieu-Minh-Cuu-Chua';
  console.log(`Danh sách tập: ${rel} · kế tiếp EP08 / EP100 · ${slugify('Liều mình cứu chúa')} ${okRel ? '✓' : '✗'}`);
  const listed = model.episodeList.length;
  const ep06 = model.episodes.find((e) => e.id === 'EP06');
  console.log(`  dự án: ${listed} dòng · EP06 → ${ep06?.release} ${ep06?.title} · lịch ${ep06?.releaseDate?.toISOString().slice(0, 10)}`);
  if (!okRel) process.exitCode = 1;

  // form ý tưởng: đọc → ghi giữ mục lạ
  const icfg = { file: '', fields: [{ label: 'Ý tưởng chính' }, { label: 'Thể loại', kind: 'choice' as const }] };
  const itext = writeIdea('# X\n\n## Thể loại\n\nCũ\n\n## Mục riêng\n\ngiữ\n', { 'Ý tưởng chính': 'Mới', 'Thể loại': 'Hoạt hình' }, icfg);
  const iv = readIdea(itext, icfg);
  const okIdea = iv['Ý tưởng chính'] === 'Mới' && iv['Thể loại'] === 'Hoạt hình' && iv['Mục riêng'] === 'giữ' && itext.startsWith('# X');
  console.log(`Form ý tưởng: ${okIdea ? '✓' : '✗ ' + JSON.stringify(iv)}`);
  if (!okIdea) process.exitCode = 1;

  // tài nguyên dự án
  const res = listResources(root, cfg.project.resources);
  const nRes = res.reduce((a, g) => a + g.entries.reduce((b, e) => b + e.files.length, 0), 0);
  const missing = res.flatMap((g) => g.entries.flatMap((e) => e.files.filter((f) => !f.exists).map((f) => f.rel)));
  const okRes = isResource('01_RESEARCH/65_ngon-ngu-dien-anh/01_ke-bang-hinh-va-loi-dan.md', cfg.project.resources) && !isResource('04_PRODUCTION/EPISODES/EP01/README.md', cfg.project.resources);
  console.log(`Tài nguyên dự án: ${res.length} nhóm · ${nRes} file${missing.length ? ' · thiếu ' + missing.join(', ') : ''} ${okRes ? '✓' : '✗'}`);
  if (!okRes) process.exitCode = 1;
}
