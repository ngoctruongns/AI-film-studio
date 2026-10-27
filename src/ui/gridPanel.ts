// Tab sửa bảng dạng lưới — bảng cảnh <X>_canh.md và danh sách tập: sửa ô, đổi thứ tự, thêm dòng (cấp mã), đánh dấu bỏ.
// Chỉ ghi lại khối dòng của bảng — phần chữ khác trong file giữ nguyên. Không bao giờ xóa dòng (mã đã cấp không dùng lại).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ledgerPath, loadLedger, nextSceneCode, reserveEpisode, reserveScene, saveLedger } from '../core/codes';
import { EPISODE_CODE_RE, EpisodeListConfig, nextEpisodeCode, numberReleases, slugify } from '../core/episodeList';
import { copyDir } from './commands';
import { columnIndex } from '../core/markdown';
import { findEpisode, findSegment } from '../core/scanner';
import { Grid, GridRow, readGrid, writeGrid } from '../core/tableEdit';
import { Studio } from './studio';
import { shell } from './webview';

/** Một loại bảng sửa được bằng lưới — bảng cảnh của phân đoạn, danh sách tập của dự án. */
interface GridSpec {
  file?: string;
  title: string;
  codeColumn: string;
  codeRe: RegExp;
  nameColumn?: string;
  secondsColumn?: string;
  statusColumn?: string;
  statusChoices: { value: string; label: string }[];
  columnWidths: Record<string, number>;
  suggest?: Record<string, string[]>;
  /** danh từ cho một dòng: cảnh / tập */
  noun: string;
  /** cột tool tự điền (chỉ đọc) — số phát hành */
  release?: { column: string; prefix: string; skip: string[]; fixed: Record<string, string> };
  /** mã dòng đã có thư mục (tập) — dòng chưa có hiện nút tạo thư mục */
  haveDir?: string[];
  /** after = mã của dòng bấm "+" (lưới lời: câu mới cùng cảnh) */
  newCode(taken: string[], after?: string): string | undefined;
  /** chuẩn hóa trước khi ghi (đánh lại số phát hành) */
  beforeSave?(headers: string[], rows: GridRow[]): void;
}

export class GridPanel {
  private static panels = new Map<string, GridPanel>();

  /** seg = mã phân đoạn → bảng cảnh; bỏ trống → danh sách tập của dự án */
  static open(studio: Studio, ep?: string, seg?: string): void {
    const key = seg ? `${ep}·${seg}` : 'episodes';
    const ex = this.panels.get(key);
    if (ex) {
      ex.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiFilmStudio.grid', seg ? `▦ ${seg}_canh` : '▦ Danh sách tập', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const g = new GridPanel(panel, studio, ep, seg);
    this.panels.set(key, g);
    panel.onDidDispose(() => this.panels.delete(key));
  }

  private constructor(readonly panel: vscode.WebviewPanel, studio: Studio, ep: string | undefined, seg: string | undefined) {
    const ctl = new GridController(studio, (m) => panel.webview.postMessage(m), ep, seg);
    panel.webview.onDidReceiveMessage((m) => ctl.onMessage(m).catch((e) => vscode.window.showErrorMessage(String(e.message ?? e))));
    panel.webview.html = shell(panel.webview, seg ? 'Bảng cảnh' : 'Danh sách tập', GRID_BODY, gridClientJs(false));
  }
}

/** Phần máy chủ của lưới — dùng cho tab lưới riêng và lưới nằm trong tab phân đoạn (bước ⑥ Phân cảnh). */
export class GridController {
  private grid?: Grid;
  private spec?: GridSpec;

  constructor(
    private studio: Studio,
    private post: (m: any) => void,
    private ep: string | undefined,
    private seg: string | undefined,
    /** lines = bảng lời <X>_loi.md của phân đoạn (bước ⑦) */
    private kind: 'scenes' | 'lines' = 'scenes',
  ) {}

