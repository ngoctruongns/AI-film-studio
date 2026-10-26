// Tab Cài đặt AI: dự án / máy này · danh sách model (thêm, sửa, xóa, khóa API, thử) · gán model cho từng bước.
// Model + gán riêng máy → VS Code User settings. Gán theo dự án → .studio/models.yaml (giữ chú thích). Khóa → SecretStorage.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import YAML from 'yaml';
import { STUDIO_DIR } from '../core/config';
import { ModelConfig, PROVIDERS } from '../core/providers';
import { ModelRegistry } from './models';
import { Studio } from './studio';
import { shell } from './webview';

export class SettingsPanel {
  static panel?: vscode.WebviewPanel;

  static show(studio: Studio, models: ModelRegistry): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('aiFilmStudio.settings', 'Cài đặt AI', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    const post = async () => panel.webview.postMessage({ type: 'state', vm: await vm(studio, models) });
    const subs = [
      studio.onDidChange(post),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('aiFilmStudio') && post()),
    ];
    panel.onDidDispose(() => {
      subs.forEach((s) => s.dispose());
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      try {
        await handle(m, studio, models, panel);
      } catch (e: any) {
        vscode.window.showErrorMessage(String(e.message ?? e));
      }
      post();
    });
    panel.webview.html = shell(panel.webview, 'Cài đặt AI', BODY, CLIENT_JS);
  }
}

async function vm(studio: Studio, models: ModelRegistry) {
  const s = studio.settings;
  const list = models.list();
  const keys: Record<string, boolean> = {};
  for (const m of list) {
    const p = PROVIDERS.find((x) => x.id === m.provider);
    if (p?.needsKey || m.secret) keys[m.id] = !!(await models.apiKey(m));
  }
  const cfg = studio.config?.models;
  const local = s.get<Record<string, string>>('stepModels') ?? {};
  const steps = (studio.config?.pipeline.steps ?? [])
    .filter((x) => x.executor === 'chat')
    .map((x) => ({
      id: x.id,
      label: `${x.no} ${x.title}`,
      project: cfg?.steps?.[x.id] ?? '',
      local: local[x.id] ?? '',
      effective: models.forStep(x.id)?.id ?? '',
    }));
  return {
    root: studio.root ?? '',
    rootSetting: s.get<string>('projectRoot') ?? '',
    hasStudio: !!studio.config,
    mediaRoot: s.get<string>('mediaRoot') ?? '',
    mediaDefault: studio.config?.project.paths.media ?? '',
    machine: s.get<string>('machineProfile') ?? '',
    maxInputTokens: s.get<number>('maxInputTokens') ?? 60000,
    claudePath: s.get<string>('claudePath') ?? '',
    claudeFound: models.claudeCli(),
    providers: PROVIDERS,
    models: list,
    keys,
    steps,
    projectDefault: cfg?.default ?? '',
    projectFallback: (cfg?.fallback ?? []).join(', '),
    error: studio.error,
  };
}

function modelsYamlPath(studio: Studio): string {
  return path.join(studio.root!, STUDIO_DIR, 'models.yaml');
}

/** Sửa .studio/models.yaml mà giữ nguyên chú thích của người viết */
function editModelsYaml(studio: Studio, fn: (doc: YAML.Document) => void): void {
  const file = modelsYamlPath(studio);
  const doc = YAML.parseDocument(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'default: claude-code\n');
  fn(doc);
  fs.writeFileSync(file, doc.toString(), 'utf8');
  studio.refresh();
}

