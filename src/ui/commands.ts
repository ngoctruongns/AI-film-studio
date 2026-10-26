// Lệnh quản lý dự án: chọn thư mục, khởi tạo .studio/, .gitignore, git đầu việc, thêm tập / phân đoạn, cấp mã, chạy script.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STUDIO_DIR, ScriptSpec, hasStudio } from '../core/config';
import { ledgerPath, loadLedger, nextSceneCode, nextSegmentCode, reserveScene, reserveSegment, saveLedger } from '../core/codes';
import { applyManagedBlock } from '../core/gitignore';
import { runsDir } from '../core/runs';
import { Episode, Segment, fill, placeholdersFor } from '../core/scanner';
import { Studio } from './studio';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))),
  );
}

function copyDir(src: string, dst: string, skip: (rel: string) => boolean, rename: (name: string) => string, transform: (text: string) => string, rel = ''): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    const to = path.join(dst, rename(e.name));
    if (e.isDirectory()) copyDir(path.join(src, e.name), to, skip, rename, transform, r);
    else if (!fs.existsSync(to)) {
      const buf = fs.readFileSync(path.join(src, e.name));
      fs.writeFileSync(to, e.name.endsWith('.md') ? transform(buf.toString('utf8')) : buf);
    }
  }
}

async function pickEpisode(studio: Studio, arg?: { ep?: Episode }): Promise<Episode | undefined> {
  if (arg?.ep) return arg.ep;
  const eps = studio.model?.episodes.filter((e) => !e.legacy) ?? [];
  const p = await vscode.window.showQuickPick(eps.map((e) => ({ label: e.id, description: e.slug, e })), { placeHolder: 'Tập nào?' });
  return p?.e;
}

async function pickSegment(studio: Studio, ep: Episode, arg?: { seg?: Segment }): Promise<Segment | undefined> {
  if (arg?.seg) return arg.seg;
  const p = await vscode.window.showQuickPick(
    ep.segments.filter((s) => !s.dropped && s.dir).map((s) => ({ label: s.code, description: s.name, s })),
    { placeHolder: 'Phân đoạn nào?' },
  );
  return p?.s;
}

