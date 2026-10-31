# Runtime cho phiên họp tiếng Việt —26/10/2026

Version 0.2.0. Người dùng yêu cầu runtime vừa đủ cho cuộc họp chiều nay, sau đó làm rõ **chỉ tiếng Việt, không phiên dịch**. Đây là pilot hỗ trợ phiên hiện tại; mục tiêu phiên dịch Việt–Lào của sản phẩm vẫn thuộc giai đoạn sau.

## Đã dựng

- Local MCP server cho Claude Desktop: chuẩn bị phiên/context, liệt kê nguồn, bật/tạm dừng tai, đọc nguồn theo cursor, ghi chú có source ID, đọc lịch sử và kết thúc.
- Bảng cá nhân tại `http://127.0.0.1:8796/`, bind loopback, có transcript tiếng Việt, trạng thái nguồn/Claude, lịch sử và tải text.
- Nhận dạng tiếng Việt cục bộ bằng faster-whisper small, CPU int8. Vai trò chỉ ASR, không dịch và không gọi speech API.
- Bộ tai Windows WASAPI; nguồn người dùng chọn là G243FW. Đây là audio phát trên thiết bị, không phải nguồn Zoom đã tách riêng. Microphone không tự bật.
- Text lưu SQLite trong `.local/runtime/`; audio cuộc họp chỉ ở RAM. Mẫu công khai phục vụ kiểm tra nằm riêng trong `.local/verification/`, không phải recording cuộc họp.
- Context agenda do người dùng gửi được lưu riêng ở `.local/meeting-context.json`; không đưa agenda/tên người/transcript lên Git.

## Trạng thái bàn giao

`LOCAL_RUNTIME_IMPLEMENTED / GUARDED_INSTALLER_READY / AWAITING_OWNER_QUIT_INSTALL_REOPEN`.

Cấu hình MCP ban đầu được merge/readback và có backup, nhưng Claude đang chạy sau đó ghi đè lại, mất entry mới. Installer đã sửa để từ chối ghi khi Claude Desktop còn chạy. Người dùng chọn **tự khởi động lại Claude sau**: cần chạy file hoàn tất cài đặt sau khi thoát hẳn và trước khi mở lại. Chưa xác nhận host đã nạp/gọi tools thật. Không khởi động lại Claude thay người dùng, không chạy phép thu âm G243FW trong lần dựng này. Không có actual meeting/continuous-agent/Human UAT receipt.

## Cách dùng chiều nay

1. Thoát hẳn Claude; đóng cửa sổ có thể chỉ thu xuống tray. Chạy [Hoan-tat-cai-Claude.cmd](../Hoan-tat-cai-Claude.cmd), đợi thông báo config đã ghi/readback rồi tự mở Claude lại. Helper không đóng/mở Claude hay bật tai; từ chối ghi nếu app còn chạy. Trong Settings → Developer → Local MCP servers, kiểm tra `personal-meeting-assistant`. Không đổi các thiết lập security/privacy.
2. Mở `http://127.0.0.1:8796/`. Chọn **Chuẩn bị phiên → Đọc danh sách nguồn → G243FW → Cho phép nguồn này trong phiên**. Lúc này chưa bật tai.
3. Mở cuộc họp bằng ứng dụng họp như bình thường. Dán [lời giao việc](../handoff/CLAUDE_MEETING_START.vi.txt) vào cuộc trò chuyện Claude dùng bộ tools này và yêu cầu bắt đầu; Claude gọi `hearing_start`. Nút **Bật bộ tai** trên bảng là đường điều khiển trực tiếp nếu cần.
4. Chỉ xem là nguồn đã hoạt động khi bảng báo **Đang nghe tiếng Việt**, có mức âm thanh và transcript mới. `Đang tải ASR` / `Chờ đọc được nguồn` chưa phải bằng chứng nghe thành công. Kiểm tra một câu thực tế trước khi dựa vào nội dung.
5. Khi cần, hỏi Claude dựa trên source IDs; các ghi chú AI phải dẫn nguồn. Nếu Claude đã kết thúc lượt, nhắn “tiếp tục theo dõi”. Transcript cục bộ không chứng minh Claude đang suy luận nền.
6. Kết thúc bằng **Kết thúc / Dừng ngay** hoặc tool `session_finish`. Text được giữ. **Xem lịch sử text** và **Tải toàn bộ text phiên** cho phép xem lại mà không bật recorder.

Nếu chưa thấy tools, giữ nguyên bản cài và kiểm tra Developer/log của đúng entry. Không đổi sang API/Claude Code/host khác âm thầm. Tài liệu này không chứng minh surface Chat/Cowork cụ thể đã nhận tools trên client hiện tại; đó là bước kiểm tra sau restart.

