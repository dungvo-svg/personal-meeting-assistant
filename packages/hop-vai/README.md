# Gói `hop-vai` (bản nháp 0.1.0-draft)

Gói này để Claude của **Quân** và **Oanh**, trên máy và tài khoản của chính họ, nhận bối cảnh và việc từ phiên trung tâm của Dũng trong họp thầu, rồi gửi biên nhận và trả lời. Hợp đồng chi tiết: `docs/SEAT_CONTRACT.md` (`pma-seat/1`).

**Hôm nay chưa cài ở đâu cho Quân hay Oanh. Chưa có kết nối thật nào.** Gói chưa dùng ở họp thật.

## Gói là gì

- Một plugin Claude chỉ có **một skill** (`hop-vai`) và tài liệu kiểm tra (`PREFLIGHT.md`).
- Trao đổi bằng các file JSON trong **một folder Google Drive công ty riêng cho phối hợp họp**, qua connector Google Drive của chính người đó (tài khoản công ty).
- Dũng ghi `packet-<personKey>.json`; Claude của người đó ghi `receipt-<personKey>.json` rồi `reply-<personKey>-<n>.json`.

## Gói không phải là

- Không phải PMA. Không ghi âm, không nhận dạng giọng nói, không GPU, không transcript.
- Không có code chạy, không MCP server, không lệnh `pma`, không cần cài thêm gì ngoài plugin và connector Drive.
- Không quyết định thay ai. Reply chỉ là nhận, từ chối, trả lời hoặc đề xuất. Chốt là việc ở phiên của Dũng.
- Không gửi email, không nhắn chat, không đưa dữ liệu ra ngoài Drive công ty.
- Vai giả lập trên máy Dũng không dùng gói này và không được gọi là Claude của Quân hay Oanh.

## Cài đặt

**Cách A: kho công ty `nnc-claude-plugins`.** Chỉ làm được sau khi Dũng đồng ý đưa gói lên kho (chưa có đồng ý). Khi có: người dùng thêm kho công ty trong Claude rồi cài plugin `hop-vai`.

**Cách B: bản sao thư mục này do Dũng đưa.** Người dùng nhận thư mục `hop-vai` (qua kênh công ty Dũng chọn), làm theo cách Claude của họ cài plugin từ thư mục cục bộ. Không tải từ nơi khác.

Sau khi cài: làm `PREFLIGHT.md`, rồi nói với Claude "vào vai họp thầu".

## `seat.example.json`

Một file nhỏ để người dùng điền (hoặc đọc cho Claude nghe), không cần nộp vào đâu:

| Trường | Nghĩa |
|---|---|
| `schema` | luôn `pma-seat/1` |
| `kind` | luôn `seat` |
| `person` | tên người, có dấu, như Dũng ghi (ví dụ Quân) |
| `personKey` | tên viết thường, không dấu, chỉ `a-z0-9-` (quan, oanh) |
| `folder` | link hoặc id folder Drive phối hợp họp do Dũng đưa |
| `companyEmail` | email công ty của người này; phải trùng email Drive đang kết nối |

Claude chỉ dùng giá trị người dùng đưa. Trường nào chưa biết thì để trống và hỏi Dũng, không đoán.

## Ví dụ

Thư mục `examples/` có ba file giả (`packet-quan.json`, `receipt-quan.json`, `reply-quan-1.json`) với `meetingId` giả. Chỉ để đối chiếu cấu trúc. Không chép vào folder thật.
