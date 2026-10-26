// Giả lập phần API VS Code mà extension dùng — đủ để chạy activate(), cây, lệnh và webview (qua jsdom) trong node.
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

export const log: string[] = [];
export const errors: string[] = [];
/** Câu trả lời xếp hàng cho các hộp thoại: showInformationMessage/Warning (modal), showQuickPick, showInputBox, showOpenDialog */
export const answers: { kind: string; value: any }[] = [];
function answer(kind: string, fallback: any): any {
  const i = answers.findIndex((a) => a.kind === kind);
  if (i < 0) return fallback;
  const [a] = answers.splice(i, 1);
  return typeof a.value === 'function' ? a.value : a.value;
}

export class EventEmitter<T> {
  private fns: ((e: T) => any)[] = [];
  event = (fn: (e: T) => any) => {
    this.fns.push(fn);
    return { dispose: () => (this.fns = this.fns.filter((f) => f !== fn)) };
  };
  fire(e?: T) {
    for (const f of [...this.fns]) f(e as T);
  }
  dispose() {
    this.fns = [];
  }
}

export class Uri {
  constructor(public scheme: string, public fsPath: string) {}
  static file(p: string) {
    return new Uri('file', p);
  }
  static parse(s: string) {
    return new Uri('file', s.replace(/^file:\/\//, ''));
  }
  get path() {
    return this.fsPath;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}
export class Position {
  constructor(public line: number, public character: number) {}
}
export class Range {
  constructor(public start: any, public end: any, public c?: number, public d?: number) {}
}
export class Selection extends Range {}
export class TreeItem {
  description?: string;
  iconPath?: any;
  command?: any;
  contextValue?: string;
  tooltip?: any;
  constructor(public label: string, public collapsibleState?: number) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class ThemeIcon {
  constructor(public id: string) {}
}
export class MarkdownString {
  constructor(public value = '') {}
}
export class Diagnostic {
  source?: string;
  constructor(public range: Range, public message: string, public severity: number) {}
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const ProgressLocation = { Notification: 15 };
export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

// ------------------------------------------------------------------ cấu hình
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
const defaults: Record<string, any> = {};
for (const [k, v] of Object.entries<any>(pkg.contributes.configuration.properties)) defaults[k] = v.default;
export const settingsStore: Record<string, any> = {};
const configEmitter = new EventEmitter<any>();

export let workspaceRoot = '';
export function setWorkspaceRoot(r: string) {
  workspaceRoot = r;
}

export const workspace = {
  get workspaceFolders() {
    return workspaceRoot ? [{ uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }] : undefined;
  },
  getConfiguration(section: string) {
    return {
      get<T>(k: string, def?: T): T {
        const key = `${section}.${k}`;
        return (key in settingsStore ? settingsStore[key] : key in defaults ? defaults[key] : def) as T;
      },
      async update(k: string, v: any) {
        settingsStore[`${section}.${k}`] = v;
        configEmitter.fire({ affectsConfiguration: (s: string) => `${section}.${k}`.startsWith(s) });
      },
    };
  },
  onDidChangeConfiguration: configEmitter.event,
  createFileSystemWatcher() {
    const noop = () => ({ dispose() {} });
    return { onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {} };
  },
  async openTextDocument(x: any) {
    log.push(`openTextDocument ${typeof x === 'string' ? x : x?.fsPath ?? 'untitled'}`);
    return { uri: Uri.file(typeof x === 'string' ? x : x?.fsPath ?? 'untitled'), lineCount: 100, isDirty: false, getText: () => x?.content ?? '' };
  },
  textDocuments: [] as any[],
};

// ------------------------------------------------------------------ webview qua jsdom
export const panels: FakePanel[] = [];

export class FakePanel {
  private receive: ((m: any) => any)[] = [];
  private disposeFns: (() => void)[] = [];
  dom?: JSDOM;
  disposed = false;
  pending: Promise<any>[] = [];
  options: any;
  readonly webview: any;
  constructor(public viewType: string, public title: string, opts: any) {
    this.options = opts;
    const self = this;
    this.webview = {
      cspSource: 'vscode-resource:',
      options: opts,
      asWebviewUri: (u: Uri) => ({ toString: () => `vscode-resource:${u.fsPath}` }),
      onDidReceiveMessage: (fn: any) => {
        self.receive.push(fn);
        return { dispose() {} };
      },
      postMessage: async (m: any) => {
        await new Promise((r) => setImmediate(r));
        if (!self.dom || self.disposed) return false;
        self.dom.window.dispatchEvent(new self.dom.window.MessageEvent('message', { data: m }));
        return true;
      },
      set html(h: string) {
        self.setHtml(h);
      },
      get html() {
        return self.dom?.serialize() ?? '';
      },
    };
    panels.push(this);
  }
  private setHtml(h: string) {
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(`[${this.viewType}] ${e.message}`));
    vc.on('error', (e) => errors.push(`[${this.viewType}] console.error ${e}`));
    let state: any;
    this.dom = new JSDOM(h, {
      runScripts: 'dangerously',
      virtualConsole: vc,
      beforeParse: (win: any) => {
        win.acquireVsCodeApi = () => ({
          // như VS Code thật: tin từ webview tới extension bất đồng bộ
          postMessage: (m: any) => {
            this.pending.push(new Promise((r) => setImmediate(r)).then(() => Promise.all(this.receive.map((f) => f(m)))));
          },
          getState: () => state,
          setState: (s: any) => (state = s),
        });
      },
    });
  }
  get doc(): Document {
    return this.dom!.window.document;
  }
  $(sel: string): HTMLElement | null {
    return this.doc.querySelector(sel) as HTMLElement | null;
  }
  $$(sel: string): HTMLElement[] {
    return [...this.doc.querySelectorAll(sel)] as HTMLElement[];
  }
  /** chờ các xử lý tin nhắn đang chạy xong */
  async settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      await Promise.all(this.pending.splice(0));
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  reveal() {
    log.push(`reveal ${this.title}`);
  }
  onDidDispose(fn: () => void) {
    this.disposeFns.push(fn);
    return { dispose() {} };
  }
  dispose() {
    this.disposed = true;
    this.disposeFns.forEach((f) => f());
  }
}

// ------------------------------------------------------------------ window / commands
export const trees: Record<string, any> = {};
export const terminals: string[] = [];
export const shown: string[] = [];

export const window = {
  createOutputChannel: () => ({ appendLine: (s: string) => log.push(`out: ${s}`), append() {}, clear() {}, show() {}, dispose() {} }),
  registerTreeDataProvider: (id: string, p: any) => {
    trees[id] = p;
    return { dispose() {} };
  },
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  createWebviewPanel: (viewType: string, title: string, _col: any, opts: any) => new FakePanel(viewType, title, opts),
  showInformationMessage: async (msg: string, ...items: any[]) => {
    log.push(`info: ${msg}`);
    const modal = typeof items[0] === 'object' && items[0]?.modal;
    return modal || items.length ? answer('info', undefined) : undefined;
  },
  showWarningMessage: async (msg: string, ...items: any[]) => {
    log.push(`warn: ${msg}`);
    return items.length ? answer('warn', undefined) : undefined;
  },
  showErrorMessage: async (msg: string) => {
    log.push(`error: ${msg}`);
    errors.push(`showErrorMessage: ${msg}`);
    return undefined;
  },
  showQuickPick: async (items: any[]) => {
    const a = answer('pick', undefined);
    const list = await items;
    return typeof a === 'function' ? list.find(a) : a === undefined ? undefined : list[a];
  },
  showInputBox: async () => answer('input', undefined),
  showOpenDialog: async () => answer('open', undefined),
  showTextDocument: async (x: any) => {
    shown.push(x?.fsPath ?? x?.uri?.fsPath ?? 'doc');
    return {};
  },
  createTerminal: (o: any) => ({ show() {}, sendText: (s: string) => terminals.push(`${o?.name}: ${s}`), dispose() {} }),
  withProgress: async (_o: any, fn: any) => fn({ report() {} }),
};

const cmds = new Map<string, (...a: any[]) => any>();
export const executed: string[] = [];
export const commands = {
  registerCommand: (id: string, fn: any) => {
    cmds.set(id, fn);
    return { dispose: () => cmds.delete(id) };
  },
  executeCommand: async (id: string, ...args: any[]) => {
    executed.push(id);
    if (cmds.has(id)) return cmds.get(id)!(...args);
    if (id === 'markdown.api.render') return `<div class="rendered">${String(args[0]).replace(/[<>&]/g, '').slice(0, 2000)}</div>`;
    return undefined;
  },
};

export const languages = {
  createDiagnosticCollection: () => {
    const map = new Map<string, any[]>();
    return { clear: () => map.clear(), set: (u: Uri, d: any[]) => map.set(u.fsPath, d), dispose() {}, map };
  },
};

export const env = {
  clipboard: { writeText: async (s: string) => log.push(`clipboard: ${s}`) },
  openExternal: async (u: Uri) => {
    log.push(`openExternal ${u.fsPath}`);
    return true;
  },
};

export function fakeContext(extensionPath: string) {
  const secrets = new Map<string, string>();
  return {
    subscriptions: [] as any[],
    extensionPath,
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
  };
}
