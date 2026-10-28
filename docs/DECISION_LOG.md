# Sổ quyết định

Revision v0.3.0 —28/10/2026. Chỉ nội dung dưới nhãn OWNER_LOCKED là lựa chọn đã được người dùng chốt. Nội dung kỹ thuật do agent thiết kế phải giữ nhãn riêng.

## Nguồn quyết định

| Nguồn | Nội dung trong cuộc trao đổi |
| --- | --- |
| U1 | Yêu cầu tạo thư mục/dự án/Git repo riêng cho trợ lý cá nhân; có thể thay Claude bằng AGY hoặc Codex |
| U2 | Yêu cầu tiếp tục khóa tài liệu, cách dùng, định hình sản phẩm và kỹ thuật |
| U3 | Trả lời chọn host đầu tiên: “Claude desktop dùng được first” |
| U4 | Trả lời luồng dùng: “Chỉ bảng dịch trực tiếp trước, hỏi đáp làm sau” |
| U5 | Trả lời lưu dữ liệu: “Tự lưu lịch sử text trên máy; audio chỉ tạm thời” |
| U6 | Điều chỉnh mô hình: xây tools quanh trợ lý để nó kích hoạt tham gia hỗ trợ họp; nghĩ theo AGENTIC AI |
| U7 | Làm rõ tham gia họp: “Hỗ trợ cuộc họp đã mở: tự bật bộ tai, lấy ngữ cảnh và hiển thị dịch” |
| U8 | Yêu cầu dựng runtime vừa đủ để Claude hỗ trợ phiên họp chiều nay; cung cấp ảnh agenda |
| U9 | Làm rõ: “Chiêu nay chỉ có tiếng Việt không cần Phiên dịch” |
| U10 | Chọn nguồn phát Zoom: G243FW — âm thanh qua màn hình NVIDIA |
| U11 | Với đề nghị restart Claude/thu thử mẫu công khai, chọn “Tôi sẽ tự khởi động lại Claude sau” |
| U12 | 28/10: chọn chạy theo dõi họp Zoom qua Claude Code (MCP local), nguồn G243FW |
| U13 | 28/10: “khi tôi gửi link họp + nội dung thì nghe cho tôi sau đó có RAW + Summarize + task sau họp” |
| U14 | 28/10: bộ công cụ được giao cho người dùng không dùng Claude; audit và chỉnh sửa |
| U15 | 28/10: “update bộ nghe được tiếng hỗn hợp nhé VIỆT LÀO” |

Ảnh định hướng trong U1 và tài liệu b15f178 của repo AIOS chỉ cung cấp bối cảnh hai sản phẩm độc lập. Không nhập runtime, quyền phiên họp hoặc tiêu chí nghiệm thu của repo đó vào đây.

## Khóa theo chủ sản phẩm

| ID | Nguồn | Nội dung |
| --- | --- | --- |
| OWN-001 | U1 | Dự án/repository cá nhân độc lập AIOS |
| OWN-002 | U1 | Claude/AGY/Codex thay thế được theo lựa chọn người dùng |
| OWN-003 | U3 | Claude Desktop trước |
| OWN-004 | U4 | Bảng dịch trực tiếp trước, hỏi đáp sau |
| OWN-005 | U5 | Lưu text cục bộ mặc định; audio tạm |
| OWN-006 | U6 | Agent chủ động dùng tools; không thiết kế thành app gọi hàm dịch |
| OWN-007 | U7 | Hỗ trợ cuộc họp đã mở, không cần tự mở lời mời/Join trong V1 |
| OWN-008 | U8/U9 | Pilot hiện tại nghe tiếng Việt, không phiên dịch; tools/context/transcript phục vụ phiên chiều nay |
| OWN-009 | U13 | Người dùng gửi link Zoom + nội dung họp; trợ lý mở link và nghe. Thay phần “không tự mở lời mời/Join” của OWN-007: trợ lý được mở link người dùng gửi, người dùng vẫn tự bấm Join/Join Audio |
| OWN-010 | U13 | Sau họp có RAW transcript, Summary và Task |
| OWN-011 | U14 | Bộ công cụ dùng được với host không phải Claude (Codex, Antigravity…), cùng bộ MCP tools |
| OWN-012 | U15 | Bộ tai nghe cuộc họp nói lẫn tiếng Việt và tiếng Lào. Thay phần “chỉ tiếng Việt” của OWN-008; vẫn không phiên dịch |

U10 là lựa chọn nguồn cho phiên hiện tại, không mặc định mọi máy. U11 là ranh giới vận hành lần này: không restart Claude hoặc thực hiện đề nghị thu thử thay người dùng. Claude đã ghi đè lần chỉnh config khi còn chạy; installer hiện yêu cầu app đóng trước khi apply. Host/device acceptance vẫn chờ. Hỏi đáp/ghi chú trong Claude khi người dùng yêu cầu là hỗ trợ theo scope pilot, không phải đã hoàn thành giao diện hỏi đáp hoặc V1 phiên dịch.

## Baseline kỹ thuật do agent lập