async function handle(m: any, studio: Studio, models: ModelRegistry, panel: vscode.WebviewPanel): Promise<void> {
  const s = studio.settings;
  const G = vscode.ConfigurationTarget.Global;
  switch (m.type) {
    case 'ready':
      return;
    case 'setting': {
      const allowed = ['projectRoot', 'mediaRoot', 'machineProfile', 'maxInputTokens', 'claudePath'];
      if (!allowed.includes(m.key)) return;
      await s.update(m.key, m.key === 'maxInputTokens' ? Number(m.value) || 60000 : String(m.value ?? '').trim(), G);
      return;
    }
    case 'cmd':
      switch (m.cmd) {
        case 'pickRoot':
          return vscode.commands.executeCommand('aiFilmStudio.setProjectRoot');
        case 'pickMedia': {
          const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Chọn thư mục media của máy này' });
          if (pick?.[0]) await s.update('mediaRoot', pick[0].fsPath, G);
          return;
        }
        case 'init':
          return vscode.commands.executeCommand('aiFilmStudio.initProject');
        case 'openModelsYaml':
          if (studio.root) await vscode.window.showTextDocument(vscode.Uri.file(modelsYamlPath(studio)));
          return;
        case 'openSettingsJson':
          return vscode.commands.executeCommand('workbench.action.openSettings', 'aiFilmStudio');
      }
      return;
    case 'saveModel': {
      const x = m.model as ModelConfig & { originalId?: string };
      const id = String(x.id ?? '').trim();
      if (!/^[\w.-]+$/.test(id)) throw new Error('Tên model chỉ gồm chữ, số, dấu chấm, gạch (vd. local-qwen).');
      const list = models.list().filter((y) => y.id !== (x.originalId || id));
      if (x.originalId !== id && models.get(id)) throw new Error(`Đã có model "${id}".`);
      const clean: ModelConfig = { id, provider: x.provider };
      if (x.title?.trim()) clean.title = x.title.trim();
      if (x.model?.trim()) clean.model = x.model.trim();
      if (x.apiBase?.trim()) clean.apiBase = x.apiBase.trim();
      if (x.secret?.trim()) clean.secret = x.secret.trim();
      if (Number(x.maxOutputTokens) > 0) clean.maxOutputTokens = Number(x.maxOutputTokens);
      const pi = Number(x.price?.input);
      const po = Number(x.price?.output);
      if (pi > 0 || po > 0) clean.price = { input: pi || 0, output: po || 0 };
      const extra = (x.extraArgs as unknown as string | undefined)?.toString().trim();
      if (extra) clean.extraArgs = extra.split(/\s+/);
      const idx = models.list().findIndex((y) => y.id === (x.originalId || id));
      list.splice(idx >= 0 ? idx : list.length, 0, clean);
      await s.update('models', list, G);
      vscode.window.showInformationMessage(`Đã lưu model "${id}".`);
      return;
    }
    case 'deleteModel': {
      const ok = await vscode.window.showWarningMessage(`Xóa model "${m.id}" khỏi máy này? (khóa API giữ nguyên)`, { modal: true }, 'Xóa');
      if (ok) await s.update('models', models.list().filter((y) => y.id !== m.id), G);
      return;
    }
    case 'moveModel': {
      const list = models.list();
      const i = list.findIndex((y) => y.id === m.id);
      const j = i + (m.dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      await s.update('models', list, G);
      return;
    }
    case 'setKey': {
      const mod = models.get(m.id);
      if (!mod) return;
      const key = String(m.key ?? '').trim();
      if (key) await studio.context.secrets.store(models.secretKey(mod), key);
      else await studio.context.secrets.delete(models.secretKey(mod));
      vscode.window.showInformationMessage(key ? `Đã lưu khóa cho "${mod.secret ?? mod.provider}".` : 'Đã xóa khóa.');
      return;
    }
    case 'test': {
      const mod = models.get(m.id);
      if (!mod) return;
      panel.webview.postMessage({ type: 'test', id: m.id, text: '⏳ đang thử…' });
      try {
        const r = await models.provider(mod).complete({
          model: mod,
          system: 'Trả lời đúng một chữ.',
          prompt: 'Trả lời: OK',
          cwd: studio.root ?? process.cwd(),
          apiKey: await models.apiKey(mod),
        });
        const cost = r.costUsd !== undefined ? ` · ${r.costUsd.toFixed(4)} USD` : '';
        panel.webview.postMessage({ type: 'test', id: m.id, ok: true, text: `✅ "${r.text.trim().slice(0, 40)}" · ${r.inputTokens ?? '?'}→${r.outputTokens ?? '?'} token${cost}` });
      } catch (e: any) {
        panel.webview.postMessage({ type: 'test', id: m.id, ok: false, text: `❌ ${String(e.message).slice(0, 300)}` });
      }
      return;
    }
    case 'stepModel': {
      if (m.scope === 'local') {
        const local = { ...(s.get<Record<string, string>>('stepModels') ?? {}) };
        if (m.value) local[m.step] = m.value;
        else delete local[m.step];
        await s.update('stepModels', local, G);
      } else if (studio.root) {
        editModelsYaml(studio, (doc) => {
          if (m.value) doc.setIn(['steps', m.step], m.value);
          else doc.deleteIn(['steps', m.step]);
        });
      }
      return;
    }
    case 'projectModels': {
      if (!studio.root) return;
      editModelsYaml(studio, (doc) => {
        if (m.default) doc.set('default', m.default);
        const fb = String(m.fallback ?? '').split(/[,\s]+/).filter(Boolean);
        doc.set('fallback', doc.createNode(fb, { flow: true }));
      });
      return;
    }
  }
}

const BODY = `
<h1>Cài đặt AI Film Studio</h1>
<div id="err"></div>
<h2>Dự án &amp; máy này</h2>
<table id="proj"></table>
<h2>Model của máy này <span class="muted">(lưu ở VS Code User settings — máy công ty và laptop khác nhau)</span></h2>
<div id="models"></div>
<div class="row" style="margin-top:8px"><button data-act="new">+ Thêm model</button>
  <button class="link" data-cmd="openSettingsJson">mở settings gốc</button></div>
<div id="form" class="card" style="margin-top:10px" hidden></div>
<h2>Gán model cho từng bước</h2>
<p class="muted">Cột <b>Dự án</b> ghi vào <code>.studio/models.yaml</code> (vào git, dùng chung mọi máy). Cột <b>Máy này</b> ghi đè riêng máy đang dùng.
Model được gán mà máy này không có → dùng lần lượt <i>dự phòng</i> → <i>mặc định</i>. <button class="link" data-cmd="openModelsYaml">mở models.yaml</button></p>
<div class="row" id="projModels"></div>
<div id="steps" style="margin-top:8px"></div>
`;

const CLIENT_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let vm = null; const tests = {};

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { vm = m.vm; render(); }
  if (m.type === 'test') { tests[m.id] = m.text; const el = document.getElementById('t-' + m.id); if (el) el.textContent = m.text; }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const act = b.dataset.act;
  if (act === 'new') openForm(null);
  if (act === 'edit') openForm(vm.models.find((x) => x.id === id));
  if (act === 'del') vscode.postMessage({ type: 'deleteModel', id });
  if (act === 'up' || act === 'down') vscode.postMessage({ type: 'moveModel', id, dir: act });
  if (act === 'test') { tests[id] = '⏳ đang thử…'; render(); vscode.postMessage({ type: 'test', id }); }
  if (act === 'key') {
    const inp = document.getElementById('k-' + id);
    vscode.postMessage({ type: 'setKey', id, key: inp.value }); inp.value = '';
  }
  if (act === 'save') saveForm();
  if (act === 'cancel') $('form').hidden = true;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting) vscode.postMessage({ type: 'setting', key: t.dataset.setting, value: t.value });
  if (t.dataset.step) vscode.postMessage({ type: 'stepModel', step: t.dataset.step, scope: t.dataset.scope, value: t.value });
  if (t.id === 'pDefault' || t.id === 'pFallback') vscode.postMessage({ type: 'projectModels', default: $('pDefault').value, fallback: $('pFallback').value });
  if (t.id === 'fProvider') hint();
});

