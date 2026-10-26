// Claude Code CLI ở chế độ không tương tác: `claude -p --output-format json`.
// Dùng được ở máy chỉ có Claude Code (không cần khóa API). Mặc định TẮT mọi công cụ (--tools "")
// và MCP (--strict-mcp-config) → chỉ trả văn bản, không tự sửa file; tool tự ghép ngữ cảnh.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatRequest, ChatResult, Provider } from './types';

/** Tìm CLI: cấu hình → PATH → bản đi kèm extension Claude Code */
export function findClaudeCli(configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  for (const base of ['.vscode-server', '.vscode', '.cursor-server', '.vscode-insiders'].map((d) => path.join(os.homedir(), d, 'extensions'))) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(base).filter((d) => d.startsWith('anthropic.claude-code')).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = path.join(base, d, 'resources', 'native-binary', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return exe;
}

export class ClaudeCodeProvider implements Provider {
  id = 'claude-code' as const;
  loadsProjectInstructions = true;
  needsKey = false;
  constructor(private cliPath: string) {}

  complete(req: ChatRequest): Promise<ChatResult> {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config'];
    if (req.model.model) args.push('--model', req.model.model);
    if (req.system) args.push('--append-system-prompt', req.system);
    args.push(...(req.model.extraArgs ?? []));

    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath, args, { cwd: req.cwd, env: process.env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d;
        req.onProgress?.(`… đã nhận ${out.length} ký tự`);
      });
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => reject(new Error(`Không chạy được Claude CLI (${this.cliPath}): ${e.message}`)));
      req.signal?.addEventListener('abort', () => child.kill());
      child.on('close', (code) => {
        if (req.signal?.aborted) return reject(new Error('Đã hủy'));
        let j: any;
        try {
          j = JSON.parse(out);
        } catch {
          return reject(new Error(`Claude CLI thoát mã ${code}: ${(err || out).slice(0, 800)}`));
        }
        if (j.is_error) return reject(new Error(`Claude: ${String(j.result ?? j.subtype).slice(0, 800)}`));
        const u = j.usage ?? {};
        resolve({
          text: String(j.result ?? ''),
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          costUsd: j.total_cost_usd,
          costReported: j.total_cost_usd !== undefined,
        });
      });
      child.stdin.end(req.prompt);
    });
  }
}
