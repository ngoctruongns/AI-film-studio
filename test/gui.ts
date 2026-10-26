// Thử GUI không cần VS Code: API VS Code giả (mockVscode) + jsdom chạy JS thật của webview + server LLM giả tương thích OpenAI.
// Chạy trên BẢN SAO văn bản của dự án phim (scratch) — không đụng repo thật.
//   node out/test/gui.js [đường dẫn dự án]  (mặc định ../../.. so với thư mục tool)
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
const Module = require('module');

// 'vscode' → mock
const mockPath = path.join(__dirname, 'mockVscode.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: any[]) {
  return req === 'vscode' ? mockPath : origResolve.call(this, req, ...rest);
};
import * as V from './mockVscode';

const SRC = path.resolve(process.argv[2] ?? path.join(__dirname, '../../../../..'));
const TOOL = path.join(__dirname, '../..');
let failed = 0;
const ok = (cond: any, msg: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => any, msg: string, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (fn()) return ok(true, msg);
    } catch {
      /* chưa có */
    }
    await sleep(20);
  }
  ok(false, msg + ' (hết giờ)');
}

// ------------------------------------------------------------------ bản sao dự án
function copyProject(): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'afs-gui-'));
  const keep = /(\.(md|ya?ml|json|py|txt)|\.gitignore)$/i;
  const skipDir = new Set(['.git', 'node_modules', 'pdf-sach', 'runs', 'anh-tham-khao', '_gis']);
  const toolRel = path.relative(SRC, TOOL);
  fs.cpSync(SRC, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SRC, src);
      if (!rel) return true;
      if (rel === toolRel || rel.startsWith(toolRel + path.sep)) return false;
      const st = fs.statSync(src);
      if (st.isDirectory()) return !skipDir.has(path.basename(src));
      return keep.test(src) && st.size < 2_000_000;
    },
  });
  execFileSync('git', ['init', '-q'], { cwd: dst });
  execFileSync('git', ['add', '-A'], { cwd: dst });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dst });
  return dst;
}

// ------------------------------------------------------------------ LLM giả
let lastRequest: any;
function fakeLlm(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastRequest = JSON.parse(body || '{}');
      const prompt: string = lastRequest.messages?.[1]?.content ?? '';
      let content = 'OK';
      // trả lại nội dung hiện tại + một dòng đánh dấu → kiểm được luồng diff / Nhận
      const cur = /<hien-tai path="[^"]*">\n([\s\S]*?)\n<\/hien-tai>/.exec(prompt);
      if (prompt.includes('KẾT THÚC PHIÊN')) content = '<<<BEGIN>>>\n### Phiên 999 — thử · KIỂM TRA GUI\n- dòng thử\n<<<END>>>';
      else if (cur) content = `<<<BEGIN>>>\n${cur[1]}\n<!-- ${lastRequest.model} đã sửa -->\n<<<END>>>`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1234, completion_tokens: 56 } }));
    });
  });
  return new Promise((r) => server.listen(0, () => r({ port: (server.address() as any).port, close: () => server.close() })));
}

