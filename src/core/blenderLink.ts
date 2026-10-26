// Nói chuyện với Blender: (1) socket của addon "MCP for Blender" — cùng giao thức với 04_PRODUCTION/BLENDER/tools/blender_bridge.py
// (Blender chạy máy Windows, cổng chuyển về localhost:9876) · (2) Blender dòng lệnh trên máy này (chạy nền, không mở cửa sổ).
import { spawn } from 'child_process';
import * as net from 'net';

export function runInBlenderSocket(host: string, port: number, code: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    let done = false;
    const finish = (err?: Error, out?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(out ?? '');
    };
    const timer = setTimeout(() => finish(new Error(`Blender không trả lời sau ${timeoutMs / 1000} s`)), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'execute_code', params: { code } })));
    sock.on('data', (d: string) => {
      buf += d;
      let resp: any;
      try {
        resp = JSON.parse(buf);
      } catch {
        return; // chưa đủ gói
      }
      if (resp.status === 'error') finish(new Error(`Blender: ${resp.message}`));
      else finish(undefined, String(resp.result?.result ?? resp.result ?? ''));
    });
    sock.on('error', (e: any) =>
      finish(new Error(e.code === 'ECONNREFUSED' ? `Không kết nối được Blender ở ${host}:${port} — Blender đã mở, addon MCP đã "Connect", cổng đã chuyển về chưa?` : e.message)),
    );
    sock.on('close', () => finish(new Error('Blender đóng kết nối')));
  });
}

/** blender -b <file> --python-expr <code> → stdout */
export function runBlenderCli(blenderPath: string, file: string, code: string, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(blenderPath, ['-b', file, '--factory-startup', '--python-expr', code], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Blender chạy quá ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được Blender (${blenderPath}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.includes('AFS_')) resolve(out);
      else reject(new Error(`Blender thoát mã ${code}: ${(err || out).slice(-600)}`));
    });
  });
}
