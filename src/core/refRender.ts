// Render tham chiếu của một tập bằng script của dự án (blender.refRender, vd. render_tham_chieu.py):
// "<script> <tập> --ds" in JSON mọi mục trong sổ (sheet · ảnh tĩnh · clip · key frame) + file ra đã có chưa,
// kèm prompt ảnh thật của sheet / ảnh tĩnh (blender/ANH-THAT_prompt.md, mục cùng mã);
// tool chỉ đọc danh sách đó và dựng lệnh render — không tự đọc sổ, không có danh sách cứng.
import { execFile } from 'child_process';
import * as fs from 'fs';

export type RefKind = 'sheet' | 'anh' | 'clip' | 'key';

export interface RefPrompt {
  /** file prompt (tương đối gốc repo) + dòng tiêu đề mục (đếm từ 1) */
  file: string;
  dong: number;
  ra?: string;
  nap?: string;
  model?: string;
  /** prompt đã ghép khung chung, thay sẵn tên file — chép là dán được */
  prompt?: string;
}

export interface RefItem {
  loai: RefKind;
  ma: string;
  /** đường dẫn file ra (máy này) */
  dich: string;
  co: boolean;
  file?: string;
  frame?: [number, number];
  canh?: string;
  phan_doan?: string[];
  prompt?: RefPrompt;
}

export interface RefList {
  tap: string;
  out: string;
  /** file prompt ảnh thật của tập (tương đối gốc repo) — có thể chưa tồn tại */
  prompt_file?: string;
  ds: RefItem[];
}

export function pythonCommand(setting: string | undefined): string {
  return setting || (process.platform === 'win32' ? 'python' : 'python3');
}

export function listRefs(python: string, script: string, ep: string, cwd: string, timeoutMs = 30000): Promise<RefList> {
  return new Promise((resolve, reject) => {
    execFile(python, [script, ep, '--ds'], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      if (err) return reject(new Error(`${python} ${script} ${ep} --ds: ${(errOut || err.message).trim().slice(-400)}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() || ''));
      } catch {
        reject(new Error(`Script render không trả danh sách JSON: ${out.slice(-300)}`));
      }
    });
  });
}

/** Cập nhật cột "đã có" theo đĩa — trả true nếu có gì đổi (render xong một file). */
export function recheck(list: RefList): boolean {
  let changed = false;
  for (const it of list.ds) {
    const co = fs.existsSync(it.dich);
    if (co !== it.co) {
      it.co = co;
      changed = true;
    }
  }
  return changed;
}

const q = (s: string) => (/[\s"']/.test(s) ? `"${s}"` : s);

/** Lệnh gõ vào terminal (thư mục gốc repo). chi = mã / tiền tố · phan = sheet,anh,clip,key. */
export function refCommand(o: { python: string; script: string; ep: string; chi?: string; phan?: string; lai?: boolean; dryRun?: boolean; blender?: string }): string {
  const py = q(o.python);
  const parts = [process.platform === 'win32' && py.startsWith('"') ? `& ${py}` : py, q(o.script), o.ep];
  if (o.chi) parts.push('--chi', o.chi);
  if (o.phan) parts.push('--phan', o.phan);
  if (o.lai) parts.push('--lai');
  if (o.dryRun) parts.push('--in');
  if (o.blender) parts.push('--blender', `"${o.blender}"`);
  return parts.join(' ');
}
