// Tab 🧊 Blender của một tập: file .blend · script dựng · hướng dẫn · shot (marker) → frame → cảnh · quét từ Blender · ghi sổ SO-BLENDER.md.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlenderModel, DUMP_PY, gotoShotPy, parseDump, renderCommandFor, renderRegister, saveIndex, scanBlender } from '../core/blender';
import { runBlenderCli, runInBlenderSocket } from '../core/blenderLink';
import { listSceneMedia } from '../core/results';
import { runsDir } from '../core/runs';
import { Episode, episodeLabel, fill, findEpisode, placeholdersFor } from '../core/scanner';
import { Studio } from './studio';
import { shell } from './webview';

export function blenderSettings(studio: Studio) {
  const s = studio.settings;
  return {
    path: s.get<string>('blenderPath') || '',
    host: s.get<string>('blenderHost') || 'localhost',
    port: s.get<number>('blenderPort') || 9876,
  };
}

export async function blenderSocket(studio: Studio, code: string): Promise<string> {
  const b = blenderSettings(studio);
  return runInBlenderSocket(b.host, b.port, code);
}

/** Đưa Blender đang mở tới một shot (preview range + camera). Báo nếu file đang mở không phải file của shot. */
export async function gotoShotInBlender(studio: Studio, file: string, start: number, end: number, camera?: string): Promise<void> {
  const out = await blenderSocket(studio, gotoShotPy(start, end, camera));
  const opened = /AFS_OK:(.*)/.exec(out)?.[1]?.trim() ?? '';
  const base = path.basename(opened.replace(/\\/g, '/'));
  if (base && base !== file) vscode.window.showWarningMessage(`Blender đang mở ${base}, không phải ${file} — đã đặt frame ${start}–${end} nhưng có thể sai file.`);
  else vscode.window.showInformationMessage(`Blender: ${file} · ${camera ?? ''} · frame ${start}–${end} (preview range).`);
}

export class BlenderPanel {
  private static panels = new Map<string, BlenderPanel>();
  private bm?: BlenderModel;

  static open(studio: Studio, ep: string): void {
    const ex = this.panels.get(ep);
    if (ex) {
      ex.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiFilmStudio.blender', `🧊 Blender ${ep}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const p = new BlenderPanel(panel, studio, ep);
    this.panels.set(ep, p);
    panel.onDidDispose(() => {
      p.sub.dispose();
      this.panels.delete(ep);
    });
  }

  private sub: vscode.Disposable;

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private studio: Studio,
    private epId: string,
  ) {
    this.sub = studio.onDidChange(() => this.post());
    panel.webview.onDidReceiveMessage((m) =>
      this.onMessage(m).catch((e) => {
        this.status(`❌ ${e.message ?? e}`);
        vscode.window.showErrorMessage(String(e.message ?? e));
      }),
    );
    panel.webview.html = shell(panel.webview, 'Blender', BODY, CLIENT_JS);
  }

  private ep(): Episode | undefined {
    return this.studio.model && findEpisode(this.studio.model, this.epId);
  }

  private status(text: string) {
    this.panel.webview.postMessage({ type: 'status', text });
  }

