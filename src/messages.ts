// Readable Vietnamese for the refusals a save command can meet (0.13.0, item 5): zod's own wording ("Too small: expected array to
// have >=1 items") and the draft validator's codes ("BAD_LENGTH content.participants[0].role") told the agent nothing about what to fix
// (23/11: `pma picture` with a missing --sources only said "Too small"). Pure functions, no state. The codes stay in the text so that
// anything matching them keeps working; the explanation is added, never substituted.
import type { z } from 'zod';

// What the caller types for a field of the request, so the message names the flag, not the JSON key.
const FIELD: Record<string, string> = {
  sourceIds: '--sources (các #id của đoạn đã đọc)', sourceId: '--source (một #id)', expectedRevision: '--base (bản đã đọc; lần đầu 0)', receipt: '--receipt (rcpt-… của pma brief --as chinh)',
  idempotencyKey: '--key', sessionId: '--session', markdown: 'nội dung SUMMARY (--file)', text: 'nội dung (--file hoặc --text)', items: 'danh sách bản dịch', tasks: 'danh sách việc',
  participants: 'danh sách người dự', result: 'kết quả (--file hoặc --text)', token: '--token (job-… của pma job start)', title: 'tên', id: 'số id',
};
const nameOf = (path: PropertyKey[]) => { const last = [...path].reverse().find(p => typeof p === 'string') as string | undefined; return (last && FIELD[last]) || (path.length ? path.join('.') : 'dữ liệu'); };

// One zod issue in words. Unknown shapes fall back to zod's own message after the field name, so nothing is ever hidden.
export function explainIssue(issue: { code?: string; path: PropertyKey[]; message: string; [key: string]: unknown }): string {
  const name = nameOf(issue.path); const last = [...issue.path].reverse().find(p => typeof p === 'string');
  const origin = String(issue.origin ?? ''); const minimum = issue.minimum as number | bigint | undefined; const maximum = issue.maximum as number | bigint | undefined;
  if (issue.code === 'too_small' && origin === 'array') {
    if (last === 'sourceIds') return 'cần ít nhất một #id có chữ thật trong --sources (ví dụ --sources 120,121; #id lấy từ pma follow / pma read)';
    return `${name} cần ít nhất ${minimum} mục, hiện thiếu`;
  }
  if (issue.code === 'too_big' && origin === 'array') return `${name} nhiều quá: tối đa ${maximum} mục`;
  if (issue.code === 'too_small' && origin === 'string') return Number(minimum) <= 1 ? `${name} đang rỗng${last === 'text' || last === 'markdown' || last === 'result' ? ' (--file - mà stdin trống? hoặc quên nội dung)' : ''}` : `${name} ngắn quá: cần ít nhất ${minimum} ký tự`;
  if (issue.code === 'too_big' && origin === 'string') return `${name} dài quá: tối đa ${maximum} ký tự`;
  if (issue.code === 'too_small' || issue.code === 'too_big') return `${name} ngoài khoảng cho phép (${issue.code === 'too_small' ? 'nhỏ nhất ' + minimum : 'lớn nhất ' + maximum})`;
  if (issue.code === 'invalid_type') return /received undefined/.test(issue.message) ? `thiếu ${name}` : `${name} sai dạng (cần ${String(issue.expected ?? 'kiểu khác')})`;
  if (issue.code === 'invalid_format') return `${name} sai dạng`;
  if (issue.code === 'invalid_value') return `${name} không nằm trong các giá trị cho phép`;
  if (issue.code === 'unrecognized_keys') return `có trường lạ: ${((issue.keys as string[]) ?? []).join(', ')}`;
  return `${name}: ${issue.message}`;
}
export const explainInput = (error: z.ZodError) => 'INVALID_INPUT: ' + error.issues.map(issue => explainIssue(issue as any)).join('; ');

// The draft validator's code and path (drafts.ts) in words. `path` looks like content.participants[0].role.
const CODE_TEXT: Record<string, string> = {
  BAD_LENGTH: 'độ dài hoặc số lượng không hợp lệ (rỗng, quá ngắn hoặc quá dài)', NOT_A_STRING: 'phải là chữ', NOT_AN_ARRAY: 'phải là danh sách', NOT_AN_OBJECT: 'phải là một đối tượng {…}', MISSING_KEY: 'thiếu trường bắt buộc',
  UNKNOWN_KEY: 'có trường không được phép', FORBIDDEN_KEY: 'có trường không được phép', BAD_INTEGER: 'phải là số nguyên dương', BAD_VALUE: 'giá trị không nằm trong các giá trị cho phép', DUPLICATE_ENTRY: 'bị trùng với mục khác',
  NUL_IN_TEXT: 'chứa ký tự không hợp lệ', UNKNOWN_KIND: 'loại nội dung không có',
};
export function explainDraft(kind: string, code: string, path: string): string {
  const index = path.match(/\[(\d+)\]/); const field = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? path;
  const where = index ? `mục thứ ${Number(index[1]) + 1}, trường ${field}` : `trường ${field}`;
  const hint = field === 'sourceIds' ? ' — cần ít nhất một #id có chữ thật (--sources 120,121)' : '';
  return `${where}: ${CODE_TEXT[code] ?? code}${hint}`;
}