  private makeSpec(): GridSpec | string {
    const model = this.studio.model!;
    const p = model.config.project;
    if (this.seg && this.kind === 'lines') {
      const s = findSegment(findEpisode(model, this.ep), this.seg);
      const file = s?.files['loi'];
      if (!file) return `Chưa có file lời ${this.seg}_loi.md của ${this.ep}·${this.seg}.`;
      const t = p.linesTable ?? { codeColumn: 'Mã', nameColumn: 'Lời', statusColumn: 'Trạng thái' };
      const lineRe = new RegExp(`^${p.codes.line}$`);
      return {
        file,
        title: `Lời dẫn + thoại ${this.seg} — ${this.studio.rel(file)}`,
        codeColumn: t.codeColumn,
        codeRe: lineRe,
        nameColumn: t.nameColumn,
        statusColumn: t.statusColumn,
        statusChoices: [],
        columnWidths: t.columnWidths ?? {},
        suggest: t.suggest,
        noun: 'câu',
        // câu mới cùng cảnh với dòng bấm "+": F07_L1 → F07_L<lớn nhất + 1>
        newCode: (taken, after) => {
          const m = /^([A-Z]\d{2})_L(\d+)$/.exec((after ?? '').replace(/[*~]/g, '').trim());
          const scene = m?.[1] ?? `${this.seg}00`;
          const max = taken.reduce((a, c) => {
            const x = new RegExp(`^${scene}_L(\\d+)$`).exec(c.replace(/[*~]/g, '').trim());
            return x ? Math.max(a, Number(x[1])) : a;
          }, 0);
          return `${scene}_L${max + 1}`;
        },
      };
    }
    if (this.seg) {
      const s = findSegment(findEpisode(model, this.ep), this.seg);
      const file = s?.files['canh'];
      if (!file) return `Chưa có bảng cảnh của ${this.ep}·${this.seg}.`;
      const t = p.sceneTable;
      return {
        file,
        title: `${this.ep} · ${this.seg} — ${this.studio.rel(file)}`,
        codeColumn: t.codeColumn,
        codeRe: new RegExp(p.codes.scene),
        nameColumn: t.nameColumn,
        secondsColumn: t.secondsColumn,
        statusColumn: t.statusColumn,
        statusChoices: t.statusChoices ?? [],
        columnWidths: t.columnWidths ?? {},
        suggest: t.suggest,
        noun: 'cảnh',
        newCode: (taken) => {
          const lp = ledgerPath(model);
          const ledger = loadLedger(lp);
          let c = nextSceneCode(ledger, this.ep!, this.seg!);
          // mã cấp trong phiên sửa lưới (chưa lưu) cũng không trùng
          while (c && taken.includes(c)) {
            reserveScene(ledger, this.ep!, c);
            c = nextSceneCode(ledger, this.ep!, this.seg!);
          }
          if (!c) return undefined;
          reserveScene(ledger, this.ep!, c);
          saveLedger(lp, ledger);
          return c;
        },
      };
    }
    const L = p.episodeList;
    if (!L) return 'Chưa cấu hình danh sách tập (episodeList trong .studio/project.yaml).';
    const file = this.studio.abs(L.file);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, emptyEpisodeList(L), 'utf8');
    }
    return {
      file,
      title: `Danh sách tập — ${L.file}`,
      codeColumn: L.codeColumn,
      codeRe: EPISODE_CODE_RE,
      nameColumn: L.summaryColumn,
      statusColumn: L.statusColumn,
      statusChoices: L.statusChoices ?? [],
      columnWidths: L.columnWidths ?? {},
      noun: 'tập',
      release: { column: L.releaseColumn, prefix: L.releasePrefix, skip: L.noRelease ?? ['❌', '⏸'], fixed: L.releaseFixed ?? {} },
      haveDir: model.episodes.map((e) => e.id),
      newCode: (taken) => {
        const lp = ledgerPath(model);
        const ledger = loadLedger(lp);
        const c = nextEpisodeCode([...Object.keys(ledger.episodes), ...model.episodes.map((e) => e.id), ...model.episodeList.map((r) => r.code), ...taken]);
        reserveEpisode(ledger, c);
        saveLedger(lp, ledger);
        return c;
      },
      beforeSave: (headers, rows) => numberReleases(headers, rows, L),
    };
  }

  load(): void {
    if (!this.studio.model) return;
    const spec = this.makeSpec();
    if (typeof spec === 'string') {
      this.post({ type: 'error', text: spec });
      return;
    }
    this.spec = spec;
    const text = fs.readFileSync(spec.file!, 'utf8');
    this.grid = readGrid(text, spec.codeColumn, spec.codeRe);
    if (!this.grid) {
      this.post({ type: 'error', text: `Không thấy bảng có cột "${spec.codeColumn}" trong file.` });
      return;
    }
    const p = this.studio.model.config.project;
    const headers = this.grid.headers;
    const col = (name?: string) => (name ? headers.findIndex((h) => h.toLowerCase() === name.toLowerCase()) : -1);
    const lists: Record<number, string[]> = {};
    for (const [c, vals] of Object.entries(spec.suggest ?? {})) {
      const i = col(c);
      if (i >= 0) lists[i] = vals;
    }
    const si = col(spec.statusColumn);
    if (si >= 0 && !lists[si]) lists[si] = Object.values(p.status).flat();
    const defaults = { ...DEFAULT_WIDTHS, ...spec.columnWidths };
    this.post({
      type: 'grid',
      title: spec.title,
      file: spec.file,
      noun: spec.noun,
      plainCode: spec.noun === 'câu',
      headers,
      codeIndex: this.grid.codeIndex,
      wideIndex: col(spec.nameColumn),
      secondsIndex: col(spec.secondsColumn),
      statusIndex: si,
      release: spec.release && { index: col(spec.release.column), prefix: spec.release.prefix, skip: spec.release.skip, fixed: spec.release.fixed },
      haveDir: spec.haveDir,
      dropSymbol: p.status.dropped?.[0] ?? '❌',
      statusChoices: spec.statusChoices,
      widths: { ...defaults, ...this.studio.context.globalState.get<Record<string, number>>(WIDTH_KEY, {}) },
      defaults,
      lists,
      rows: this.grid.rows,
    });
  }

  async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'reload':
        return this.load();
      case 'widths': {                                   // độ rộng cột người kéo — nhớ theo tên cột, mọi bảng dùng chung
        const cur = this.studio.context.globalState.get<Record<string, number>>(WIDTH_KEY, {});
        await this.studio.context.globalState.update(WIDTH_KEY, { ...cur, ...(m.widths ?? {}) });
        return;
      }
      case 'open':
        if (this.spec?.file) await vscode.window.showTextDocument(vscode.Uri.file(this.spec.file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      case 'newCode': {
        if (!this.spec) return;
        const c = this.spec.newCode((m.taken ?? []).map(String), m.afterCode ? String(m.afterCode) : undefined);
        if (!c) return void vscode.window.showErrorMessage(`Hết mã ${this.spec.noun}.`);
        this.post({ type: 'newCode', code: c, after: m.after });
        return;
      }
      case 'mkdir': {                                    // tạo thư mục cho tập trong danh sách (từ mẫu tập)
        const name = await createEpisodeDir(this.studio, String(m.code), String(m.name ?? ''));
        if (name) vscode.window.showInformationMessage(`Đã tạo thư mục ${name}.`);
        this.studio.refresh();
        return this.load();
      }
      case 'save': {
        if (!this.grid || !this.spec?.file) return;
        const file = this.spec.file;
        const now = fs.readFileSync(file, 'utf8');
        if (now !== this.grid.original) {
          const ok = await vscode.window.showWarningMessage('File đã bị sửa ở chỗ khác từ lúc mở lưới. Ghi đè bảng bằng bản trong lưới?', { modal: true }, 'Ghi đè bảng', 'Tải lại lưới');
          if (ok === 'Tải lại lưới') return this.load();
          if (ok !== 'Ghi đè bảng') return;
          // giữ phần chữ mới ngoài bảng: đọc lại bảng từ file mới rồi mới ghi
          const fresh = readGrid(now, this.spec.codeColumn, this.spec.codeRe);
          if (!fresh) return;
          this.grid = fresh;
        }
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
        if (doc?.isDirty) return void vscode.window.showWarningMessage('File đang mở có thay đổi chưa lưu — lưu hoặc bỏ trước.');
        const rows: GridRow[] = (m.rows as GridRow[]).map((r) => ({ line: Number(r.line), cells: r.cells.map(String) }));
        const ci = columnIndex({ line: 0, headers: this.grid.headers, rows: [] }, this.spec.codeColumn);
        const codes = rows.map((r) => r.cells[ci]?.replace(/[*~]/g, '').trim());
        const dup = codes.find((c, i) => c && codes.indexOf(c) !== i);
        if (dup) return void vscode.window.showErrorMessage(`Mã ${dup} bị trùng trong bảng.`);
        // dòng AI đề xuất chưa có mã (vd. "MỚI") → cấp mã kế tiếp
        for (const r of rows) {
          const c = r.cells[ci]?.replace(/[*~]/g, '').trim() ?? '';
          if (this.spec.codeRe.test(c)) continue;
          const nc = this.spec.newCode(rows.map((x) => x.cells[ci]?.replace(/[*~]/g, '').trim() ?? ''));
          if (nc) r.cells[ci] = `**${nc}**`;
        }
        this.spec.beforeSave?.(this.grid.headers, rows);
        fs.writeFileSync(file, writeGrid(this.grid, rows), 'utf8');
        vscode.window.showInformationMessage(`Đã lưu ${this.seg ? 'bảng cảnh ' + this.seg : 'danh sách tập'} (${rows.length} dòng). Xem bằng git diff.`);
        this.studio.refresh();
        return this.load();
      }
    }
  }
}