  private vm() {
    const model = this.studio.model;
    const ep = this.ep();
    if (!model || !ep) return { error: this.studio.error ?? `Không thấy ${this.epId}` };
    const bm = (this.bm = scanBlender(model, ep));
    const b = blenderSettings(this.studio);
    const scenes = new Map(ep.segments.flatMap((s) => s.scenes.map((c) => [c.code, { c, seg: s }] as const)));
    const ph = placeholdersFor(model, ep);
    const mediaDirs = [
      ...(model.mediaFound && model.mediaRoot ? [{ dir: model.mediaRoot, inRepo: false }] : []),
      ...(model.config.project.paths.sceneMedia ?? []).map((d) => ({ dir: this.studio.abs(fill(d, ph)), inRepo: true })).filter((d) => fs.existsSync(d.dir)),
    ];
    return {
      ep: ep.id,
      title: episodeLabel(ep),
      fps: bm.cfg.fps,
      blender: b,
      register: { abs: bm.registerFile, rel: this.studio.rel(bm.registerFile), exists: bm.registerExists },
      canPull: !!bm.cfg.pullCommand,
      files: bm.files.map((f) => ({
        ...f,
        shots: bm.shots.filter((s) => s.file === f.name).length,
        scriptsAbs: f.scripts.map((x) => this.studio.abs(x)),
        guidesAbs: f.guides.map((x) => this.studio.abs(x)),
        buildAbs: f.buildScripts.map((x) => this.studio.abs(x)),
      })),
      shots: bm.shots.map((s) => {
        const sc = scenes.get(s.scene);
        const refs = listSceneMedia(mediaDirs, ep.id, s.scene).filter((m) => m.kind === 'R');
        const f = bm.files.find((x) => x.name === s.file);
        return {
          ...s,
          frames: s.end - s.start + 1,
          seconds: (s.end - s.start + 1) / bm.cfg.fps,
          sceneSeconds: sc?.c.seconds,
          seg: sc?.seg.code,
          segName: sc?.seg.name,
          sceneTitle: sc?.c.title,
          fromAbs: s.from && !s.from.startsWith('Blender') ? this.studio.abs(s.from) : undefined,
          refs: refs.map((r) => ({ name: r.name, abs: r.abs })),
          render: renderCommandFor(bm, s, f, b.path),
        };
      }),
      issues: bm.issues,
    };
  }

  private post(): void {
    this.panel.webview.postMessage({ type: 'state', vm: this.vm() });
  }

