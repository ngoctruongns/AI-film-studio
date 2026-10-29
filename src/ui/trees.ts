// Sidebar: cây Dự án (tập → phân đoạn → cảnh) và danh sách ghi chú @C / @T.
import * as path from 'path';
import * as vscode from 'vscode';
import { Scope, STATUS_LABEL, statusSymbol } from '../core/config';
import { StepTarget } from '../core/context';
import { formatDuration } from '../core/markdown';
import { Episode, Scene, Segment, episodeLabel } from '../core/scanner';
import { Note } from '../core/notes';
import { scanBlender } from '../core/blender';
import { ResourceEntry, ResourceFile, listResources } from '../core/resources';
import { Studio } from './studio';

export type ProjectNode =
  | { kind: 'dashboard' }
  | { kind: 'guides' }
  | { kind: 'resources' }
  | { kind: 'resGroup'; group: string; entries: ResourceEntry[] }
  | { kind: 'resDir'; entry: ResourceEntry }
  | { kind: 'resFile'; file: ResourceFile }
  | { kind: 'project' }
  | { kind: 'episode'; ep: Episode }
  | { kind: 'blender'; ep: Episode }
  | { kind: 'segment'; ep: Episode; seg: Segment }
  | { kind: 'scene'; ep: Episode; seg: Segment; scene: Scene };

export function nodeTarget(n: ProjectNode | undefined): { scope: Scope; target: StepTarget } {
  switch (n?.kind) {
    case 'episode':
      return { scope: 'episode', target: { ep: n.ep.id } };
    case 'segment':
      return { scope: 'segment', target: { ep: n.ep.id, seg: n.seg.code } };
    case 'scene':
      return { scope: 'scene', target: { ep: n.ep.id, seg: n.seg.code, scene: n.scene.code } };
    default:
      return { scope: 'project', target: {} };
  }
}

