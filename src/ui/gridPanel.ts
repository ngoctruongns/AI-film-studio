// Tab sửa bảng cảnh <X>_canh.md dạng lưới: sửa ô, đổi thứ tự chiếu, thêm cảnh (cấp mã), đánh dấu bỏ.
// Chỉ ghi lại khối dòng của bảng — phần chữ khác trong file giữ nguyên. Không bao giờ xóa dòng (mã đã cấp không dùng lại).
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ledgerPath, loadLedger, nextSceneCode, reserveScene, saveLedger } from '../core/codes';
import { columnIndex } from '../core/markdown';
import { findEpisode, findSegment } from '../core/scanner';
import { Grid, GridRow, readGrid, writeGrid } from '../core/tableEdit';
import { Studio } from './studio';
import { shell } from './webview';

export class GridPanel {
  private static panels = new Map<string, GridPanel>();
  private grid?: Grid;
  private file?: string;

  static open(studio: Studio, ep: string, seg: string): void {
    const key = `${ep}·${seg}`;
    const ex = this.panels.get(key);
    if (ex) {
      ex.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiFilmStudio.grid', `▦ ${seg}_canh`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const g = new GridPanel(panel, studio, ep, seg);
    this.panels.set(key, g);
    panel.onDidDispose(() => this.panels.delete(key));
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private studio: Studio,
    private ep: string,
    private seg: string,
  ) {
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e))));
    panel.webview.html = shell(panel.webview, 'Bảng cảnh', BODY, CLIENT_JS);
  }

  private load(): void {
    const model = this.studio.model;
    const s = findSegment(findEpisode(model!, this.ep), this.seg);
    this.file = s?.files['canh'];
    if (!model || !this.file) {
      this.panel.webview.postMessage({ type: 'error', text: `Chưa có bảng cảnh của ${this.ep}·${this.seg}.` });
      return;
    }
    const p = model.config.project;
    const text = fs.readFileSync(this.file, 'utf8');
    this.grid = readGrid(text, p.sceneTable.codeColumn, new RegExp(p.codes.scene));
    if (!this.grid) {
      this.panel.webview.postMessage({ type: 'error', text: 'Không thấy bảng có cột mã cảnh trong file.' });
      return;
    }
    const headers = this.grid.headers;
    const suggest = p.sceneTable.suggest;
    const lists: Record<number, string[]> = {};
    for (const [col, vals] of Object.entries(suggest ?? {})) {
      const i = headers.findIndex((h) => h.toLowerCase() === col.toLowerCase());
      if (i >= 0) lists[i] = vals;
    }
    const si = headers.findIndex((h) => h.toLowerCase() === p.sceneTable.statusColumn?.toLowerCase());
    if (si >= 0 && !lists[si]) lists[si] = Object.values(p.status).flat();
    this.panel.webview.postMessage({
      type: 'grid',
      title: `${this.ep} · ${this.seg} — ${this.studio.rel(this.file)}`,
      file: this.file,
      headers,
      codeIndex: this.grid.codeIndex,
      wideIndex: headers.findIndex((h) => h.toLowerCase() === p.sceneTable.nameColumn?.toLowerCase()),
      secondsIndex: headers.findIndex((h) => h.toLowerCase() === p.sceneTable.secondsColumn?.toLowerCase()),
      statusIndex: si,
      dropSymbol: p.status.dropped?.[0] ?? '❌',
      lists,
      rows: this.grid.rows,
    });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'reload':
        return this.load();
      case 'open':
        if (this.file) await vscode.window.showTextDocument(vscode.Uri.file(this.file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      case 'newCode': {
        const model = this.studio.model!;
        const lp = ledgerPath(model);
        const ledger = loadLedger(lp);
        const code = nextSceneCode(ledger, this.ep, this.seg);
        if (!code) return void vscode.window.showErrorMessage('Hết mã cảnh (99).');
        // mã cấp trong phiên sửa lưới (chưa lưu) cũng không trùng
        const taken = new Set<string>(m.taken ?? []);
        let c = code;
        while (taken.has(c)) {
          reserveScene(ledger, this.ep, c);
          c = nextSceneCode(ledger, this.ep, this.seg)!;
        }
        reserveScene(ledger, this.ep, c);
        saveLedger(lp, ledger);
        this.panel.webview.postMessage({ type: 'newCode', code: c, after: m.after });
        return;
      }
      case 'save': {
        if (!this.grid || !this.file) return;
        const now = fs.readFileSync(this.file, 'utf8');
        if (now !== this.grid.original) {
          const ok = await vscode.window.showWarningMessage('File đã bị sửa ở chỗ khác từ lúc mở lưới. Ghi đè bảng bằng bản trong lưới?', { modal: true }, 'Ghi đè bảng', 'Tải lại lưới');
          if (ok === 'Tải lại lưới') return this.load();
          if (ok !== 'Ghi đè bảng') return;
          // giữ phần chữ mới ngoài bảng: đọc lại bảng từ file mới rồi mới ghi
          const p = this.studio.model!.config.project;
          const fresh = readGrid(now, p.sceneTable.codeColumn, new RegExp(p.codes.scene));
          if (!fresh) return;
          this.grid = { ...fresh, rows: fresh.rows };
        }
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === this.file);
        if (doc?.isDirty) return void vscode.window.showWarningMessage('File đang mở có thay đổi chưa lưu — lưu hoặc bỏ trước.');
        const rows: GridRow[] = (m.rows as GridRow[]).map((r) => ({ line: Number(r.line), cells: r.cells.map(String) }));
        const p = this.studio.model!.config.project;
        const ci = columnIndex({ line: 0, headers: this.grid.headers, rows: [] }, p.sceneTable.codeColumn);
        const codes = rows.map((r) => r.cells[ci]?.replace(/\*/g, '').trim());
        const dup = codes.find((c, i) => c && codes.indexOf(c) !== i);
        if (dup) return void vscode.window.showErrorMessage(`Mã ${dup} bị trùng trong bảng.`);
        const text = writeGrid(this.grid, rows);
        fs.writeFileSync(this.file, text, 'utf8');
        vscode.window.showInformationMessage(`Đã lưu bảng cảnh ${this.seg} (${rows.length} dòng). Xem bằng git diff.`);
        this.studio.refresh();
        return this.load();
      }
    }
  }
}