function render() {
  $('err').innerHTML = vm.error ? '<p class="warn">' + esc(vm.error) + (vm.hasStudio ? '' : ' <button data-cmd="init">Khởi tạo .studio/</button>') + '</p>' : '';
  const row = (label, input, note) => '<tr><th style="width:220px">' + label + '</th><td>' + input + '</td><td class="muted">' + (note || '') + '</td></tr>';
  $('proj').innerHTML =
    row('Thư mục dự án', '<code>' + esc(vm.root || '(chưa có)') + '</code> <button class="sec" data-cmd="pickRoot">Chọn…</button>', vm.rootSetting ? 'đặt trong settings' : 'theo workspace') +
    row('Thư mục media (máy này)', '<input data-setting="mediaRoot" size="50" value="' + esc(vm.mediaRoot) + '" placeholder="' + esc(vm.mediaDefault) + '"> <button class="sec" data-cmd="pickMedia">Chọn…</button>', 'trống = ' + esc(vm.mediaDefault || '(theo project.yaml)')) +
    row('Tên máy', '<input data-setting="machineProfile" size="20" value="' + esc(vm.machine) + '" placeholder="laptop / cong-ty">', 'ghi vào nhật ký chạy') +
    row('Trần token một lần chạy', '<input data-setting="maxInputTokens" type="number" value="' + vm.maxInputTokens + '">', 'vượt thì hỏi lại') +
    row('Claude CLI', '<input data-setting="claudePath" size="50" value="' + esc(vm.claudePath) + '" placeholder="tự tìm">', 'đang dùng: <code>' + esc(vm.claudeFound) + '</code>');

  const prov = (id) => vm.providers.find((p) => p.id === id) || { label: id };
  $('models').innerHTML = vm.models.length ? '<table><tr><th></th><th>Tên</th><th>Nhà cung cấp</th><th>Model</th><th>Giá USD/1M (vào/ra)</th><th>Khóa API</th><th></th></tr>' +
    vm.models.map((m, i) => {
      const needKey = m.id in vm.keys;
      const key = needKey ? (vm.keys[m.id] ? '<span class="ok">✓ đã có</span>' : '<span class="err">chưa có</span>')
        + ' <input id="k-' + esc(m.id) + '" type="password" size="16" placeholder="dán khóa mới"><button class="link" data-act="key" data-id="' + esc(m.id) + '">lưu</button>' : '<span class="muted">không cần</span>';
      return '<tr><td style="white-space:nowrap"><button class="link" data-act="up" data-id="' + esc(m.id) + '"' + (i ? '' : ' disabled') + '>▲</button><button class="link" data-act="down" data-id="' + esc(m.id) + '"' + (i < vm.models.length - 1 ? '' : ' disabled') + '>▼</button></td>'
        + '<td><b>' + esc(m.id) + '</b><br><span class="muted">' + esc(m.title || '') + '</span></td><td>' + esc(prov(m.provider).label) + (m.apiBase ? '<br><code>' + esc(m.apiBase) + '</code>' : '') + '</td>'
        + '<td>' + esc(m.model || '(mặc định)') + '</td><td>' + (m.price ? (m.price.input ?? 0) + ' / ' + (m.price.output ?? 0) : '<span class="muted">—</span>') + '</td><td>' + key + '</td>'
        + '<td style="white-space:nowrap"><button class="sec" data-act="test" data-id="' + esc(m.id) + '">Thử</button> <button class="link" data-act="edit" data-id="' + esc(m.id) + '">sửa</button><button class="link" data-act="del" data-id="' + esc(m.id) + '">xóa</button>'
        + '<div id="t-' + esc(m.id) + '" class="muted">' + esc(tests[m.id] || '') + '</div></td></tr>';
    }).join('') + '</table>' : '<p class="muted">Chưa có model nào.</p>';

  const opts = (cur, empty) => '<option value="">' + empty + '</option>' + vm.models.map((m) => '<option' + (m.id === cur ? ' selected' : '') + '>' + esc(m.id) + '</option>').join('')
    + (cur && !vm.models.some((m) => m.id === cur) ? '<option selected value="' + esc(cur) + '">' + esc(cur) + ' (máy này không có)</option>' : '');
  $('projModels').innerHTML = vm.hasStudio ? '<label>Mặc định của dự án <select id="pDefault">' + opts(vm.projectDefault, '—') + '</select></label>'
    + '<label>Dự phòng <input id="pFallback" size="40" value="' + esc(vm.projectFallback) + '" placeholder="claude-code, local-qwen"></label>' : '';
  $('steps').innerHTML = vm.steps.length ? '<table><tr><th>Bước</th><th>Dự án (models.yaml)</th><th>Máy này</th><th>Đang dùng</th></tr>' + vm.steps.map((s) =>
    '<tr><td>' + esc(s.label) + '</td><td><select data-step="' + esc(s.id) + '" data-scope="project">' + opts(s.project, '(mặc định)') + '</select></td>'
    + '<td><select data-step="' + esc(s.id) + '" data-scope="local">' + opts(s.local, '(theo dự án)') + '</select></td><td><b>' + esc(s.effective) + '</b></td></tr>').join('') + '</table>' : '';
}