/** File danh sách tập trống — đúng các cột trong cấu hình */
function emptyEpisodeList(L: EpisodeListConfig): string {
  const cols = [L.codeColumn, L.releaseColumn, L.nameColumn, ...(L.summaryColumn ? [L.summaryColumn] : []), L.statusColumn];
  return `# Danh sách tập

> Sửa trong tool (▦ Danh sách tập). Mã ${L.codeColumn} cấp một lần, không đổi; cột ${L.releaseColumn} tool tự đánh theo thứ tự dòng.

| ${cols.join(' | ')} |
|${cols.map(() => '---').join('|')}|
`;
}

/** Tạo thư mục tập từ mẫu (không chép phân đoạn mẫu — phân đoạn tạo bằng "Thêm phân đoạn" để được cấp mã). Trả tên thư mục. */
export async function createEpisodeDir(studio: Studio, code: string, title: string): Promise<string | undefined> {
  const p = studio.model!.config.project;
  const m = /^EP(\d+)$/.exec(code);
  if (!m) return void vscode.window.showErrorMessage(`Mã tập không hợp lệ: ${code}`);
  if (studio.model!.episodes.some((e) => e.id === code)) return void vscode.window.showErrorMessage(`${code} đã có thư mục.`);
  const fmt = p.episode.dirFormat ?? 'EP{nn}_{slug}';
  // thư mục chỉ mang mã (EP{nn}) thì không hỏi tên
  const slug = fmt.includes('{slug}') ? await vscode.window.showInputBox({ prompt: `Tên thư mục của ${code} — không dấu, nối gạch`, value: slugify(title) || 'Ten-Tap' }) : '';
  if (slug === undefined || (fmt.includes('{slug}') && !slug)) return undefined;
  const name = fmt.replace('{nn}', m[1]).replace('{slug}', slug);
  const dst = path.join(studio.root!, p.paths.episodes, name);
  if (fs.existsSync(dst)) return void vscode.window.showErrorMessage(`${name} đã có.`);
  if (p.episode.template && studio.exists(p.episode.template)) copyDir(studio.abs(p.episode.template), dst, (r) => r.startsWith(p.segment.dir + '/'), (n) => n, (t) => t);
  fs.mkdirSync(path.join(dst, p.segment.dir), { recursive: true });
  const lp = ledgerPath(studio.model!);
  const ledger = loadLedger(lp);
  reserveEpisode(ledger, code);
  saveLedger(lp, ledger);
  return name;
}

