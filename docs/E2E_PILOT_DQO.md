# Kịch bản chứng minh tự chủ: ca Dũng–Quân–Oanh (thử giả lập)

**Trạng thái (03/11/2026):** thiết kế + mã nguồn, CHƯA chạy.
- Chạy phải có GO của phiên gốc/Astra sau rà soát tĩnh đúng snapshot.
- Đây là ca thử dự kiến bằng dữ liệu giả: không mở họp, không mời ai, không ghi âm, không cấp quyền thật.

## Bốn tầng chứng minh

Tầng dưới không thay được tầng trên.

| Tầng | Chạy bằng gì | Chứng minh được | Không chứng minh được | File |
| --- | --- | --- | --- | --- |
| L1 thuần | `node --test` mô-đun thuần | luật của từng mô-đun | mô-đun nối với nhau | `context_pack`, `jobs`, `decisions`, `mic_share`, `harness` |
| L2 runtime trong tiến trình | runtime chế độ thử, không host, không tiến trình con | luật host mà phiên trung tâm dựa vào | CLI, RPC, agent | `pilot_dqo.test.mjs`, `late_exit.test.mjs` |
| L3 host thử qua CLI | host chế độ thử trong `isolatedEnv`, dòng giả (`fixture`) | lệnh `pma` thật, RPC, khoá máy, nối vào host | Claude có làm đúng skill không | sẽ viết sau GO tầng L1–L2 |
| L4 agent trung tâm thật | một phiên Claude thật chạy skill `hop` trên host thử của L3 | tự chủ: đọc context, chốt đúng thẩm quyền, việc nền không chặn, dừng đúng | âm thanh thật, giọng Lào/Thái, họp thật | chưa có công cụ: xem dưới |

## Khả năng có thật và chưa có

**Có:**
- Công cụ Agent với `run_in_background` (báo một lần khi xong).
- Bash có giới hạn 10 phút một lệnh.
- `pma follow --minutes N` tự thoát.
- Host chế độ thử nhận dòng giả qua RPC `fixture` (chỉ khi `PMA_TEST_MODE=1`).
- Monitor có trong Claude Code, nhưng lệnh Monitor gốc từng bị từ chối trong dự án này: chưa dùng lại.

**Chưa có:**
- Một script điều khiển một phiên Claude thật như người dùng: gửi lời của chủ, đọc câu trả lời, đo thời gian.
- Vì vậy L4 hiện chỉ làm được theo kiểu: người (hoặc phiên điều phối có quyền) mở một phiên Claude thật, cho nó chạy skill với host thử, rồi chấm bằng biên nhận ở cột "Bằng chứng".
- Không giả mô hình để gọi là đạt.

## Các bước (L3/L4)

Quy ước:
- `S` = dòng giả đưa vào host thử.
- "Chủ" = lời người dùng gõ cho phiên trung tâm (L4), hoặc lệnh tương đương do kịch bản gọi (L3).

| # | Đầu vào | Phải thấy | Bằng chứng lưu | Hỏng khi |
| --- | --- | --- | --- | --- |
| 0 | `isolatedEnv('pilot-dqo')` | `PMA_DATA_DIR`, `PMA_LOCK_DIR` nằm trong thư mục gốc tạm; `PMA_TEST_MODE=1` | env (không token), đường dẫn gốc | khoá hoặc dữ liệu nằm ngoài gốc; bắt được biến `PMA_*` của máy |
| 1 | Bật host thử, `pma start --title "Thiết lập thầu (thử)"` (phiên fixture) | `status`: `testMode`; khoá máy thuộc host thử; không có bộ ghi | `pma status` (không token) | `attached.via = machine` tới host không phải host thử; có `recorder.pid` |
| 2 | Chủ: người dự Dũng, Quân, Oanh, Phet; nội dung họp | gói context v1, `missing` không có roster | `pma brief --as chinh` in `Đã ghi nhận: vai chinh đọc context v1` | không có dòng ghi nhận; phiên bản không khớp `status.context.version` |
| 3 | Chủ: "Quân chốt phần giá, Oanh chốt mọi phần" | hai `grant`, nguồn ghi đúng câu chủ | `pma decisions` | có grant không xuất phát từ lời chủ; có grant cho Phet |
| 4 | S: "Phet: em đề xuất gửi báo giá trước thứ Sáu." | `propose`; `decide --by Phet` không chốt; đúng một câu hỏi chờ Quân/Oanh | kết quả `decide` (`park.who`), `pma questions` | quyết định thành `decided`; hai câu hỏi trở lên |
| 5 | S: "Quân: chốt, gửi báo giá trước thứ Sáu." | `decide --by Quân --scope giá` chốt, kèm `#id` câu chốt; `act` tạo việc | `pma decisions` (QĐ, nguồn #id) | chốt không có nguồn; chốt bằng tên không được giao |
| 6 | Chủ hỏi một câu cần phân tích dài | `job start` → id; agent nền chạy; trong lúc đó chủ hỏi "đã chốt gì" | `pma job list` cho thấy `running`; câu trả lời có trước khi job xong (mục tiêu ≤ 10 giây ở bản thử, không phải cam kết sản phẩm) | phiên trung tâm chờ job mới trả lời |
| 7 | S: "Oanh: đổi lại, gửi trước thứ Năm." | `change` → QĐ cũ `superseded`, việc cũ `blocked`, việc mới làm xong | `pma decisions` (chain) | việc cũ vẫn `planned`; quyết định cũ còn "đã chốt" |
| 8 | Chủ thêm một người dự giữa họp | follow in `CONTEXT ĐỔI`; agent chạy lại `pma brief --as chinh` → v2 | dòng follow, dòng ghi nhận v2 | follow tự xác nhận thay agent; agent tiếp tục với v1 |
| 9 | Lưu bản dịch bị từ chối (giả lập ở agent dịch nền) | `pma degraded save-denied` một lần; `committed` của vai dịch không tiến | `pma status` (followers.dich.committed), danh sách suy giảm | báo nhiều lần; `committed` vượt dòng chưa lưu |
| 10 | Chủ: "kết thúc" | `pma stop` chạy trước mọi chờ; job dở thành `cancelled`; câu hỏi chưa trả lời vào "Câu hỏi mở"; `decisions` và `unfinished` có trong kết quả | kết quả `stop`; RAW; thứ tự lệnh trong nhật ký phiên | chờ dịch/phân tích xong mới `stop`; câu hỏi im lặng bị coi là đã trả lời |
| 11 | Bật lại follow sau khi ngắt giữa chừng | đọc tiếp từ `committed`, không bật ghi âm lại | dòng `FOLLOWING … từ #N` | ghi âm bắt đầu lại; mất dòng giữa `committed` và chỗ đã in |

**Giới hạn của bước 9–11 ở L3:** dòng `fixture` không mang kênh micro. Riêng tư micro (OFF/UNKNOWN không tới vai dịch) đã được chứng minh ở L1/L2 (`share.test`, `mic_share.test`), không ở kịch bản này.

## Điều kiện để chạy

1. Rà soát tĩnh đúng snapshot: mã nguồn + dist sinh ra + import closure của các file test.
2. GO L1/L2 cho các file: `decisions`, `pilot_dqo`, `harness`, `late_exit`.
3. Sau đó mới viết L3 trên `isolatedEnv`/`ownedShutdown`, rồi xin GO riêng.
4. L4 cần một người (hoặc phiên có quyền) mở phiên Claude thật; chấm bằng bảng trên.
