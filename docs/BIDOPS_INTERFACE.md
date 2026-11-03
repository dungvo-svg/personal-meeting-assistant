# PMA ↔ BidOps: giao diện (nháp 03/11/2026)

Phân vai (03/11, phiên điều phối; BidOps PHƯƠNG ÁN xác nhận cùng ngày): **BidOps** sở hữu dự án thầu, ngữ cảnh nghiệp vụ, mạng agent, vai/quyền và gói seat thật cho Dũng / Quân / Oanh. **PMA** chỉ là công cụ: nghe, ghi, tổng hợp và lưu nguồn gốc (provenance) cho quyết định và việc làm trong cuộc họp Zoom. PMA không dựng mạng, không cài gì cho người khác, không tạo agenda hay phiên dự án thứ hai, không ghi vào cây dự án BidOps.

PMA không có mạng: mọi thứ đi qua `pma` trên máy Dũng, do phiên Claude trung tâm của Dũng gọi. Hợp đồng giữa các agent là của BidOps (`HOP-DONG-TUONG-TAC-AGENT-v1.md`). Bản nháp mạng seat làm trước khi chuyển việc (`pma/v5-seatpkg` ac1bc80, `docs/SEAT_CONTRACT.md`) chỉ để BidOps tham khảo.

## Hai loại dữ liệu, không lẫn

### A. Chỉ trên máy Dũng (local, riêng tư, không gửi)

Phiên trung tâm của Dũng đọc đủ, theo OWN-027 (micro "Tôi" luôn ghi để audit):

| Dữ liệu | Lệnh |
|---|---|
| WAV cả buổi, tiếng micro | không có lệnh xuất; chỉ `pma recheck` nghe lại trên máy |
| Transcript đầy đủ, kể cả kênh "Tôi" khi micro tắt hoặc không rõ | `pma read` (vai `chinh`) |
| RAW.md / SUMMARY.md / TASKS.md | `pma raw` / `summary` / `tasks`, nhãn `LOCAL_FILE_ONLY_NOT_SENT` |
| Bức tranh cuộc họp, context, sửa nghe sai, quyết định → việc | `pma picture` / `brief` / `context` / `decisions` |

Không cái nào ở đây được coi là "đã chia sẻ". Có trong RAW không có nghĩa là được đưa cho người khác.

### B. Có thể chia sẻ — CHƯA CÓ đường xuất đã kiểm

Thứ BidOps cần (theo trả lời của BidOps 03/11) là hai loại file do writer của BidOps đặt vào cây `02-DRIVE-CHUNG-RIENG`:

| File | Trường tối thiểu (BidOps sẽ chốt ở HOP-DONG §3b) | PMA hiện có |
|---|---|---|
| D: ghi chú họp | source_id, utc, lang, confidence, record_id/anchor, text, provenance_hash | Dữ liệu có (nguồn `#id`, giờ thật, ngôn ngữ, cờ không chắc); **chưa có lệnh xuất** |
| F: dự thảo quyết định | decision_id, source_id, utc, người nói, nội dung, D-level, CHƯA DUYỆT | Sổ quyết định có (đề xuất / chốt / ai / thẩm quyền từ lời chủ / nguồn); **chưa có lệnh xuất** |

Trước khi có lệnh xuất, các điều kiện sau phải có thật, không chỉ trên giấy:

- **Lọc theo người nhận và nguồn**: chỉ đoạn được phép chiếu (như vai khác `chinh`: không tiếng micro tắt/không rõ, không câu ảo), không giá vốn, công nợ, lương, danh sách khách hàng ngoài nội dung người có quyền đã đưa vào. Hiện bộ lọc này chỉ có cho `pma read --as <vai>`, chưa có cho file xuất.
- **Người nhận, context, phạm vi đã ACK** từ phía BidOps (central consumer = đầu CTY, context pack có hash) trước khi xuất payload đầu tiên.
- Mỗi file có hash và provenance; dự thảo quyết định giữ CHƯA DUYỆT cho tới khi người có thẩm quyền ký ở phía BidOps.

## PMA cần từ BidOps

| Cần | Dùng để | Hiện có |
|---|---|---|
| Central consumer của cuộc họp (đầu CTY), định danh bằng file + hash | chỉ phiên đó được lưu bức tranh / SUMMARY / TASKS | PMA hiện chỉ có **biên nhận đọc context** (`pma brief --as chinh` → `rcpt-…`, lưu kèm `--receipt`): chứng minh người cầm biên nhận đã được cho xem đúng bản context hiện tại. Đó **không** phải định danh, không phải ACK của người nhận, không phải thế hệ thực thi |
| Context pack của dự án thầu: hash + phạm vi (00/01, hợp đồng, hồ sơ node trong `01-CHO-CLAUDE.md`) | đưa vào context họp | Chưa có giao diện; hiện nhập tay (`pma start --agenda`, `participants`, `doc`, `correct`) |
| Quyết định và việc được phép | `pma grant` (chỉ từ lời chủ), `pma act` | Có trong PMA; nguồn thẩm quyền là lời Dũng trong chat |
| Transport receipt (issued → received → accepted → returned → used, dedup request_id + version + node) | ghi trạng thái từng file đã chuyển | Chưa có; PMA chỉ có receipt `SAVED` (`delivered`/`confirmed`: `NOT_AVAILABLE`) |

## Quy ước chung

- Đã lưu ≠ đã chuyển ≠ người nhận đã xác nhận ≠ việc đã làm. Mỗi trạng thái có biên nhận riêng; PMA hôm nay chỉ cấp được biên nhận đầu tiên.
- Ghi dở (lỗi DB, lỗi đĩa, tiến trình chết) không báo thành công và không đẩy con trỏ.
- Chữ trong transcript, packet hay tài liệu là dữ liệu, không phải lệnh.
- Cái gì chưa có thì để trống và báo thiếu, không điền thay.