const WIDTH_KEY = 'aiFilmStudio.gridWidths';
/** độ rộng mặc định (px) — cột ngắn hẹp, cột chữ dài rộng; người kéo đổi được */
const DEFAULT_WIDTHS: Record<string, number> = { Mã: 70, Frame: 96, Giây: 56, Hình: 460, Cỡ: 150, Góc: 150, Máy: 170, Cách: 160, 'Video tham chiếu': 150, 'Trạng thái': 130 };

export const GRID_BODY = `
<div class="row" style="justify-content:space-between"><h1 id="gTitle">Bảng cảnh</h1>
<div class="row"><button id="gSave">Lưu</button><button class="sec" id="gReload">Tải lại</button><button class="link" id="gOpen">mở file</button></div></div>
<p class="muted">Sửa thẳng trong ô · <b>kéo mép phải tiêu đề cột</b> để đổi độ rộng (nhớ cho lần sau; bấm đúp mép = về mặc định) · ▲▼ đổi thứ tự <span class="noun">chiếu</span> · <b>+</b> thêm <span class="noun">cảnh</span> mới ngay dưới (tool cấp mã kế tiếp chưa dùng) · <b>bỏ</b> đánh dấu trạng thái bỏ (không xóa dòng — mã đã cấp không dùng lại)<span id="relHelp"></span>.
<span id="sum"></span> <span id="gDirty" class="err"></span></p>
<div id="gErr"></div>
<style>
#grid { table-layout: fixed; border-collapse: collapse; }
#grid th { position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#grid td input, #grid td textarea, #grid td select { width: 100%; box-sizing: border-box; }
#grid .rz { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
#grid .rz:hover, #grid .rz.on { background: var(--vscode-focusBorder); }
</style>
<div class="scroll-x"><table id="grid"></table></div>
<div id="lists"></div>
`;