export function registerCommands(context: vscode.ExtensionContext, studio: Studio): void {
  const reg = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('aiFilmStudio.refresh', () => studio.load());

  reg('aiFilmStudio.setProjectRoot', async () => {
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Chọn thư mục dự án phim' });
    if (!pick?.[0]) return;
    await studio.settings.update('projectRoot', pick[0].fsPath, vscode.ConfigurationTarget.Global);
    if (!hasStudio(pick[0].fsPath)) {
      const ok = await vscode.window.showInformationMessage('Thư mục chưa có .studio/. Khởi tạo cấu hình mẫu?', 'Khởi tạo');
      if (ok) await vscode.commands.executeCommand('aiFilmStudio.initProject');
    }
  });

  reg('aiFilmStudio.initProject', async () => {
    const root = studio.findRoot();
    if (!root) return vscode.window.showErrorMessage('Chưa có thư mục dự án — mở một thư mục hoặc chọn bằng "Chọn thư mục dự án".');
    if (hasStudio(root)) return vscode.window.showInformationMessage(`${root} đã có .studio/project.yaml.`);
    const tpl = path.join(context.extensionPath, 'templates', 'default', STUDIO_DIR);
    copyDir(tpl, path.join(root, STUDIO_DIR), () => false, (n) => n, (t) => t);
    vscode.window.showInformationMessage('Đã tạo .studio/ từ mẫu. Sửa .studio/project.yaml cho khớp cấu trúc thư mục của dự án, rồi "Cập nhật .gitignore".');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, STUDIO_DIR, 'project.yaml')));
    studio.load();
  });

  reg('aiFilmStudio.updateGitignore', async () => {
    if (!studio.root || !studio.config) return;
    const file = path.join(studio.root, '.gitignore');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = applyManagedBlock(cur, studio.config.project.gitignore ?? []);
    if (next === cur) return vscode.window.showInformationMessage('.gitignore đã đúng, không cần đổi.');
    const tmp = path.join(runsDir(studio.root), 'gitignore.proposal');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, next, 'utf8');
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(file), vscode.Uri.file(tmp), '.gitignore ↔ khối của tool');
    const ok = await vscode.window.showInformationMessage('Ghi thay đổi này vào .gitignore? (chỉ khối có đánh dấu của tool)', { modal: true }, 'Ghi');
    if (ok) {
      fs.writeFileSync(file, next, 'utf8');
      vscode.window.showInformationMessage('Đã cập nhật .gitignore.');
    }
  });

  reg('aiFilmStudio.startWork', async () => {
    if (!studio.root) return;
    try {
      const stat = await git(studio.root, ['diff', '--stat']);
      const untracked = await git(studio.root, ['ls-files', '--others', '--exclude-standard']);
      studio.output.clear();
      studio.output.appendLine('== Những gì đã sửa từ lần stage trước (git diff --stat) ==');
      studio.output.appendLine(stat || '(không có)');
      studio.output.appendLine('== File mới chưa theo dõi ==');
      studio.output.appendLine(untracked || '(không có)');
      studio.output.show(true);
      await vscode.commands.executeCommand('workbench.view.scm');
      if (!stat.trim() && !untracked.trim()) return vscode.window.showInformationMessage('Không có gì mới để stage.');
      const ok = await vscode.window.showInformationMessage(
        'Chốt phần đã sửa bằng "git add -A"? (tool không bao giờ commit)',
        { modal: true },
        'git add -A',
      );
      if (ok) {
        await git(studio.root, ['add', '-A']);
        vscode.window.showInformationMessage('Đã git add -A. Phần AI sửa sau đây sẽ nằm ngoài stage — xem bằng git diff.');
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`git: ${e.message}`);
    }
  });

  reg('aiFilmStudio.newEpisode', async () => {
    if (!studio.model) return;
    const p = studio.model.config.project;
    const nn = await vscode.window.showInputBox({ prompt: 'Số tập (vd. 02)', validateInput: (v) => (/^\d{1,2}$/.test(v) ? undefined : 'Nhập số') });
    if (!nn) return;
    const slug = await vscode.window.showInputBox({ prompt: 'Tên ngắn không dấu, nối gạch (vd. Sach-Vo-Thanh-Tro)' });
    if (!slug) return;
    const name = fill(p.episode.dirFormat ?? 'EP{nn}_{slug}', {}).replace('{nn}', nn.padStart(2, '0')).replace('{slug}', slug);
    const dst = path.join(studio.root!, p.paths.episodes, name);
    if (fs.existsSync(dst)) return vscode.window.showErrorMessage(`${name} đã có.`);
    if (p.episode.template && studio.exists(p.episode.template)) {
      // Thư mục phân đoạn mẫu không chép — phân đoạn tạo bằng lệnh "Thêm phân đoạn" để được cấp mã
      copyDir(studio.abs(p.episode.template), dst, (r) => r.startsWith(p.segment.dir + '/'), (n) => n, (t) => t);
    }
    fs.mkdirSync(path.join(dst, p.segment.dir), { recursive: true });
    studio.refresh();
    vscode.window.showInformationMessage(`Đã tạo ${name}.`);
  });

  reg('aiFilmStudio.newSegment', async (node?: { ep?: Episode }) => {
    if (!studio.model) return;
    const ep = await pickEpisode(studio, node);
    if (!ep) return;
    const lp = ledgerPath(studio.model);
    const ledger = loadLedger(lp);
    const code = nextSegmentCode(ledger, ep.id);
    if (!code) return vscode.window.showErrorMessage('Hết chữ A–Z cho phân đoạn.');
    const slug = await vscode.window.showInputBox({ prompt: `Phân đoạn mới mã ${code} — tên ngắn không dấu (vd. tay-do-bi-pha)` });
    if (!slug) return;
    const p = studio.model.config.project;
    const dst = path.join(ep.dir, p.segment.dir, `${code}_${slug}`);
    if (p.segment.template && studio.exists(p.segment.template)) {
      // Mẫu dùng mã 'A' → đổi sang mã mới cả trong tên file lẫn nội dung (A_canh.md → K_canh.md, A01 → K01)
      copyDir(
        studio.abs(p.segment.template),
        dst,
        () => false,
        (n) => n.replace(/^A_/, `${code}_`),
        (t) => t.replace(/\bA(\d{2})/g, `${code}$1`).replace(/\bA_/g, `${code}_`),
      );
    } else fs.mkdirSync(dst, { recursive: true });
    reserveSegment(ledger, ep.id, code);
    saveLedger(lp, ledger);
    studio.refresh();
    vscode.window.showInformationMessage(`Đã cấp mã ${code} và tạo ${path.basename(dst)}. Nhớ thêm dòng ${code} vào bảng phân đoạn (README tập) đúng thứ tự chiếu.`);
    if (ep.files['readme']) await vscode.window.showTextDocument(vscode.Uri.file(ep.files['readme']), { preview: false });
  });

  reg('aiFilmStudio.newSceneCode', async (node?: { ep?: Episode; seg?: Segment }) => {
    if (!studio.model) return;
    const ep = await pickEpisode(studio, node);
    const seg = ep && (await pickSegment(studio, ep, node));
    if (!ep || !seg) return;
    const lp = ledgerPath(studio.model);
    const ledger = loadLedger(lp);
    const code = nextSceneCode(ledger, ep.id, seg.code);
    if (!code) return vscode.window.showErrorMessage(`Phân đoạn ${seg.code} đã dùng hết 99 mã cảnh.`);
    reserveScene(ledger, ep.id, code);
    saveLedger(lp, ledger);
    await vscode.env.clipboard.writeText(code);
    vscode.window.showInformationMessage(`Mã cảnh mới: ${code} (đã chép). Chèn dòng vào bảng cảnh đúng thứ tự chiếu.`);
  });

  reg('aiFilmStudio.runScript', async (node?: { ep?: Episode; seg?: Segment }) => {
    if (!studio.model) return;
    const scripts = studio.model.config.project.scripts ?? [];
    const pick = await vscode.window.showQuickPick(scripts.map((s) => ({ label: s.label, description: s.command, s })), { placeHolder: 'Chạy script nào?' });
    if (!pick) return;
    const s: ScriptSpec = pick.s;
    let ep = node?.ep;
    let seg = node?.seg;
    if (/\{(episodeDir|ep|segmentDir|X)\}/.test(s.command) && !ep) ep = await pickEpisode(studio);
    if (/\{(segmentDir|X)\}/.test(s.command) && ep && !seg) seg = await pickSegment(studio, ep);
    const ph = placeholdersFor(studio.model, ep, seg);
    if (s.command.includes('{scene}')) ph.scene = await vscode.window.showInputBox({ prompt: 'Mã cảnh / dải cảnh (vd. F02-F06)' });
    const term = vscode.window.createTerminal({ name: `Script · ${s.label}`, cwd: studio.root });
    term.show();
    term.sendText(fill(s.command, ph));
  });
}