  private async onMessage(m: any): Promise<void> {
    const model = this.studio.model;
    switch (m.type) {
      case 'ready':
        return this.post();
      case 'open':
        if (m.path && fs.existsSync(m.path)) {
          const doc = await vscode.workspace.openTextDocument(m.path);
          const pos = new vscode.Position(Number(m.line ?? 0), 0);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos), preview: false });
        }
        return;
      case 'cmd':
        break;
      default:
        return;
    }
    if (!model) return;
    switch (m.cmd) {
      case 'refresh':
        this.studio.refresh();
        return;
      case 'settings':
        return void vscode.commands.executeCommand('aiFilmStudio.openSettings');
      case 'scanSocket': {
        this.status('⏳ hỏi Blender đang mở…');
        const idx = parseDump(await blenderSocket(this.studio, DUMP_PY));
        if (!idx) throw new Error('Blender không trả dữ liệu (script quét không chạy?)');
        idx.via = 'socket';
        const name = path.basename(idx.file.replace(/\\/g, '/'));
        if (!name) throw new Error('File đang mở trong Blender chưa được lưu — lưu file trước rồi quét.');
        let ep = this.epId;
        const mine = this.bm?.files.some((f) => f.name === name);
        if (!mine) {
          const pick = await vscode.window.showQuickPick(
            model.episodes.filter((e) => !e.legacy).map((e) => ({ label: e.id, description: episodeLabel(e), e: e.id })),
            { placeHolder: `${name} chưa thấy trong ${this.epId} — lưu kết quả quét vào tập nào?` },
          );
          if (!pick) return this.status('đã hủy');
          ep = pick.e;
        }
        const out = saveIndex(model, ep, idx);
        this.status(`✅ ${name}: ${idx.markers.length} marker · frame ${idx.frame_start}–${idx.frame_end} · ${idx.fps} fps → ${this.studio.rel(out)}`);
        this.studio.refresh();
        return;
      }
      case 'scanCli': {
        const b = blenderSettings(this.studio);
        if (!b.path) return void vscode.window.showWarningMessage('Chưa đặt đường dẫn Blender của máy này (Cài đặt AI → Blender).');
        const targets = (this.bm?.files ?? []).filter((f) => f.present && f.abs && (!m.arg || f.name === m.arg) && !f.shared);
        let n = 0;
        for (const f of targets) {
          this.status(`⏳ quét ${f.name} (${++n}/${targets.length})…`);
          const idx = parseDump(await runBlenderCli(b.path, f.abs!, DUMP_PY));
          if (idx) saveIndex(model, this.epId, { ...idx, via: 'cli' });
        }
        this.status(`✅ đã quét ${n} file bằng Blender máy này`);
        this.studio.refresh();
        return;
      }
      case 'goto': {
        const s = this.bm?.shots.find((x) => `${x.file}|${x.code}` === m.arg);
        if (s) await gotoShotInBlender(this.studio, s.file, s.start, s.end, s.camera);
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.arg));
        this.status('đã chép lệnh');
        return;
      case 'render': {
        const term = vscode.window.createTerminal({ name: `Render · ${this.epId}`, cwd: this.studio.root });
        term.show();
        term.sendText(String(m.arg));
        return;
      }
      case 'pull': {
        const tpl = this.bm?.cfg.pullCommand;
        const f = this.bm?.files.find((x) => x.name === m.arg);
        if (!tpl || !f) return;
        const dest = f.rel ?? `${this.ep()!.relDir}/blender/${f.name}`;
        const term = vscode.window.createTerminal({ name: `Kéo .blend · ${f.name}`, cwd: this.studio.root });
        term.show();
        term.sendText(tpl.replace(/\{file\}/g, dest));
        return;
      }
      case 'runScript': {
        const term = vscode.window.createTerminal({ name: `Dựng · ${path.basename(String(m.arg))}`, cwd: path.dirname(String(m.arg)) });
        term.show();
        term.sendText(/\.bat$/i.test(m.arg) ? `"${m.arg}"` : `bash "${m.arg}"`);
        return;
      }
      case 'openStep': {
        const [seg, scene] = String(m.arg).split('|');
        return void vscode.commands.executeCommand('aiFilmStudio.pickStep', this.sceneNode(seg, scene));
      }
      case 'writeRegister':
        return this.writeRegister();
    }
  }

  private sceneNode(seg: string, scene: string) {
    const ep = this.ep()!;
    const s = ep.segments.find((x) => x.code === seg);
    const c = s?.scenes.find((x) => x.code === scene);
    return s && c ? { kind: 'scene', ep, seg: s, scene: c } : undefined;
  }

  /** Ghi sổ SO-BLENDER.md: diff trước, hỏi rồi mới ghi. Cột Ra / Ghi chú của sổ cũ được giữ (scanBlender đã gộp). */
  private async writeRegister(): Promise<void> {
    const ep = this.ep();
    if (!ep || !this.bm) return;
    const secs = new Map(ep.segments.flatMap((s) => s.scenes.map((c) => [c.code, c.seconds] as const)));
    const text = renderRegister(this.bm, `${ep.id} · ${episodeLabel(ep)}`, (sc) => secs.get(sc));
    const file = this.bm.registerFile;
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur === text) return this.status('sổ đã đúng, không cần ghi');
    const tmp = path.join(runsDir(this.studio.root!), `SO-BLENDER_${ep.id}.proposal.md`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    if (cur) await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(file), vscode.Uri.file(tmp), `SO-BLENDER ${ep.id} ↔ bản mới`);
    else await vscode.window.showTextDocument(vscode.Uri.file(tmp), { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const ok = await vscode.window.showInformationMessage(`Ghi ${this.studio.rel(file)}?`, { modal: true }, 'Ghi');
    if (ok !== 'Ghi') return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.readFileSync(tmp, 'utf8'), 'utf8');
    this.status(`✅ đã ghi ${this.studio.rel(file)} — xem bằng git diff`);
    this.studio.refresh();
  }
}

