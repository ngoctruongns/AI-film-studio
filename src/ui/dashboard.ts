// Tab Tổng quan: tiến độ các tập, ma trận phân đoạn × bước của tập đang chọn, thời lượng, lịch phát hành, chi phí AI.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { STATUS_LABEL, STATUS_ORDER, StatusKey, statusSymbol } from '../core/config';
import { findSection, formatDuration, parseHeadings } from '../core/markdown';
import { readRuns, summarizeCost } from '../core/runs';
import { Episode, Segment } from '../core/scanner';
import { Studio } from './studio';
import { esc, handleOpen, shell } from './webview';

/** Cột của ma trận phân đoạn: bước → cách tính ô */
const SEG_COLUMNS: { step: string; label: string; file?: string }[] = [
  { step: 'kich-ban', label: '③ Kịch bản' },
  { step: 'chia-canh', label: '④ Cảnh', file: 'canh' },
  { step: 'loi', label: '⑤a Lời', file: 'loi' },
  { step: 'am-thanh', label: '⑤b Âm', file: 'am-thanh' },
  { step: 'dung', label: '⑤c Dựng', file: 'dung' },
  { step: 'prompt', label: '⑤d Prompt', file: 'prompt' },
  { step: 'ket-qua', label: '⑦ Kết quả', file: 'ket-qua' },
];

export class Dashboard {
  static panel?: vscode.WebviewPanel;
  private static selected?: string;

