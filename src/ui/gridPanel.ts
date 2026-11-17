// Tab sửa bảng dạng lưới — bảng cảnh <X>_canh.md và danh sách tập: sửa ô, đổi thứ tự, thêm dòng (cấp mã), đánh dấu bỏ.
// Chỉ ghi lại khối dòng của bảng — phần chữ khác trong file giữ nguyên. Bảng cảnh không bao giờ xóa dòng; danh sách tập xóa được dòng ❌ bỏ
// (🗑 trong lưới, hoặc Chia tập) — mã EP đã cấp vẫn nằm trong sổ mã, không dùng lại.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ledgerPath, loadLedger, nextSceneCode, reserveEpisode, reserveScene, saveLedger } from '../core/codes';
import { EPISODE_CODE_RE, EpisodeListConfig, nextEpisodeCode, numberReleases, slugify } from '../core/episodeList';
import { copyDir } from './commands';
import { columnIndex, stripMd } from '../core/markdown';
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
  /** bảng lời <X>_loi.md đi kèm lưới cảnh — cột "Lời / thoại" (17/11/2026) */
  private lines?: { file: string; grid: Grid };

  constructor(
    private studio: Studio,
    private post: (m: any) => void,
    private ep: string | undefined,
    private seg: string | undefined,
    /** lines = bảng lời <X>_loi.md của phân đoạn (bước ⑦) */
    private kind: 'scenes' | 'lines' | 'episodes' | 'tik' = 'scenes',
  ) {}

  private makeSpec(): GridSpec | string {
    const model = this.studio.model!;
    const p = model.config.project;
    if (this.kind === 'tik') {
      // ⑪ Tik (D-36): bảng tik của tập — EPISODES/<tập>/tik.md, mã TIK1…TIK9
      const ep = findEpisode(model, this.ep);
      if (!ep) return 'Chưa chọn tập.';
      const T = tikSpec(model.config.project);
      const file = path.join(ep.dir, T.file);
      if (!fs.existsSync(file)) fs.writeFileSync(file, emptyTikTable(ep.id, T), 'utf8');
      return {
        file,
        title: `Tik ${ep.id} — ${this.studio.rel(file)}`,
        codeColumn: T.codeColumn,
        codeRe: TIK_CODE_RE,
        nameColumn: T.nameColumn,
        secondsColumn: T.secondsColumn,
        statusColumn: T.statusColumn,
        statusChoices: T.statusChoices,
        columnWidths: T.columnWidths,
        noun: 'tik',
        newCode: (taken) => {
          const used = taken.map((c) => /^TIK(\d+)$/.exec(c.replace(/[*`~]/g, '').trim())?.[1]).filter(Boolean).map(Number);
          const n = (used.length ? Math.max(...used) : 0) + 1;
          return n <= 9 ? `TIK${n}` : undefined;
        },
      };
    }
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
    this.lines = undefined;
    let linesVm: any;
    if (this.kind === 'scenes' && this.seg) {
      const lf = findSegment(findEpisode(this.studio.model, this.ep), this.seg)?.files['loi'];
      const L = p.linesTable ?? { codeColumn: 'Mã', nameColumn: 'Lời', statusColumn: 'Trạng thái' };
      const lg = lf && fs.existsSync(lf) ? readGrid(fs.readFileSync(lf, 'utf8'), L.codeColumn, new RegExp(`^${p.codes.line}$`)) : undefined;
      if (lf && lg) {
        this.lines = { file: lf, grid: lg };
        const li = (n: string) => lg.headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
        linesVm = {
          file: this.studio.rel(lf),
          headers: lg.headers,
          codeIndex: lg.codeIndex,
          oldIndex: li('Mã cũ'),
          typeIndex: li('Loại'),
          speakerIndex: li('Người nói'),
          textIndex: li(L.nameColumn ?? 'Lời'),
          noteIndex: li('Ghi chú'),
          statusIndex: li(L.statusColumn ?? 'Trạng thái'),
          rows: lg.rows,
        };
      }
    }
    this.post({
      type: 'grid',
      title: spec.title,
      file: spec.file,
      noun: spec.noun,
      plainCode: spec.noun === 'câu' || spec.noun === 'tik',
      headers,
      codeIndex: this.grid.codeIndex,
      wideIndex: col(spec.nameColumn),
      secondsIndex: col(spec.secondsColumn),
      statusIndex: si,
      release: spec.release && { index: col(spec.release.column), prefix: spec.release.prefix, skip: spec.release.skip, fixed: spec.release.fixed },
      haveDir: spec.haveDir,
      // lịch phát hành (cột chỉ đọc cuối lưới tập): TAP firstEpisode ra ngày firstDate, mỗi tập cách everyDays
      schedule: spec.noun === 'tập' ? p.release : undefined,
      dropSymbol: p.status.dropped?.[0] ?? '❌',
      doneSymbol: p.status.done?.[0] ?? '✅',
      todoSymbol: p.status.todo?.[0] ?? '⬜',
      seg: this.kind === 'scenes' ? this.seg : undefined,
      // cột ẩn ở lưới cảnh (giữ nguyên trong file khi lưu) — sceneTable.gridHide
      hide: this.kind === 'scenes' && this.seg ? (p.sceneTable.gridHide ?? []).map((n) => col(n)).filter((i) => i >= 0) : [],
      statusChoices: spec.statusChoices,
      widths: { ...defaults, ...this.studio.context.globalState.get<Record<string, number>>(WIDTH_KEY, {}) },
      defaults,
      lists,
      rows: this.grid.rows,
      lines: linesVm,
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
        if (this.spec.noun === 'tập') {                    // tập xóa bằng 🗑: mã vẫn ghi trong sổ → không cấp lại
          const lp = ledgerPath(this.studio.model!);
          const ledger = loadLedger(lp);
          for (const r of this.grid.rows) {
            const c = r.cells[ci]?.replace(/[*~]/g, '').trim() ?? '';
            if (EPISODE_CODE_RE.test(c)) reserveEpisode(ledger, c);
          }
          saveLedger(lp, ledger);
        }
        // lời của cảnh (cột "Lời / thoại") → ghi về <X>_loi.md, xếp theo thứ tự cảnh
        let linesMsg = '';
        if (this.lines && Array.isArray(m.lines) && m.linesDirty) {
          const lf = this.lines.file;
          const lnow = fs.readFileSync(lf, 'utf8');
          if (lnow !== this.lines.grid.original) {
            const ok = await vscode.window.showWarningMessage(`${path.basename(lf)} đã bị sửa ở chỗ khác từ lúc mở lưới. Ghi đè lời bằng bản trong lưới?`, { modal: true }, 'Ghi đè lời', 'Tải lại lưới');
            if (ok === 'Tải lại lưới') return this.load();
            if (ok !== 'Ghi đè lời') return;
            const L = this.studio.model!.config.project.linesTable ?? { codeColumn: 'Mã' };
            const fresh = readGrid(lnow, L.codeColumn, new RegExp(`^${this.studio.model!.config.project.codes.line}$`));
            if (!fresh) return;
            this.lines.grid = fresh;
          }
          const lrows: GridRow[] = (m.lines as GridRow[]).map((r) => ({ line: Number(r.line), cells: r.cells.map(String) }));
          const lcodes = lrows.map((r) => stripMd(r.cells[this.lines!.grid.codeIndex] ?? '').replace(/~/g, '').trim());
          const ldup = lcodes.find((c, i) => c && lcodes.indexOf(c) !== i);
          if (ldup) return void vscode.window.showErrorMessage(`Mã câu ${ldup} bị trùng trong ${path.basename(lf)}.`);
          const order = rows.map((r) => r.cells[ci]?.replace(/[*~]/g, '').trim() ?? '');
          fs.writeFileSync(lf, writeGrid(this.lines.grid, sortLinesByScenes(lrows, this.lines.grid.codeIndex, order)), 'utf8');
          linesMsg = ` + lời ${path.basename(lf)}`;
        }
        fs.writeFileSync(file, writeGrid(this.grid, rows), 'utf8');
        vscode.window.showInformationMessage(`Đã lưu ${this.seg ? 'bảng cảnh ' + this.seg : 'danh sách tập'} (${rows.length} dòng)${linesMsg}. Xem bằng git diff.`);
        this.studio.refresh();
        return this.load();
      }
    }
  }
}

/** Xếp câu lời theo thứ tự cảnh trong bảng cảnh (thứ tự dòng của <X>_loi.md = thứ tự phim). Trong một cảnh giữ thứ tự cũ;
 *  câu mang mã cảnh không có trong bảng (vd. <X>00_L…) đi liền sau câu đứng trước nó. */
export function sortLinesByScenes(rows: GridRow[], codeIndex: number, sceneOrder: string[]): GridRow[] {
  let last = -1;
  const keyed = rows.map((r, i) => {
    const sc = /^([A-Z]\d{2})_L/.exec(stripMd(r.cells[codeIndex] ?? '').replace(/~/g, '').trim())?.[1] ?? '';
    const k = sceneOrder.indexOf(sc);
    if (k >= 0) last = k;
    return { r, i, k: k >= 0 ? k : last };
  });
  return keyed.sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r);
}

/** Sau khi Nhận bản "Chia tập" của AI: xóa dòng ❌ bỏ, cấp mã cho dòng MỚI, đánh lại số phát hành. Mã bị xóa vẫn giữ trong sổ mã. */
export function finalizeEpisodeList(studio: Studio): { removed: string[]; added: string[] } | undefined {
  const model = studio.model;
  const L = model?.config.project.episodeList;
  if (!model || !L || !studio.exists(L.file)) return undefined;
  const file = studio.abs(L.file);
  const g = readGrid(fs.readFileSync(file, 'utf8'), L.codeColumn, /^(EP\d{2,}|MỚI|MOI|NEW)$/i);
  if (!g) return undefined;
  const si = columnIndex({ line: 0, headers: g.headers, rows: [] }, L.statusColumn);
  const drop = model.config.project.status.dropped?.[0] ?? '❌';
  const code = (r: GridRow) => stripMd(r.cells[g.codeIndex] ?? '').replace(/~/g, '').trim();
  const lp = ledgerPath(model);
  const ledger = loadLedger(lp);
  const removed: string[] = [];
  const added: string[] = [];
  const rows: GridRow[] = [];
  for (const r of g.rows) {
    const c = code(r);
    if (EPISODE_CODE_RE.test(c)) reserveEpisode(ledger, c);
    if (si >= 0 && (r.cells[si] ?? '').includes(drop)) removed.push(c);
    else rows.push({ line: r.line, cells: r.cells.slice() });
  }
  for (const r of rows) {
    if (EPISODE_CODE_RE.test(code(r))) continue;
    const c = nextEpisodeCode([...Object.keys(ledger.episodes), ...model.episodes.map((e) => e.id), ...model.episodeList.map((x) => x.code), ...rows.map(code)]);
    reserveEpisode(ledger, c);
    r.cells[g.codeIndex] = `**${c}**`;
    added.push(c);
  }
  saveLedger(lp, ledger);
  numberReleases(g.headers, rows, L);
  fs.writeFileSync(file, writeGrid(g, rows), 'utf8');
  return { removed, added };
}

/** Sau khi Nhận bản AI của ⑥ / ⑦: tool cấp mã cho dòng mới — AI không tự đánh mã (Trường 30/10/2026).
 *  scenes: ô Mã không phải mã cảnh (vd. "MỚI") → mã cảnh kế tiếp chưa dùng theo sổ mã (mã đã bỏ không dùng lại).
 *  lines: ô Mã "<cảnh>_L?" / "<cảnh>_LMỚI" / "<cảnh>_L" → số câu kế tiếp của cảnh đó. Trả danh sách mã vừa cấp. */
/** Mã tik: TIK1…TIK9 (có thể bọc `…` hoặc **…**) */
export const TIK_CODE_RE = /^[`*]*TIK\d[`*]*$/;

export function tikSpec(p: any) {
  const T = p.tikTable ?? {};
  return {
    file: T.file ?? 'tik.md',
    codeColumn: T.codeColumn ?? 'Mã',
    nameColumn: T.nameColumn ?? 'Tên phần',
    secondsColumn: T.secondsColumn ?? '~Giây',
    statusColumn: T.statusColumn ?? 'Trạng thái',
    statusChoices: T.statusChoices ?? [{ value: '✅', label: 'Duyệt' }, { value: '⬜', label: 'Chưa duyệt' }, { value: '❌', label: 'Bỏ' }],
    columnWidths: T.columnWidths ?? { Mã: 64, 'Phân đoạn': 90, 'Cảnh': 120, '~Giây': 64, 'Tên phần': 240, 'Ghi chú': 420, 'Trạng thái': 120 },
  };
}

function emptyTikTable(ep: string, T: ReturnType<typeof tikSpec>): string {
  return `# Tik — ${ep} · đoạn cắt cho TikTok / Facebook / Shorts *(D-36)*\n\n`
    + `> Cắt từ bản dựng của tập, theo ranh giới phân đoạn (1 tik = 1–2 phân đoạn), giữ 16:9. Giây = ước tính, chốt sau khi dựng.\n\n`
    + `| ${T.codeColumn} | Phân đoạn | Cảnh | ${T.secondsColumn} | ${T.nameColumn} | Ghi chú | ${T.statusColumn} |\n|---|---|---|---|---|---|---|\n`
    + `| TIK1 |  |  |  |  |  | ⬜ |\n`;
}

export function finalizeCodes(studio: Studio, ep: string, seg: string, kind: 'scenes' | 'lines'): string[] {
  const model = studio.model;
  const s = model && findSegment(findEpisode(model, ep), seg);
  const file = s?.files[kind === 'scenes' ? 'canh' : 'loi'];
  if (!model || !file || !fs.existsSync(file)) return [];
  const p = model.config.project;
  const codeCol = kind === 'scenes' ? p.sceneTable.codeColumn : p.linesTable?.codeColumn ?? 'Mã';
  // chỉ nhận bảng có dòng mang mã cảnh / mã câu / MỚI — tránh nhầm bảng chú thích mã đứng trước (cột "Mã — nghĩa")
  const sceneSrc = p.codes.scene.replace(/^\^|\$$/g, '');
  const pick = kind === 'scenes' ? new RegExp(`^(?:${sceneSrc}|MỚI|MOI|NEW)$`, 'i') : /^[A-Z]\d{2}_L/;
  const g = readGrid(fs.readFileSync(file, 'utf8'), codeCol, pick);
  if (!g) return [];
  const code = (r: GridRow) => stripMd(r.cells[g.codeIndex] ?? '').replace(/~/g, '').trim();
  const added: string[] = [];
  const rows = g.rows.map((r) => ({ line: r.line, cells: r.cells.slice() }));
  if (kind === 'scenes') {
    const re = new RegExp(`^${p.codes.scene}$`);
    const lp = ledgerPath(model);
    const ledger = loadLedger(lp);
    for (const r of rows) if (re.test(code(r))) reserveScene(ledger, ep, code(r));
    for (const r of rows) {
      if (re.test(code(r)) || !/^(MỚI|MOI|NEW|\?|\+)?$/i.test(code(r)) && code(r) !== '') continue;
      if (!r.cells.some((c, i) => i !== g.codeIndex && c.trim())) continue;     // dòng trống
      const c = nextSceneCode(ledger, ep, seg);
      if (!c) break;
      reserveScene(ledger, ep, c);
      r.cells[g.codeIndex] = `**${c}**`;
      added.push(c);
    }
    saveLedger(lp, ledger);
  } else {
    const max = new Map<string, number>();
    for (const r of rows) {
      const m = /^([A-Z]\d{2})_L(\d+)$/.exec(code(r));
      if (m) max.set(m[1], Math.max(max.get(m[1]) ?? 0, Number(m[2])));
    }
    for (const r of rows) {
      const m = /^([A-Z]\d{2})_L(\?|MỚI|MOI|\+)?$/i.exec(code(r));
      if (!m) continue;
      const n = (max.get(m[1]) ?? 0) + 1;
      max.set(m[1], n);
      r.cells[g.codeIndex] = r.cells[g.codeIndex].replace(/[A-Z]\d{2}_L\S*/, `${m[1]}_L${n}`);
      added.push(`${m[1]}_L${n}`);
    }
  }
  if (added.length) fs.writeFileSync(file, writeGrid(g, rows), 'utf8');
  return added;
}

/** File danh sách tập trống — đúng các cột trong cấu hình */
function emptyEpisodeList(L: EpisodeListConfig): string {
  const cols = [L.codeColumn, L.releaseColumn, L.nameColumn, ...(L.summaryColumn ? [L.summaryColumn] : []), L.statusColumn];
  return `# Danh sách tập

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
const DEFAULT_WIDTHS: Record<string, number> = { 'Lời / thoại': 380, Mã: 70, Frame: 96, Giây: 56, Hình: 460, Cỡ: 150, Góc: 150, Máy: 170, Cách: 160, 'Video tham chiếu': 150, 'Trạng thái': 130 };

export const GRID_BODY = `
<div class="row" style="justify-content:space-between"><h1 id="gTitle">Bảng cảnh</h1>
<div class="row"><button class="sec" id="gView" title="👁 xem: ô Hình + lời hiện markdown (đậm, nghiêng…) · ✏ sửa: ô chữ để gõ — ở chế độ xem, bấm vào một ô là sửa ngay ô đó">✏ Sửa</button><button class="sec" id="gLines" hidden title="cột Lời / thoại — lời dẫn + thoại của từng cảnh, đọc / ghi file <X>_loi.md">ẩn lời</button><button id="gSave">Lưu</button><button class="sec" id="gReload">Tải lại</button><button class="link" id="gOpen">mở file</button></div></div>
<p class="muted">Sửa thẳng trong ô · <b>kéo mép phải tiêu đề cột</b> để đổi độ rộng (nhớ cho lần sau; bấm đúp mép = về mặc định) · ▲▼ đổi thứ tự <span class="noun">chiếu</span> · <b>+</b> thêm <span class="noun">cảnh</span> mới ngay dưới (tool cấp mã kế tiếp chưa dùng) · <b>duyệt</b> / <b>xem lại</b> đổi trạng thái ngay ở cột đầu (cột Trạng thái chỉ hiển thị) · <b>bỏ</b> đánh dấu trạng thái bỏ (không xóa dòng — mã đã cấp không dùng lại)<span id="relHelp"></span>.
<span id="sum"></span> <span id="gDirty" class="err"></span></p>
<div id="gErr"></div>
<style>
#grid { table-layout: fixed; border-collapse: collapse; }
#grid th { position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#grid td input, #grid td textarea, #grid td select { width: 100%; box-sizing: border-box; }
#grid .rz { position: absolute; top: 0; right: 0; width: 7px; height: 100%; cursor: col-resize; }
#grid .ln { border-left: 3px solid var(--vscode-textLink-foreground); padding: 2px 0 4px 6px; margin-bottom: 6px; }
#grid .ln.off { border-left-color: var(--vscode-disabledForeground); opacity: .55; }
#grid .ln.dlg { border-left-color: var(--vscode-charts-orange, orange); }
#grid .ln .hd { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 90%; margin-bottom: 2px; }
#grid .ln .hd select { width: auto; }
#grid .ln .hd input { width: 130px; }
#grid .gmd { white-space: pre-wrap; cursor: text; min-height: 1.4em; }
#grid .gmd:hover { outline: 1px dashed var(--vscode-focusBorder); }
#grid td.act { white-space: normal; overflow: hidden; line-height: 1.7; }
#grid td.act .link { margin-right: 4px; }
#grid .rz:hover, #grid .rz.on { background: var(--vscode-focusBorder); }
</style>
<div class="scroll-x"><table id="grid"></table></div>
<div id="lists"></div>
`;

/** Mã chạy trong webview. embedded = lưới nằm trong tab phân đoạn: tin gửi đi gắn __grid, gọi window.gridReload() khi lưới hiện. */
export function gridClientJs(embedded: boolean): string {
  return `(function () {
const post = (m) => vscode.postMessage(${embedded ? "Object.assign({ __grid: true }, m)" : 'm'});
const EMB = ${embedded};
window.gridReload = () => post({ type: 'reload' });
window.gridDirty = () => dirty;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let G = null; let rows = []; let dirty = false;
// cột "Lời / thoại" (17/11/2026): câu của <X>_loi.md ghép theo mã cảnh — LN = cấu hình bảng lời, lrows = các câu, ldirty = lời đã đổi
let LN = null; let lrows = []; let ldirty = false; let SHOWL = true; let DN = [];
// 👁 xem / ✏ sửa (17/11/2026): GV = true → ô Hình + câu lời hiện markdown, bấm đúp = sang sửa
let GV = true;
/** độ rộng cột thao tác (▲▼ + bỏ duyệt …) — 17/11/2026: 92 px làm nút duyệt tràn sang cột Mã */
const AW = 118;
function imd(t) { return esc(t).replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/(^|[^*\\w])\\*([^*\\s][^*]*?)\\*/g, '$1<i>$2</i>').replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>'); }
const gvBtn = () => { $('gView').textContent = GV ? '✏ Sửa' : '👁 Xem'; };
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
    $('relHelp').innerHTML = m.release ? ' · cột <b>' + esc(m.headers[m.release.index] || '') + '</b> tool tự đánh theo thứ tự dòng, bỏ qua tập ' + m.release.skip.map(esc).join(' ') + ' · <b>⤴</b> gộp vào tập phát hành dòng trên (1 TAP nhiều EP), <b>⤵</b> tách ra · <b>📁</b> tạo thư mục cho tập chưa có · <b>🗑</b> xóa hẳn tập ❌ bỏ (mã không dùng lại)' : ''; rows = m.rows.map((r) => ({ line: r.line, cells: r.cells.slice() })); dirty = false;
    LN = m.lines || null; lrows = LN ? LN.rows.map((r) => ({ line: r.line, cells: r.cells.slice() })) : []; ldirty = false;
    $('gLines').hidden = !LN; $('gLines').textContent = SHOWL ? 'ẩn lời' : 'hiện lời'; $('gDirty').textContent = ''; $('gTitle').textContent = m.title; render(); }
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
function dateOf(r) {
  const S = G.schedule, m = S && /(\\d+)/.exec(String(r.cells[G.release.index] || ''));
  if (!m || String(r.cells[G.release.index]).trim().startsWith('↑')) return '';
  const d = new Date(S.firstDate); d.setDate(d.getDate() + (Number(m[1]) - S.firstEpisode) * S.everyDays);
  return d.toLocaleDateString('vi-VN');
}
// ô Hình (textarea) tự cao theo chữ; ô anh kéo cao hơn thì nhớ theo mã cảnh (TH), render lại không mất
const TH = {};
function fit(t) {
  if (!t || t.tagName !== 'TEXTAREA') return;
  t.style.height = 'auto';
  const k = rows[+t.dataset.r] ? codeOf(rows[+t.dataset.r]) : '';
  t.style.height = Math.max(t.dataset.l !== undefined ? 30 : 56, t.scrollHeight + 4, TH[k] || 0) + 'px';
}
function fitAll() { document.querySelectorAll('#grid textarea').forEach(fit); }
// duyệt nhanh ở cột đầu (16/11/2026): lưới có lựa chọn ✅ → cột Trạng thái chỉ hiển thị; 3 trạng thái ⬜ chưa duyệt · ✅ đã duyệt · ❌ bỏ
const AP = () => !!G.seg && G.statusIndex >= 0 && G.statusChoices.some((o) => o.value === G.doneSymbol);
const isDone = (r) => String(r.cells[G.statusIndex] || '').includes(G.doneSymbol);
const LEAD = /^(?:[⬜✍👀✅⏸🧪❌⛔]\uFE0F?\\s*)+/u;
function stLabel(c, dropped) {
  const rest = String(c || '').replace(LEAD, '').trim();
  const b = dropped ? '❌ Bỏ' : String(c || '').includes(G.doneSymbol) ? '<b>✅ Đã duyệt</b>' : '⬜ Chưa duyệt';
  return b + (rest ? ' <span class="muted">' + esc(rest) + '</span>' : '');
}
function setOk(r, ok) { const rest = String(r.cells[G.statusIndex] || '').replace(LEAD, '').trim(); r.cells[G.statusIndex] = ((ok ? G.doneSymbol : G.todoSymbol) + ' ' + rest).trim(); }
// ---- lời của cảnh
const markL = () => { ldirty = true; mark(); };
const lcode = (l) => String(l.cells[LN.codeIndex] || '').replace(/[*~]/g, '').trim();
const lst = (l) => String(l.cells[LN.statusIndex] || '');
const lOff = (l) => /^\\s*[⛔❌]/u.test(lst(l));
const linesOf = (sc) => lrows.map((l, i) => i).filter((i) => lcode(lrows[i]).startsWith(sc + '_L'));
const DROPPED_L = /^\\s*⛔\\s*bỏ(?:\\s+theo\\s+[A-Z]\\d{2})?\\s*·\\s*/u;
function lRestore(l) { const c = lst(l); l.cells[LN.statusIndex] = DROPPED_L.test(c) ? c.replace(DROPPED_L, '') : '⬜ nháp'; }
function lDrop(l, by) { l.cells[LN.statusIndex] = '⛔ bỏ' + (by ? ' theo ' + by : '') + ' · ' + (lst(l).trim() || '⬜ nháp'); }
function nextLine(sc) { return sc + '_L' + (lrows.reduce((a, l) => { const x = new RegExp('^' + sc + '_L(\\\\d+)$').exec(lcode(l)); return x ? Math.max(a, +x[1]) : a; }, 0) + 1); }
// cảnh gần nhất chưa bỏ, về trước (-1) hoặc về sau (+1)
function near(ri, d) { for (let i = ri + d; i >= 0 && i < rows.length; i += d) if (!isDropped(rows[i])) return codeOf(rows[i]); return ''; }
function moveLine(li, to, fwd) {
  const l = lrows[li], old = lcode(l);
  if (DROPPED_L.test(lst(l)) || lOff(l)) lRestore(l);
  if (LN.oldIndex >= 0) { const o = String(l.cells[LN.oldIndex] || '').trim(); l.cells[LN.oldIndex] = old + (o && o !== '—' ? ' · ' + o : ''); }
  l.cells[LN.codeIndex] = nextLine(to);
  lrows.splice(li, 1);
  const at = linesOf(to);
  if (!at.length) lrows.push(l); else if (fwd) lrows.splice(at[0], 0, l); else lrows.splice(at[at.length - 1] + 1, 0, l);
}
function linesCell(r, ri, dropped) {
  const sc = codeOf(r);
  const idx = linesOf(sc);
  const types = ['lời dẫn', 'thoại', 'lặng'];
  const prev = near(ri, -1), next = near(ri, 1);
  return '<td>' + idx.map((li) => {
    const l = lrows[li], off = lOff(l), t = String(l.cells[LN.typeIndex] || '').trim(), st = lst(l);
    const mine = /^\\s*✍/u.test(st);
    const opts = (types.includes(t) ? types : [t].concat(types)).map((x) => '<option' + (x === t ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    let hd = '<span class="muted">' + esc(lcode(l)) + '</span>';
    if (off) hd += ' <span title="' + esc(st) + '">⛔ bỏ</span> <button class="link" data-la="undrop" data-l="' + li + '">khôi phục</button>';
    else {
      if (LN.typeIndex >= 0) hd += '<select data-l="' + li + '" data-lf="type">' + opts + '</select>';
      if (LN.speakerIndex >= 0 && t === 'thoại') hd += '<input data-l="' + li + '" data-lf="speaker" placeholder="người nói" value="' + esc(l.cells[LN.speakerIndex]) + '">';
      hd += '<button class="link" data-la="st" data-l="' + li + '" title="' + esc(st) + '">' + (mine ? '✍ của anh' : '⬜ nháp') + '</button>';
      hd += '<button class="link" data-la="drop" data-l="' + li + '" title="bỏ câu này (⛔)">bỏ</button>';
    }
    if (dropped) hd += (prev ? '<button class="link" data-la="mv" data-l="' + li + '" data-to="' + prev + '" title="chuyển câu sang cảnh trước — câu nhận mã mới, mã cũ ghi ở cột Mã cũ">← ' + prev + '</button>' : '')
      + (next ? '<button class="link" data-la="mv" data-l="' + li + '" data-to="' + next + '" data-fwd="1" title="chuyển câu sang cảnh sau — câu nhận mã mới, mã cũ ghi ở cột Mã cũ">→ ' + next + '</button>' : '');
    const body = off ? '<div style="text-decoration:line-through">' + esc(l.cells[LN.textIndex]) + '</div>'
      : t === 'lặng' ? '<div class="muted">(lặng)</div>'
      : GV ? '<div class="gmd" data-el="' + li + '" title="bấm để sửa">' + imd(l.cells[LN.textIndex]) + '</div>'
      : '<textarea data-l="' + li + '" data-lf="text" style="min-height:30px;overflow:hidden">' + esc(l.cells[LN.textIndex]) + '</textarea>';
    const note = !off && LN.noteIndex >= 0 && String(l.cells[LN.noteIndex] || '').trim() ? '<div class="muted" style="font-size:85%">' + esc(l.cells[LN.noteIndex]) + '</div>' : '';
    return '<div class="ln' + (off ? ' off' : t === 'thoại' ? ' dlg' : '') + '"><div class="hd">' + hd + '</div>' + body + note + '</div>';
  }).join('') + (dropped ? '' : '<button class="link" data-la="add" data-sc="' + esc(sc) + '" title="thêm câu lời dẫn / thoại cho cảnh này (mã ' + esc(sc) + '_L kế tiếp)">+ câu</button>') + '</td>';
}
function render() {
  const sy = window.scrollY, sx = document.querySelector('.scroll-x'), sl = sx ? sx.scrollLeft : 0;
  renumber();
  $('lists').innerHTML = Object.entries(G.lists).map(([i, vals]) => '<datalist id="dl' + i + '">' + vals.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>').join('');
  const W = (h) => G.widths[h] || 140;
  const SW = G.schedule ? 120 : 0;
  // cột hiển thị: các cột của bảng + cột ảo "Lời / thoại" ngay sau cột Hình
  const DC = [];
  G.headers.forEach((h, i) => { if ((G.hide || []).includes(i)) return; DC.push({ name: h, ci: i }); if (LN && SHOWL && i === G.wideIndex) DC.push({ name: 'Lời / thoại', v: true }); });
  DN = DC.map((d) => d.name);
  $('grid').style.width = (AW + SW + DN.reduce((a, h) => a + W(h), 0)) + 'px';
  $('grid').innerHTML = '<colgroup><col style="width:' + AW + 'px">' + DN.map((h) => '<col style="width:' + W(h) + 'px">').join('') + (SW ? '<col style="width:' + SW + 'px">' : '') + '</colgroup>'
    + '<tr><th></th>' + DN.map((h, i) => '<th title="' + esc(DC[i].v ? 'lời dẫn + thoại của cảnh — ' + LN.file : h) + '">' + esc(h) + '<div class="rz" data-rz="' + i + '"></div></th>').join('') + (SW ? '<th>Lịch</th>' : '') + '</tr>' + rows.map((r, ri) => {
    const dropped = G.statusIndex >= 0 && String(r.cells[G.statusIndex]).includes(G.dropSymbol);
    return '<tr' + (dropped ? ' style="opacity:.5"' : '') + '><td class="act">'
      + '<button class="link" data-a="up" data-r="' + ri + '">▲</button><button class="link" data-a="down" data-r="' + ri + '">▼</button>'
      + '<button class="link" data-a="add" data-r="' + ri + '" title="thêm dòng mới dưới dòng này (tool cấp mã)">+</button>'
      + (G.statusIndex >= 0 ? '<button class="link" data-a="drop" data-r="' + ri + '">' + (dropped ? 'khôi phục' : 'bỏ') + '</button>' : '')
      + (AP() && !dropped ? (isDone(r) ? '<button class="link" data-a="ok" data-r="' + ri + '" title="đưa về ⬜ chưa duyệt — AI được viết lại cảnh này">xem lại</button>' : '<button class="link" data-a="ok" data-r="' + ri + '" title="✅ đã duyệt — AI không viết lại cảnh này nữa" style="font-weight:bold">duyệt</button>') : '')
      + (G.release && ri > 0 ? '<button class="link" data-a="merge" data-r="' + ri + '" title="' + (String(r.cells[G.release.index]).startsWith('↑') ? 'tách ra thành tập phát hành riêng' : 'gộp vào tập phát hành ở dòng trên (1 TAP gồm nhiều EP)') + '">' + (String(r.cells[G.release.index]).startsWith('↑') ? '⤵' : '⤴') + '</button>' : '')
      + (G.noun === 'tập' && dropped ? '<button class="link" data-a="del" data-r="' + ri + '" title="xóa hẳn dòng — mã EP không dùng lại">🗑</button>' : '')
      + (G.haveDir && !dropped && r.line >= 0 && /^EP\\d{2,}$/.test(codeOf(r)) && !G.haveDir.includes(codeOf(r)) ? '<button class="link" data-a="mkdir" data-r="' + ri + '" title="tạo thư mục tập từ mẫu">📁</button>' : '') + '</td>'
      + DC.map((d) => {
        if (d.v) return linesCell(r, ri, dropped);
        const ci = d.ci, c = r.cells[ci];
        const rel = G.release && ci === G.release.index;
        const ro = (ci === G.codeIndex && r.line >= 0) || rel;
        const attrs = ' data-r="' + ri + '" data-c="' + ci + '"';
        if (ci === G.wideIndex && GV) return '<td><div class="gmd" data-er="' + ri + '" data-ec="' + ci + '" title="bấm để sửa">' + imd(c) + '</div></td>';
        if (ci === G.wideIndex) return '<td><textarea' + attrs + ' style="min-height:56px;overflow:hidden">' + esc(c) + '</textarea></td>';
        if (ci === G.statusIndex && AP()) return '<td title="' + esc(c) + '" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + stLabel(c, dropped) + '</td>';
        if (ci === G.statusIndex && G.statusChoices.length && (!dropped || G.statusChoices.some((o) => o.value === G.dropSymbol))) {
          const cur = G.statusChoices.find((o) => String(c).trim().startsWith(o.value));
          return '<td><select' + attrs + ' title="' + esc(c) + '">' + (cur ? '' : '<option value="' + esc(c) + '" selected>' + esc(c || '—') + '</option>')
            + G.statusChoices.map((o) => '<option value="' + esc(o.value) + '"' + (cur === o ? ' selected' : '') + '>' + esc(o.value + ' ' + o.label) + '</option>').join('') + '</select></td>';
        }
        return '<td><input' + attrs + ' value="' + esc(c) + '"' + (ro ? ' readonly title="' + (rel ? 'tool tự đánh theo thứ tự dòng' : 'mã đã cấp không đổi') + '"' : '') + (G.lists[ci] ? ' list="dl' + ci + '"' : '') + '></td>';
      }).join('') + (SW ? '<td class="muted" style="white-space:nowrap">' + esc(dateOf(r)) + (EMB && G.haveDir && G.haveDir.includes(codeOf(r)) ? ' <a data-cmd="target" data-arg="' + esc(JSON.stringify({ ep: codeOf(r) })) + '">mở</a>' : '') + '</td>' : '') + '</tr>';
  }).join('');
  sum();
  fitAll();
  if (window.scrollY !== sy) window.scrollTo(window.scrollX, sy); if (sx && sx.scrollLeft !== sl) sx.scrollLeft = sl;
}
function ledit(t) {
  const l = lrows[+t.dataset.l]; if (!l) return false;
  const f = { text: LN.textIndex, type: LN.typeIndex, speaker: LN.speakerIndex }[t.dataset.lf];
  if (f === undefined || f < 0) return false;
  l.cells[f] = t.value; markL(); return true;
}
function edit(e) {
  const t = e.target; if (t.dataset.l !== undefined) { ledit(t); return; }
  if (t.dataset.r === undefined || t.dataset.c === undefined) return;
  rows[+t.dataset.r].cells[+t.dataset.c] = t.value; mark();
}
document.addEventListener('input', (e) => { edit(e); fit(e.target); });
// anh kéo góc ô Hình: cao hơn mức vừa chữ thì nhớ theo mã cảnh
document.addEventListener('mouseup', (e) => {
  const t = e.target; if (!t || t.tagName !== 'TEXTAREA' || !rows[+t.dataset.r]) return;
  const k = codeOf(rows[+t.dataset.r]), h = t.offsetHeight;
  t.style.height = 'auto'; const auto = Math.max(56, t.scrollHeight + 4); t.style.height = h + 'px';
  if (h > auto + 6) TH[k] = h; else delete TH[k];
});
window.addEventListener('resize', fitAll);
document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' && e.target.dataset.l !== undefined) { ledit(e.target); render(); return; }
  if (e.target.tagName === 'SELECT') { edit(e); if (G && e.target.dataset.c !== undefined && +e.target.dataset.c === G.statusIndex) render(); } });
// kéo đổi độ rộng cột
let RZ = null;
document.addEventListener('mousedown', (e) => {
  const h = e.target.closest('[data-rz]'); if (!h) return;
  const i = +h.dataset.rz, col = $('grid').querySelectorAll('col')[i + 1];
  RZ = { i, col, x0: e.clientX, w0: parseFloat(col.style.width), h }; h.classList.add('on'); e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!RZ) return;
  const w = Math.max(40, Math.round(RZ.w0 + e.clientX - RZ.x0)), name = DN[RZ.i];
  $('grid').style.width = (parseFloat($('grid').style.width) + w - parseFloat(RZ.col.style.width)) + 'px';
  RZ.col.style.width = w + 'px'; G.widths[name] = w;
});
document.addEventListener('mouseup', () => {
  if (!RZ) return; RZ.h.classList.remove('on');
  post({ type: 'widths', widths: { [DN[RZ.i]]: G.widths[DN[RZ.i]] } }); RZ = null; fitAll();
});
// 👁 Xem: bấm một ô markdown → đổi riêng ô đó thành ô gõ (17/11/2026 — trước phải bấm đúp / nút ✏ Sửa)
function cellEdit(d) {
  const t = document.createElement('textarea');
  t.className = 'gedit';
  if (d.dataset.el !== undefined) { t.dataset.l = d.dataset.el; t.dataset.lf = 'text'; t.value = lrows[+d.dataset.el].cells[LN.textIndex] || ''; t.style.minHeight = '30px'; }
  else { t.dataset.r = d.dataset.er; t.dataset.c = d.dataset.ec; t.value = rows[+d.dataset.er].cells[+d.dataset.ec] || ''; t.style.minHeight = '56px'; }
  t.style.overflow = 'hidden';
  d.replaceWith(t); fit(t); t.focus();
}
document.addEventListener('focusout', (e) => {
  const t = e.target; if (!GV || !t.classList || !t.classList.contains('gedit')) return;
  const d = document.createElement('div'); d.className = 'gmd'; d.title = 'bấm để sửa';
  if (t.dataset.l !== undefined) d.dataset.el = t.dataset.l; else { d.dataset.er = t.dataset.r; d.dataset.ec = t.dataset.c; }
  d.innerHTML = imd(t.value); t.replaceWith(d);
});
document.addEventListener('dblclick', (e) => {
  const h = e.target.closest('[data-rz]'); if (!h) return;
  const name = DN[+h.dataset.rz]; G.widths[name] = (G.defaults || {})[name] || 140;
  post({ type: 'widths', widths: { [name]: G.widths[name] } }); render();
});
document.addEventListener('click', (e) => {
  const gm = GV && !e.target.closest('a, button') && e.target.closest('#grid .gmd'); if (gm) { cellEdit(gm); return; }
  const la = e.target.closest('[data-la]'); if (la && LN) {
    const li = +la.dataset.l, l = lrows[li];
    if (la.dataset.la === 'add') { const sc = la.dataset.sc, at = linesOf(sc), cells = LN.headers.map(() => '');
      cells[LN.codeIndex] = nextLine(sc); if (LN.oldIndex >= 0) cells[LN.oldIndex] = '—'; if (LN.typeIndex >= 0) cells[LN.typeIndex] = 'lời dẫn'; cells[LN.statusIndex] = '⬜ nháp';
      const nl = { line: -1, cells }; if (at.length) lrows.splice(at[at.length - 1] + 1, 0, nl); else lrows.push(nl); }
    if (la.dataset.la === 'st') { const c = lst(l); l.cells[LN.statusIndex] = /^\\s*✍/u.test(c) ? c.replace(/^\\s*✍\\s*(Trường)?/u, '⬜ nháp') : /^\\s*⬜\\s*(nháp)?/u.test(c) ? c.replace(/^\\s*⬜\\s*(nháp)?/u, '✍ Trường') : ('✍ Trường ' + c).trim(); }
    if (la.dataset.la === 'drop') lDrop(l, '');
    if (la.dataset.la === 'undrop') lRestore(l);
    if (la.dataset.la === 'mv') moveLine(li, la.dataset.to, !!la.dataset.fwd);
    markL(); render(); return;
  }
  const b = e.target.closest('[data-a]'); if (b) {
    const i = +b.dataset.r;
    if (b.dataset.a === 'up' && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; if (LN) ldirty = true; mark(); render(); }
    if (b.dataset.a === 'down' && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; if (LN) ldirty = true; mark(); render(); }
    if (b.dataset.a === 'add') post({ type: 'newCode', after: i, afterCode: codeOf(rows[i]), taken: rows.map(codeOf) });
    if (b.dataset.a === 'del') { rows.splice(i, 1); mark(); render(); }
    if (b.dataset.a === 'merge') { const c = String(rows[i].cells[G.release.index] || ''); rows[i].cells[G.release.index] = c.startsWith('↑') ? '' : '↑'; mark(); render(); }
    if (b.dataset.a === 'mkdir') { if (dirty) { $('gDirty').textContent = '● lưu bảng trước khi tạo thư mục'; return; } post({ type: 'mkdir', code: codeOf(rows[i]), name: rows[i].cells[G.headers.findIndex((h) => /tên/i.test(h))] || '' }); }
    if (b.dataset.a === 'ok') { setOk(rows[i], !isDone(rows[i])); mark(); render(); }
    if (b.dataset.a === 'drop') {
      const c = String(rows[i].cells[G.statusIndex] || '');
      const was = c.includes(G.dropSymbol);
      rows[i].cells[G.statusIndex] = was ? c.replace(G.dropSymbol, '⬜').trim() : (G.dropSymbol + ' ' + c.replace(/^[⬜✍👀✅⏸]\\s*/u, '')).trim();
      // lời theo cảnh: bỏ cảnh → câu của cảnh ⛔ "bỏ theo <cảnh>"; khôi phục cảnh → câu trở lại trạng thái cũ
      if (LN) { const sc = codeOf(rows[i]); for (const li of linesOf(sc)) { const l = lrows[li];
        if (!was && !lOff(l)) { lDrop(l, sc); ldirty = true; }
        if (was && new RegExp('^\\\\s*⛔\\\\s*bỏ\\\\s+theo\\\\s+' + sc + '\\\\b', 'u').test(lst(l))) { lRestore(l); ldirty = true; } } }
      mark(); render();
    }
  }
  if (e.target.id === 'gSave') post({ type: 'save', rows, lines: LN ? lrows : undefined, linesDirty: ldirty });
  if (e.target.id === 'gView') { GV = !GV; gvBtn(); render(); }
  if (e.target.id === 'gLines') { SHOWL = !SHOWL; e.target.textContent = SHOWL ? 'ẩn lời' : 'hiện lời'; render(); }
  if (e.target.id === 'gReload') { if (!dirty || confirmReload()) post({ type: 'reload' }); }
  if (e.target.id === 'gOpen') post({ type: 'open' });
});
function confirmReload() { $('gDirty').textContent = '● bỏ thay đổi chưa lưu — bấm Tải lại lần nữa'; if (window._rl) return true; window._rl = true; setTimeout(() => (window._rl = false), 3000); return false; }
${embedded ? '' : "post({ type: 'ready' });"}
})();
`;
}

