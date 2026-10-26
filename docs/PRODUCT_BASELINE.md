# Baseline sản phẩm v0.1.0

Ngày: 26/10/2026. Chủ thể làm việc là **trợ lý AI của người dùng**. Sản phẩm ta xây là bộ công cụ để agent thực hiện nhiệm vụ hỗ trợ cuộc họp. Claude Desktop là môi trường dùng đầu tiên, không phải tên cố định của toàn bộ sản phẩm.

Đây là bản khóa yêu cầu và thiết kế ban đầu; chưa có runtime hoặc nghiệm thu. `OWNER_LOCKED` là quyết định người dùng đã chốt; `ENGINEERING_BASELINE` là thiết kế thực hiện do agent lập; `OPEN` là khả năng chưa chứng minh. Sổ nguồn ở [DECISION_LOG.md](DECISION_LOG.md).

## Những điều đã khóa với người dùng

| ID | Quyết định | Trạng thái |
| --- | --- | --- |
| OWN-001 | Dự án cá nhân tách thư mục và Git repo, độc lập sản phẩm AIOS dùng chung | OWNER_LOCKED |
| OWN-002 | Trợ lý có thể thay Claude bằng AGY hoặc Codex; không khóa sản phẩm vào một host | OWNER_LOCKED |
| OWN-003 | Claude Desktop là host đầu tiên phải dùng được | OWNER_LOCKED |
| OWN-004 | V1 chỉ bảng dịch trực tiếp; hỏi đáp làm sau | OWNER_LOCKED |
| OWN-005 | Tự lưu lịch sử text trên máy; audio chỉ tạm thời | OWNER_LOCKED |
| OWN-006 | Xây tools quanh agent để agent chủ động kích hoạt và hỗ trợ họp | OWNER_LOCKED |
| OWN-007 | V1 hỗ trợ cuộc họp đã mở: agent tự bật tai, lấy ngữ cảnh và hiển thị dịch | OWNER_LOCKED |

## Lời hứa của V1

Sau khi người dùng giao nhiệm vụ cho cuộc họp đang mở, agent chuẩn bị phiên, xác định nguồn được phép, bật bộ tai, nhận nguồn/ngữ cảnh và đưa bản dịch Việt ↔ Lào lên bảng riêng. Agent theo dõi tình trạng nguồn và phần đang chờ dịch, xử lý các tình huống có thể phục hồi trong phạm vi phiên và báo khi cần người dùng can thiệp. Text của phiên được lưu trên máy; audio chỉ dùng trong vòng đời tạm thời.

Đây là hành vi phải chứng minh trước khi gọi V1 dùng được. Nếu cần người dùng nhắc từng đoạn để Claude tiếp tục, chỉ được ghi nhận là bản thử hỗ trợ theo lượt, chưa đạt bảng dịch trực tiếp.

## Agent làm gì, tools làm gì

| Trách nhiệm | Chủ thể |
| --- | --- |
| Hiểu mục tiêu phiên, chọn công cụ, đọc ngữ cảnh, dịch, quyết định bước hỗ trợ tiếp theo | Agent trong host được chọn |
| Xác nhận nguồn thực tế, thu/lưu audio tạm, trả phần nguồn mới và trạng thái backlog | Bộ tai và công cụ nguồn |
| Xác thực kết quả gắn đúng nguồn/phiên, cập nhật bảng, lưu lịch sử text | Công cụ hiển thị và lưu trữ |
| Giới hạn tài nguyên, ngăn thao tác ngoài scope, dừng và giải phóng tiến trình | Runtime của bộ tools |
| Giao nhiệm vụ, chọn nguồn khi còn mơ hồ, dừng phiên, thay trợ lý | Người dùng |

Việc tool giữ nguồn, báo trạng thái hoặc quản lý tiến trình không biến tool thành một translator khác. Đường ASR nếu cần phải công khai vai trò nhận dạng; không tự thêm backend dịch độc lập với agent.

## Yêu cầu V1

Các yêu cầu dưới đây là `ENGINEERING_BASELINE` phục vụ OWN-001…OWN-007, chưa phải bằng chứng đã đạt.

| ID | Hành vi cần có | Kiểm chứng |
| --- | --- | --- |
| REQ-01 | Agent dùng tools hỗ trợ phiên hiện có; không cần người dùng vận hành từng chunk | AT-02, AT-03 |
| REQ-02 | Thu nguồn độc lập khi agent đang suy luận; khoảng thiếu và backlog phải nhìn thấy | AT-04, AT-07 |
| REQ-03 | Dịch lời được nói, giữ lặp thật, số, phủ định và sửa lời; không thay bằng tóm tắt | AT-05 |
| REQ-04 | Cho phép bản tạm và bản sửa có dấu hiệu rõ; không đợi hai kết quả giống hệt mới hiển thị | AT-05, AT-06 |
| REQ-05 | Bảng hiển thị riêng, đọc được Việt/Lào, có trạng thái nghe/chờ/trễ và lịch sử | AT-06 |
| REQ-06 | Một lệnh giao phiên bao phủ thao tác thường lệ trong scope; không hỏi lại từng đoạn | AT-02, AT-03 |
| REQ-07 | Dừng từ bảng vẫn hiệu lực khi agent bận hoặc host mất kết nối | AT-07 |
| REQ-08 | Text tự lưu trên máy; audio được thu dọn theo chính sách tạm thời, kể cả sau crash | AT-08 |
| REQ-09 | Không dùng nguồn, credential, runtime, queue hoặc dịch vụ AIOS | AT-01 |
| REQ-10 | Capability thiếu phải báo rõ; không tự đổi host, API, tài khoản hay mô hình dịch | AT-02, AT-07 |
| REQ-11 | Ngữ cảnh cuộc họp hỗ trợ dịch; lời nói/tài liệu trong họp không trở thành quyền điều khiển tools | AT-09 |

## Phạm vi giai đoạn

V1 gồm chuẩn bị phiên, tai, nguồn/context, agent tools, bảng dịch, lưu text, tạm dừng/kết thúc, trạng thái và khả năng phục hồi đã đo. Tài liệu chủ đề/glossary do người dùng cung cấp có thể hỗ trợ dịch. Hỏi đáp, đề xuất hành động, ghi biên bản/tóm tắt có tương tác, voice, gửi chat cho người khác và tự Join không nằm trong V1.

Kiến trúc phải cho phép thêm công cụ hỗ trợ agent về sau mà không dựng lại lõi. Điều đó không tự cấp quyền sử dụng hoặc mở rộng V1 ngay trong phiên đầu.

## Ranh giới hoàn thành

Khóa tài liệu không phải hoàn thành sản phẩm. Một tool call thành công không chứng minh agent theo dõi liên tục. Nguồn được thu đủ byte không chứng minh đủ lời/đúng nghĩa. Bảng render không chứng minh người dùng đọc kịp. Các mức bằng chứng được tách trong [ACCEPTANCE.md](ACCEPTANCE.md).