## Giới hạn pilot đã đặt

Một nguồn mỗi phiên; grant nguồn tối đa 3 giờ, một lần capture tối đa 2 giờ và không vượt hạn grant. Chunk tách theo khoảng yên lặng sau tối thiểu 3 giây, trần 12 giây; tối đa 4 chunk chờ ASR. Đầy queue hoặc lỗi đọc làm dừng nguồn và hiện lỗi, không tự giả vờ vẫn nghe đủ. Model load xảy ra trước capture; chỉ có first-read thật mới chuyển LISTENING.

Mốc giây là phạm vi chunk trong từng capture ID, không là timestamp chính xác từng từ hoặc clock liên tục qua pause/resume. ASR có thể nhận sai từ, số, tên người hoặc cắt lời ở giới hạn chunk. Dừng ngay có thể bỏ phần audio chưa xử lý; không nhận kết quả đến muộn sau STOP. Text tối đa 10.000 đoạn/5 triệu ký tự mỗi phiên; notes tối đa 2.000 revisions.

Nút STOP không cần lượt Claude. Worker có watchdog theo parent process. Backend giữ quyền sở hữu recorder trong lúc dừng để chặn recorder thứ hai. Giới hạn này đã kiểm tra bằng fixture/process watcher, chưa thay cho phép thử microphone/loopback thật.

## Bằng chứng hiện có

| Kiểm tra | Kết quả và giới hạn |
| --- | --- |
| TypeScript build + Node contract tests | Ghi số run cuối trong handoff; gồm cursor/lặp thật/STOP/revision/source scope/restart/expiry/concurrent STOP |
| MCP stdio probe | SDK client đọc/publish/STOP qua protocol và kiểm tra HTTP controls; không phải Claude Desktop thật |
| Browser UI | Text Việt, nhãn nguồn nhập tay, chuỗi HTML hiển thị như text, STOP và giữ text được kiểm tra trên database UAT riêng |
| Audio infrastructure | Resample 44.1/48 kHz →16 kHz; watcher thoát khi parent kết thúc; không capture thiết bị |
| Public file ASR | FLEURS vi_vn/test row 0, 11,34s; inference + file decode khoảng 3,80s sau model load ~1,40s; có từ sai, không phải Human UAT |
| Im lặng tổng hợp | 5s, không phát sinh đoạn transcript |
| G243FW capture | Chưa thực hiện; người dùng chưa chọn phép thu thử trong bước này |
| Claude Desktop tool call | Chưa xác nhận; chờ người dùng restart |
| Config persistence | Lần ghi khi app đang chạy bị ghi đè; installer đã thêm kiểm tra app đóng, test từ chối và giữ nguyên config mẫu PASS. Chưa chạy bước apply sau khi app đóng vì owner sẽ tự làm. |

Các số đo ASR là một clip public, không phải SLA, throughput phiên dài hoặc chất lượng cuộc họp. Lần thử decode với PyAV 19.0.2 lỗi API `metadata_errors`; đã pin PyAV 16.0.1 và chạy lại thành công. Receipt gốc và kết quả cuối được giữ riêng, không đổi lỗi cũ thành PASS.

## Tái dựng và kiểm tra

Node 24.14.0 đã dùng trên máy này. Chạy `npm ci`, `npm run build`. Tạo `.venv` bằng Python 3.13 rồi cài `requirements-audio.lock.txt`; chạy `.venv/Scripts/python.exe tools/fetch_model.py` để tải đúng public model revision và kiểm SHA-256. Runtime không tự download model khi bắt đầu cuộc họp.

`python tools/doctor.py` chỉ kiểm tra file/config/model/source enumeration, không thu âm hay gọi model. `npm test`, `.venv/Scripts/python.exe -m unittest discover -s tests -p test_audio_worker.py -v` và `node tools/probe.mjs` chạy các kiểm tra offline; probe dùng port 8797, dữ liệu tạm và fixture label riêng. Không gán receipt probe thành actual Claude.

## Nguồn phụ thuộc

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) và [model public Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small): ASR cục bộ, files/revision pin tại `config/asr-model.lock.json`.
- [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch): Windows WASAPI loopback; thiết bị thật đã enumerate, chưa capture.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x): bản 1.32.2 được pin và dùng trong protocol probe.
- [Google FLEURS](https://huggingface.co/datasets/google/fleurs): nguồn public cho phép thử file; không phải audio cuộc họp của người dùng.
