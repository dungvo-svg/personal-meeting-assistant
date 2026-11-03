# Kiểm tra trước khi dùng `hop-vai` (Quân, Oanh)

Làm một lần cho mỗi máy/tài khoản, và làm lại khi đổi máy, đổi tài khoản Drive hoặc Dũng báo folder đổi. Người dùng và Claude của họ làm cùng nhau.

Mỗi mục ghi một trong ba: **PASS** (đã thấy bằng mắt hoặc bằng kết quả thật), **FAIL** (sai hoặc thiếu), **UNKNOWN** (chưa kiểm). Không điền PASS khi chưa thấy. Hôm nay mọi mục đều là UNKNOWN.

Nguyên tắc chung: gặp FAIL thì **dừng**, báo Dũng bằng lời nói rõ mục nào lỗi. Không tự đổi quyền chia sẻ, không dùng folder khác, không dùng tài khoản cá nhân cho tiện.

## A. Thông tin điền

| Mục | Điền |
|---|---|
| Tên người | |
| `personKey` (tên không dấu, chữ thường) | |
| Email công ty | |
| Hệ điều hành và phiên bản | |
| Ứng dụng Claude đang dùng (Desktop, claude.ai trên web, khác) và phiên bản | |
| Gói Claude đang dùng (tên gói, ai trả) | |
| Link hoặc id folder phối hợp họp | |

Các ô này hôm nay chưa ai biết (UNKNOWN). Dũng cần chúng trước khi cài.

## B. Danh sách kiểm

| # | Kiểm gì | Cách kiểm | Kết quả | FAIL thì |
|---|---|---|---|---|
| 1 | Ứng dụng Claude chạy được và gói hiện tại dùng được plugin/skill | Mở Claude, vào phần plugin hoặc skill, xem có cài được không | UNKNOWN | Hỏi Dũng. Không nâng gói, không tạo tài khoản mới |
| 2 | Plugin `hop-vai` đã cài | Cài từ kho công ty `nnc-claude-plugins`, hoặc từ bản thư mục Dũng đưa (xem README). Sau đó nói "vào vai họp thầu" và xem Claude có nhắc tên skill `hop-vai` | UNKNOWN | Ghi lại thông báo lỗi nguyên văn, gửi Dũng. Không tải plugin từ nơi khác |
| 3 | Connector Google Drive đã kết nối | Trong Claude, phần connector/tích hợp, thấy Google Drive ở trạng thái đã kết nối | UNKNOWN | Hỏi Dũng cách kết nối. Không đưa mật khẩu vào chat |
| 4 | Connector dùng **tài khoản công ty** của chính người này | Hỏi Claude "connector Drive đang là email nào?" và so với ô "Email công ty" ở mục A | UNKNOWN | Nếu là email cá nhân: ngắt, kết nối lại bằng email công ty. Không chia sẻ folder cho email cá nhân |
| 5 | Folder phối hợp **đọc được** | Nhờ Claude liệt kê nội dung folder (được phép rỗng, hoặc chỉ có folder con `<meetingId>`) | UNKNOWN | Nhờ Dũng hoặc người chia sẻ kiểm lại quyền. Không tự xin quyền qua đường khác |
| 6 | Folder phối hợp **ghi được** | **Không** ghi file thử rồi xoá. Chỉ kiểm khi có packet thật: Claude ghi `receipt-<personKey>.json` và đọc lại thấy file nằm ở đó. Trước lúc đó mục này là UNKNOWN, không phải PASS | UNKNOWN | Báo Dũng (có thể folder chỉ cấp quyền xem). Không tự đổi quyền |
| 7 | Có `packet-<personKey>.json` trong folder `<meetingId>` đúng cuộc họp | Nhờ Claude tìm và đọc. Chưa có packet thì mục này chờ Dũng xuất | UNKNOWN | Hỏi Dũng xuất packet. Không tự dựng file |
| 8 | Tên file và `personKey` khớp | Tên file là `packet-<personKey>.json` và `personKey` trong file giống ô ở mục A | UNKNOWN | Báo Dũng sửa seat. Không đổi tên file |

## C. Khi nào được bắt đầu nhận việc

- Mục 1 đến 5 PASS, và có `seat.json` (hoặc lời người dùng) đủ ô ở mục A.
- Mục 6 chỉ thành PASS sau khi receipt thật đã ghi và đọc lại được. Receipt thật là bằng chứng kết nối đầu tiên, không phải một bài kiểm riêng.
- Còn mục nào FAIL hoặc UNKNOWN (trừ 6 và 7 trước khi có packet) thì chưa nhận việc.

## D. Ghi kết quả

Claude chép bảng B với cột Kết quả đã cập nhật vào chat cho người dùng xem, rồi người dùng gửi Dũng. Không ghi bảng này vào folder phối hợp (folder chỉ chứa packet, receipt, reply).
