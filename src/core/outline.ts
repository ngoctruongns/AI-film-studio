// Bước ③ Dàn ý: mỗi tập một file dan-y.md. Trạng thái duyệt = ghi chú của tool ở đầu file: <!-- @tool dan-y: ✅ đã duyệt -->
// (quy ước ghi chú 29/10/2026: <!-- @tool … --> tool ghi · /*@C … */ người dùng → AI · /*@T … */ AI → người dùng).
// Tool tự giữ khi lưu, ô sửa không hiện dòng này; xem .md trên GitHub cũng không thấy. Dạng cũ <!-- dan-y: ✅ … --> vẫn đọc.

const MARK_RE = /^<!--\s*(?:@tool\s+)?dan-y:\s*(✅|⬜)[^>]*-->[ \t]*\r?\n?/m;
const MARK_DONE = '<!-- @tool dan-y: ✅ đã duyệt -->';

export type OutlineStatus = 'done' | 'todo' | 'none';

/** none = chưa có chữ nào · todo = có dàn ý, chưa duyệt · done = đã duyệt */
export function outlineStatus(text: string): OutlineStatus {
  if (!stripOutlineStatus(text).trim()) return 'none';
  return MARK_RE.exec(text)?.[1] === '✅' ? 'done' : 'todo';
}

export function stripOutlineStatus(text: string): string {
  return text.replace(MARK_RE, '');
}

/** nội dung (không dòng trạng thái) + trạng thái → nội dung file */
export function withOutlineStatus(body: string, done: boolean): string {
  const b = stripOutlineStatus(body).replace(/\s*$/, '\n');
  return done ? `${MARK_DONE}\n${b}` : b;
}