const BODY = `
<div class="row" style="justify-content:space-between"><h1 id="title">🧊 Blender</h1>
  <div class="row">
    <button data-cmd="scanSocket" title="hỏi Blender đang mở qua addon MCP (cùng cổng với blender_bridge.py)">Quét Blender đang mở</button>
    <button class="sec" data-cmd="scanCli" id="btnCli" title="chạy Blender nền trên máy này, quét mọi file .blend của tập">Quét bằng Blender máy này</button>
    <button class="sec" data-cmd="writeRegister">Ghi sổ SO-BLENDER.md</button>
    <button class="link" data-cmd="refresh">quét lại</button><button class="link" data-cmd="settings">cài đặt</button>
  </div></div>
<div id="status" class="muted"></div>
<div id="sub" class="muted"></div>
<h2>File .blend</h2><div class="scroll-x" id="files"></div>
<h2>Shot ↔ cảnh <span class="muted">(thứ tự chiếu)</span></h2>
<div class="row"><input id="filter" placeholder="lọc: F02, F, tran_da_bang…" size="30"><label><input type="checkbox" id="onlyIssues"> chỉ dòng có vấn đề</label><span id="count" class="muted"></span></div>
<div class="scroll-x" id="shots" style="margin-top:6px"></div>
<h2>Cần xem</h2><div id="issues"></div>
`;

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let vm = null;
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { vm = m.vm; render(); }
  if (m.type === 'status') $('status').textContent = m.text;
});
$('filter').addEventListener('input', () => vm && renderShots());
$('onlyIssues').addEventListener('change', () => vm && renderShots());
const kb = (n) => n === undefined ? '' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB';
const base = (p) => String(p).split('/').pop();
const links = (rels, abss) => rels.map((r, i) => '<a data-open="' + esc(abss[i]) + '">' + esc(base(r)) + '</a>').join(', ');
function render() {
  if (vm.error) { $('status').innerHTML = '<span class="err">' + esc(vm.error) + '</span>'; return; }
  $('title').textContent = '🧊 Blender · ' + vm.title;
  $('btnCli').disabled = !vm.blender.path;
  $('btnCli').title = vm.blender.path ? 'Blender: ' + vm.blender.path : 'máy này chưa đặt đường dẫn Blender (Cài đặt AI)';
  $('sub').innerHTML = 'Blender đang mở: <code>' + esc(vm.blender.host + ':' + vm.blender.port) + '</code> · Blender máy này: <code>' + esc(vm.blender.path || 'chưa đặt') + '</code> · '
    + vm.fps + ' fps · sổ: ' + (vm.register.exists ? '<a data-open="' + esc(vm.register.abs) + '">' + esc(vm.register.rel) + '</a>' : '<span class="muted">' + esc(vm.register.rel) + ' (chưa có)</span>');
  $('files').innerHTML = '<table><tr><th>File</th><th>Ở đâu</th><th>Cỡ</th><th>Shot</th><th>Script dựng</th><th>Hướng dẫn</th><th>Quét Blender</th><th></th></tr>' + vm.files.map((f) => {
    const where = f.present ? (f.shared ? 'dùng chung' : 'repo') : (f.buildScripts.length ? '<span class="muted">dựng tại máy</span>' : '<span class="err">không thấy</span>');
    const idx = f.index ? esc((f.index.scannedAt || '').slice(0, 10)) + ' · ' + f.index.markers.length + ' marker · ' + f.index.frame_start + '–' + f.index.frame_end + ' · ' + f.index.fps + ' fps' + (f.index.engine ? ' · ' + esc(f.index.engine) : '') : '<span class="muted">chưa</span>';
    let act = '';
    if (f.present && !f.shared && vm.blender.path) act += '<button class="link" data-cmd="scanCli" data-arg="' + esc(f.name) + '">quét</button>';
    if (vm.canPull && !f.shared) act += '<button class="link" data-cmd="pull" data-arg="' + esc(f.name) + '" title="lưu file đang mở trong Blender Windows về repo">kéo về</button>';
    act += f.buildAbs.map((b) => '<button class="link" data-cmd="runScript" data-arg="' + esc(b) + '">▶ ' + esc(base(b)) + '</button>').join('');
    return '<tr><td><b>' + (f.abs ? '<a data-open="' + esc(f.abs) + '">' + esc(f.name) + '</a>' : esc(f.name)) + '</b></td><td>' + where + '</td><td>' + kb(f.size) + '</td><td>' + (f.shots || '') + '</td>'
      + '<td>' + links(f.scripts, f.scriptsAbs) + '</td><td>' + links(f.guides, f.guidesAbs) + '</td><td>' + idx + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
  }).join('') + '</table>';
  renderShots();
  $('issues').innerHTML = vm.issues.length ? vm.issues.map((i) => '<div>' + (i.severity === 'warning' ? '⚠' : 'ℹ') + ' ' + esc(i.message) + '</div>').join('') : '<span class="ok">không có</span>';
}
function renderShots() {
  const q = $('filter').value.trim().toLowerCase();
  const only = $('onlyIssues').checked;
  const issueOf = (s) => vm.issues.filter((i) => i.shot === s.code || (i.scene === s.scene && !i.shot));
  const list = vm.shots.filter((s) => (!q || (s.code + ' ' + s.file + ' ' + (s.segName || '')).toLowerCase().includes(q)) && (!only || s.conflicts.length || issueOf(s).length));
  $('count').textContent = list.length + ' / ' + vm.shots.length + ' shot';
  let lastSeg = null;
  const rows = list.map((s) => {
    let h = '';
    if (s.seg !== lastSeg) { lastSeg = s.seg; h += '<tr><th colspan="10">' + esc(s.seg ? s.seg + ' · ' + s.segName : 'không thuộc bảng cảnh nào') + '</th></tr>'; }
    const warnSec = s.sceneSeconds !== undefined && Math.abs(s.seconds - s.sceneSeconds) > 0.6;
    const conf = s.conflicts.length ? ' <span class="err" title="' + esc(s.conflicts.map((c) => c.source + ' ' + c.start + '–' + c.end + ' (' + (c.from || '') + ')').join('\\n')) + '">⚠ ' + s.conflicts.map((c) => c.start + '–' + c.end).join(', ') + '</span>' : '';
    const src = s.fromAbs ? '<a data-open="' + esc(s.fromAbs) + '" data-line="' + (s.line || 0) + '"><span class="badge">' + esc(s.source) + '</span></a>' : '<span class="badge" title="' + esc(s.from) + '">' + esc(s.source) + '</span>';
    const refs = s.refs.length ? s.refs.map((r) => '<a data-open="' + esc(r.abs) + '">' + esc(r.name) + '</a>').join(' ') : '<span class="muted">' + esc(s.out || '') + '</span>';
    return h + '<tr><td><a data-cmd="openStep" data-arg="' + esc((s.seg || '') + '|' + s.scene) + '" title="' + esc(s.sceneTitle || '') + '"><b>' + esc(s.scene) + '</b></a></td><td>' + esc(s.code) + '</td>'
      + '<td>' + esc(s.file) + '</td><td>' + esc(s.camera || '') + '</td><td style="white-space:nowrap">' + s.start + ' – ' + s.end + conf + '</td><td>' + s.frames + '</td>'
      + '<td class="' + (warnSec ? 'err' : '') + '">' + s.seconds.toFixed(1) + ' s' + (s.sceneSeconds !== undefined ? ' <span class="muted">/ ' + s.sceneSeconds + '</span>' : '') + '</td>'
      + '<td>' + src + '</td><td>' + refs + (s.note ? '<div class="muted">' + esc(s.note) + '</div>' : '') + '</td>'
      + '<td style="white-space:nowrap"><button class="link" data-cmd="goto" data-arg="' + esc(s.file + '|' + s.code) + '" title="đặt preview range + camera trong Blender đang mở">xem trong Blender</button>'
      + (s.render ? '<button class="link" data-cmd="copy" data-arg="' + esc(s.render) + '" title="' + esc(s.render) + '">chép lệnh render</button>' + (vm.blender.path ? '<button class="link" data-cmd="render" data-arg="' + esc(s.render) + '">render</button>' : '') : '') + '</td></tr>';
  }).join('');
  $('shots').innerHTML = '<table><tr><th>Cảnh</th><th>Shot</th><th>File</th><th>Camera</th><th>Frame</th><th>Số frame</th><th>Giây / bảng</th><th>Nguồn</th><th>Clip tham chiếu / Ra</th><th></th></tr>' + rows + '</table>';
}
vscode.postMessage({ type: 'ready' });
`;
