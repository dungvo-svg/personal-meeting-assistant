# Cài PMA trên máy mới (cho Claude của người dùng)

Người cài là Claude trên máy của người dùng (owner 21/11). Máy mỗi người một khác: không có đường dẫn nào cố định. Claude tự kiểm máy, đề xuất chỗ cài cho người dùng duyệt, rồi mới cài (owner 25/11). Làm đúng thứ tự, mỗi bước kiểm kết quả trước khi sang bước sau. Không ghi âm để thử; thử thật ở cuộc họp đầu tiên.

## 0. Câu mồi người dùng dán vào Claude Code

Người dùng mở Claude Code ở thư mục bất kỳ và dán:

> Cài trợ lý họp PMA cho máy này. Hướng dẫn ở docs/CAI-DAT.md của repo GitHub dungvo-svg/personal-meeting-assistant (repo riêng: đăng nhập bằng gh, tôi tự gõ mật khẩu/mã). Đọc hướng dẫn đó trước, tự kiểm máy, đề xuất chỗ cài cho tôi duyệt, rồi làm từng bước.

Claude đọc file này bằng `gh api repos/dungvo-svg/personal-meeting-assistant/contents/docs/CAI-DAT.md -H "Accept: application/vnd.github.raw"`. Báo lỗi 404 nghĩa là tài khoản GitHub của người dùng chưa được mời vào repo: nói người dùng nhờ chủ repo thêm, rồi dừng.

## 1. Kiểm máy và đề xuất (chỉ đọc, chưa cài gì)

Kiểm và ghi lại:
- Windows 10/11 64-bit.
- `git --version`, `node --version` (cần 24.14 trở lên), `py -0p` (cần Python 3.13 64-bit), `gh --version`.
- `nvidia-smi --query-gpu=name,memory.total --format=csv`: có card NVIDIA không, VRAM bao nhiêu.
- RAM, các ổ đĩa và chỗ trống (`Get-PSDrive -PSProvider FileSystem`).
- Người dùng hay để việc ở đâu: hỏi một câu, hoặc xem các thư mục làm việc sẵn có.

Chọn chỗ cài theo thứ tự:
1. Ổ không phải ổ hệ thống, còn trống ít nhất 15 GB (mô hình vài GB, mỗi giờ họp WAV khoảng 0,5 GB).
2. Đường dẫn không dấu, không khoảng trắng, ví dụ `<ổ>:/pma` hoặc `<thư mục làm việc của người dùng>/pma`.
3. KHÔNG nằm trong thư mục đồng bộ (OneDrive, Google Drive, Dropbox): WAV cuộc họp chỉ được nằm trên máy này.
4. Chỉ có một ổ thì `%USERPROFILE%/pma`.

Trình người dùng một bảng ngắn: chỗ cài đề xuất (kèm lý do), bậc máy dự kiến theo GPU/RAM (bảng ở bước 4), thứ còn thiếu phải cài, thời gian tải. Chờ người dùng đồng ý. Thiếu Git/Node/Python/gh thì nói người dùng cài (kèm link chính thức); không tự đổi cài đặt hệ thống. Máy không có card NVIDIA thì nói ngay: máy này không họp trực tiếp được, chỉ dùng `pma transcribe` cho file ghi âm.

Dưới đây `<PMA>` là thư mục đã chốt, viết bằng dấu `/`.

## 2. Lấy mã và dựng

```bash
gh repo clone dungvo-svg/personal-meeting-assistant "<PMA>"
cd "<PMA>"
npm ci && npm run build
py -3.13 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-audio.lock.txt
```

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

## 5. Nối vào thư mục họp

Hỏi người dùng hay mở Claude ở thư mục nào để họp. Chưa có thì đề xuất dùng chính `<PMA>` (kỹ năng `hop` có sẵn). Rồi:

```bash
"<PMA>/pma" connect --project "<thư mục họp>"
```

Lệnh này chép kỹ năng `hop` với đường dẫn đầy đủ của máy này và thêm Stop hook (node của máy này, không cần `node` trên PATH). Chạy lại không đổi gì. Thư mục đang trỏ tới bản pma khác thì được trỏ lại về bản này. Nhiều thư mục họp thì chạy cho từng thư mục.

## 6. Kiểm

```bash
"<PMA>/pma" doctor --project "<thư mục họp>"
```

Dòng cuối phải là `SẴN SÀNG` (bậc `day-du`), hoặc `SẴN SÀNG cho tiếng Việt; máy CHỈ đủ tiếng Việt` (bậc `tieng-viet`). Dòng `THIẾU` hoặc `chú ý` nào thì làm theo phần `→` của dòng đó.

Báo người dùng: chỗ đã cài, bậc máy, thư mục họp đã nối, và cách dùng (mở Claude ở thư mục họp, gõ `/hop` kèm link Zoom/Meet và nội dung họp).

Lấy bản mới: trong `<PMA>`, `git pull`, `npm ci`, `npm run build`, rồi `pma connect` lại cho từng thư mục họp và `pma doctor`.