  static show(studio: Studio, openStep: (stepId: string, target: object) => void): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiFilmStudio.dashboard', 'Tổng quan dự án', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    const render = () => (panel.webview.html = this.html(studio, panel.webview));
    const sub = studio.onDidChange(render);
    panel.onDidDispose(() => {
      sub.dispose();
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'open') return handleOpen(m);
      if (m.type === 'cmd' && m.cmd === 'episode') {
        this.selected = m.arg;
        render();
      }
      if (m.type === 'cmd' && m.cmd === 'step') openStep(...(JSON.parse(m.arg) as [string, object]));
      if (m.type === 'cmd' && m.cmd === 'refresh') studio.refresh();
      if (m.type === 'cmd' && m.cmd === 'blender') vscode.commands.executeCommand('aiFilmStudio.openBlender', { ep: m.arg });
      if (m.type === 'cmd' && m.cmd === 'settings') vscode.commands.executeCommand('aiFilmStudio.openSettings');
      if (m.type === 'cmd' && m.cmd === 'endSession') vscode.commands.executeCommand('aiFilmStudio.endSession');
      if (m.type === 'cmd' && m.cmd === 'grid') vscode.commands.executeCommand('aiFilmStudio.editSceneTable', JSON.parse(m.arg));
    });
    render();
  }

  private static html(studio: Studio, webview: vscode.Webview): string {
    const model = studio.model;
    if (!model) return shell(webview, 'Tổng quan', `<h1>AI Film Studio</h1><p class="err">${esc(studio.error ?? 'Chưa nạp dự án')}</p>`);
    const p = model.config.project;
    const st = p.status;
    const cap = p.episodeCapSeconds;
    const now = new Date();
    const live = model.episodes.filter((e) => !e.legacy);
    const sel = model.episodes.find((e) => e.id === this.selected) ?? live[0];

    // ----- tổng
    const allScenes = live.flatMap((e) => e.segments.filter((s) => !s.dropped).flatMap((s) => s.scenes)).filter((c) => c.status !== 'dropped');
    const done = allScenes.filter((c) => c.status === 'done').length;
    // số lần sinh: ưu tiên sổ kết quả (người ghi), không có thì đếm file _V trong thư mục media
    const attempts = (c: (typeof allScenes)[number]) => c.result?.attempts ?? c.media['V'] ?? 0;
    const withV = allScenes.filter((c) => attempts(c) > 0);
    const avgV = withV.length ? withV.reduce((a, c) => a + attempts(c), 0) / withV.length : undefined;
    const chosen = allScenes.filter((c) => c.result?.chosen).length;
    const runs = studio.root ? readRuns(studio.root) : [];
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    const costMonth = summarizeCost(runs, month);
    const costAll = summarizeCost(runs);
    const todo = studio.notes.filter((n) => n.kind === 'todo').length;
    const ask = studio.notes.filter((n) => n.kind === 'question').length;
    const nextRelease = model.episodes.find((e) => e.releaseDate && e.releaseDate >= now);
    const days = nextRelease?.releaseDate ? Math.ceil((+nextRelease.releaseDate - +now) / 864e5) : undefined;

    const tile = (label: string, value: string, sub = '') =>
      `<div class="card" style="min-width:150px"><div class="muted">${label}</div><div style="font-size:1.5em">${value}</div><div class="muted">${sub}</div></div>`;
    const tiles = `<div class="row">
      ${tile('Tập đã vào cấu trúc mới', `${live.length} / ${model.episodes.length}`)}
      ${tile('Cảnh duyệt ✅', `${done} / ${allScenes.length}`, allScenes.length ? `${Math.round((done / allScenes.length) * 100)}%` : '')}
      ${tile('Lần sinh video / cảnh', avgV !== undefined ? avgV.toFixed(1) : '—', `${withV.length} cảnh đã sinh · ${chosen} có bản chốt${model.mediaFound ? '' : ' · không thấy thư mục media'}`)}
      ${tile('Ghi chú', `@C ${todo} · @T ${ask}`, 'xem ở sidebar')}
      ${tile('Tập phát hành kế tiếp', nextRelease ? nextRelease.id : '—', days !== undefined ? `còn ${days} ngày (${nextRelease!.releaseDate!.toLocaleDateString('vi-VN')})` : '')}
      ${tile('Chi phí AI tháng này', `${costMonth.usd.toFixed(2)} USD`, `${costMonth.runs} lần chạy · tổng ${costAll.usd.toFixed(2)} USD`)}
      ${tile('Soát nhất quán', String(studio.issues.length), 'xem ở tab Problems')}
    </div>`;

    // ----- bảng tập
    const statusCells = (e: Episode) => {
      const sc = e.segments.filter((s) => !s.dropped).flatMap((s) => s.scenes);
      const count = (k: StatusKey) => sc.filter((c) => c.status === k).length;
      return STATUS_ORDER.map((k) => `<td style="text-align:center">${count(k) || ''}</td>`).join('');
    };
    const epRows = model.episodes
      .map((e) => {
        const segs = e.segments.filter((s) => !s.dropped);
        const sc = segs.flatMap((s) => s.scenes);
        const over = cap && e.sceneSeconds > cap;
        const late = e.releaseDate && e.releaseDate < now;
        return `<tr ${e === sel ? 'style="outline:2px solid var(--vscode-focusBorder)"' : ''}>
          <td><a data-cmd="episode" data-arg="${e.id}"><b>${e.id}</b></a> <span class="muted">${esc(e.slug.replace(/-/g, ' '))}</span></td>
          <td>${e.legacy ? '<span class="muted">cấu trúc cũ</span>' : `${segs.length}`}</td>
          <td>${e.legacy ? '' : sc.length}</td>
          ${e.legacy ? `<td colspan="${STATUS_ORDER.length}"></td>` : statusCells(e)}
          <td class="${over ? 'err' : ''}">${e.sceneSeconds ? formatDuration(e.sceneSeconds) : ''}${e.plannedSeconds ? ` <span class="muted">/ dự kiến ${formatDuration(e.plannedSeconds)}</span>` : ''}</td>
          <td class="${late ? 'err' : ''}">${e.releaseDate ? e.releaseDate.toLocaleDateString('vi-VN') : ''}</td>
        </tr>`;
      })
      .join('');
    const epTable = `<div class="scroll-x"><table>
      <tr><th>Tập</th><th>Đoạn</th><th>Cảnh</th>${STATUS_ORDER.map((k) => `<th title="${STATUS_LABEL[k]}">${statusSymbol(k, st)}</th>`).join('')}
      <th>Giây cảnh ${cap ? `(trần ${formatDuration(cap)})` : ''}</th><th>Phát hành</th></tr>${epRows}</table></div>`;

    return shell(
      webview,
      'Tổng quan',
      `<div class="row" style="justify-content:space-between"><h1>${esc(p.name)}</h1>
        <span class="muted">quét lúc ${model.scannedAt.toLocaleTimeString('vi-VN')} <button class="link" data-cmd="refresh">quét lại</button>
        <button class="link" data-cmd="settings">cài đặt AI</button><button class="link" data-cmd="endSession">kết thúc phiên</button></span></div>
      ${tiles}
      <h2>Các tập</h2>${epTable}
      ${sel ? this.episodeDetail(studio, sel) : ''}`,
    );
  }

  private static episodeDetail(studio: Studio, ep: Episode): string {
    const st = studio.config!.project.status;
    const scriptText = ep.files['script'] ? fs.readFileSync(ep.files['script'], 'utf8') : '';
    const cell = (seg: Segment, col: (typeof SEG_COLUMNS)[number]) => {
      const arg = esc(JSON.stringify([col.step, { ep: ep.id, seg: seg.code }]));
      let txt = '·';
      let cls = 'muted';
      if (col.step === 'ket-qua') {
        const done = seg.scenes.filter((c) => c.result);
        if (done.length || seg.scenes.some((c) => c.media['V'])) {
          cls = '';
          const ok = done.filter((c) => c.result!.chosen).length;
          const sum = seg.scenes.reduce((a, c) => a + (c.result?.attempts ?? c.media['V'] ?? 0), 0);
          txt = `✅${ok} / ${seg.scenes.length} · ${sum} lần sinh`;
        }
        // bước cấp cảnh → ô mở cảnh đầu tiên chưa có bản chốt
        const first = seg.scenes.find((c) => !c.result?.chosen && c.status !== 'dropped') ?? seg.scenes[0];
        if (!first) return `<td class="muted">·</td>`;
        return `<td class="${cls}"><a data-cmd="step" data-arg="${esc(JSON.stringify([col.step, { ep: ep.id, seg: seg.code, scene: first.code }]))}">${txt}</a></td>`;
      }
      if (col.step === 'kich-ban') {
        const sec = scriptText ? findSection(scriptText, `[${seg.code}]`) : undefined;
        if (sec) {
          txt = `${statusSymbol(seg.status, st) || '✓'} ${sec.end - sec.start} dòng`;
          cls = '';
        }
      } else if (col.file && seg.files[col.file]) {
        cls = '';
        if (col.file === 'canh') {
          const n = seg.scenes.filter((c) => c.status !== 'dropped');
          const ok = n.filter((c) => c.status === 'done').length;
          txt = `${n.length} cảnh${ok ? ` · ✅${ok}` : ''}`;
        } else if (col.file === 'loi') txt = `${seg.lineCodes.length} câu`;
        else if (col.file === 'prompt') {
          const heads = parseHeadings(fs.readFileSync(seg.files['prompt'], 'utf8'));
          const n = seg.scenes.filter((c) => heads.some((h) => h.text.startsWith(c.code))).length;
          txt = `${n} / ${seg.scenes.length} cảnh`;
        } else txt = '✓';
      }
      return `<td class="${cls}"><a data-cmd="step" data-arg="${arg}">${txt}</a></td>`;
    };
    const rows = ep.segments
      .map((s) =>
        s.dropped
          ? `<tr class="muted"><td><s>${s.code}</s></td><td colspan="${SEG_COLUMNS.length + 2}">${esc(s.name)} — bỏ</td></tr>`
          : `<tr><td><b>${s.code}</b></td><td>${s.relDir ? `<a data-open="${esc(s.dir!)}">${esc(s.name)}</a>` : esc(s.name)}</td>
             <td>${s.plannedSeconds ?? ''}${s.files['canh'] ? ` <a data-cmd="grid" data-arg="${esc(JSON.stringify({ ep: ep.id, seg: s.code }))}" title="sửa bảng cảnh dạng lưới">▦</a>` : ''}${s.scenes.length ? ` <span class="muted">/ ${s.scenes.reduce((a, c) => a + (c.seconds ?? 0), 0)}</span>` : ''}</td>
             ${SEG_COLUMNS.map((c) => cell(s, c)).join('')}</tr>`,
      )
      .join('');
    const links = Object.entries(ep.files)
      .map(([k, f]) => `<a data-open="${esc(f)}" data-how="preview">${esc(studio.rel(f).split('/').pop()!)}</a> <span class="muted">(${k})</span>`)
      .join(' · ');
    return `<h2>${ep.id} — phân đoạn × bước <span class="muted">(bấm ô để mở tab bước)</span></h2>
      <p>${links}${ep.legacy ? '' : ` · <a data-cmd="blender" data-arg="${ep.id}"><b>🧊 Blender của tập</b></a>`}</p>
      ${ep.legacy ? '<p class="warn">Tập này chưa chuyển sang cấu trúc phân đoạn mới.</p>' : ''}
      <div class="scroll-x"><table><tr><th>Mã</th><th>Phân đoạn</th><th>Giây dự kiến / cảnh</th>${SEG_COLUMNS.map((c) => `<th>${c.label}</th>`).join('')}</tr>${rows}</table></div>`;
  }
}