export class ProjectTree implements vscode.TreeDataProvider<ProjectNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private studio: Studio) {
    studio.onDidChange(() => this.emitter.fire());
  }

  getChildren(n?: ProjectNode): ProjectNode[] {
    const model = this.studio.model;
    if (!model) return [];
    if (!n) return [{ kind: 'dashboard' }, { kind: 'guides' }, { kind: 'resources' }, { kind: 'project' }, ...model.episodes.map((ep) => ({ kind: 'episode' as const, ep }))];
    if (n.kind === 'guides')
      return listResources(model.config.root, model.config.project.guides).map((g) => ({ kind: 'resGroup' as const, group: g.group, entries: g.entries }));
    if (n.kind === 'resources')
      return listResources(model.config.root, model.config.project.resources).map((g) => ({ kind: 'resGroup' as const, group: g.group, entries: g.entries }));
    if (n.kind === 'resGroup')
      return n.entries.map((e) => (e.dir ? { kind: 'resDir' as const, entry: e } : { kind: 'resFile' as const, file: e.files[0] }));
    if (n.kind === 'resDir') return n.entry.files.map((file) => ({ kind: 'resFile' as const, file }));
    if (n.kind === 'episode') {
      const segs = n.ep.segments.map((seg) => ({ kind: 'segment' as const, ep: n.ep, seg }));
      return n.ep.legacy ? segs : [{ kind: 'blender' as const, ep: n.ep }, ...segs];
    }
    if (n.kind === 'segment') return n.seg.scenes.map((scene) => ({ kind: 'scene' as const, ep: n.ep, seg: n.seg, scene }));
    return [];
  }

  getTreeItem(n: ProjectNode): vscode.TreeItem {
    const st = this.studio.config!.project.status;
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'dashboard': {
        const it = new vscode.TreeItem('Trạng thái dự án', C.None);
        it.iconPath = new vscode.ThemeIcon('dashboard');
        it.command = { command: 'aiFilmStudio.openDashboard', title: '' };
        return it;
      }
      case 'guides': {
        const it = new vscode.TreeItem('Tài liệu hướng dẫn', C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('question');
        it.description = 'tool · quy trình · Blender · Dreamina · KdenLive';
        it.tooltip = 'Hướng dẫn cho người làm phim — cấu hình ở .studio/project.yaml (guides)';
        return it;
      }
      case 'resources': {
        const it = new vscode.TreeItem('Tài nguyên dự án', C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('library');
        it.description = 'sử liệu · quy trình · kiến thức';
        it.tooltip = 'Tài liệu dùng chung cả dự án — cấu hình ở .studio/project.yaml (resources)';
        return it;
      }
      case 'resGroup': {
        const it = new vscode.TreeItem(n.group, C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('folder-library');
        it.description = `${n.entries.reduce((a, e) => a + e.files.length, 0)} file`;
        return it;
      }
      case 'resDir': {
        const it = new vscode.TreeItem(n.entry.label, n.entry.files.length ? C.Collapsed : C.None);
        it.iconPath = vscode.ThemeIcon.Folder;
        it.description = n.entry.files.length ? `${n.entry.files.length} file` : 'trống';
        it.tooltip = n.entry.dir;
        return it;
      }
      case 'resFile': {
        const f = n.file;
        const it = new vscode.TreeItem(f.label, C.None);
        it.iconPath = new vscode.ThemeIcon(f.exists ? 'book' : 'warning');
        it.description = f.exists ? '' : 'chưa có file';
        it.tooltip = f.rel;
        it.contextValue = 'resource';
        if (f.exists) {
          it.resourceUri = vscode.Uri.file(f.abs);
          it.command = { command: 'markdown.showPreview', title: '', arguments: [vscode.Uri.file(f.abs)] };
        }
        return it;
      }
      case 'project': {
        const it = new vscode.TreeItem('Ý tưởng – phong cách', C.None);
        it.description = '① ý tưởng · ② tóm tắt + chia tập · ③ dàn ý';
        it.iconPath = new vscode.ThemeIcon('book');
        it.contextValue = 'project';
        it.command = { command: 'aiFilmStudio.openTarget', title: '', arguments: [n] };
        return it;
      }
      case 'episode': {
        const ep = n.ep;
        const live = ep.segments.filter((s) => !s.dropped);
        const it = new vscode.TreeItem(episodeLabel(ep), live.length || !ep.legacy ? C.Collapsed : C.None);
        const tag = ep.release ? ep.id : '';
        it.description = ep.dropped
          ? `${ep.id} · bỏ`
          : ep.legacy
          ? `${tag} cấu trúc cũ`.trim()
          : `${tag ? tag + ' · ' : ''}${live.length} đoạn · ${live.reduce((a, s) => a + s.scenes.length, 0)} cảnh · ${formatDuration(ep.sceneSeconds)}`;
        it.iconPath = new vscode.ThemeIcon(ep.legacy ? 'archive' : 'device-camera-video');
        it.contextValue = 'episode';
        it.tooltip = `${ep.relDir}${ep.releaseDate ? `\nPhát hành: ${ep.releaseDate.toLocaleDateString('vi-VN')}` : ''}`;
        it.command = { command: 'aiFilmStudio.openTarget', title: '', arguments: [n] };
        return it;
      }
      case 'blender': {
        const bm = scanBlender(this.studio.model!, n.ep);
        const it = new vscode.TreeItem('🧊 Blender', C.None);
        const files = bm.files.filter((f) => !f.shared).length;
        const warn = bm.issues.filter((i) => i.severity === 'warning').length;
        it.description = `${files} file · ${bm.shots.length} shot${warn ? ` · ⚠ ${warn}` : ''}`;
        it.tooltip = 'File .blend, script dựng, shot (marker) → frame → cảnh của tập';
        it.contextValue = 'blender';
        it.command = { command: 'aiFilmStudio.openBlender', title: '', arguments: [n] };
        return it;
      }
      case 'segment': {
        const s = n.seg;
        const it = new vscode.TreeItem(`${s.code} · ${s.name}`, s.scenes.length ? C.Collapsed : C.None);
        it.description = s.dropped ? 'bỏ' : `${statusSymbol(s.status, st)} ${s.scenes.length ? s.scenes.length + ' cảnh' : 'chưa chia cảnh'}`;
        it.iconPath = new vscode.ThemeIcon(s.dropped ? 'circle-slash' : 'symbol-namespace');
        it.contextValue = s.dropped ? 'segment-dropped' : 'segment';
        it.tooltip = `${s.relDir ?? '(chưa có thư mục)'}\n${s.statusText}`;
        if (!s.dropped) it.command = { command: 'aiFilmStudio.openTarget', title: '', arguments: [n] };
        return it;
      }
      case 'scene': {
        const c = n.scene;
        const it = new vscode.TreeItem(`${statusSymbol(c.status, st) || '·'} ${c.code}${c.seconds ? ` · ${c.seconds}s` : ''}`, C.None);
        it.description = c.title;
        const v = c.media['V'] ?? 0;
        it.tooltip = new vscode.MarkdownString(
          `**${c.code}** — ${c.status ? STATUS_LABEL[c.status] : '?'}\n\n${c.title}\n\nVideo AI đã sinh: ${v}`,
        );
        it.contextValue = 'scene';
        it.command = { command: 'aiFilmStudio.openTarget', title: '', arguments: [n] };
        return it;
      }
    }
  }
}

type NoteNode = { group: Note['kind'] } | { note: Note };

export class NotesTree implements vscode.TreeDataProvider<NoteNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private studio: Studio) {
    studio.onDidChange(() => this.emitter.fire());
  }

  getChildren(n?: NoteNode): NoteNode[] {
    if (!n) return [{ group: 'todo' }, { group: 'question' }];
    if ('group' in n) return this.studio.notes.filter((x) => x.kind === n.group).map((note) => ({ note }));
    return [];
  }

  getTreeItem(n: NoteNode): vscode.TreeItem {
    if ('group' in n) {
      const count = this.studio.notes.filter((x) => x.kind === n.group).length;
      const it = new vscode.TreeItem(
        n.group === 'todo' ? `@C — việc cho AI (${count})` : `@T — câu hỏi cho người (${count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      it.iconPath = new vscode.ThemeIcon(n.group === 'todo' ? 'checklist' : 'question');
      return it;
    }
    const { note } = n;
    const it = new vscode.TreeItem(note.text || '(trống)', vscode.TreeItemCollapsibleState.None);
    it.description = `${path.basename(note.file)}:${note.line + 1}`;
    it.tooltip = `${this.studio.rel(note.file)}:${note.line + 1}\n${note.text}`;
    it.command = {
      command: 'vscode.open',
      title: '',
      arguments: [vscode.Uri.file(note.file), { selection: new vscode.Range(note.line, 0, note.line, 0) }],
    };
    return it;
  }
}
