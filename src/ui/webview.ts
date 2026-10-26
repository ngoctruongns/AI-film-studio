// Phần dùng chung cho các tab webview: khung HTML + CSP, CSS theo theme VS Code, render markdown có link mở file.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Studio, openFileAt, openPreview } from './studio';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const BASE_CSS = `
:root { --gap: 12px; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  background: var(--vscode-editor-background); padding: 0 16px 32px; line-height: 1.5; }
h1 { font-size: 1.35em; margin: 16px 0 4px; }
h2 { font-size: 1.1em; margin: 20px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
.muted { color: var(--vscode-descriptionForeground); }
.row { display: flex; gap: var(--gap); flex-wrap: wrap; align-items: center; }
.col { display: flex; flex-direction: column; gap: 6px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
  padding: 4px 10px; border-radius: 2px; cursor: pointer; font: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.sec:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
button:disabled { opacity: .5; cursor: default; }
select, textarea, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); font: inherit; padding: 4px; }
textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; vertical-align: top; }
th { background: var(--vscode-editorWidget-background); }
a, [data-open] { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover, [data-open]:hover { text-decoration: underline; }
code { font-family: var(--vscode-editor-font-family); }
.badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: .85em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.warn { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 6px 10px; background: var(--vscode-editorWidget-background); }
.err { color: var(--vscode-errorForeground); }
.ok { color: var(--vscode-testing-iconPassed, #3c3); }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 12px; }
.md { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0 14px; max-height: 70vh; overflow: auto; }
.md table { font-size: .92em; }
.scroll-x { overflow-x: auto; }
`;

export function shell(webview: vscode.Webview, title: string, body: string, script = ''): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: https:`,
    `media-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<style>${BASE_CSS}</style></head><body>${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-open],[data-cmd]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.open) vscode.postMessage({ type: 'open', path: el.dataset.open, line: Number(el.dataset.line || 0), how: el.dataset.how || 'edit' });
  else vscode.postMessage({ type: 'cmd', cmd: el.dataset.cmd, arg: el.dataset.arg });
});
${script}
</script></body></html>`;
}

/** Render markdown bằng chính bộ render của VS Code, biến link tương đối và `đường/dẫn` thành link mở file. */
export async function renderMarkdown(studio: Studio, text: string, baseFile: string): Promise<string> {
  let html: string;
  try {
    html = (await vscode.commands.executeCommand<string>('markdown.api.render', text)) ?? '';
  } catch {
    html = `<pre>${esc(text)}</pre>`;
  }
  const baseDir = path.dirname(baseFile);
  const resolve = (p: string): string | undefined => {
    const clean = p.replace(/[#?].*$/, '').replace(/\/+$/, '');
    if (!clean || /^[a-z]+:/i.test(clean) || clean.includes('<') || clean.includes('*')) return undefined;
    for (const cand of [path.resolve(baseDir, clean), studio.abs(clean)]) {
      if (fs.existsSync(cand)) return cand;
    }
    return undefined;
  };
  html = html.replace(/<a href="([^"]*)"/g, (all, href) => {
    if (/^https?:/.test(href)) return all;
    const abs = resolve(decodeURI(href));
    return abs ? `<a data-open="${esc(abs)}"` : all;
  });
  html = html.replace(/<code>([^<]{3,200})<\/code>/g, (all, inner) => {
    const raw = inner.replace(/&amp;/g, '&');
    if (!/[/.]/.test(raw) || /\s/.test(raw.trim())) return all;
    const abs = resolve(raw.trim());
    return abs ? `<a data-open="${esc(abs)}"><code>${inner}</code></a>` : all;
  });
  return html;
}

/** Xử lý tin nhắn 'open' chung: edit = editor bên cạnh · preview = markdown preview · reveal = hiện trong Explorer */
export async function handleOpen(msg: { path: string; line?: number; how?: string }): Promise<void> {
  const p = msg.path;
  if (!fs.existsSync(p)) {
    vscode.window.showWarningMessage(`Không thấy ${p}`);
    return;
  }
  if (fs.statSync(p).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p));
    return;
  }
  if (msg.how === 'preview' && p.endsWith('.md')) return openPreview(p);
  if (!/\.(md|txt|py|yaml|yml|json|sh|bat|csv)$/i.test(p)) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), vscode.ViewColumn.Beside);
    return;
  }
  await openFileAt(p, msg.line ?? 0);
}
