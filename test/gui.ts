// Thử GUI không cần VS Code: API VS Code giả (mockVscode) + jsdom chạy JS thật của webview + server LLM giả tương thích OpenAI.
// Chạy trên BẢN SAO văn bản của dự án phim (scratch) — không đụng repo thật.
//   node out/test/gui.js [đường dẫn dự án]  (mặc định ../../.. so với thư mục tool)
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
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
  const keep = /(\.(md|ya?ml|json|py|txt|sh|bat)|\.gitignore)$/i;
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
  // .blend nặng không chép — tạo file rỗng cùng tên để tool thấy
  for (const d of ['04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/blender', '04_PRODUCTION/BLENDER/thu_vien', '04_PRODUCTION/BLENDER/scenes']) {
    const from = path.join(SRC, d);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(dst, d), { recursive: true });
    for (const f of fs.readdirSync(from)) if (f.endsWith('.blend')) fs.writeFileSync(path.join(dst, d, f), '');
  }
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

// ------------------------------------------------------------------ Blender giả (giao thức addon MCP for Blender)
const blenderCodes: string[] = [];
function fakeBlender(): Promise<{ port: number; close: () => void }> {
  const markers = [['F01', 0], ['F01_2', 60], ['F02', 140], ['F03', 228], ['F04', 372], ['F05', 480], ['F06', 600], ['F07', 720], ['F36', 816], ['F08', 984], ['F09', 1104]];
  const dump = {
    file: 'D:/video/LS600/tran_da_bang.blend', blender: '4.2.3', scene: 'Scene', fps: 24, frame_start: 0, frame_end: 1248,
    resolution: [1280, 720, 100], engine: 'BLENDER_EEVEE_NEXT', output: '//render/', camera: 'CAM_F01',
    markers: markers.map(([name, frame]) => ({ name, frame, camera: `CAM_${name}` })), cameras: markers.map(([n]) => `CAM_${n}`),
  };
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let req: any;
      try {
        req = JSON.parse(buf);
      } catch {
        return;
      }
      const code: string = req.params?.code ?? '';
      blenderCodes.push(code);
      const out = code.includes('AFS_JSON') ? 'AFS_JSON:' + JSON.stringify(dump) + '\n' : 'AFS_OK:4.2.3 | D:/video/LS600/tran_da_bang.blend\n';
      // gửi làm hai mảnh để thử ghép gói
      const msg = JSON.stringify({ status: 'success', result: { result: out } });
      sock.write(msg.slice(0, 40));
      setTimeout(() => sock.write(msg.slice(40)), 10);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as any).port, close: () => server.close() })));
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
  const bl = await fakeBlender();
  V.settingsStore['aiFilmStudio.blenderHost'] = '127.0.0.1';
  V.settingsStore['aiFilmStudio.blenderPort'] = bl.port;
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
  const segs = tree.getChildren(ep1).filter((n: any) => n.kind === 'segment');
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
  await waitFor(() => step.$$('#stepper .st').length === 5, `sơ đồ bước phân đoạn: ${step.$$('#stepper .st').map((b) => b.textContent).join(' → ')}`);
  ok(step.$('#stepper .st.cur')?.dataset.step === 'chia-canh', 'bấm ô dashboard → tab phân đoạn K, chọn sẵn ④');
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

  console.log('\n[11] Blender của tập');
  const epKids = tree.getChildren(ep1);
  ok(epKids[0].kind === 'blender', 'nút 🧊 Blender đầu danh sách của EP01');
  const bItem = tree.getTreeItem(epKids[0]);
  ok(/file · \d+ shot/.test(bItem.description), `cây: ${bItem.description}`);
  await V.commands.executeCommand('aiFilmStudio.openBlender', epKids[0]);
  const bp = V.panels.find((p) => p.viewType === 'aiFilmStudio.blender')!;
  await bp.settle();
  await waitFor(() => bp.$$('#files tr').length >= 6, `bảng file .blend: ${bp.$$('#files tr').length - 1} file`);
  ok(bp.$('#files')!.textContent!.includes('dựng tại máy'), 'ban_do_dai_ngu.blend: dựng tại máy (.sh/.bat)');
  const shotRows = () => bp.$$('#shots tr').filter((r) => r.querySelector('td'));
  ok(shotRows().length >= 38, `shot từ hướng dẫn: ${shotRows().length}`);
  ok(bp.$('#shots')!.textContent!.includes('CAM_E01_2'), 'shot E01_2 lấy mã từ tên camera');
  (bp.$('[data-cmd="scanSocket"]') as HTMLElement).click();
  await bp.settle(15);
  await waitFor(() => bp.$('#status')!.textContent!.includes('✅'), `quét Blender đang mở: ${bp.$('#status')!.textContent}`);
  ok(fs.existsSync(path.join(root, '.studio/blender/EP01/tran_da_bang.json')), 'lưu .studio/blender/EP01/tran_da_bang.json');
  await bp.settle();
  const f02 = shotRows().find((r) => r.children[1]?.textContent === 'F02')!;
  ok(f02?.textContent!.includes('140 – 227') && f02.textContent!.includes('⚠'), `F02 theo Blender 140–227, ⚠ lệch hướng dẫn 132`);
  ok(bp.$('#issues')!.textContent!.includes('F02'), 'mục "Cần xem" báo F02 lệch');
  V.answers.push({ kind: 'info', value: 'Ghi' });
  (bp.$('[data-cmd="writeRegister"]') as HTMLElement).click();
  await bp.settle(10);
  const reg = path.join(root, '04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/blender/SO-BLENDER.md');
  ok(fs.existsSync(reg) && /\| F02 \| F02 \| tran_da_bang.blend \| CAM_F02 \| 140 – 227 \|/.test(fs.readFileSync(reg, 'utf8')), 'ghi sổ SO-BLENDER.md');
  // người ghi chú trong sổ → ghi lại sổ không mất
  fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').replace(/(\| F03 \| F03 \|.*\|)\s+\|\n/, '$1 ghi chú của Trường |\n'));
  V.commands.executeCommand('aiFilmStudio.refresh');
  await bp.settle();
  V.answers.push({ kind: 'info', value: 'Ghi' });
  (bp.$('[data-cmd="writeRegister"]') as HTMLElement).click();
  await bp.settle(10);
  ok(fs.readFileSync(reg, 'utf8').includes('ghi chú của Trường'), 'ghi lại sổ giữ cột Ghi chú');
  // bảng đã vẽ lại sau khi ghi sổ → tìm lại dòng F02
  (shotRows().find((r) => r.children[1]?.textContent === 'F02')!.querySelector('[data-cmd="goto"]') as HTMLElement).click();
  await bp.settle(10);
  ok(blenderCodes.some((c) => c.includes('frame_preview_start = 140') && c.includes('CAM_F02')), 'xem trong Blender → preview range 140 + CAM_F02');
  V.commands.executeCommand('aiFilmStudio.openStep', 'blender', { ep: 'EP01', seg: 'F', scene: 'F02' });
  const bs = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await bs.settle();
  await waitFor(() => bs.$('#head')!.textContent!.includes('CAM_F02'), 'tab ⑥a F02 có thẻ Blender');
  ok(bs.$('#files')!.textContent!.includes('Blender của F02'), 'đầu vào ảo "Blender của F02" cho Claude Code');
  const sp = V.panels.find((p) => p.viewType === 'aiFilmStudio.settings')!;
  (sp.$('[data-cmd="testBlender"]') as HTMLElement).click();
  await sp.settle(10);
  await waitFor(() => sp.$('#t-__blender')?.textContent?.includes('4.2.3'), `Cài đặt → thử Blender: ${sp.$('#t-__blender')?.textContent}`);

  console.log('\n[12] Bấm cây → tab overview · duyệt theo cấp');
  const segI = segs.find((n: any) => n.seg.code === 'I');
  const itemI = tree.getTreeItem(segI);
  ok(itemI.command?.command === 'aiFilmStudio.openTarget', 'bấm phân đoạn trong cây → mở tab (không hỏi chọn bước)');
  await V.commands.executeCommand(itemI.command.command, ...(itemI.command.arguments ?? []));
  const pI = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await pI.settle();
  await waitFor(() => pI.$('#overview h1')?.textContent?.startsWith('I ·'), `overview: ${pI.$('#overview h1')?.textContent}`);
  ok(pI.$('#stepper .st.cur')?.dataset.step === 'kich-ban', 'mở lần đầu → bước 1 (③ Kịch bản)');
  ok(pI.$('#head h2')?.textContent?.includes('Kịch bản'), 'nội dung bước 1 hiện ngay dưới');
  (pI.$('[data-step="loi"]') as HTMLElement).click();
  await pI.settle();
  await waitFor(() => pI.$('#stepper .st.cur')?.dataset.step === 'loi' && pI.$('#head h2')!.textContent!.includes('Lời'), 'bấm ⑤a trên sơ đồ → hiện bước Lời');
  // duyệt phân đoạn K → dòng K ở README + mọi cảnh K
  const kp = V.panels.find((p) => p.viewType === 'aiFilmStudio.step' && p.title.includes('EP01·K') && !p.title.includes('K0'))!;
  ok(kp.$('[data-approve="do"]')?.textContent?.includes('Duyệt phân đoạn K'), 'nút "✅ Duyệt phân đoạn K"');
  V.answers.push({ kind: 'info', value: 'Duyệt' });
  (kp.$('[data-approve="do"]') as HTMLElement).click();
  await kp.settle(10);
  const readme = fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP01_Nuoc-Mat/README.md'), 'utf8');
  const kRow = readme.split('\n').find((l) => /^\|\s*\d+\s*\|\s*\*\*K\*\*/.test(l)) ?? '';
  ok(/\|\s*✅[^|]*\|\s*$/.test(kRow), `README dòng K → ✅`);
  const kText = fs.readFileSync(kFile, 'utf8');
  const kStatuses = kText.split('\n').filter((l) => /^\|\s*\*\*K\d\d\*\*/.test(l)).map((l) => l.trim().split('|').slice(-2)[0].trim());
  ok(kStatuses.length >= 11 && kStatuses.every((x) => x.startsWith('✅') || x.startsWith('❌')), `mọi cảnh K → ✅ (${kStatuses.length} dòng)`);
  await waitFor(() => kp.$('#overview')!.textContent!.includes('đã duyệt'), 'overview: "phân đoạn K đã duyệt" + nút Bỏ duyệt');
  (kp.$('[data-step="chia-canh"]') as HTMLElement).click();
  await kp.settle();
  await waitFor(() => kp.$('#head h2')?.textContent?.includes('Chia cảnh') && !kp.$('#head')!.textContent!.includes('Cổng chưa mở'), 'cổng ④ mở sau khi duyệt');
  // duyệt riêng một cảnh: chỉ dòng đó
  const jFile = path.join(path.dirname(kFile), '..', fs.readdirSync(path.join(path.dirname(kFile), '..')).find((d) => d.startsWith('J_'))!, 'J_canh.md');
  const jBefore = fs.readFileSync(jFile, 'utf8');
  V.commands.executeCommand('aiFilmStudio.openTarget', { kind: 'scene', ep: ep1.ep, seg: ep1.ep.segments.find((x: any) => x.code === 'J'), scene: ep1.ep.segments.find((x: any) => x.code === 'J').scenes.find((c: any) => c.code === 'J02') });
  const jp = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await jp.settle();
  await waitFor(() => jp.$('[data-approve="do"]')?.textContent?.includes('cảnh J02'), 'tab cảnh J02: nút "✅ Duyệt cảnh J02"');
  ok(jp.$$('#stepper .st').length === 4 && jp.$('#stepper .st.cur')?.dataset.step === 'prompt', `sơ đồ bước cảnh: ${jp.$$('#stepper .st').map((b) => b.textContent).join(' → ')}`);
  V.answers.push({ kind: 'info', value: 'Duyệt' });
  (jp.$('[data-approve="do"]') as HTMLElement).click();
  await jp.settle(10);
  const jAfter = fs.readFileSync(jFile, 'utf8');
  const diff = jAfter.split('\n').filter((l, i) => l !== jBefore.split('\n')[i]);
  ok(diff.length === 1 && diff[0].includes('J02') && /✅/.test(diff[0]), 'duyệt cảnh → chỉ đúng 1 dòng J02 đổi');
  await jp.settle();
  await waitFor(() => jp.$('[data-approve="undo"]'), 'cảnh J02 hiện "Bỏ duyệt"');
  V.answers.push({ kind: 'info', value: 'Bỏ duyệt' });
  (jp.$('[data-approve="undo"]') as HTMLElement).click();
  await jp.settle(10);
  ok(/J02[^\n]*👀 chờ duyệt/.test(fs.readFileSync(jFile, 'utf8')), 'bỏ duyệt → 👀 chờ duyệt');

  console.log('\n[10] Lỗi JS trong webview');
  for (const p of V.panels) await p.settle();
  ok(V.errors.length === 0, V.errors.length ? V.errors.join('\n    ') : 'không có lỗi');

  llm.close();
  bl.close();
  console.log(`\n${failed ? `❌ ${failed} kiểm tra hỏng` : '✅ tất cả đạt'} · bản sao: ${root}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
