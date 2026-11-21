# Cài PMA trên máy mới (cho Claude của người dùng)

Người cài là Claude trên máy của người dùng (owner 21/11). Làm đúng thứ tự, mỗi bước kiểm kết quả trước khi sang bước sau. Không ghi âm để thử; thử thật ở cuộc họp đầu tiên.

## 1. Cần có

Windows 10/11, Git, Node 24.14 trở lên, Python 3.13 64-bit. Thiếu thì nói người dùng cài; không tự đổi cài đặt hệ thống.

## 2. Lấy mã và dựng

```bash
git clone https://github.com/dungvo-svg/personal-meeting-assistant.git "D:/WORK/Agent/Agent-first/personal-meeting-assistant"
cd "D:/WORK/Agent/Agent-first/personal-meeting-assistant"
npm ci && npm run build
py -3.13 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-audio.lock.txt
```

Để thư mục khác thì sửa đường dẫn trong `.claude/skills/hop/SKILL.md`.

## 3. Xếp bậc máy: quyết định cài gì

```bash
./pma hardware
```

| Bậc | Dùng cho | GPU | RAM | Đĩa trống | Mô hình cần cài |
| --- | --- | --- | --- | --- | --- |
| `day-du` | họp tiếng Việt + Lào/Thái | NVIDIA có CUDA, VRAM ≥ 6 GB | ≥ 16 GB | ≥ 10 GB | turbo (1,5 GB) + BuzzASR Lào (2,9 GB) |
| `tieng-viet` | chỉ họp tiếng Việt (và Thái) | NVIDIA có CUDA, VRAM 4–6 GB | ≥ 8 GB | ≥ 10 GB | turbo; KHÔNG cài mô hình Lào |
| `khong-du` | không họp trực tiếp được | không có NVIDIA CUDA / VRAM < 4 GB | < 8 GB | < 10 GB | dừng ở đây |

Đã thử: RTX 3050 6 GB, i5-12400F, 16 GB RAM (21/11) chạy đủ Việt + Lào, nhanh khoảng 4 lần thời gian thực. `pma start` tự từ chối khi máy không đủ, hoặc khi cuộc họp có tiếng Lào mà máy không chạy được/chưa cài mô hình Lào (`HARDWARE_NOT_ENOUGH`, kèm cách sửa).

## 4. Cài mô hình theo bậc (ngoài giờ họp: tải vài GB, chuyển đổi 30 phút tới vài giờ)

- **`day-du`**: `sh tools/setup_lao_gpu.sh` (CUDA runtime, BuzzASR Lào, Whisper large-v3-turbo, chấm thử FLEURS), rồi đặt `.local/models/asr-profile.json` thành `{"main": "whisper-large-v3-turbo-ct2", "lo": "buzzasr-lao-ct2", "vi": null}`.
- **`tieng-viet`**: `.venv/Scripts/python.exe -m pip install -r requirements-gpu.lock.txt`; chuyển đổi turbo theo bước 4–5 của `tools/setup_lao_gpu.sh` (chỉ dòng `convert_whisper_model.py … whisper-large-v3-turbo-ct2`); `asr-profile.json` = `{"main": "whisper-large-v3-turbo-ct2", "lo": null, "vi": null}`.
- **`khong-du`**: không cài mô hình; nói người dùng máy này không dùng cho họp trực tiếp được, và vì sao (dòng `Bậc:` của `pma hardware`).
- Mọi bậc: `.venv/Scripts/python.exe tools/fetch_model.py` (mô hình `small`, có kiểm mã băm).

## 5. Kiểm

```bash
./pma doctor
```

Dòng cuối phải là `SẴN SÀNG` (bậc `day-du`), hoặc `SẴN SÀNG cho tiếng Việt; máy CHỈ đủ tiếng Việt` (bậc `tieng-viet`). Dòng `THIẾU` nào thì làm theo phần `→` của dòng đó.

## 6. Nối vào thư mục người dùng họp

Trong thư mục dự án người dùng mở Claude để họp: chép `.claude/skills/hop/SKILL.md` của PMA vào `.claude/skills/hop/SKILL.md` của thư mục đó, và thêm Stop hook `node "<đường dẫn PMA>/tools/meeting_stop_hook.mjs"` vào `.claude/settings.local.json` của thư mục đó. `pma doctor --project <thư mục>` kiểm cả hai.

Lấy bản mới: `git pull`, `npm ci`, `npm run build`, rồi `pma doctor`.
