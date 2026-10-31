# Kiểm chứng Claude Desktop trước khi triển khai rộng

Ngày nghiên cứu: 26/10/2026. Host đầu tiên đã được người dùng chọn. Chưa cài extension, đọc tài khoản/credential, gọi model hoặc thu âm trong công việc baseline này.

## Những gì tài liệu công khai hỗ trợ

| Nguồn | Kết luận giới hạn |
| --- | --- |
| [Anthropic: local MCP và desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) | Có cơ chế cài local MCP qua desktop extension, gồm custom package `.mcpb`. Không chứng minh extension của ta đã cài/chạy. |
| [Anthropic: desktop và web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) | Tài liệu phân biệt desktop extension với plugin chứa MCP; khả năng xuất hiện phụ thuộc surface. Cần kiểm tra đúng Chat/Cowork trên client thật, không suy từ tên Claude Desktop. |
| [MCP tools, bản đặc tả 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Có tools do model gọi và kiểu nội dung audio trong protocol. Việc protocol biểu diễn audio không chứng minh client hiểu hoặc suy luận từ audio. |
| [MCP sampling, bản đặc tả 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) | Client phải khai báo capability sampling để dùng cơ chế đó. Chưa kiểm tra capability của Claude Desktop trên máy người dùng. |
| [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | Client khởi chạy server con, trao đổi JSON-RPC qua stdin/stdout. Từ thiết kế này, dự án cần xử lý mất kết nối/tiến trình và cleanup riêng. |
| [MCP bundle](https://github.com/modelcontextprotocol/mcpb) và [TypeScript SDK chính thức](https://github.com/modelcontextprotocol/typescript-sdk) | Có công cụ đóng gói và SDK để khảo sát khi triển khai; chưa chọn/pin bản phát hành hay cài dependency. |

Không dùng ma trận client cũ hoặc dòng “full support” để kết luận sampling, audio hoặc chạy liên tục. Các protocol links trên là phiên bản tham chiếu cụ thể; implementation phải dùng phiên bản thực tế thương lượng với host.

## Chuỗi phép thử cần làm

Mỗi phép thử ghi client version, đúng surface, cách cài, protocol/capabilities, phiên bản source, đầu vào và bằng chứng quan sát. Tên phép thử không phải kết quả.

| ID | Phép thử | Bằng chứng đạt | Khi không đạt |
| --- | --- | --- | --- |
| FP-01 | Tool server local, fixture text tổng hợp, panel và STOP | Tools hiện trong đúng surface; agent đọc source và gọi publish; panel hiển thị đúng source/revision | Sửa packaging/schema; chưa chạm audio |
| FP-02 | Nguồn fixture đến theo nhịp, có đoạn chờ và câu lặp | Agent nhiều lần tự đọc và publish trong cùng phiên; ghi số lần người dùng phải nhắc | Nếu cần nhắc từng đợt, ghi turn-bound, chưa gọi live |
| FP-03 | Turn kết thúc, context lớn, host bận/đóng, rồi kết nối lại | Có bằng chứng client duy trì/khôi phục workflow theo cơ chế hỗ trợ; STOP vẫn độc lập; không duplicate nguồn | Báo rõ giới hạn; không lén đổi host/API hoặc automation UI |
| FP-04 | Đường nguồn đã chọn: audio trực tiếp hoặc ASR cho Việt/Lào | Nguồn được phép, nơi xử lý/quota rõ; agent dịch từ đầu vào thực; người đánh giá kiểm tra nghĩa | Chọn lại đường nguồn trong phạm vi được giao; không gọi protocol-audio là hiểu audio |
| FP-05 | Giới hạn tài nguyên và vòng đời trên máy cá nhân | Backlog/đầy đĩa/STOP/crash cleanup đúng; pin profile hữu hạn; text giữ, audio dọn | Chưa cho chạy họp dài |
| FP-06 | Người dùng dùng bảng trong cuộc họp thực được phép | Đủ luồng hai chiều, đọc được, có ích trong nhịp họp và nguồn/cleanup rõ | Chưa nghiệm thu V1 |

FP-01 với fixture chỉ là proof đường tool. FP-02/03 phải đo cơ chế tiếp tục thật trong Claude Desktop; không thay lượt tự động bằng script giả client rồi gán thành công cho host.

## Điều kiện chốt đường triển khai

Ưu tiên local MCP + agent-owned workflow theo ENG-01. Đóng được FP-01 và FP-02/03 mới mở rộng UI và nghe liên tục. Nếu host không đáp ứng tính tự vận hành, báo bằng chứng cho người dùng để quyết định cách dùng hoặc host khác; không tự chuyển khỏi OWN-003 và không hạ nghĩa “dịch trực tiếp” xuống thao tác thủ công mà không ghi nhận.

Việc chưa có bằng chứng không là kết luận Claude Desktop không làm được. Đây là điểm cần thử sớm để tránh xây phần tai/UI trước rồi mới phát hiện vòng agent không đáp ứng.