async function main() {
  const root = copyProject();
  const media = path.join(root, '04_PRODUCTION/VIDEO_OUT/EP01/K');
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'EP01_K02_I0.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(media, 'EP01_K02_V1.mp4'), 'x');
  fs.writeFileSync(path.join(media, 'EP01_K02_V2.mp4'), 'x');
  const download = path.join(root, '..', `dl-${path.basename(root)}.mp4`);
  fs.writeFileSync(download, 'video');
  console.log(`Bản sao dự án: ${root}`);

  const llm = await fakeLlm();
  V.setWorkspaceRoot(root);
  V.settingsStore['aiFilmStudio.models'] = [
    { id: 'claude-code', provider: 'claude-code' },
    { id: 'fake', provider: 'openai-compatible', model: 'fake-a', apiBase: `http://127.0.0.1:${llm.port}/v1` },
    { id: 'fake2', provider: 'openai-compatible', model: 'fake-b', apiBase: `http://127.0.0.1:${llm.port}/v1`, price: { input: 1, output: 2 } },
  ];
  V.settingsStore['aiFilmStudio.stepModels'] = { 'chia-canh': 'fake', 'ket-thuc-phien': 'fake' };

  const ext = require('../src/extension');
  const ctx = V.fakeContext(TOOL);
  ext.activate(ctx);

  console.log('\n[1] Cây dự án + ghi chú');
  const tree = V.trees['aiFilmStudio.project'];
  const roots = tree.getChildren();
  ok(roots.length > 3, `gốc cây có ${roots.length} mục`);
  const ep1 = roots.find((n: any) => n.kind === 'episode' && n.ep.id === 'EP01');
  ok(ep1, 'có EP01');
  const segs = tree.getChildren(ep1);
  ok(segs.length >= 10, `EP01 có ${segs.length} phân đoạn`);
  const kNode = segs.find((n: any) => n.seg.code === 'K');
  ok(tree.getChildren(kNode).length >= 10, `K có ${tree.getChildren(kNode).length} cảnh`);
  for (const n of [...roots, ...segs]) tree.getTreeItem(n);
  ok(true, 'getTreeItem chạy hết không lỗi');
  const notes = V.trees['aiFilmStudio.notes'];
  ok(notes.getChildren().length === 2, 'ghi chú có 2 nhóm @C / @T');

  console.log('\n[2] Dashboard');
  await V.commands.executeCommand('aiFilmStudio.openDashboard');
  const dash = V.panels.find((p) => p.viewType === 'aiFilmStudio.dashboard')!;
  ok(dash.doc.body.textContent!.includes('EP01'), 'dashboard có EP01');
  ok(dash.$$('a[data-cmd="step"]').length > 20, `ma trận phân đoạn × bước: ${dash.$$('a[data-cmd="step"]').length} ô`);
  const cell = dash.$$('a[data-cmd="step"]').find((a) => a.dataset.arg!.includes('"chia-canh"') && a.dataset.arg!.includes('"K"'))!;
  cell.click();
  await dash.settle();
  const step = V.panels.find((p) => p.viewType === 'aiFilmStudio.step')!;
  ok(step, 'bấm ô → mở tab bước');

  console.log('\n[3] Tab bước ④ Chia cảnh · EP01·K (model fake)');
  await step.settle();
  await waitFor(() => step.$$('#files tr').length >= 5, `bảng file: ${step.$$('#files tr').length} dòng`);
  ok(step.$('#head')!.textContent!.includes('Cổng chưa mở'), 'cổng đóng (README K chưa ✅)');
  ok(step.$('#est')!.textContent!.includes('token'), `ước tính: ${step.$('#est')!.textContent}`);
  (step.$('#files [data-cmd="show"]') as HTMLElement).click();
  await step.settle();
  await waitFor(() => step.$('#pv .rendered'), 'xem nhanh file đầu vào');
  const run = step.$('#actions [data-cmd="run"]')!;
  ok(run.textContent!.includes('bỏ qua cổng'), 'nút Chạy (bỏ qua cổng)');
  run.click();
  await step.settle(20);
  await waitFor(() => step.$('#runs')!.textContent!.includes('xong'), 'chạy xong → thẻ kết quả');
  ok(lastRequest?.model === 'fake-a', 'LLM giả nhận đúng model fake-a');
  ok(V.executed.includes('vscode.diff'), 'tự mở diff');
  (step.$('#runs [data-cmd="apply"]') as HTMLElement).click();
  await step.settle();
  const kCanh = fs.readdirSync(path.join(root, '04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/phan-doan')).find((d) => d.startsWith('K_'))!;
  const kFile = path.join(root, '04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/phan-doan', kCanh, 'K_canh.md');
  ok(fs.readFileSync(kFile, 'utf8').includes('fake-a đã sửa'), 'Nhận → ghi K_canh.md');

  console.log('\n[4] So sánh 2 model');
  const cmp = step.$('#cmp') as HTMLSelectElement;
  cmp.value = 'fake2';
  cmp.dispatchEvent(new step.dom!.window.Event('change', { bubbles: true }));
  await step.settle();
  await waitFor(() => step.$('[data-cmd="runCompare"]'), 'hiện nút Chạy cả 2');
  (step.$('[data-cmd="runCompare"]') as HTMLElement).click();
  await step.settle(25);
  await waitFor(() => step.$$('#runs .card').filter((c) => c.textContent!.includes('xong')).length >= 2, 'hai thẻ kết quả (fake + fake2)');
  ok(step.$('#runs')!.textContent!.includes('USD (ước tính)'), 'fake2 có giá → hiện chi phí ước tính');

  console.log('\n[5] Cài đặt AI');
  await V.commands.executeCommand('aiFilmStudio.openSettings');
  const set = V.panels.find((p) => p.viewType === 'aiFilmStudio.settings')!;
  await set.settle();
  await waitFor(() => set.$$('#models tr').length === 4, `bảng model: ${set.$$('#models tr').length - 1} model`);
  ok(set.$$('#steps select').length > 10, 'bảng gán model theo bước');
  (set.$('[data-act="new"]') as HTMLElement).click();
  (set.$('#fId') as HTMLInputElement).value = 'local-qwen';
  const prov = set.$('#fProvider') as HTMLSelectElement;
  prov.value = 'openai-compatible';
  (set.$('#fModel') as HTMLInputElement).value = 'qwen2.5:14b';
  (set.$('#fBase') as HTMLInputElement).value = `http://127.0.0.1:${llm.port}/v1`;
  (set.$('[data-act="save"]') as HTMLElement).click();
  await set.settle();
  ok(V.settingsStore['aiFilmStudio.models'].some((m: any) => m.id === 'local-qwen'), 'thêm model local-qwen vào settings');
  await waitFor(() => set.$$('#models tr').length === 5, 'bảng model cập nhật');
  (set.$('[data-act="test"][data-id="local-qwen"]') as HTMLElement).click();
  await set.settle(10);
  await waitFor(() => set.$('#t-local-qwen')?.textContent?.includes('✅'), `thử kết nối: ${set.$('#t-local-qwen')?.textContent}`);
  const sel = set.$$('#steps select').find((s) => s.dataset.step === 'am-thanh' && s.dataset.scope === 'local') as HTMLSelectElement;
  sel.value = 'local-qwen';
  sel.dispatchEvent(new set.dom!.window.Event('change', { bubbles: true }));
  await set.settle();
  ok(V.settingsStore['aiFilmStudio.stepModels']['am-thanh'] === 'local-qwen', 'gán âm thanh → local-qwen (máy này)');
  const psel = set.$$('#steps select').find((s) => s.dataset.step === 'dung' && s.dataset.scope === 'project') as HTMLSelectElement;
  psel.value = 'fake2';
  psel.dispatchEvent(new set.dom!.window.Event('change', { bubbles: true }));
  await set.settle();
  const my = fs.readFileSync(path.join(root, '.studio/models.yaml'), 'utf8');
  ok(/dung: fake2/.test(my) && my.includes('ƯU TIÊN CLAUDE'), 'ghi models.yaml, giữ chú thích');

  console.log('\n[6] Bảng cảnh dạng lưới · K');
  await V.commands.executeCommand('aiFilmStudio.editSceneTable', { ep: 'EP01', seg: 'K' });
  const grid = V.panels.find((p) => p.viewType === 'aiFilmStudio.grid')!;
  await grid.settle();
  await waitFor(() => grid.$$('#grid tr').length > 5, `lưới: ${grid.$$('#grid tr').length - 1} cảnh`);
  const before = fs.readFileSync(kFile, 'utf8');
  const nRows = grid.$$('#grid tr').length - 1;
  const secInput = grid.$$('#grid input').find((i) => i.dataset.r === '2' && i.dataset.c === '1') as HTMLInputElement;
  secInput.value = '7';
  secInput.dispatchEvent(new grid.dom!.window.Event('input', { bubbles: true }));
  (grid.$('[data-a="add"][data-r="0"]') as HTMLElement).click();
  await grid.settle();
  await waitFor(() => grid.$$('#grid tr').length - 1 === nRows + 1, 'thêm cảnh mới (mã do tool cấp)');
  const newCode = (grid.$$('#grid input').find((i) => i.dataset.r === '1' && i.dataset.c === '0') as HTMLInputElement).value;
  (grid.$('[data-a="down"][data-r="3"]') as HTMLElement).click();
  (grid.$('#save') as HTMLElement).click();
  await grid.settle();
  const after = fs.readFileSync(kFile, 'utf8');
  ok(after.includes(newCode) && /K1[2-9]/.test(newCode), `file có cảnh mới ${newCode}`);
  ok(after.split('\n').length === before.split('\n').length + 1, 'chỉ thêm đúng 1 dòng, phần chữ khác giữ nguyên');
  ok(/\|\s*\*\*K03\*\*\s*\|\s*7\s*\|/.test(after), 'sửa giây K03 = 7');

  console.log('\n[7] Bước ⑦ kết quả · K02 (media + ghi kết quả)');
  V.commands.executeCommand('aiFilmStudio.openStep', 'ket-qua', { ep: 'EP01', seg: 'K', scene: 'K02' });
  const kq = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await kq.settle();
  await waitFor(() => kq.$$('#media .card').length === 3, `media K02: ${kq.$$('#media .card').length} file`);
  ok(kq.$('#media img')?.getAttribute('src')?.startsWith('vscode-resource:'), 'ảnh hiện qua asWebviewUri');
  (kq.$('#rAttempts') as HTMLInputElement).value = '3';
  (kq.$('#rChosen') as HTMLInputElement).value = 'EP01_K02_V2.mp4';
  (kq.$('#rNote') as HTMLTextAreaElement).value = 'lần 1 lính đi ngược | sai hướng';
  (kq.$('#saveResult') as HTMLElement).click();
  await kq.settle();
  const kqFile = path.join(path.dirname(kFile), 'K_ket-qua.md');
  ok(fs.existsSync(kqFile) && /\| K02 \| 3 \| EP01_K02_V2.mp4 \|/.test(fs.readFileSync(kqFile, 'utf8')), 'ghi K_ket-qua.md');
  ok(fs.readFileSync(kqFile, 'utf8').includes('ngược \\| sai'), 'dấu | trong ghi chú được thoát');
  V.answers.push({ kind: 'open', value: [V.Uri.file(download)] }, { kind: 'pick', value: (x: any) => x.k.kind === 'V' });
  (kq.$('[data-cmd="import"]') as HTMLElement).click();
  await kq.settle(10);
  ok(fs.existsSync(path.join(media, 'EP01_K02_V3.mp4')) && fs.existsSync(download), 'nhập file → EP01_K02_V3.mp4, file gốc còn nguyên');

  console.log('\n[8] Kết thúc phiên');
  await V.commands.executeCommand('aiFilmStudio.endSession');
  const es = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await es.settle();
  await waitFor(() => es.$('#files')!.textContent!.includes('git diff'), 'đầu vào ảo git diff');
  (es.$('#actions [data-cmd="run"]') as HTMLElement).click();
  await es.settle(20);
  await waitFor(() => es.$('#runs [data-cmd="apply"]'), 'nháp nhật ký xong');
  (es.$('#runs [data-cmd="apply"]') as HTMLElement).click();
  await es.settle();
  const stateMd = fs.readFileSync(path.join(root, '00_PROJECT/STATE.md'), 'utf8');
  const iLog = stateMd.indexOf('## Nhật ký phiên');
  const iNew = stateMd.indexOf('### Phiên 999');
  const iOld = stateMd.indexOf('### Phiên', iLog);
  ok(iNew > iLog && iNew === iOld, 'chèn mục mới ngay đầu "Nhật ký phiên"');

  console.log('\n[9] Lệnh quản lý');
  V.answers.push({ kind: 'info', value: 'Ghi' });
  fs.writeFileSync(path.join(root, '.gitignore'), fs.readFileSync(path.join(root, '.gitignore'), 'utf8').replace(/# >>> ai-film-studio[\s\S]*# <<< ai-film-studio\n?/, ''));
  await V.commands.executeCommand('aiFilmStudio.updateGitignore');
  ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('# >>> ai-film-studio'), 'cập nhật .gitignore (khối tool)');
  V.answers.push({ kind: 'input', value: 'thu-nghiem' });
  await V.commands.executeCommand('aiFilmStudio.newSegment', ep1);
  const created = fs.readdirSync(path.join(root, '04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/phan-doan')).find((d) => d.endsWith('_thu-nghiem'));
  ok(created === 'O_thu-nghiem', `phân đoạn mới cấp mã ${created}`);
  V.answers.push({ kind: 'info', value: 'git add -A' });
  await V.commands.executeCommand('aiFilmStudio.startWork');
  ok(execFileSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' }).trim() === '', 'Bắt đầu việc → git add -A');

  console.log('\n[10] Lỗi JS trong webview');
  for (const p of V.panels) await p.settle();
  ok(V.errors.length === 0, V.errors.length ? V.errors.join('\n    ') : 'không có lỗi');

  llm.close();
  console.log(`\n${failed ? `❌ ${failed} kiểm tra hỏng` : '✅ tất cả đạt'} · bản sao: ${root}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