/** Mã chạy trong webview. embedded = lưới nằm trong tab phân đoạn: tin gửi đi gắn __grid, gọi window.gridReload() khi lưới hiện. */
export function gridClientJs(embedded: boolean): string {
  return `(function () {
const post = (m) => vscode.postMessage(${embedded ? "Object.assign({ __grid: true }, m)" : 'm'});
window.gridReload = () => post({ type: 'reload' });
window.gridDirty = () => dirty;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let G = null; let rows = []; let dirty = false;
const mark = () => { dirty = true; $('gDirty').textContent = '● chưa lưu'; sum(); };
const isDropped = (r) => G.statusIndex >= 0 && String(r.cells[G.statusIndex] || '').includes(G.dropSymbol);
const codeOf = (r) => String(r.cells[G.codeIndex] || '').replace(/[*~]/g, '').trim();
function sum() {
  if (!G) return;
  if (G.secondsIndex < 0) { $('sum').textContent = '· ' + rows.filter((r) => !isDropped(r)).length + ' ' + G.noun; return; }
  let s = 0, n = 0;
  for (const r of rows) { const v = parseFloat(String(r.cells[G.secondsIndex]).replace(',', '.')); if (!isNaN(v) && !String(r.cells[G.statusIndex] || '').includes(G.dropSymbol)) { s += v; n++; } }
  $('sum').textContent = '· ' + n + ' cảnh, ' + Math.floor(s / 60) + '′' + String(Math.round(s % 60)).padStart(2, '0') + '″';
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'error') { $('gErr').innerHTML = '<p class="err">' + esc(m.text) + '</p>'; }
  if (m.type === 'grid') { G = m;
    document.querySelectorAll('.noun').forEach((x, i) => (x.textContent = i === 0 ? (m.noun === 'tập' ? 'phát hành' : 'chiếu') : m.noun));
    $('relHelp').innerHTML = m.release ? ' · cột <b>' + esc(m.headers[m.release.index] || '') + '</b> tool tự đánh theo thứ tự dòng, bỏ qua tập ' + m.release.skip.map(esc).join(' ') + ' · <b>⤴</b> gộp vào tập phát hành dòng trên (1 TAP nhiều EP), <b>⤵</b> tách ra · <b>📁</b> tạo thư mục cho tập chưa có' : ''; rows = m.rows.map((r) => ({ line: r.line, cells: r.cells.slice() })); dirty = false; $('gDirty').textContent = ''; $('gTitle').textContent = m.title; render(); }
  if (m.type === 'newCode') {
    const cells = G.headers.map(() => '');
    cells[G.codeIndex] = G.plainCode ? m.code : '**' + m.code + '**';
    if (G.statusIndex >= 0) cells[G.statusIndex] = '⬜';
    rows.splice(m.after + 1, 0, { line: -1, cells });
    mark(); render();
  }
});
// số phát hành: đánh lại theo thứ tự dòng, bỏ qua dòng bỏ / chờ — khớp numberReleases() ở core/episodeList.ts
function renumber() {
  const R = G.release; if (!R || R.index < 0) return;
  let n = 0, last = '';
  for (const r of rows) {
    const st = String(r.cells[G.statusIndex] || '');
    const off = /~~/.test(r.cells[G.codeIndex]) || R.skip.some((x) => st.includes(x)) || !/^EP\\d{2,}$/.test(codeOf(r));
    const merge = String(r.cells[R.index] || '').trim().startsWith('↑');
    if (off) r.cells[R.index] = '—';
    else if (R.fixed[codeOf(r)]) r.cells[R.index] = R.fixed[codeOf(r)];
    else if (merge && last) r.cells[R.index] = '↑ ' + last;
    else r.cells[R.index] = last = R.prefix + String(++n).padStart(2, '0');
  }
}
function render() {
  renumber();
  $('lists').innerHTML = Object.entries(G.lists).map(([i, vals]) => '<datalist id="dl' + i + '">' + vals.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>').join('');
  const W = (h) => G.widths[h] || 140;
  $('grid').style.width = (92 + G.headers.reduce((a, h) => a + W(h), 0)) + 'px';
  $('grid').innerHTML = '<colgroup><col style="width:92px">' + G.headers.map((h) => '<col style="width:' + W(h) + 'px">').join('') + '</colgroup>'
    + '<tr><th></th>' + G.headers.map((h, i) => '<th title="' + esc(h) + '">' + esc(h) + '<div class="rz" data-rz="' + i + '"></div></th>').join('') + '</tr>' + rows.map((r, ri) => {
    const dropped = G.statusIndex >= 0 && String(r.cells[G.statusIndex]).includes(G.dropSymbol);
    return '<tr' + (dropped ? ' style="opacity:.5"' : '') + '><td style="white-space:nowrap">'
      + '<button class="link" data-a="up" data-r="' + ri + '">▲</button><button class="link" data-a="down" data-r="' + ri + '">▼</button>'
      + '<button class="link" data-a="add" data-r="' + ri + '" title="thêm dòng mới dưới dòng này (tool cấp mã)">+</button>'
      + (G.statusIndex >= 0 ? '<button class="link" data-a="drop" data-r="' + ri + '">' + (dropped ? 'khôi phục' : 'bỏ') + '</button>' : '')
      + (G.release && ri > 0 ? '<button class="link" data-a="merge" data-r="' + ri + '" title="' + (String(r.cells[G.release.index]).startsWith('↑') ? 'tách ra thành tập phát hành riêng' : 'gộp vào tập phát hành ở dòng trên (1 TAP gồm nhiều EP)') + '">' + (String(r.cells[G.release.index]).startsWith('↑') ? '⤵' : '⤴') + '</button>' : '')
      + (G.haveDir && !dropped && r.line >= 0 && /^EP\\d{2,}$/.test(codeOf(r)) && !G.haveDir.includes(codeOf(r)) ? '<button class="link" data-a="mkdir" data-r="' + ri + '" title="tạo thư mục tập từ mẫu">📁</button>' : '') + '</td>'
      + r.cells.map((c, ci) => {
        const rel = G.release && ci === G.release.index;
        const ro = (ci === G.codeIndex && r.line >= 0) || rel;
        const attrs = ' data-r="' + ri + '" data-c="' + ci + '"';
        if (ci === G.wideIndex) return '<td><textarea' + attrs + ' style="min-height:56px">' + esc(c) + '</textarea></td>';
        if (ci === G.statusIndex && G.statusChoices.length && !dropped) {
          const cur = G.statusChoices.find((o) => String(c).trim().startsWith(o.value));
          return '<td><select' + attrs + ' title="' + esc(c) + '">' + (cur ? '' : '<option value="' + esc(c) + '" selected>' + esc(c || '—') + '</option>')
            + G.statusChoices.map((o) => '<option value="' + esc(o.value) + '"' + (cur === o ? ' selected' : '') + '>' + esc(o.value + ' ' + o.label) + '</option>').join('') + '</select></td>';
        }
        return '<td><input' + attrs + ' value="' + esc(c) + '"' + (ro ? ' readonly title="' + (rel ? 'tool tự đánh theo thứ tự dòng' : 'mã đã cấp không đổi') + '"' : '') + (G.lists[ci] ? ' list="dl' + ci + '"' : '') + '></td>';
      }).join('') + '</tr>';
  }).join('');
  sum();
}
function edit(e) {
  const t = e.target; if (t.dataset.r === undefined || t.dataset.c === undefined) return;
  rows[+t.dataset.r].cells[+t.dataset.c] = t.value; mark();
}
document.addEventListener('input', edit);
document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') edit(e); });
// kéo đổi độ rộng cột
let RZ = null;
document.addEventListener('mousedown', (e) => {
  const h = e.target.closest('[data-rz]'); if (!h) return;
  const i = +h.dataset.rz, col = $('grid').querySelectorAll('col')[i + 1];
  RZ = { i, col, x0: e.clientX, w0: parseFloat(col.style.width), h }; h.classList.add('on'); e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!RZ) return;
  const w = Math.max(40, Math.round(RZ.w0 + e.clientX - RZ.x0)), name = G.headers[RZ.i];
  $('grid').style.width = (parseFloat($('grid').style.width) + w - parseFloat(RZ.col.style.width)) + 'px';
  RZ.col.style.width = w + 'px'; G.widths[name] = w;
});
document.addEventListener('mouseup', () => {
  if (!RZ) return; RZ.h.classList.remove('on');
  post({ type: 'widths', widths: { [G.headers[RZ.i]]: G.widths[G.headers[RZ.i]] } }); RZ = null;
});
document.addEventListener('dblclick', (e) => {
  const h = e.target.closest('[data-rz]'); if (!h) return;
  const name = G.headers[+h.dataset.rz]; G.widths[name] = (G.defaults || {})[name] || 140;
  post({ type: 'widths', widths: { [name]: G.widths[name] } }); render();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (b) {
    const i = +b.dataset.r;
    if (b.dataset.a === 'up' && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; mark(); render(); }
    if (b.dataset.a === 'down' && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; mark(); render(); }
    if (b.dataset.a === 'add') post({ type: 'newCode', after: i, afterCode: codeOf(rows[i]), taken: rows.map(codeOf) });
    if (b.dataset.a === 'merge') { const c = String(rows[i].cells[G.release.index] || ''); rows[i].cells[G.release.index] = c.startsWith('↑') ? '' : '↑'; mark(); render(); }
    if (b.dataset.a === 'mkdir') { if (dirty) { $('gDirty').textContent = '● lưu bảng trước khi tạo thư mục'; return; } post({ type: 'mkdir', code: codeOf(rows[i]), name: rows[i].cells[G.headers.findIndex((h) => /tên/i.test(h))] || '' }); }
    if (b.dataset.a === 'drop') {
      const c = String(rows[i].cells[G.statusIndex] || '');
      rows[i].cells[G.statusIndex] = c.includes(G.dropSymbol) ? c.replace(G.dropSymbol, '⬜').trim() : (G.dropSymbol + ' ' + c.replace(/^[⬜✍👀✅⏸]\\s*/u, '')).trim();
      mark(); render();
    }
  }
  if (e.target.id === 'gSave') post({ type: 'save', rows });
  if (e.target.id === 'gReload') { if (!dirty || confirmReload()) post({ type: 'reload' }); }
  if (e.target.id === 'gOpen') post({ type: 'open' });
});
function confirmReload() { $('gDirty').textContent = '● bỏ thay đổi chưa lưu — bấm Tải lại lần nữa'; if (window._rl) return true; window._rl = true; setTimeout(() => (window._rl = false), 3000); return false; }
${embedded ? '' : "post({ type: 'ready' });"}
})();
`;
}

