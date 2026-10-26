// Trạng thái chung của extension: gốc dự án, cấu hình, mô hình đã quét, ghi chú, lỗi soát. Quét lại khi file đổi.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StudioConfig, hasStudio, loadStudioConfig } from '../core/config';
import { ledgerPath, loadLedger, saveLedger, syncLedger } from '../core/codes';
import { Issue, lintProject } from '../core/lint';
import { Note, scanNotes } from '../core/notes';
import { ProjectModel, scanProject } from '../core/scanner';

export class Studio implements vscode.Disposable {
  root?: string;
  config?: StudioConfig;
  model?: ProjectModel;
  notes: Note[] = [];
  issues: Issue[] = [];
  error?: string;
  readonly output = vscode.window.createOutputChannel('AI Film Studio');

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aiFilmStudio.projectRoot') || e.affectsConfiguration('aiFilmStudio.mediaRoot')) this.load();
      }),
    );
  }

  get settings() {
    return vscode.workspace.getConfiguration('aiFilmStudio');
  }

  /** Gốc dự án: setting → thư mục workspace có .studio/project.yaml → thư mục workspace đầu tiên */
  findRoot(): string | undefined {
    const configured = this.settings.get<string>('projectRoot');
    if (configured) return configured;
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.find((f) => hasStudio(f.uri.fsPath))?.uri.fsPath ?? folders[0]?.uri.fsPath;
  }

  load(): void {
    this.root = this.findRoot();
    this.watcher?.dispose();
    this.watcher = undefined;
    this.config = undefined;
    this.model = undefined;
    vscode.commands.executeCommand('setContext', 'aiFilmStudio.ready', false);
    if (!this.root || !hasStudio(this.root)) {
      this.error = this.root ? `Thư mục ${this.root} chưa có .studio/project.yaml` : 'Chưa mở thư mục nào';
      this.changed.fire();
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*.{md,yaml,json}'));
    const kick = (u: vscode.Uri) => {
      if (!u.fsPath.includes(`${path.sep}.studio${path.sep}runs${path.sep}`)) this.scheduleRefresh();
    };
    this.watcher.onDidChange(kick);
    this.watcher.onDidCreate(kick);
    this.watcher.onDidDelete(kick);
    this.refresh();
  }

  scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 600);
  }

  refresh(): void {
    if (!this.root) return this.load();
    try {
      this.config = loadStudioConfig(this.root);
      this.model = scanProject(this.config, this.settings.get<string>('mediaRoot') || undefined);
      this.notes = scanNotes(this.root, this.config.project);
      this.issues = lintProject(this.model);
      // Sổ mã: ghi thêm mọi mã đang thấy → mã bỏ sau này vẫn không bị cấp lại
      const lp = ledgerPath(this.model);
      const ledger = loadLedger(lp);
      if (syncLedger(this.model, ledger)) saveLedger(lp, ledger);
      this.error = undefined;
      vscode.commands.executeCommand('setContext', 'aiFilmStudio.ready', true);
    } catch (e: any) {
      this.error = `Lỗi đọc cấu hình .studio/: ${e.message}`;
      this.output.appendLine(this.error);
    }
    this.changed.fire();
  }

  rel(abs: string): string {
    return this.root ? path.relative(this.root, abs).split(path.sep).join('/') : abs;
  }

  abs(rel: string): string {
    return path.isAbsolute(rel) ? rel : path.join(this.root ?? '', rel);
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  dispose(): void {
    this.watcher?.dispose();
    this.changed.dispose();
    this.output.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export async function openFileAt(abs: string, line = 0, beside = true): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(abs);
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  await vscode.window.showTextDocument(doc, {
    viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    selection: new vscode.Range(pos, pos),
    preview: false,
  });
}

export async function openPreview(abs: string): Promise<void> {
  await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(abs));
}