const BODY = `
<div class="row" style="justify-content:space-between"><h1 id="title">Bảng cảnh</h1>
<div class="row"><button id="save">Lưu</button><button class="sec" id="reload">Tải lại</button><button class="link" id="open">mở file</button></div></div>
<p class="muted">Sửa thẳng trong ô · ▲▼ đổi thứ tự chiếu · <b>+</b> thêm cảnh mới ngay dưới (tool cấp mã kế tiếp chưa dùng) · <b>bỏ</b> đánh dấu trạng thái bỏ (không xóa dòng — mã đã cấp không dùng lại).
<span id="sum"></span> <span id="dirty" class="err"></span></p>
<div id="err"></div>
<div class="scroll-x"><table id="grid"></table></div>
<div id="lists"></div>
`;

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let G = null; let rows = []; let dirty = false;
const mark = () => { dirty = true; $('dirty').textContent = '● chưa lưu'; sum(); };
function sum() {
  if (!G || G.secondsIndex < 0) return;
  let s = 0, n = 0;
  for (const r of rows) { const v = parseFloat(String(r.cells[G.secondsIndex]).replace(',', '.')); if (!isNaN(v) && !String(r.cells[G.statusIndex] || '').includes(G.dropSymbol)) { s += v; n++; } }
  $('sum').textContent = '· ' + n + ' cảnh, ' + Math.floor(s / 60) + '′' + String(Math.round(s % 60)).padStart(2, '0') + '″';
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'error') { $('err').innerHTML = '<p class="err">' + esc(m.text) + '</p>'; }
  if (m.type === 'grid') { G = m; rows = m.rows.map((r) => ({ line: r.line, cells: r.cells.slice() })); dirty = false; $('dirty').textContent = ''; $('title').textContent = m.title; render(); }
  if (m.type === 'newCode') {
    const cells = G.headers.map(() => '');
    cells[G.codeIndex] = '**' + m.code + '**';
    if (G.statusIndex >= 0) cells[G.statusIndex] = '⬜';
    rows.splice(m.after + 1, 0, { line: -1, cells });
    mark(); render();
  }
});
function render() {
  $('lists').innerHTML = Object.entries(G.lists).map(([i, vals]) => '<datalist id="dl' + i + '">' + vals.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>').join('');
  $('grid').innerHTML = '<tr><th></th>' + G.headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' + rows.map((r, ri) => {
    const dropped = G.statusIndex >= 0 && String(r.cells[G.statusIndex]).includes(G.dropSymbol);
    return '<tr' + (dropped ? ' style="opacity:.5"' : '') + '><td style="white-space:nowrap">'
      + '<button class="link" data-a="up" data-r="' + ri + '">▲</button><button class="link" data-a="down" data-r="' + ri + '">▼</button>'
      + '<button class="link" data-a="add" data-r="' + ri + '" title="thêm cảnh dưới dòng này">+</button>'
      + (G.statusIndex >= 0 ? '<button class="link" data-a="drop" data-r="' + ri + '">' + (dropped ? 'khôi phục' : 'bỏ') + '</button>' : '') + '</td>'
      + r.cells.map((c, ci) => {
        const ro = ci === G.codeIndex && r.line >= 0;
        const attrs = ' data-r="' + ri + '" data-c="' + ci + '"';
        if (ci === G.wideIndex) return '<td style="min-width:320px"><textarea' + attrs + ' style="min-height:56px">' + esc(c) + '</textarea></td>';
        const w = ci === G.codeIndex || ci === G.secondsIndex ? 7 : Math.min(28, Math.max(8, String(c).length + 2));
        return '<td><input' + attrs + ' size="' + w + '" value="' + esc(c) + '"' + (ro ? ' readonly title="mã đã cấp không đổi"' : '') + (G.lists[ci] ? ' list="dl' + ci + '"' : '') + '></td>';
      }).join('') + '</tr>';
  }).join('');
  sum();
}
document.addEventListener('input', (e) => {
  const t = e.target; if (t.dataset.r === undefined || t.dataset.c === undefined) return;
  rows[+t.dataset.r].cells[+t.dataset.c] = t.value; mark();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (b) {
    const i = +b.dataset.r;
    if (b.dataset.a === 'up' && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; mark(); render(); }
    if (b.dataset.a === 'down' && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; mark(); render(); }
    if (b.dataset.a === 'add') vscode.postMessage({ type: 'newCode', after: i, taken: rows.map((r) => String(r.cells[G.codeIndex]).replace(/\\*/g, '').trim()) });
    if (b.dataset.a === 'drop') {
      const c = String(rows[i].cells[G.statusIndex] || '');
      rows[i].cells[G.statusIndex] = c.includes(G.dropSymbol) ? c.replace(G.dropSymbol, '⬜').trim() : (G.dropSymbol + ' ' + c.replace(/^[⬜✍👀✅⏸]\\s*/u, '')).trim();
      mark(); render();
    }
  }
  if (e.target.id === 'save') vscode.postMessage({ type: 'save', rows });
  if (e.target.id === 'reload') { if (!dirty || confirmReload()) vscode.postMessage({ type: 'reload' }); }
  if (e.target.id === 'open') vscode.postMessage({ type: 'open' });
});
function confirmReload() { $('dirty').textContent = '● bỏ thay đổi chưa lưu — bấm Tải lại lần nữa'; if (window._rl) return true; window._rl = true; setTimeout(() => (window._rl = false), 3000); return false; }
vscode.postMessage({ type: 'ready' });
`;
