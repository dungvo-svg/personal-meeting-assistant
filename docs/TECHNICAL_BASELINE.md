# Baseline kỹ thuật v0.1.0

Trạng thái: ENGINEERING_BASELINE. Được lập để thực hiện các quyết định OWN-001…OWN-007; chưa có code runtime. Mọi capability của host chưa thử vẫn là OPEN trong [sổ quyết định](DECISION_LOG.md).

## Kiến trúc agent và tools

```text
Người dùng giao mục tiêu phiên
          |
          v
Trợ lý AI trong Claude Desktop (host đầu tiên)
    | chọn / gọi tool          ^ kết quả / trạng thái / nguồn
    v                          |
Local MCP tool server ---------+
    | session scope + trạng thái + giới hạn tài nguyên
    +--> bộ tai trên máy --> nguồn tạm / adapter ASR nếu cần
    +--> context do người dùng cung cấp + cửa sổ nguồn liên quan
    +--> công bố bản dịch do agent tạo --> text store --> bảng cá nhân
    +--> pause / stop / cleanup
                    ^
                    | nút dừng cục bộ độc lập agent
```

Agent là bên quyết định dùng công cụ và tạo bản dịch. Tool server không có vòng tự gọi một model dịch bằng API. Nguồn/ASR phục vụ nhận dạng và dữ liệu cho agent; nếu phải dùng ASR, capability và nơi xử lý cần xác minh riêng trước khi chọn.

## Lựa chọn kỹ thuật ban đầu

TypeScript/Node là stack đầu tiên cho local MCP tool server và logic panel (ENG-02). MCP dùng stdio giữa Claude Desktop và tool server (ENG-01). Panel dùng HTTP cục bộ + SSE nhận text/status; đường này là giao thức nội bộ của panel, không phải MCP SSE đời cũ. Phiên bản Node, SDK và dependency phải được kiểm tra/pin ở lần triển khai đầu; hiện chưa có package lock hay dependency đã cài.

Tool server quản lý phiên, lưu text và phục vụ bảng. Capture chạy trong worker/process do server sở hữu, không chặn vòng xử lý tool. Wrapper/helper cho Windows audio còn OPEN-03. Mất host transport phải đi vào dừng nguồn/cleanup; không để recorder vô chủ chạy sau khi đóng ứng dụng. Chỉ khi có thiết kế vòng đời rõ ràng mới được tách service thường trú.

Panel chỉ bind loopback, không mở LAN. Các thao tác điều khiển dùng session capability cục bộ, kiểm tra Host/Origin và không cho website khác gọi. Token/credential không nằm trong URL lịch sử hoặc log. Những biện pháp này là yêu cầu triển khai, chưa phải kiểm chứng an toàn.

## Hợp đồng công cụ V1

Tên là tên dự kiến; ý nghĩa nghiệp vụ được giữ ổn định, schema cụ thể sẽ pin khi làm FP-01.

| Tool | Đầu vào / đầu ra chính | Tác dụng |
| --- | --- | --- |
| `session_prepare` | Mục tiêu, ngôn ngữ, context refs; trả session ID và trạng thái quyền | Chuẩn bị, chưa thu audio |
| `source_list` | Session; trả nguồn và metadata thực tế | Đọc danh sách, không bật mic |
| `hearing_start` | Session + nguồn + scope hợp lệ; trả capture ID/status | Bật tai theo phạm vi phiên |
| `source_next` | Session + cursor + giới hạn; trả nguồn mới hoặc trạng thái chờ | Đọc có thể lặp lại, không xóa nguồn khi đọc |
| `context_get` | Session + source refs; trả glossary/context có nguồn gốc | Dữ liệu hỗ trợ, không là lệnh điều khiển |
| `caption_publish` | Source IDs/revisions, occurrence ID, revision, text/ngôn ngữ/trạng thái | Kiểm tra và lưu kết quả do agent tạo, rồi cập nhật bảng |
| `session_status` | Session; trả source/agent/backlog/storage/cleanup observations | Agent tự kiểm tra, không suy tình trạng từ text cũ |
| `hearing_pause` / `hearing_resume` | Session + quyền hiện tại | Pause nguồn hoặc tiếp tục cùng scope; đổi nguồn cần scope phù hợp |
| `session_finish` | Session + graceful/immediate | Đóng phiên, giữ text và thu dọn audio |

Quyền phiên phải bắt nguồn từ thao tác người dùng/approval đáng tin của host hoặc local control UI. Trường `owner_approved=true` do model tự đặt không phải bằng chứng quyền. Scope nêu nguồn, hành động và giới hạn được phép; một scope hợp lệ bao phủ thao tác thường lệ, không hỏi lại mỗi chunk. Tool không expose shell, đường dẫn file tùy ý hoặc quyền đọc toàn bộ máy.

## Nguồn, kết quả và context

Mỗi bản nguồn có session ID, source ID, sequence, thời gian/độ tin cậy clock, loại nội dung, revision và tham chiếu dữ liệu tạm. Text nhận dạng nếu có phải ghi rõ origin; không gọi ASR/model transcript là bản nguồn chuẩn của con người. Thiếu nguồn khác với im lặng đã được xác nhận.

