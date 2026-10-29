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
  for (const d of ['04_PRODUCTION/EPISODES/EP01/blender', '04_PRODUCTION/BLENDER/thu_vien', '04_PRODUCTION/BLENDER/scenes']) {
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
      if (prompt.startsWith('# ④ KỊCH BẢN CHI TIẾT + PHÂN ĐOẠN') || prompt.includes('\n# ④ KỊCH BẢN CHI TIẾT + PHÂN ĐOẠN'))
        content = '<<<BEGIN>>>\n# KỊCH BẢN CHI TIẾT — thử\n\n## Phân đoạn\n\n| Thứ tự | Mã | Phân đoạn | ~Giây | Trạng thái |\n|---|---|---|---|---|\n| 1 | **A** | Mở đầu thử | 40 | ⬜ chưa duyệt |\n| 2 | **B** | Hội thề thử | 60 | ⬜ chưa duyệt |\n\n## [A] MỞ ĐẦU THỬ\nnội dung\n\n## [B] HỘI THỀ THỬ\nnội dung\n<<<END>>>';
      else if (prompt.includes('# ② KỊCH BẢN TÓM TẮT → CHIA TẬP') && cur) {
        // AI "sửa" cả tập ✅ (tool phải khôi phục) và thêm một tập MỚI cuối bảng
        const lines = cur[1].replace('LỜI CHA GIÀ NƠI BIÊN ẢI', 'AI ĐỔI TÊN TẬP ĐÃ DUYỆT').split('\n');
        const last = lines.map((l, i) => (l.startsWith('|') ? i : -1)).filter((i) => i >= 0).pop()!;
        lines.splice(last + 1, 0, '| MỚI |  | TẬP MỚI THỬ |  | tóm tắt một dòng thử | ⬜ |');
        content = `<<<BEGIN>>>\n${lines.join('\n')}\n<<<END>>>`;
      }
      else if (prompt.includes('# ⑥ PHÂN CẢNH') && cur) {
        // thêm một cảnh MỚI cuối bảng cảnh đầu tiên — tool phải cấp mã
        const L = cur[1].split('\n');
        const h = L.findIndex((l) => /^\|\s*Mã\s*\|/.test(l));
        let e = h + 2;
        while (e < L.length && L[e].startsWith('|')) e++;
        const w = L[h].split('|').length - 2;
        L.splice(e, 0, '| MỚI | 6 | cảnh thử mới' + ' | '.repeat(w - 3) + ' | ⬜ |');
        content = `<<<BEGIN>>>\n${L.join('\n')}\n<!-- ${lastRequest.model} đã sửa -->\n<<<END>>>`;
      }
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
  // test cần EP03, EP04 ở trạng thái dàn ý chưa duyệt (dữ liệu thật có thể đã duyệt)
  for (const ep of ['EP03', 'EP04']) {
    const f = path.join(root, '04_PRODUCTION/EPISODES', ep, 'dan-y.md');
    if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^<!--\s*(?:@tool\s+)?dan-y:[^>]*-->\s*\n?/m, ''));
  }
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
  V.settingsStore['aiFilmStudio.stepModels'] = { 'chia-canh': 'fake', 'kich-ban-tap': 'fake', 'chia-tap': 'fake', 'dan-y-cac-tap': 'fake', 'dan-y': 'fake', chat: 'fake' };

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
  await waitFor(() => step.$$('#stepper .st').length === 4, `sơ đồ bước phân đoạn: ${step.$$('#stepper .st').map((b) => b.textContent).join(' → ')}`);
  ok(step.$('#stepper .st.cur')?.dataset.step === 'chia-canh', 'bấm ô dashboard → tab phân đoạn K, chọn sẵn ④');
  await waitFor(() => step.$$('#files tr').length >= 2, `bảng file: ${step.$$('#files tr').length} dòng`);
  ok(/tài liệu dùng chung/.test(step.$('#files details summary')?.textContent ?? ''), `tài liệu dùng chung gấp lại: ${step.$('#files details summary')?.textContent}`);
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
  const kCanh = fs.readdirSync(path.join(root, '04_PRODUCTION/EPISODES/EP01/phan-doan')).find((d) => d.startsWith('K_'))!;
  const kFile = path.join(root, '04_PRODUCTION/EPISODES/EP01/phan-doan', kCanh, 'K_canh.md');
  ok(fs.readFileSync(kFile, 'utf8').includes('fake-a đã sửa'), 'Nhận → ghi K_canh.md');
  let kNew: RegExpExecArray | null = null;
  await waitFor(() => (kNew = /\*\*(K\d\d)\*\* \| 6 \| cảnh thử mới/.exec(fs.readFileSync(kFile, 'utf8'))) && !/\| MỚI \|/.test(fs.readFileSync(kFile, 'utf8')), 'cảnh MỚI của AI → tool cấp mã', 8000);
  ok(/CHU-THICH-MA|\(toàn\)|\(cận/.test(fs.readFileSync(kFile, 'utf8')), `Nhận → tool tự chạy chú thích mã (mã mới ${(kNew as any)?.[1]})`);
  ok((step.$('#actions [data-cmd="run"]')?.textContent ?? '').startsWith('✨'), 'nút chạy AI có dấu ✨');

  console.log('\n[3b] Khung chat cuối trang');
  await waitFor(() => step.$('#chatBox') && (step.$('#chatModel') as HTMLSelectElement).options.length >= 2, 'khung chat + chọn model');
  (step.$('#chatModel') as HTMLSelectElement).value = 'fake';
  (step.$('#chatText') as HTMLTextAreaElement).value = 'Phân đoạn này có mấy cảnh?';
  (step.$('#chatSend') as HTMLElement).click();
  await step.settle(20);
  await waitFor(() => /Phân đoạn này có mấy cảnh/.test(step.$('#chatLog')!.textContent ?? '') && /OK/.test(step.$('#chatLog')!.textContent ?? ''), 'gửi → log có câu hỏi + trả lời (markdown)');
  const cp = String(lastRequest?.messages?.[1]?.content ?? '');
  ok(/## Trang đang mở/.test(cp) && /K_canh\.md/.test(cp) && /④|⑥|Phân cảnh/.test(cp), 'AI nhận sẵn ngữ cảnh trang (đối tượng, bước, file liên quan)');
  (step.$('#chatCopy') as HTMLElement).click();
  await step.settle();
  ok(/Phân đoạn này có mấy cảnh/.test(V.clipboard.text ?? ''), 'Copy → clipboard có toàn bộ log');
  (step.$('#chatClear') as HTMLElement).click();
  await step.settle();
  await waitFor(() => /Chưa có trao đổi/.test(step.$('#chatLog')!.textContent ?? ''), 'Clear → log trống');

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
  const sel = set.$$('#steps select').find((s) => s.dataset.step === 'loi' && s.dataset.scope === 'local') as HTMLSelectElement;
  sel.value = 'local-qwen';
  sel.dispatchEvent(new set.dom!.window.Event('change', { bubbles: true }));
  await set.settle();
  ok(V.settingsStore['aiFilmStudio.stepModels']['loi'] === 'local-qwen', 'gán lời → local-qwen (máy này)');
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
  ok(grid.$$('#grid col').length > 3 && grid.$$('#grid [data-rz]').length > 3, 'cột có tay kéo đổi độ rộng');
  const stSel = grid.$$('#grid select');
  ok(stSel.length > 0 && [...(stSel[0] as HTMLSelectElement).options].some((o) => o.value === '✅'), `ô Trạng thái = danh sách chọn (${stSel.length} ô)`);
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
  (grid.$('#gSave') as HTMLElement).click();
  await grid.settle();
  const after = fs.readFileSync(kFile, 'utf8');
  ok(after.includes(newCode) && /K1[2-9]/.test(newCode), `file có cảnh mới ${newCode}`);
  ok(after.split('\n').length === before.split('\n').length + 1, 'chỉ thêm đúng 1 dòng, phần chữ khác giữ nguyên');
  ok(/\|\s*\*\*K03\*\*\s*\|\s*7\s*\|/.test(after), 'sửa giây K03 = 7');

  console.log('\n[7] Cảnh: ⑨ Prompt ảnh + video · ⑩ Blender (chỉ file render _R)');
  fs.writeFileSync(path.join(media, 'EP01_K02_R1_I0.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  V.commands.executeCommand('aiFilmStudio.openStep', 'blender', { ep: 'EP01', seg: 'K', scene: 'K02' });
  const kq = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await kq.settle();
  ok(kq.$$('#stepper .st').map((x) => x.dataset.step).join(',') === 'prompt,blender', `sơ đồ bước cảnh: ${kq.$$('#stepper .st').map((x) => x.textContent).join(' → ')}`);
  await waitFor(() => kq.$$('#media .card').length === 1, `⑩ media K02: chỉ ${kq.$$('#media .card').length} file render (bỏ ảnh / video AI)`);
  ok(kq.$('#media img')?.getAttribute('src')?.startsWith('vscode-resource:'), 'ảnh render hiện qua asWebviewUri');
  ok(!kq.$('[data-cmd="import"]') && !kq.$('#saveResult'), 'không còn nút nhập file / ghi kết quả');
  V.commands.executeCommand('aiFilmStudio.openStep', 'prompt', { ep: 'EP01', seg: 'F', scene: 'F03' });
  await sleep(50);
  const pf = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await pf.settle();
  await waitFor(() => pf.$('#editor [data-copy]'), '⑨ F03: prompt của cảnh có nút 📋 chép');
  ok(/Đại quân Minh dàn trận/.test(pf.$('#editor')!.textContent ?? ''), 'hiện khối prompt video F03');
  const refCards = pf.$$('#editor .card').filter((c) => c.querySelector('b')?.textContent === '@[DON_VANTHE]');
  ok(refCards.length === 1 && /cũng dùng ở/.test(refCards[0].textContent ?? ''), `ảnh dùng chung @[DON_VANTHE]: ${(refCards[0]?.textContent ?? '').slice(0, 90)}`);
  (pf.$('#editor [data-copy]') as HTMLElement).click();
  await pf.settle();
  ok(/^Thực hiện video/.test(V.clipboard.text ?? ''), `📋 chép → clipboard: ${(V.clipboard.text ?? '').slice(0, 40)}`);

  console.log('\n[9] Lệnh quản lý');
  V.answers.push({ kind: 'info', value: 'Ghi' });
  fs.writeFileSync(path.join(root, '.gitignore'), fs.readFileSync(path.join(root, '.gitignore'), 'utf8').replace(/# >>> ai-film-studio[\s\S]*# <<< ai-film-studio\n?/, ''));
  await V.commands.executeCommand('aiFilmStudio.updateGitignore');
  ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('# >>> ai-film-studio'), 'cập nhật .gitignore (khối tool)');
  V.answers.push({ kind: 'input', value: 'thu-nghiem' });
  await V.commands.executeCommand('aiFilmStudio.newSegment', ep1);
  const created = fs.readdirSync(path.join(root, '04_PRODUCTION/EPISODES/EP01/phan-doan')).find((d) => d.endsWith('_thu-nghiem'));
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
  const reg = path.join(root, '04_PRODUCTION/EPISODES/EP01/blender/SO-BLENDER.md');
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
  ok(pI.$('#stepper .st.cur')?.dataset.step === 'kich-ban', 'mở lần đầu → bước 1 (⑤ Kịch bản phân đoạn)');
  ok(pI.$('#head h2')?.textContent?.includes('Kịch bản'), 'nội dung bước 1 hiện ngay dưới');
  (pI.$('[data-step="loi"]') as HTMLElement).click();
  await pI.settle();
  await waitFor(() => pI.$('#stepper .st.cur')?.dataset.step === 'loi' && pI.$('#head h2')!.textContent!.includes('Lời'), 'bấm ⑤a trên sơ đồ → hiện bước Lời');
  // duyệt phân đoạn K → dòng K ở README + mọi cảnh K
  const kp = V.panels.find((p) => p.viewType === 'aiFilmStudio.step' && p.title.includes('TAP01·K') && !p.title.includes('K0'))!;
  ok(kp.$('[data-approve="do"]')?.textContent?.includes('Duyệt phân đoạn K'), 'nút "✅ Duyệt phân đoạn K"');
  V.answers.push({ kind: 'info', value: 'Duyệt' });
  (kp.$('[data-approve="do"]') as HTMLElement).click();
  await kp.settle(10);
  const readme = fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP01/README.md'), 'utf8');
  const kRow = readme.split('\n').find((l) => /^\|\s*\d+\s*\|\s*\*\*K\*\*/.test(l)) ?? '';
  ok(/\|\s*✅[^|]*\|\s*$/.test(kRow), `README dòng K → ✅`);
  const kText = fs.readFileSync(kFile, 'utf8');
  const kStatuses = kText.split('\n').filter((l) => /^\|\s*\*\*K\d\d\*\*/.test(l)).map((l) => l.trim().split('|').slice(-2)[0].trim());
  ok(kStatuses.length >= 11 && kStatuses.every((x) => x.startsWith('✅') || x.startsWith('❌')), `mọi cảnh K → ✅ (${kStatuses.length} dòng)`);
  await waitFor(() => kp.$('#overview')!.textContent!.includes('đã duyệt'), 'overview: "phân đoạn K đã duyệt" + nút Bỏ duyệt');
  (kp.$('[data-step="chia-canh"]') as HTMLElement).click();
  await kp.settle();
  await waitFor(() => kp.$('#head h2')?.textContent?.includes('Phân cảnh') && !kp.$('#head')!.textContent!.includes('Cổng chưa mở'), 'cổng ⑤ mở sau khi duyệt');
  // duyệt riêng một cảnh: chỉ dòng đó
  const jFile = path.join(path.dirname(kFile), '..', fs.readdirSync(path.join(path.dirname(kFile), '..')).find((d) => d.startsWith('J_'))!, 'J_canh.md');
  const jBefore = fs.readFileSync(jFile, 'utf8');
  V.commands.executeCommand('aiFilmStudio.openTarget', { kind: 'scene', ep: ep1.ep, seg: ep1.ep.segments.find((x: any) => x.code === 'J'), scene: ep1.ep.segments.find((x: any) => x.code === 'J').scenes.find((c: any) => c.code === 'J02') });
  const jp = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step').pop()!;
  await jp.settle();
  await waitFor(() => jp.$('[data-approve="do"]')?.textContent?.includes('cảnh J02'), 'tab cảnh J02: nút "✅ Duyệt cảnh J02"');
  ok(jp.$$('#stepper .st').length === 2 && jp.$('#stepper .st.cur')?.dataset.step === 'prompt', `sơ đồ bước cảnh: ${jp.$$('#stepper .st').map((b) => b.textContent).join(' → ')}`);
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

  console.log('\n[13] Trạng thái · Tài nguyên · Ý tưởng – phong cách · danh sách tập');
  const r0 = tree.getChildren().slice(0, 4).map((n: any) => tree.getTreeItem(n).label);
  ok(r0.join(' | ') === 'Trạng thái dự án | Tài liệu hướng dẫn | Tài nguyên dự án | Ý tưởng – phong cách', `gốc cây: ${r0.join(' | ')}`);
  const top = tree.getChildren();
  ok(top[0].kind === 'dashboard' && top[1].kind === 'guides' && tree.getTreeItem(top[1]).label === 'Tài liệu hướng dẫn', 'khung trái: 📖 Tài liệu hướng dẫn ngay dưới Trạng thái dự án');
  const gGroups = tree.getChildren(top[1]);
  const gFiles = gGroups.flatMap((g: any) => tree.getChildren(g)).flatMap((n: any) => (n.kind === 'resDir' ? tree.getChildren(n) : [n]));
  for (const n of [...gGroups, ...gFiles]) tree.getTreeItem(n);
  ok(gGroups.length >= 5 && gFiles.some((n: any) => /từng bước/.test(n.file.label)) && gFiles.every((n: any) => n.file.exists || n.file.rel.includes('tools/studio')), `Hướng dẫn: ${gGroups.length} nhóm · ${gFiles.length} file, đủ file`);
  const resNode = top.find((n: any) => n.kind === 'resources')!;
  const groups = tree.getChildren(resNode);
  const resFiles = groups.flatMap((g: any) => tree.getChildren(g)).flatMap((n: any) => (n.kind === 'resDir' ? tree.getChildren(n) : [n]));
  for (const n of [...groups, ...resFiles]) tree.getTreeItem(n);
  ok(groups.length >= 5 && resFiles.some((n: any) => /đối chiếu sử liệu/.test(n.file.label)), `Tài nguyên: ${groups.length} nhóm · ${resFiles.length} file`);
  V.commands.executeCommand('aiFilmStudio.openTarget', tree.getChildren().find((n: any) => n.kind === 'project'));
  await sleep(50);
  for (const p of V.panels) await p.settle();
  const pp = V.panels.filter((p) => p.viewType === 'aiFilmStudio.step' && !p.disposed).find((p) => p.$('[data-step="y-tuong"]'))!;
  (pp.$('[data-step="y-tuong"]') as HTMLElement).click();
  await pp.settle();
  await waitFor(() => pp.$$('.ideaF').length >= 4, `① form ý tưởng: ${pp.$$('.ideaF').length} ô`);
  ok(pp.$$('#stepper .st').map((x) => x.textContent).join(' ').includes('② Kịch bản tóm tắt + Chia tập'), `sơ đồ: ${pp.$$('#stepper .st').map((x) => x.textContent).join(' → ')}`);
  const genre = pp.$('select.ideaF') as HTMLSelectElement;
  genre.value = 'Phim giả tưởng';
  genre.dispatchEvent(new pp.dom!.window.Event('change', { bubbles: true }));
  (pp.$('#saveIdea') as HTMLElement).click();
  await pp.settle(10);
  ok(/## Thể loại\s+Phim giả tưởng/.test(fs.readFileSync(path.join(root, '00_PROJECT/Y-TUONG_PHONG-CACH.md'), 'utf8')), 'lưu form → file ý tưởng đổi thể loại');
  (pp.$('[data-step="chia-tap"]') as HTMLElement).click();
  await pp.settle();
  await waitFor(() => pp.$('#synText') && !pp.$('#gridHost')!.hidden && pp.$$('#gridHost #grid tr').length > 15, `② kịch bản tóm tắt + lưới ${pp.$$('#gridHost #grid tr').length - 1} tập ngay trong tab`);
  ok(/Chia tập/.test(pp.$('#editor [data-cmd="run"]')?.textContent ?? ''), 'nút ✨ Chia tập');
  const gh = pp.$('#gridHost')!;
  const hdr = Array.from(gh.querySelectorAll('#grid tr')[0].querySelectorAll('th')).map((x) => x.textContent ?? '');
  ok(hdr.includes('Tóm tắt') && hdr.includes('Lịch'), `cột lưới: ${hdr.filter(Boolean).join(' · ')}`);
  const si = hdr.indexOf('Trạng thái') - 1;
  const rowOf = (code: string) => Array.from(gh.querySelectorAll('#grid tr')).find((tr) => (tr.querySelector('input[data-c="0"]') as HTMLInputElement | null)?.value === `**${code}**`)!;
  const st11 = rowOf('EP11').querySelector(`select[data-c="${si}"]`) as HTMLSelectElement;
  ok(Array.from(st11.options).map((o) => o.textContent).join(' · ') === '✅ Duyệt · ⬜ Chưa duyệt · ❌ Bỏ', `trạng thái 3 lựa chọn: ${Array.from(st11.options).map((o) => o.textContent).join(' · ')}`);
  st11.value = '❌';
  st11.dispatchEvent(new pp.dom!.window.Event('change', { bubbles: true }));
  await pp.settle();
  ok(!!rowOf('EP11').querySelector('[data-a="del"]') && !!rowOf('EP11').querySelector(`select[data-c="${si}"]`), 'tập ❌ có nút 🗑 và vẫn đổi lại trạng thái được');
  (gh.querySelector('#gSave') as HTMLElement).click();
  await pp.settle(10);
  ok(/\*\*EP11\*\* \| — \|.*\| ❌ \|/.test(fs.readFileSync(path.join(root, '04_PRODUCTION/DANH-SACH-TAP.md'), 'utf8')), 'lưu lưới → EP11 ❌, không số phát hành');
  (pp.$('#editor [data-cmd="run"]') as HTMLElement).click();
  await pp.settle(20);
  await waitFor(() => pp.$('#runs [data-cmd="apply"]'), 'Chia tập: AI đề xuất xong');
  (pp.$('#runs [data-cmd="apply"]') as HTMLElement).click();
  await pp.settle(10);
  const ds = fs.readFileSync(path.join(root, '04_PRODUCTION/DANH-SACH-TAP.md'), 'utf8');
  ok(!/\*\*EP11\*\*/.test(ds), 'Nhận → tập ❌ EP11 bị xóa khỏi danh sách');
  ok(/LỜI CHA GIÀ NƠI BIÊN ẢI/.test(ds) && !/AI ĐỔI TÊN/.test(ds), 'tập ✅ giữ nguyên văn dù AI sửa');
  const nm = /\*\*(EP\d+)\*\* \| (TAP\d+) \| TẬP MỚI THỬ \|/.exec(ds);
  ok(!!nm && nm[1] !== 'EP11' && nm[1] > 'EP16', `tập MỚI được cấp mã ${nm?.[1]} (không dùng lại EP11) · ${nm?.[2]}`);
  await waitFor(() => !!rowOf(nm?.[1] ?? '?'), 'lưới trong tab tải lại sau khi Nhận');
  await V.commands.executeCommand('aiFilmStudio.editEpisodeList');
  const eg = V.panels.filter((p) => p.viewType === 'aiFilmStudio.grid').pop()!;
  await eg.settle();
  await waitFor(() => eg.$$('#grid tr').length > 15, `lưới danh sách tập: ${eg.$$('#grid tr').length - 1} dòng`);
  const relCol = (r: number) => (eg.$$('#grid tr')[r + 1].querySelectorAll('input')[1] as HTMLInputElement).value;
  ok(relCol(0) === 'TAP00', `teaser EP00 cố định: ${relCol(0)}`);
  (eg.$('[data-a="down"][data-r="1"]') as HTMLElement).click();
  await eg.settle();
  ok(relCol(1) === 'TAP01' && relCol(2) === 'TAP02', `đổi thứ tự → TAP đánh lại: ${relCol(1)}, ${relCol(2)}`);
  (eg.$('[data-a="add"][data-r="2"]') as HTMLElement).click();
  await eg.settle(10);
  const epNew = (eg.$$('#grid tr')[4].querySelectorAll('input')[0] as HTMLInputElement).value;
  ok(/^\*\*EP\d+\*\*$/.test(epNew) && epNew !== `**${nm?.[1]}**`, `thêm tập → mã kế tiếp chưa dùng: ${epNew}`);
  ok(eg.$$('[data-a="mkdir"]').length === 1, 'tập mới chưa lưu chưa có nút 📁 (chỉ tập MỚI của AI đã lưu có)');
  (eg.$('[data-a="merge"][data-r="3"]') as HTMLElement).click();
  await eg.settle();
  ok(relCol(3) === '↑ TAP02' && relCol(4) === 'TAP03', `⤴ gộp EP21 vào tập phát hành dòng trên: ${relCol(3)} · dòng sau ${relCol(4)}`);
  (eg.$('#gSave') as HTMLElement).click();
  await eg.settle(10);
  const listTxt = fs.readFileSync(path.join(root, '04_PRODUCTION/DANH-SACH-TAP.md'), 'utf8');
  ok(/\*\*EP02\*\* \| TAP01/.test(listTxt) && listTxt.includes(`${epNew} | ↑ TAP02`) && /\*\*EP01\*\* \| TAP02/.test(listTxt), `lưu → file có EP02=TAP01, EP01=TAP02, ${epNew}=↑ TAP02`);
  await waitFor(() => eg.$$('[data-a="mkdir"]').length === 2, `sau khi lưu: ${epNew} có nút 📁 tạo thư mục`);

  console.log('\n[13b] Dự án: ③ Dàn ý mọi tập — chọn tập, sửa, duyệt');
  ok(!pp.$('[data-step="ket-thuc-phien"]'), 'không còn bước Kết thúc phiên');
  (pp.$('[data-step="dan-y-cac-tap"]') as HTMLElement).click();
  await pp.settle();
  await waitFor(() => pp.$$('#olList .olRow').length > 15 && pp.$('#olAllText'), `③ bảng dàn ý ${pp.$$('#olList .olRow').length} tập + ô sửa`);
  (pp.$('#olList .olRow[data-ep="EP03"]') as HTMLElement).click();
  await pp.settle();
  await waitFor(() => (pp.$('#olAllText') as HTMLTextAreaElement)?.dataset.ep === 'EP03', 'chọn EP03 → hiện dàn ý EP03');
  ok(/Lê Lợi/.test((pp.$('#olAllText') as HTMLTextAreaElement).value), 'dàn ý EP03 có nội dung');
  const olT = pp.$('#olAllText') as HTMLTextAreaElement;
  olT.value += '\n- ý thêm ở tab dự án';
  olT.dispatchEvent(new pp.dom!.window.Event('input', { bubbles: true }));
  (pp.$('#olList .olRow[data-ep="EP04"]') as HTMLElement).click();
  await pp.settle();
  ok(/đang sửa dở/.test(pp.$('#olWarn')!.textContent ?? '') && (pp.$('#olAllText') as HTMLTextAreaElement).dataset.ep === 'EP03', 'sửa dở → không cho chuyển tập');
  (pp.$('#olAllAppr') as HTMLElement).click();
  await pp.settle(10);
  const ol3 = fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP03/dan-y.md'), 'utf8');
  ok(/^<!-- @tool dan-y: ✅/.test(ol3) && /ý thêm ở tab dự án/.test(ol3), 'Duyệt → lưu nội dung + dòng trạng thái ✅ đầu file');
  await waitFor(() => /đã duyệt/.test(pp.$('#olList .olRow[data-ep="EP03"]')?.textContent ?? '') && pp.$('#olAllUndo'), 'bảng: EP03 ✅ đã duyệt · nút Bỏ duyệt');
  ok(!/dan-y:/.test((pp.$('#olAllText') as HTMLTextAreaElement).value), 'ô sửa không hiện dòng trạng thái');

  // Gợi ý dàn ý: chọn EP04 (chưa duyệt) → ✨ → chọn "Chỉ EP04" → thẻ kết quả EP04 → Nhận ghi vào EP04/dan-y.md
  (pp.$('#olList .olRow[data-ep="EP04"]') as HTMLElement).click();
  await pp.settle();
  await waitFor(() => (pp.$('#olAllText') as HTMLTextAreaElement)?.dataset.ep === 'EP04', 'chọn EP04');
  ok(/Gợi ý dàn ý/.test(pp.$('#actions [data-cmd="run"]')?.textContent ?? ''), 'nút ✨ Gợi ý dàn ý ở ③ tab dự án');
  V.answers.push({ kind: 'info', value: 'Chỉ EP04' });
  (pp.$('#actions [data-cmd="run"]') as HTMLElement).click();
  await pp.settle(20);
  await waitFor(() => /EP04/.test(pp.$('#runs .card')?.textContent ?? '') && pp.$('#runs [data-cmd="apply"]'), 'thẻ kết quả ghi mã tập EP04, có Nhận');
  ok(/# ③ GỢI Ý DÀN Ý — tập EP04/.test(String(lastRequest?.messages?.[1]?.content ?? '')), 'prompt gửi đi là gợi ý dàn ý của EP04');
  ok(/khung mỗi tập là \*\*15–20 phút\*\*/.test(String(lastRequest?.messages?.[1]?.content ?? '')), 'prompt có thời lượng mỗi tập lấy từ form ① ({{thoiLuong}})');
  (pp.$('#runs [data-cmd="apply"]') as HTMLElement).click();
  await pp.settle(10);
  ok(/đã sửa/.test(fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP04/dan-y.md'), 'utf8')), 'Nhận → ghi vào EP04/dan-y.md (đúng tập, không phải file của tab dự án)');
  (pp.$('#olList .olRow[data-ep="EP03"]') as HTMLElement).click();
  await pp.settle();

  console.log('\n[14] Tập: ③ Dàn ý → Tạo phân đoạn → ④ duyệt từng phân đoạn → Phân cảnh');
  const e3 = tree.getChildren().find((n: any) => n.kind === 'episode' && n.ep.id === 'EP03');
  ok(tree.getTreeItem(e3).label === 'TAP03 HỘI THỀ LŨNG NHAI', `cây: ${tree.getTreeItem(e3).label} · ${tree.getTreeItem(e3).description}`);
  V.commands.executeCommand('aiFilmStudio.openTarget', e3);
  await sleep(50);
  const t3 = V.panels.find((p) => p.viewType === 'aiFilmStudio.step' && p.title.includes('TAP03') && !p.disposed)!;
  await t3.settle();
  await waitFor(() => t3.$('#olText'), `③ Dàn ý mở đầu: ${t3.$$('#stepper .st').map((x) => x.textContent).join(' → ')}`);
  ok(!t3.$('[data-step="gop-y"]'), 'không còn bước Góp ý ngôn ngữ điện ảnh ở tập');
  ok(/Lê Lợi/.test((t3.$('#olText') as HTMLTextAreaElement).value), 'dàn ý EP03 có nội dung (chép từ khung tập)');
  (t3.$('#olText') as HTMLTextAreaElement).value += '\n- thêm một ý thử';
  (t3.$('#olNext') as HTMLElement).click();
  await t3.settle(10);
  ok(/thêm một ý thử/.test(fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP03/dan-y.md'), 'utf8')), 'Tạo phân đoạn → lưu dàn ý');
  ok(/^<!-- @tool dan-y: ✅/.test(fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP03/dan-y.md'), 'utf8')), 'lưu ở tab tập vẫn giữ trạng thái ✅ dàn ý');
  await waitFor(() => t3.$('#stepper .st.cur')?.dataset.step === 'kich-ban-tap' && t3.$('#runs [data-cmd="apply"]'), 'tự sang ④ + AI chạy xong');
  (t3.$('#runs [data-cmd="apply"]') as HTMLElement).click();
  await t3.settle(10);
  const readme3 = path.join(root, '04_PRODUCTION/EPISODES/EP03/README.md');
  ok(fs.existsSync(readme3) && /\*\*B\*\*.*chưa duyệt/.test(fs.readFileSync(readme3, 'utf8')), 'Nhận → bảng phân đoạn A, B vào README tập (⬜ chưa duyệt)');
  await waitFor(() => t3.$$('.segSt').length === 2, `④ bảng phân đoạn: ${t3.$$('.segSt').length} dòng`);
  const selA = t3.$('.segSt[data-code="A"]') as HTMLSelectElement;
  selA.value = '✅';
  selA.dispatchEvent(new t3.dom!.window.Event('change', { bubbles: true }));
  (t3.$('#saveSeg') as HTMLElement).click();
  await t3.settle(10);
  ok(/\*\*A\*\*[^\n]*\| ✅/.test(fs.readFileSync(readme3, 'utf8')), 'duyệt A → README dòng A ✅');
  V.answers.push({ kind: 'info', value: 'Phân cảnh' });
  (t3.$('#phanCanh') as HTMLElement).click();
  await t3.settle(10);
  await sleep(100);
  ok(fs.readdirSync(path.join(root, '04_PRODUCTION/EPISODES/EP03/phan-doan')).some((d) => d.startsWith('A_')), 'Phân cảnh → mục con A (thư mục từ mẫu), B chưa duyệt thì chưa tạo');
  const sA = V.panels.find((p) => p.viewType === 'aiFilmStudio.step' && p.title.includes('TAP03·A'));
  ok(sA, 'mở tab phân đoạn A');
  if (sA) { await sA.settle(); await waitFor(() => sA.$('#stepper .st.cur')?.dataset.step === 'chia-canh' && sA.$('#runs .card'), 'tab A: ⑤ Phân cảnh, AI đang / đã chạy'); }

  console.log('\n[15] Phân đoạn: ⑤ Kịch bản phân đoạn → Tạo phân cảnh → ⑥ lưới ngay trong tab');
  const kSeg = ep1.ep.segments.find((x: any) => x.code === 'K');
  V.commands.executeCommand('aiFilmStudio.openTarget', { kind: 'segment', ep: ep1.ep, seg: kSeg });
  await sleep(50);
  const kt = V.panels.find((p) => p.viewType === 'aiFilmStudio.step' && p.title.includes('TAP01·K') && !p.title.includes('K0') && !p.disposed)!;
  await kt.settle();
  (kt.$('[data-step="kich-ban"]') as HTMLElement).click();
  await kt.settle();
  await waitFor(() => /\[K\]/.test((kt.$('#secText') as HTMLTextAreaElement)?.value ?? ''), `⑤ hiện mục [K] của kịch bản: ${kt.$$('#stepper .st').map((x) => x.textContent).join(' → ')}`);
  ok(kt.$('#gridHost')!.hidden, '⑤ chưa hiện lưới');
  ok(kt.$('#secNote') && !/### Ghi chú/.test((kt.$('#secText') as HTMLTextAreaElement).value), `⑤ ô Ghi chú riêng: "${((kt.$('#secNote') as HTMLTextAreaElement)?.value ?? '').slice(0, 40)}"`);
  (kt.$('#secText') as HTMLTextAreaElement).value += '\n- ý mới của phân đoạn K';
  (kt.$('#secNext') as HTMLElement).click();
  await kt.settle(10);
  const scriptTxt = fs.readFileSync(path.join(root, '04_PRODUCTION/EPISODES/EP01/kich-ban-chi-tiet.md'), 'utf8');
  ok(/ý mới của phân đoạn K\n[\s\S]*## ~~\[N\]/.test(scriptTxt), 'Tạo phân cảnh → lưu đúng mục [K] (trước mục [N])');
  await waitFor(() => kt.$('#stepper .st.cur')?.dataset.step === 'chia-canh' && !kt.$('#gridHost')!.hidden, '→ sang ⑥, lưới hiện trong tab');
  await waitFor(() => kt.$$('#gridHost #grid tr').length > 10, `lưới trong tab: ${kt.$$('#gridHost #grid tr').length - 1} cảnh`);
  await waitFor(() => kt.$('#runs .card'), 'AI tạo phân cảnh đang / đã chạy');
  ok(/Tạo lại phân cảnh/.test(kt.$('#actions')!.textContent ?? ''), `nút AI: ${kt.$('#actions')!.textContent}`);
  const cellK = kt.$('#gridHost #grid input[data-r="0"][data-c="1"]') as HTMLInputElement;
  cellK.value = '9';
  cellK.dispatchEvent(new kt.dom!.window.Event('input', { bubbles: true }));
  (kt.$('#gSave') as HTMLElement).click();
  await kt.settle(10);
  ok(/\| \*\*K01\*\* \| 9 \|/.test(fs.readFileSync(ep1.ep.segments.find((x: any) => x.code === 'K').files.canh, 'utf8')), 'sửa ô trong lưới nhúng → lưu vào K_canh.md');

  console.log('\n[16] Phân đoạn: ⑦ Lời dẫn + thoại — lưới bảng lời trong tab');
  (kt.$('[data-step="loi"]') as HTMLElement).click();
  await kt.settle(10);
  await waitFor(() => /Lời dẫn \+ thoại K/.test(kt.$('#gTitle')?.textContent ?? '') && kt.$$('#gridHost #grid tr').length > 2, `⑦ lưới lời trong tab: ${kt.$('#gTitle')?.textContent} · ${kt.$$('#gridHost #grid tr').length - 1} câu`);
  ok(!kt.$$('#stepper .st').some((x) => x.dataset.step === 'prompt-doan'), `sơ đồ phân đoạn: ${kt.$$('#stepper .st').map((x) => x.textContent).join(' → ')}`);
  const firstCode = (kt.$('#gridHost #grid input[data-r="0"][data-c="0"]') as HTMLInputElement).value.replace(/[*~]/g, '');
  (kt.$('#gridHost [data-a="add"][data-r="0"]') as HTMLElement).click();
  await kt.settle(10);
  const added = (kt.$('#gridHost #grid input[data-r="1"][data-c="0"]') as HTMLInputElement).value.replace(/[*~]/g, '');
  ok(added.startsWith(firstCode.split('_')[0] + '_L') && added !== firstCode, `+ dưới ${firstCode} → câu mới cùng cảnh ${added}`);
  const wordIdx = kt.$$('#gridHost #grid th').findIndex((t) => /^Lời/.test(t.textContent ?? '')) - 1;
  const ta = kt.$(`#gridHost #grid textarea[data-r="1"][data-c="${wordIdx}"]`) as HTMLTextAreaElement;
  ta.value = 'Câu thoại thử nghiệm.';
  ta.dispatchEvent(new kt.dom!.window.Event('input', { bubbles: true }));
  (kt.$('#gSave') as HTMLElement).click();
  await kt.settle(10);
  const kLoi = fs.readFileSync(ep1.ep.segments.find((x: any) => x.code === 'K').files.loi, 'utf8');
  ok(new RegExp(`${added} \\|[^\\n]*Câu thoại thử nghiệm`).test(kLoi), 'lưu → câu mới vào K_loi.md');

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
