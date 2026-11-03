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

`host: NOT_RUNNING` nghĩa là không có host nào **trong phạm vi lệnh tìm**: thư mục dữ liệu của bản đang dùng và host đang giữ khoá máy. Nó **không** chứng minh không còn host 0.11 ở chỗ khác: 0.11 không giữ khoá máy. Đừng tự mở host chỉ để xem.

## 2. Mở cuộc họp: `start` là KÍCH HOẠT

`start` (prepare) **không** phải thao tác vô hại:

- nạp model ASR, và nếu thấy loa đã dùng ở cuộc họp trước thì **bắt đầu ghi âm loa ngay**, không cần `select`;
- `--no-mic` (hoặc `PMA_MIC=0`) chỉ bỏ **micro**; tiếng **loa vẫn được ghi**. Mặc định micro "Tôi" luôn ghi (OWN-027);
- CLI `start` không có cờ fixture hay cờ tắt warm-up. `PMA_WARM=0` không tới được host đã mở qua WMI (không nằm trong danh sách biến được chuyển). Đừng hứa "không ghi âm" bằng các cờ đó.

- `start` không nhận `--session`. Nếu host đang có một cuộc họp **chưa kết thúc**, `start` trả lại chính cuộc họp đó: không tạo cuộc họp mới, và các lựa chọn mới (`--no-mic`, tiêu đề, agenda) **không** được áp vào nó. Vì vậy phải `status` trước. Đang có cuộc họp khác mở thì hỏi người dùng, không gọi `start` mù.

Trước một `start` thật của bản này, còn phải xem host 0.11 ở thư mục dữ liệu cũ đã biết (main checkout `.local\runtime`) bằng `status` của **bản này**. Lệnh này chỉ đọc. Đặt `PMA_DATA_DIR` cho đúng lệnh đó, không đặt global:

```
PMA_DATA_DIR=<main checkout>\.local\runtime node "<bản này>\dist\cli.js" status
```

Không dùng `pma status` của 0.11: bản cũ có thể tự mở host. Không quét hay tắt tiến trình toàn máy. Nếu bị từ chối (vd. truy vấn CIM) thì không thử lại bằng đường khác; báo người dùng.

Sau một `start` hợp lệ, ghi lại `session.id`, `attached.pid`, `attached.dataDir` mà lệnh trả về. Đừng tự đặt UUID cho `start`.

Chỉ chạy `start` khi người dùng muốn bắt đầu một cuộc họp thật (skill `hop`). Kiểm thử không ghi âm thì dùng phiên fixture qua RPC chẩn đoán (`prepare {fixture: true}` trong thế giới thử riêng, như `tests/control_session.test.mjs`), không dùng CLI `start`.

## 3. Dừng đúng cuộc họp: `stop --session <UUID>`

1. Chạy `status`; ghi lại `session.id`, `attached.pid`, `attached.dataDir`. Đúng là cuộc họp người dùng muốn dừng (tiêu đề, giờ mở)?
2. Dừng bằng UUID tường minh: `stop --session <session.id>`.
   - UUID hợp lệ nhưng không phải cuộc họp đang mở: `SESSION_NOT_FOUND`, **không có gì bị dừng**.
   - Không có host nào: `HOST_NOT_RUNNING`; `stop` không mở host mới.
   - Host cũ (0.11): `stop` vẫn tới được nó (không bị chặn theo phiên bản).
3. Xác minh kết thúc. `stop` trả về `session.id` của cuộc họp đã dừng: phải đúng UUID đã truyền. `stop` có thể mất vài phút (bộ nghe đọc nốt, ghép WAV, ghi RAW); lệnh tự chờ. Rồi chạy `status`; một trong hai kết quả sau là đúng:
   - **cùng** `attached.pid` và `session.id`, `session.ended` có giá trị, `recorder.state` OFF. Host thật tự thoát khoảng 1,5 s sau khi dừng xong; host thử thì ở lại;
   - `host: NOT_RUNNING`, sau khi `stop` đã trả đúng UUID: host đã thoát như bình thường.

   Nếu `status` cho thấy một host hay cuộc họp **khác** (pid khác, UUID khác), thì đó không phải cuộc họp vừa dừng. Không `stop` lại nó bằng cách thử tiếp: báo người dùng.
4. Không bao giờ kill theo tên tiến trình (node, python) hay theo PID đoán: có thể là host của cuộc họp khác hoặc của người khác. Host lạ (`RUNTIME_BUSY`) thì báo người dùng, không tự xử lý.

## 4. Sau khi dừng

`read`, `brief --as chinh` (lấy `rcpt-…`), rồi `summary` / `tasks` kèm `--receipt` và `--base` (lần đầu 0); `--key` tuỳ chọn. Lệnh lưu không tự mở host: báo `HOST_NOT_RUNNING` thì chạy `read` hoặc `history` trước.

## Đã kiểm và chưa kiểm

- Đã kiểm bằng fixture (không ghi âm): `status` / `stop` đúng UUID / sai UUID từ thư mục BidOps bằng đường dẫn tuyệt đối; `stop` khi không có host; `stop` (reach) tới host giả kiểu 0.11; MCP `session_finish` khi không có host.
- Host thử ở lại sau `stop`, nên bài kiểm luôn thấy cùng pid. Trường hợp host thật tự thoát rồi `status` trả `NOT_RUNNING` thì chỉ mô tả ở trên, chưa kiểm.
- **Chưa** kiểm: CLI `start` thật, ghi âm thật, cuộc họp thật, cài đặt global.
