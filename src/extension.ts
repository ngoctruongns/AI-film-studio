import * as vscode from 'vscode';
import { Scope } from './core/config';
import { StepTarget } from './core/context';
import { registerCommands } from './ui/commands';
import { BlenderPanel, blenderSocket } from './ui/blenderPanel';
import { Dashboard } from './ui/dashboard';
import { GridPanel } from './ui/gridPanel';
import { ModelRegistry } from './ui/models';
import { SettingsPanel } from './ui/settingsPanel';
import { StepPanel } from './ui/stepPanel';
import { Studio } from './ui/studio';
import { NotesTree, ProjectNode, ProjectTree, nodeTarget } from './ui/trees';

export function activate(context: vscode.ExtensionContext): void {
  const studio = new Studio(context);
  const models = new ModelRegistry(studio, context.secrets);
  const diagnostics = vscode.languages.createDiagnosticCollection('ai-film-studio');
  context.subscriptions.push(studio, diagnostics);

  const openStep = (stepId: string, target: StepTarget) => StepPanel.open(studio, models, stepId, target);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiFilmStudio.project', new ProjectTree(studio)),
    vscode.window.registerTreeDataProvider('aiFilmStudio.notes', new NotesTree(studio)),
    vscode.window.registerWebviewPanelSerializer(StepPanel.viewType, {
      async deserializeWebviewPanel(panel, state) {
        StepPanel.revive(panel, studio, models, state as any);
      },
    }),
    vscode.window.registerWebviewPanelSerializer('aiFilmStudio.dashboard', {
      async deserializeWebviewPanel(panel) {
        panel.dispose();
        Dashboard.show(studio, openStep);
      },
    }),
  );

  // Soát nhất quán → tab Problems
  studio.onDidChange(() => {
    diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
    for (const i of studio.issues) {
      const d = new vscode.Diagnostic(new vscode.Range(i.line, 0, i.line, 200), i.message, sev[i.severity]);
      d.source = 'AI Film Studio';
      byFile.set(i.file, [...(byFile.get(i.file) ?? []), d]);
    }
    for (const [f, ds] of byFile) diagnostics.set(vscode.Uri.file(f), ds);
  });

  const reg = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('aiFilmStudio.openDashboard', () => Dashboard.show(studio, openStep));
  reg('aiFilmStudio.openSettings', () => SettingsPanel.show(studio, models));
  reg('aiFilmStudio.openStep', openStep);
  reg('aiFilmStudio.openTarget', (node?: ProjectNode) => {
    if (!studio.config) return vscode.window.showWarningMessage(studio.error ?? 'Chưa nạp dự án.');
    StepPanel.open(studio, models, undefined, nodeTarget(node).target);
  });
  reg('aiFilmStudio.pickStep', async (node?: ProjectNode) => {
    if (!studio.config) return vscode.window.showWarningMessage(studio.error ?? 'Chưa nạp dự án.');
    const { scope, target } = nodeTarget(node);
    const steps = studio.config.pipeline.steps.filter((s) => s.scope === (scope as Scope));
    if (!steps.length) return;
    const pick = await vscode.window.showQuickPick(
      steps.map((s) => ({
        label: `${s.no} ${s.title}`,
        description: `${{ human: 'người làm', chat: 'AI', agent: 'Claude Code' }[s.executor]} · ${models.forStep(s.id)?.id ?? ''}`,
        detail: s.description,
        s,
      })),
      { placeHolder: `Mở bước nào cho ${Object.values(target).join('·') || 'cả dự án'}?` },
    );
    if (pick) openStep(pick.s.id, target);
  });
  reg('aiFilmStudio.editEpisodeList', () => studio.model && GridPanel.open(studio));
  reg('aiFilmStudio.editSceneTable', async (arg?: ProjectNode | { ep?: string; seg?: string }) => {
    let ep: string | undefined;
    let seg: string | undefined;
    if (arg && 'kind' in arg && (arg.kind === 'segment' || arg.kind === 'scene')) {
      ep = arg.ep.id;
      seg = arg.seg.code;
    } else if (arg && !('kind' in arg)) {
      ep = arg.ep;
      seg = arg.seg;
    }
    if (!ep || !seg) {
      const segs = (studio.model?.episodes ?? []).flatMap((e) => e.segments.filter((s) => s.files['canh']).map((s) => ({ label: `${e.id} · ${s.code}`, description: s.name, e: e.id, s: s.code })));
      const p = await vscode.window.showQuickPick(segs, { placeHolder: 'Sửa bảng cảnh của phân đoạn nào?' });
      if (!p) return;
      ep = p.e;
      seg = p.s;
    }
    GridPanel.open(studio, ep, seg);
  });
  reg('aiFilmStudio.openBlender', async (arg?: ProjectNode | { ep?: string }) => {
    let ep = arg && 'kind' in arg ? ('ep' in arg ? arg.ep.id : undefined) : arg?.ep;
    if (!ep) {
      const eps = (studio.model?.episodes ?? []).filter((e) => !e.legacy);
      const p = eps.length === 1 ? { e: eps[0].id } : await vscode.window.showQuickPick(eps.map((e) => ({ label: e.id, description: e.slug, e: e.id })), { placeHolder: 'Blender của tập nào?' });
      ep = p?.e;
    }
    if (ep) BlenderPanel.open(studio, ep);
  });
  reg('aiFilmStudio.blenderPing', async () => {
    const out = await blenderSocket(studio, "import bpy\nprint('AFS_OK:' + bpy.app.version_string + ' | ' + (bpy.data.filepath or '(chưa lưu)'))");
    return /AFS_OK:(.*)/.exec(out)?.[1]?.trim() ?? out.trim();
  });
  reg('aiFilmStudio.endSession', () => {
    if (!studio.config?.pipeline.steps.some((s) => s.id === 'ket-thuc-phien')) {
      return vscode.window.showWarningMessage('pipeline.yaml chưa có bước "ket-thuc-phien".');
    }
    openStep('ket-thuc-phien', {});
  });
  reg('aiFilmStudio.setApiKey', () => SettingsPanel.show(studio, models));
  reg('aiFilmStudio.testModel', () => SettingsPanel.show(studio, models));
  registerCommands(context, studio);

  studio.load();
}

export function deactivate(): void {}
