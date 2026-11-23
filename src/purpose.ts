// What the meeting is FOR (0.13.0, item 11). 23/11, the 14:00 meeting: the purpose was not known, so two tender jobs the presenter pushed
// to an app while demonstrating went into TASKS and the recipient was asked about them, and a greeting was taken for a Lao explanation.
// The purpose leads the reasoning: in a notice or a how-to the tasks, names and numbers shown while demonstrating are examples, not
// work given. Pure functions, no state. The id is what is stored in the session context (and so in the context pack version).
export type PurposeId = 'thong-bao' | 'huong-dan' | 'giao-viec' | 'ban-quyet-dinh';
export type Purpose = { id: PurposeId; label: string; rule: string };

export const PURPOSES: readonly Purpose[] = [
  { id: 'thong-bao', label: 'thông báo', rule: 'nghe để nắm nội dung được thông báo; việc, tên, số nêu khi làm mẫu là ví dụ, không vào TASKS' },
  { id: 'huong-dan', label: 'hướng dẫn', rule: 'ghi các bước và quy tắc được hướng dẫn; việc, tên, số trên màn hình làm mẫu là ví dụ, không vào TASKS' },
  { id: 'giao-viec', label: 'giao việc', rule: 'ghi việc - người - hạn; việc nêu mà chưa rõ người thì để trống người và hỏi' },
  { id: 'ban-quyet-dinh', label: 'bàn quyết định', rule: 'ghi lựa chọn, lý lẽ và ai chốt; đề xuất khác với quyết định' },
];

// "thông báo", "Thong bao", "thong-bao", "THONG_BAO", " ban  quyet dinh " all name the same purpose: lowercase, no diacritics, one dash.
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim().replace(/[\s_-]+/g, '-');

export function parsePurpose(value: unknown): Purpose {
  const key = typeof value === 'string' ? fold(value) : '';
  const found = PURPOSES.find(p => p.id === key);
  if (!found) throw new Error(`INVALID_PURPOSE: mục đích họp phải là một trong: ${PURPOSES.map(p => `${p.id} (${p.label})`).join(', ')}; nhận được "${String(value ?? '').slice(0, 40)}"`);
  return found;
}
export const purposeOf = (id: unknown): Purpose | undefined => PURPOSES.find(p => p.id === id);