function openForm(m) {
  const f = $('form'); f.hidden = false;
  const p = (m && m.price) || {};
  f.innerHTML = '<b>' + (m ? 'Sửa model ' + esc(m.id) : 'Thêm model') + '</b><table style="margin-top:6px">'
    + '<tr><th>Tên (id)</th><td><input id="fId" value="' + esc(m ? m.id : '') + '" placeholder="vd. local-qwen"></td></tr>'
    + '<tr><th>Tên hiển thị</th><td><input id="fTitle" size="40" value="' + esc(m ? m.title : '') + '"></td></tr>'
    + '<tr><th>Nhà cung cấp</th><td><select id="fProvider">' + vm.providers.map((x) => '<option value="' + x.id + '"' + (m && m.provider === x.id ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select> <span id="fHint" class="muted"></span></td></tr>'
    + '<tr><th>Model</th><td><input id="fModel" size="40" value="' + esc(m ? m.model : '') + '"></td></tr>'
    + '<tr><th>API base</th><td><input id="fBase" size="50" value="' + esc(m ? m.apiBase : '') + '" placeholder="trống = mặc định của nhà cung cấp"></td></tr>'
    + '<tr><th>Tên khóa</th><td><input id="fSecret" value="' + esc(m ? m.secret : '') + '" placeholder="trống = tên nhà cung cấp"> <span class="muted">nhiều model dùng chung một khóa</span></td></tr>'
    + '<tr><th>Giá USD / 1M token</th><td>vào <input id="fPi" type="number" step="0.01" style="width:80px" value="' + (p.input ?? '') + '"> ra <input id="fPo" type="number" step="0.01" style="width:80px" value="' + (p.output ?? '') + '"> <span class="muted">để ước tính tiền; Claude Code tự báo</span></td></tr>'
    + '<tr><th>Token ra tối đa</th><td><input id="fMax" type="number" value="' + esc(m ? m.maxOutputTokens : '') + '"></td></tr>'
    + '<tr><th>Tham số CLI thêm</th><td><input id="fExtra" size="40" value="' + esc(m && m.extraArgs ? m.extraArgs.join(' ') : '') + '"> <span class="muted">chỉ cho Claude Code</span></td></tr>'
    + '</table><div class="row" style="margin-top:6px"><button data-act="save">Lưu</button><button class="sec" data-act="cancel">Hủy</button></div>';
  f.dataset.original = m ? m.id : '';
  hint();
}
function hint() { const p = vm.providers.find((x) => x.id === $('fProvider').value); $('fHint').textContent = p ? p.hint : ''; }
function saveForm() {
  vscode.postMessage({ type: 'saveModel', model: {
    originalId: $('form').dataset.original, id: $('fId').value, title: $('fTitle').value, provider: $('fProvider').value,
    model: $('fModel').value, apiBase: $('fBase').value, secret: $('fSecret').value,
    price: { input: $('fPi').value, output: $('fPo').value }, maxOutputTokens: $('fMax').value, extraArgs: $('fExtra').value } });
  $('form').hidden = true;
}
vscode.postMessage({ type: 'ready' });
`;