| ID | Lựa chọn ENGINEERING_BASELINE | Lý do / điều kiện xem lại |
| --- | --- | --- |
| ENG-01 | Local MCP tools là đường tích hợp Claude Desktop đầu tiên để chứng minh | Có đường desktop extension được công bố; kiểm tra host thật trước khi gọi là khả dụng |
| ENG-02 | TypeScript/Node cho tool server và bảng web cục bộ; đóng gói extension sau phép thử | Một hệ ngôn ngữ cho tool và panel; phiên bản SDK/runtime được pin khi triển khai |
| ENG-03 | Bảng web chỉ bind loopback; text/history thuộc máy người dùng | Phục vụ một người và không cần dịch vụ AIOS; đóng gói native UI chưa cần ở V1 |
| ENG-04 | Agent điều phối nhiệm vụ; tools giữ state, resource bounds và STOP độc lập | Agent bận không được làm tai dừng đọc hoặc làm mất quyền dừng của người dùng |
| ENG-05 | Text lưu bền theo session; audio tạm có giới hạn và cleanup khi hết phiên/crash | Thực hiện OWN-005; dung lượng/TTL cụ thể cần phép đo trước khi bật capture |
| ENG-06 | Phiên bản snapshot tài liệu + SHA-256 + lịch sử Git | Phát hiện tài liệu bị đổi ngoài revision; không phải khóa bất biến hoặc bằng chứng sản phẩm |
| ENG-07 | Windows là máy kiểm chứng đầu tiên theo workspace hiện tại | Mở rộng OS sau; không suy từ Windows thành đã hỗ trợ mọi máy |
| ENG-08 | Pilot VI dùng faster-whisper small CPU int8, PyAudioWPatch, audio RAM và SQLite text | Công cụ nhận dạng hỗ trợ agent; không có backend dịch; test file công khai chưa là device/Human UAT |
| ENG-09 | Node 24.14.0 + SDK 1.32.2 + dependency/model locks; PyAV 16.0.1 | Pin PyAV sau lỗi decode API ở 19.0.2; không auto-download model trong cuộc họp |
| ENG-10 | Loopback có đo mức âm khi liệt kê nguồn và phát im lặng giữ khung âm khi nghe; tràn bộ đệm không làm dừng phiên | 28/10 G243FW không nhận khung âm nào vì Zoom phát ra Realtek; loopback WASAPI không có khung khi thiết bị im lặng |
| ENG-11 | RAW.md do tool ghi khi kết thúc; SUMMARY.md/TASKS.md do agent của host viết và lưu qua tool, bắt buộc source ID; file chỉ lưu cục bộ | Thực hiện OWN-006/OWN-010: không gọi thêm LLM/API; host nào cũng dùng được (OWN-011) |
| ENG-13 | Mỗi đoạn âm chọn vi hoặc lo (chỉ so hai ngôn ngữ của phiên), dò trong cùng lượt mã hóa; ngôn ngữ ngoài phiên mới chạy lại; gắn nhãn ngôn ngữ từng đoạn; cờ khi tiếng Lào bị ghi bằng chữ Thái | 28/10: whisper small viết tiếng Lào bằng chữ Thái; chất lượng tiếng Lào cần model/ASR khác và phép đo trên mẫu Lào trước khi dựa vào nội dung |
| ENG-12 | `meeting_open` chỉ nhận link Zoom, dựng lại URL từ phần đã kiểm tra, không lưu passcode; chế độ test không mở Zoom | Thực hiện OWN-009 mà không đưa chuỗi tùy ý tới trình mở URL của hệ điều hành |

Các cap/timeout cụ thể cho pilot được ghi ở [runbook](PILOT_RUNTIME_20261026.md), chưa là ngưỡng nghiệm thu sản phẩm chung. Nguồn ASR/metadata thực không đưa vào Git.

## Điểm còn mở, ai giải quyết và bằng chứng cần có

| ID | Điểm mở | Cách đóng | Ảnh hưởng |
| --- | --- | --- | --- |
| OPEN-01 | Claude Desktop thật có tiếp tục vòng tools khi nguồn đến mới và khi turn kết thúc không? | FP-02/FP-03 với client/version/surface cụ thể | Chặn tuyên bố dịch trực tiếp tự vận hành |
| OPEN-02 | Audio trực tiếp hay ASR riêng; chất lượng Việt/Lào và nơi dữ liệu được gửi | FP-04 trên nguồn được phép, ghi rõ thành phần/quota | Chặn đường audio thật |
| OPEN-03 | Nguồn audio trên máy họp, quyền OS và phụ thuộc native | Kiểm tra thiết bị/source binding và mất/đổi nguồn | Chặn capture thật |
| OPEN-04 | Thời lượng chunk, dung lượng audio tạm, timeout, backlog và cleanup deadline | Phép đo FP-05 rồi pin profile; không có giá trị ngầm/unbounded | Chặn bật capture dài |
| OPEN-05 | Mục tiêu độ trễ/chất lượng có ích cho người dùng | Đo theo AT-05/AT-10, xem bản mẫu và chốt tiêu chí | Chặn nghiệm thu V1 |
| OPEN-06 | Cách cài/package và đúng surface của Claude Desktop trên máy người dùng | FP-01; không đồng nhất plugin với desktop extension | Chặn tuyên bố cài được |

Thay thế định hướng cũ: kiến trúc “app tự điều phối provider dịch” và cách dùng “ô hỏi trợ lý ngay trong V1” không còn là baseline. Lịch sử commit khởi tạo vẫn giữ nguyên để truy xuất.
