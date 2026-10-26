// Tool chỉ ghi trong khối có đánh dấu — phần người dùng tự viết trong .gitignore không bao giờ bị đụng.
export const BLOCK_BEGIN = '# >>> ai-film-studio (khối do tool quản lý — sửa ở .studio/project.yaml, mục gitignore)';
export const BLOCK_END = '# <<< ai-film-studio';

/** Luôn có: nhật ký chạy AI (prompt, kết quả nháp) không vào git */
export const ALWAYS = ['.studio/runs/'];

export function applyManagedBlock(content: string, rules: string[]): string {
  const lines = [...new Set([...ALWAYS, ...rules])];
  const block = [BLOCK_BEGIN, ...lines, BLOCK_END].join('\n');
  const start = content.indexOf(BLOCK_BEGIN.split(' (')[0]);
  const end = content.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  }
  const base = content.replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + block + '\n';
}