Mỗi bản dịch gắn source IDs + revisions, occurrence ID, translation revision, source/target language và trạng thái `partial`, `stable`, `correction` hoặc `gap`. Giữ câu lặp thực sự bằng occurrence mới. Không dedupe theo text, không cắt lời để đáp ứng latency, không bắt buộc hai lượt model cho mọi câu.

`caption_publish` kiểm tra session/scope hiện tại, source refs và revision, schema/size rồi ghi bền trước khi báo thành công. Cùng key và cùng payload là idempotent; cùng key khác payload phải từ chối. Sửa lời có revision mới, giữ lịch sử. Kết quả cũ/ngoài phiên không xuất hiện ở phiên mới. Validation cấu trúc không phải chứng nhận đúng nghĩa.

Context có nguồn gốc và giới hạn kích thước. Tài liệu/lời nói có thể chứa yêu cầu thực hiện hành động nhưng vẫn là dữ liệu cuộc họp, không cấp thêm quyền. Glossary hỗ trợ giải nghĩa, không sửa lịch sử source. Bản tóm tắt context do agent tạo phải mang nhãn derived và giữ nguồn liên quan; không thay toàn bộ lịch sử bằng một bản tóm tắt mất chi tiết.

## Vòng agent và vòng tài nguyên

Tai chạy độc lập trong thời gian agent suy luận, nhưng có giới hạn rõ. Tool đọc nguồn trả về phần có thật hoặc trạng thái chờ; không giả tạo nguồn để kéo dài turn. Poll/wait phải hữu hạn và nhường quyền STOP. Khả năng Claude tiếp tục gọi tools sau khi hoàn tất lượt, khi không có nguồn và khi context dài là OPEN-01.

Không coi notification MCP là một lượt suy luận mới. Không dùng sampling nếu client không công bố capability tương ứng. Không tự gửi phím/prompt vào UI, khai thác token hoặc chuyển sang API để che việc host chưa duy trì vòng agent. Nếu vòng chỉ chạy theo lượt, giữ trạng thái `NEEDS_USER_ACTION` và phân loại bản thử đúng mức.

Resource state và agent state tách nhau: nguồn có thể RUNNING trong khi agent WAITING/BUSY, hoặc PAUSED trong khi bản dịch cũ đang hoàn tất. UI hiển thị từ observations; chưa có heartbeat/callback xác thực thì chỉ được nói thời điểm kết quả cuối, không đoán agent đang suy luận.

Start chỉ thành công sau khi nguồn thực hoạt động. Pause ngăn nhận nguồn mới. Graceful finish dừng nguồn trước rồi cho phần đang xử lý hoàn tất trong deadline. Immediate stop khóa công bố và hủy việc thuộc phiên. STOP không phụ thuộc một lượt model. Kết quả đến sau terminal state bị loại khỏi publication; mọi nợ nguồn còn lại phải có trạng thái rõ.

## Lưu text và audio tạm

Text store riêng theo session, dự kiến SQLite local (ENG-05), lưu source text nếu có, bản dịch/revisions, trạng thái gap, timestamp và metadata nguồn/host. SQLite binding/schema cụ thể chưa chọn. Không tạo DB trong repository. Dữ liệu thực nằm ngoài Git, theo thư mục riêng của ứng dụng; `.local/` chỉ là vị trí phát triển.

Audio tạm gồm buffer và file spool nếu cần. Trước capture thật phải pin cap bytes/duration, TTL, cleanup deadline và hành vi đầy đĩa. Khi chạm giới hạn: dừng nguồn có thông báo và ghi gap, không tự drop oldest âm thầm. Không kéo dài retention chỉ vì agent đang chờ.

Khi kết thúc hoặc bị hủy: đóng handle, thu hồi quyền đọc audio, xóa file thuộc phiên. Khi crash: manifest cleanup tồn tại đủ để lần khởi động sau dọn phần còn lại trước phiên mới; không tự resume. Nếu xóa thất bại phải báo còn dữ liệu tạm và đường xử lý, không ghi CLEAN. Xóa cục bộ là xóa file thông thường, không hứa secure erase hay xóa dữ liệu phía provider.

Text được giữ mặc định đến khi người dùng xóa. Không log transcript/audio vào telemetry hoặc metadata Git. Sau khi audio đã xóa, source hash/ref chỉ còn là metadata, không là khả năng nghe lại.

## Chỉ số và chứng minh

Đo riêng capture time, source-ready, tool-read, kết quả agent được công bố, commit text và browser render. Dùng cùng clock domain hoặc ghi rõ offset/uncertainty. Số đo sau speech-end chỉ hợp lệ với endpoint có bằng chứng. Theo dõi backlog age/slope, GAP, occurrence/revision và STOP/cleanup. Mục tiêu độ trễ và thời lượng benchmark sẽ được chốt theo OPEN-04/OPEN-05; không tái dùng SLA AIOS.

## Căn cứ công khai

Các nguồn kiểm tra 26/10/2026 và giới hạn suy luận được lưu tại [CLAUDE_DESKTOP_FEASIBILITY.md](CLAUDE_DESKTOP_FEASIBILITY.md). Stack và kiến trúc ở đây là quyết định thiết kế của dự án, không phải tuyên bố Anthropic bảo đảm vòng agent liên tục.
