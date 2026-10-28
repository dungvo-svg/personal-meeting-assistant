# Nghe họp Zoom và xuất RAW, Summary, Task

Version 0.3.0, ngày 28/10/2026. Thay cách dùng của [runbook 26/10](PILOT_RUNTIME_20261026.md). Nghe lẫn Việt–Lào, không phiên dịch. Các giới hạn nghe (một nguồn, grant 3 giờ, capture 2 giờ, chunk 3–12 giây, 4 chunk chờ) giữ nguyên.

## Luồng dùng

Người dùng gửi cho trợ lý: **link Zoom + nội dung họp**. Mẫu lời giao việc: [handoff/MEETING_START.vi.txt](../handoff/MEETING_START.vi.txt). Nút **Sao chép lời giao việc** trên bảng cũng cho ra mẫu tương tự.

1. Trợ lý gọi `session_prepare(title, agenda)`. Agenda chỉ là context.
2. Trợ lý gọi `meeting_open(url)`. Zoom mở phòng; **người dùng tự bấm Join và Join Audio**. Tool chỉ nhận link Zoom và không lưu passcode.
3. Người dùng mở `http://127.0.0.1:8796/` → **Đọc danh sách nguồn** khi trong Zoom đang có tiếng. Bảng đo mức âm từng loa, gắn nhãn `CÓ TIẾNG` / `đang im` / `không có khung âm` và chọn sẵn nguồn có tiếng. Bấm **Cho phép nguồn này trong phiên**. Quyền chọn nguồn vẫn chỉ nằm trên bảng.
4. Trợ lý gọi `hearing_start`, rồi đọc `source_next` liên tục.
5. Khi họp xong, trợ lý gọi `session_finish`. Tool tự ghi `RAW.md`. Trợ lý đọc hết bằng `history_read`, rồi lưu `SUMMARY.md` (`report_save_summary`) và `TASKS.md` (`report_save_tasks`) kèm source ID thật.

File nằm trong `.local/runtime/reports/<ngày-giờ>_<mã phiên>/`. Bảng có nút **Tải RAW / Tải Summary / Tải Task**, dùng được cả cho phiên cũ trong lịch sử.

## Nghe lẫn tiếng Việt và tiếng Lào

`session_prepare` mặc định `languages: ["vi", "lo"]`. Với mỗi đoạn âm (tối thiểu 6 giây khi nghe hai thứ tiếng, tối đa 12 giây), ASR chọn tiếng Việt hoặc tiếng Lào rồi nhận dạng theo ngôn ngữ đó. Whisper hay nhận tiếng Lào thành tiếng Thái, nên điểm “Thái” được cộng vào “Lào”. Mỗi đoạn có nhãn `vi`/`lo` trên bảng, trong `source_next` và trong RAW. Họp chỉ một thứ tiếng thì truyền một ngôn ngữ để nhanh và chính xác hơn.

Giới hạn đã đo ngày 28/10:

- Tiếng Việt vẫn nhận dạng như bản chỉ-tiếng-Việt; chi phí xử lý tăng từ khoảng 3,4 giây lên 5,3 giây cho mỗi đoạn 11,3 giây, vẫn kịp thời gian thực trên máy này.
- **Model whisper small viết tiếng Lào bằng chữ Thái** và chất lượng thấp. Những đoạn này được gắn cờ “viết bằng chữ Thái, nội dung không đáng tin”. Hiện chỉ dùng được để biết đoạn nào nói tiếng Lào, chưa dùng được làm nội dung tóm tắt hay giao việc.
- Đoạn có cả hai thứ tiếng chỉ mang một nhãn; câu chuyển ngôn ngữ giữa đoạn có thể bị ghi sai.
- Muốn nội dung tiếng Lào dùng được cần một model/ASR tiếng Lào khác và phép đo trên mẫu tiếng Lào thật; chưa làm.

## Chọn đúng nguồn âm thanh

Bộ tai thu âm thanh **phát ra một thiết bị loa** (loopback). Phải chọn đúng thiết bị Zoom đang phát; thường là loa mặc định của Windows. Ngày 28/10, G243FW không nhận khung âm nào vì Zoom phát ra Realtek.

Khi nghe, worker phát im lặng (không nghe thấy được) ra cùng thiết bị để loopback luôn có khung âm. Vì vậy `LISTENING` chỉ có nghĩa là đọc được nguồn. Nếu trong họp có người nói mà bảng báo **Nguồn im lặng ≥ 30 giây**, tức là đã chọn sai thiết bị: bấm Tạm dừng nghe rồi chọn lại.

## RAW, Summary, Task

- **RAW.md**: toàn bộ text ASR/nhập tay chưa xác minh, theo giờ máy lúc ghi nhận (trễ vài giây so với lời nói), kèm source ID và lượt nghe.
- **SUMMARY.md**: agent của host tự viết; tool bắt buộc có source ID thuộc phiên.
- **TASKS.md**: bảng việc / người phụ trách / hạn / nguồn. Người phụ trách và hạn chỉ điền khi được nói trong họp; còn lại ghi “Chưa nêu trong họp”. Cần người dùng xác nhận trước khi giao việc.

Không có LLM hay API nào khác được gọi: ASR chạy cục bộ, phần tóm tắt do chính trợ lý người dùng đang dùng viết. Không file nào được gửi ra ngoài.

## Dùng với host khác Claude

Cùng một MCP server stdio. In cấu hình với đường dẫn của máy này:

```
python tools/mcp_config.py claude-code      # lệnh claude mcp add
python tools/mcp_config.py claude-desktop   # khối mcpServers
python tools/mcp_config.py codex            # khối cho ~/.codex/config.toml
python tools/mcp_config.py antigravity      # khối mcpServers cho mcp_config.json
```

Codex cần `tool_timeout_sec` lớn hơn 25 giây vì `source_next` chờ tối đa 25 giây; script đặt sẵn 60. Chỉ chạy **một** host có server này tại một thời điểm vì bảng dùng cổng 8796. Cấu hình Codex/Antigravity chưa được thử trên host thật.

## Bằng chứng 0.3.0

| Kiểm tra | Kết quả và giới hạn |
| --- | --- |
| Contract test Node | 17/17 PASS, gồm link Zoom, context ngày cũ, RAW/Summary/Task sau khi kết thúc, nhãn vi/lo và cờ chữ Thái |
| Dò ngôn ngữ | Clip tiếng Việt công khai FLEURS: chọn vi (99,3% không giới hạn). Chưa có mẫu tiếng Lào để đo |
| Protocol probe | PASS với 16 tools; `meeting_open` không mở Zoom ở chế độ test; tải RAW/Summary/Task qua bảng |
| Mức âm thiết bị | 28/10: Realtek có khung âm, G243FW 0 khung. Chỉ đo mức, không giữ audio |
| Keepalive | G243FW im lặng: 0 khung → 71.680 khung trong 1,5 giây khi bật keepalive |
| Bảng | Chọn sẵn Realtek "CÓ TIẾNG", G243FW "không có khung âm" |
| Họp thật với 0.3.0 | Chưa chạy. Chưa có Human UAT về chất lượng RAW/Summary/Task |
