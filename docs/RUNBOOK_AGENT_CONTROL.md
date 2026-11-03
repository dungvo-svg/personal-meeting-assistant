# Runbook cho agent: xem, mở, dừng đúng cuộc họp (0.12.1, nháp 03/11/2026)

Dành cho phiên Claude điều khiển bộ họp, không phải lệnh chủ phải nhớ. Chạy được từ bất kỳ thư mục nào (vd. dự án BidOps), bằng đường dẫn tuyệt đối của bản đang dùng:

```
node "<thư mục PMA>\dist\cli.js" <lệnh>
```

Lệnh `pma` trần chỉ chạy được trong thư mục PMA; chưa có cài đặt dùng chung (global).

## 1. Luôn xem trước: `status`

`status` chỉ đọc: không mở host, không nạp model, không ghi âm. Lấy từ kết quả:

| Trường | Dùng để |
|---|---|
| `attached.pid`, `attached.dataDir`, `attached.via` | host nào đang trả lời, dữ liệu ở đâu |
| `session.id`, `session.title`, `session.ended` | cuộc họp đang mở (UUID), đã kết thúc chưa |
| `captureState`, `recorder.state`, `recorder.pid`, `asr.wanted` | có đang ghi âm / nhận dạng không |
| `host.version`, `host.protocol`, `host.capabilities`, `host.draftsAllowed` | host mới hay cũ; `draftsAllowed: false` = host cũ, lưu nháp sẽ bị từ chối (`HOST_PROTOCOL_OLD`) |

`host: NOT_RUNNING` nghĩa là không có host nào; đừng tự mở chỉ để xem.

## 2. Mở cuộc họp: `start` là KÍCH HOẠT

`start` (prepare) **không** phải thao tác vô hại:

- nạp model ASR, và nếu thấy loa đã dùng ở cuộc họp trước thì **bắt đầu ghi âm loa ngay**, không cần `select`;
- `--no-mic` (hoặc `PMA_MIC=0`) chỉ bỏ **micro**; tiếng **loa vẫn được ghi**. Mặc định micro "Tôi" luôn ghi (OWN-027);
- CLI `start` không có cờ fixture hay cờ tắt warm-up. `PMA_WARM=0` không tới được host đã mở qua WMI (không nằm trong danh sách biến được chuyển). Đừng hứa "không ghi âm" bằng các cờ đó.

Chỉ chạy `start` khi người dùng muốn bắt đầu một cuộc họp thật (skill `hop`). Kiểm thử không ghi âm thì dùng phiên fixture qua RPC chẩn đoán (`prepare {fixture: true}` trong thế giới thử riêng, như `tests/control_session.test.mjs`), không dùng CLI `start`.

## 3. Dừng đúng cuộc họp: `stop --session <UUID>`

1. Chạy `status`; ghi lại `session.id`, `attached.pid`, `attached.dataDir`. Đúng là cuộc họp người dùng muốn dừng (tiêu đề, giờ mở)?
2. Dừng bằng UUID tường minh: `stop --session <session.id>`.
   - UUID hợp lệ nhưng không phải cuộc họp đang mở: `SESSION_NOT_FOUND`, **không có gì bị dừng**.
   - Không có host nào: `HOST_NOT_RUNNING`; `stop` không mở host mới.
   - Host cũ (0.11): `stop` vẫn tới được nó (không bị chặn theo phiên bản).
3. Xác minh kết thúc bằng `status`: cùng `attached.pid`, `session.id` như trên, `session.ended` có giá trị, `recorder.state` OFF. `stop` có thể mất vài phút (bộ nghe đọc nốt, ghép WAV, ghi RAW); lệnh tự chờ.
4. Không bao giờ kill theo tên tiến trình (node, python) hay theo PID đoán: có thể là host của cuộc họp khác hoặc của người khác. Host lạ (`RUNTIME_BUSY`) thì báo người dùng, không tự xử lý.

## 4. Sau khi dừng

`read`, `brief --as chinh` (lấy `rcpt-…`), rồi `summary` / `tasks` kèm `--receipt` và `--base` (lần đầu 0); `--key` tuỳ chọn. Lệnh lưu không tự mở host: báo `HOST_NOT_RUNNING` thì chạy `read` hoặc `history` trước.

## Đã kiểm và chưa kiểm

- Đã kiểm bằng fixture (không ghi âm): `status` / `stop` đúng UUID / sai UUID từ thư mục BidOps bằng đường dẫn tuyệt đối; `stop` khi không có host.
- **Chưa** kiểm: CLI `start` thật, ghi âm thật, cuộc họp thật, cài đặt global.
