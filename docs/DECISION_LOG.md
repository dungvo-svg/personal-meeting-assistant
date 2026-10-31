# Sổ quyết định

Revision v0.7.0 —28/10/2026. Chỉ nội dung dưới nhãn OWNER_LOCKED là lựa chọn đã được người dùng chốt. Nội dung kỹ thuật do agent thiết kế phải giữ nhãn riêng.

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
| U16 | 28/10: trả lời 4 câu hỏi backlog: host Claude Desktop tab Code; micro ưu tiên nếu được; chỉ mã nguồn mở có cộng đồng; chỉ AI Claude, không AI/dịch vụ ngoài; họp dài không ngắt giữa chừng; không cồng kềnh, mọi thứ qua Claude; học có chọn lọc |
| U17 | 28/10: “sao không dựng và update đi nhỉ?” — làm ngay, áp dụng cho cuộc họp đang diễn ra |
| U18 | 28/10: “MCP là phương án ban đầu không phải phương án tốt nhất audit nhé” → duyệt “Làm M1–M6” |
| U19 | 30/10: “micro tôi mặc định nhé, luôn nghe đi nhưng làm sao bạn lấy đúng mic của zoom để khi tôi k bật thì nó cx k nghe”; phần chưa làm được thì đưa vào issue chờ thêm dữ liệu họp |
| U20 | 30/10 chiều, sau buổi thử thật trên Google Meet: “Gôm cả 3 đợt lại Plan và làm song song”; “Về mic thì biết tôi nói vào mic là được k phụ thuộc nền tảng”; Opus quyết kiến trúc, Sonnet làm; duyệt lưu âm thanh opt-in (B3) và màn hình chung có bản dịch (B1/B5) |
| U21 | 30/10: “Màn hình chung cho người dự → bỏ nó nhé vì ta đang họp trên session không phải một web nữa” |
| U22 | 31/10: “các đoạn là phần dịch theo dõi, còn wav phải ghi được đầy đủ” |
| U23 | 31/10, audit thiết kế: "có vẻ bạn đang làm sai thiết kế"; WAV là âm thanh thật cả buổi để audit/nghe lại, runtime ưu tiên không sót/ngắt; "đừng thiết kế nó giống như dịch vụ", Claude phải biết đang hỗ trợ ai, trạng thái, context; ba ngôn ngữ Việt/Thái/Lào, lỗi chủ yếu do thuật ngữ thiếu context; audit → plan → hỏi một lần → build → push |
| U24 | 31/10, trả lời câu hỏi: sống theo phiên họp, chuẩn bị context là việc chính, không thi đấu AI của Zoom/Meet; thêm tiếng Thái, đạt khi dịch ra Việt không đổi nghĩa; ghi từ lúc kích hoạt bắt đầu họp, cải tiến tới khi không thể mới bắt mở sớm; WAV giữ tới khi người dùng xoá; dừng khi gõ kết thúc; giữ hai phiên (dịch thô = "màn hình" share cho người dự, tổng hợp = chat với owner); micro khi mute vẫn ghi nhưng phân loại; dọn tài liệu |
| U25 | 31/10: "nghe lại dành cho bạn không phải cho người"; "đừng dùng màn hình như cách build thêm"; "claude ở phiên này dùng công cụ đó phục vụ cho tôi và phiên họp"; "sổ phiên thường là context trước họp"; kiểm qua lần họp tiếp theo, không tự kiểm mình; hỏi Fable như hỏi người giỏi, Opus độc lập; đem R2 A/B về dự án này, không hoàn thiện trong repo công khai |

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
| OWN-013 | U16 | Host chính: Claude Desktop, tab Code (Claude Code) |
| OWN-014 | U16 | Chỉ Claude là AI; âm thanh/ASR/dịch dùng công cụ mã nguồn mở có giấy phép mở và cộng đồng, chạy trên máy; không AI hay dịch vụ ngoài Claude |
| OWN-015 | U16 | Claude theo dõi đến khi người dùng nói kết thúc/đóng; không ngắt giữa cuộc họp |
| OWN-016 | U16 | Không cồng kềnh: mọi thao tác qua Claude; bảng web chỉ là tùy chọn. Micro dùng khi được, không thì chỉ loa |
| OWN-012 | U15 | Bộ tai nghe cuộc họp nói lẫn tiếng Việt và tiếng Lào. Thay phần “chỉ tiếng Việt” của OWN-008; vẫn không phiên dịch |
| OWN-017 | U19, U20 | Micro “Tôi” luôn mở, không hỏi lại mỗi phiên, **không phụ thuộc nền tảng họp**: lời người dùng nói vào micro là “Tôi”, tiếng loa lọt vào bị bỏ. U20 thay phần “chỉ lấy tiếng khi micro Zoom bật” của U19 (bản 0.9.0 làm mất hết lời người dùng trên Google Meet) |
| OWN-018 | U20, U22 | Âm thanh được lưu trên máy, tự xoá sau số ngày đặt (mặc định 7). Thay một phần OWN-005 “audio tạm”. U22: **lưu mặc định** (tắt bằng `pma listen --no-save-audio` hoặc `PMA_SAVE_AUDIO=0`), vì các đoạn chữ chỉ để theo dõi/dịch còn WAV phải đủ; `--save-audio` còn nhận nhưng không còn tác dụng |
| OWN-020 | U22 | Khi ngừng nghe (pause/stop), tự ghép file loa + micro của lượt đó thành `<lượt>-mix.wav` (16 kHz) để `pma replay`: ứng dụng họp không phát lại giọng người dùng ra loa nên file loa thiếu lời “Tôi”. Micro chỉ được cộng vào ở những khoảng 0,1 s đúng là giọng người dùng (cùng luật với bộ tai); ghép chạy tiến trình riêng, không làm chậm pause/stop |
| OWN-019 | U20, U21 | Không có màn hình chung/trang web cho người dự: theo dõi họp trong phiên Claude. Bản dịch Lào→Việt do Claude viết ngay trong phiên, ghi rõ “(Claude dịch)” và lưu vào RAW |
| OWN-021 | U24 | Sống theo phiên họp: không có tiến trình chờ sẵn khi không họp; Claude dùng công cụ phục vụ owner và cuộc họp; việc chính là chuẩn bị context trước họp. Hạ ưu tiên OWN-002/OWN-011 (host khác) |
| OWN-022 | U23, U24 | WAV là âm thanh thật cả buổi (hộp đen), ghi từ `pma start` tới khi owner gõ kết thúc; runtime ưu tiên không sót/ngắt; nghe real-time được phép thiếu nhưng phải báo. Thay OWN-005 |
| OWN-023 | U24 | WAV giữ tới khi người dùng tự xoá. Thay phần tự xoá 7 ngày của OWN-018 |
| OWN-024 | U25 | Nghe lại là việc của Claude: chưa nghe rõ thì tự nghe lại từ WAV hoặc đánh dấu `[chưa nghe rõ]`, không đoán |
| OWN-025 | U24, U25 | Hai phiên khi họp: dịch thô (Haiku, effort low, lô 15 s) là "màn hình" owner share cho người dự; tổng hợp (Sonnet, lô 60 s) chat với owner. Không build màn hình/trang web. Giữ OWN-019 |
| OWN-026 | U23, U24 | Ba ngôn ngữ Việt/Lào/Thái (Tai-Kadai). Đạt khi người nói Lào mà máy ra chữ Thái, dịch ra tiếng Việt không đổi nghĩa. Thay OWN-012 |
| OWN-027 | U24 | Micro "Tôi" khi mute vẫn ghi nhưng phân loại: mic bật / mic tắt (nói riêng) / không rõ |
| OWN-028 | U24 | Kết thúc phiên khi owner gõ kết thúc trong chat; học câu chào cuối buổi sau khi có thêm buổi họp |

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
| ENG-14 | Stop hook Claude Code theo project (`.claude/settings.local.json` → `tools/meeting_stop_hook.mjs`) chặn kết thúc lượt khi phiên họp còn chạy; chỉ áp dụng cho phiên đã gọi hearing_start/source_next | Thực hiện OWN-015; 28/10 phải nhắn “tiếp tục theo dõi” ~12 lần |
| ENG-15 | `source_select` cho agent cấp quyền nguồn loa sau khi người dùng đồng ý trong chat; micro bị từ chối ở tool này | Thực hiện OWN-016; thay quyền chỉ-trên-bảng của bản 0.2/0.3 |
| ENG-16 | Quá tải ASR: giữ khối tới 30 s rồi ghi khoảng trống rõ ràng thay vì dừng bộ thu; câu ảo/lặp từ gắn cờ, không xóa | 28/10 một lần ASR_BACKLOG_LIMIT làm dừng phiên |
| ENG-17 | Lõi là dịch vụ nghe chạy nền một bản mỗi máy + CLI `pma` + skill `hop` + Monitor trên `pma follow`; MCP chỉ là lớp chuyển tiếp | Audit 28/10 (E1–E6): server mỗi phiên làm hỏng trạng thái phiên khác, bộ thu chết theo host, chỉ kéo được không đẩy được, 233 lần hỏi vòng/1,5 giờ |
| ENG-18 | Tiếng Lào: Whisper small nhận diện vi/lo (th tính là lo), đoạn Lào sang BuzzASR/lao (MIT) trên CUDA; model Lào không chạy trên CPU khi họp trực tiếp | FLEURS 28/10: CER Lào 100,2% → 36,3%, chữ Thái → chữ Lào; nhận diện ngôn ngữ 100% trên 80 clip. Đáp ứng OWN-014 (mã nguồn mở, chạy trên máy) |
| ENG-19 | GPU: Whisper large-v3-turbo là model chính (nhận diện vi/lo + tiếng Việt); PhoWhisper-large chỉ là tùy chọn `vi` | FLEURS vi 4,8% (small 9,9%); PhoWhisper-large 3,9% nhưng trên họp thật đọc số thành chữ, mất viết hoa/viết tắt, 5,4 GB VRAM |
| ENG-20 | Micro “Tôi” (0.10): bỏ đọc nút mute (UI Automation) của 0.9.0. `tools/mic_in_use.ps1` (Core Audio, chỉ đọc) tìm micro mà ứng dụng họp (Zoom, trình duyệt, Teams…) đang giữ, kiểm lại mỗi 30 s và báo khi đổi, không đổi giữa chừng; không có thì micro mặc định Windows. `mic_is_own_voice` bỏ tiếng loa lọt vào | Thực hiện OWN-017 (U20); 0.9.0 cho `NO_MEETING` trên Google Meet. Hệ quả chấp nhận: lời nói khi đang tắt mic trong Zoom/Meet vẫn vào “Tôi” |
| ENG-21 | Model Lào BuzzASR bị CTranslate2 coi là English-only (vocab 53.474), `language='lo'` thành `<|en|>` từ 0.6 tới 0.9; 0.10 bọc model để giữ `<|lo|>`, đo lại FLEURS | Xác minh 30/10 bằng `model.is_multilingual == False` và cảnh báo của faster-whisper |
| ENG-22 | `pause` giữ worker và model trong máy (vòng lặp chờ nguồn mới); `modelLoadSeconds` chỉ tính thời gian nạp, thời gian chờ nguồn tách thành `waitedForSourceSeconds` | Buổi 30/10: quãng trống ~55 s sau pause; “nạp 1.273 s” thực ra là chờ họp |
| ENG-23 | Bản dịch Claude lưu bảng `translations` qua `pma translate`, chỉ cho đoạn `lo` của phiên đang mở, ghi vào RAW dưới đoạn Lào. Trang `/live` (agent D làm) đã bỏ theo U21 | Thực hiện OWN-019 không thêm AI ngoài Claude |
| ENG-24 | 0.11: bộ ghi riêng `tools/recorder.py` (không model) ghi loa + micro thành khúc 10 phút + `timeline.jsonl` (giờ thật ↔ mẫu, mất mẫu, đổi thiết bị, trạng thái micro); sống khi host chết, chỉ dừng khi có `stop`/file `STOP`/trần 12 giờ; ghép `meeting-mix.wav` theo giờ thật | Audit 31/10: 13 điểm mất âm vì bản ghi chung tiến trình với ASR |
| ENG-25 | 0.11: bộ nghe đọc WAV của bộ ghi (`--follow`) từ giây 0, đuổi kịp; lỗi ASR một đoạn thành khoảng trống rồi chạy tiếp; `stop` đọc nốt; `--recheck` nhận dạng lại một khoảng giờ thật, trả các phương án vi/lo/th | Nạp model không còn làm mất lời; nghe lại cho Claude (OWN-024) |
| ENG-26 | 0.11: nhãn micro theo `tools/mic_state.ps1` (UI Automation đọc nút micro Zoom và Meet trong Chrome/Edge, chỉ đọc) + `pma me --on/--off/--auto`; gắn `MIC_STATE_ON/OFF/UNKNOWN` cho đoạn "Tôi" | OWN-027; Meet cần kiểm ở họp thật |
| ENG-27 | 0.11: context trước họp `pma brief` (≤ 2 KB: tôi là ai, người dự, mục tiêu, thuật ngữ, một dòng tình trạng), `pma participants`, `.local/context/owner.json` | OWN-021 |
| ENG-12 | `meeting_open` chỉ nhận link Zoom, dựng lại URL từ phần đã kiểm tra, không lưu passcode; chế độ test không mở Zoom | Thực hiện OWN-009 mà không đưa chuỗi tùy ý tới trình mở URL của hệ điều hành |

Các cap/timeout cụ thể cho pilot được ghi ở [runbook](PILOT_RUNTIME_20261026.md), chưa là ngưỡng nghiệm thu sản phẩm chung. Nguồn ASR/metadata thực không đưa vào Git.

## Điểm còn mở, ai giải quyết và bằng chứng cần có

Từ 0.11, điểm mở và nghiệm thu theo [PRODUCT_BASELINE.md](PRODUCT_BASELINE.md) mục "Ranh giới hoàn thành" và issue GitHub (nhãn "cần dữ liệu họp"); danh sách dưới đây là lịch sử.

| ID | Điểm mở | Cách đóng | Ảnh hưởng |
| --- | --- | --- | --- |
| OPEN-01 | Claude Desktop thật có tiếp tục vòng tools khi nguồn đến mới và khi turn kết thúc không? | FP-02/FP-03 với client/version/surface cụ thể | Chặn tuyên bố dịch trực tiếp tự vận hành |
| OPEN-02 | Audio trực tiếp hay ASR riêng; chất lượng Việt/Lào và nơi dữ liệu được gửi | FP-04 trên nguồn được phép, ghi rõ thành phần/quota | Chặn đường audio thật |
| OPEN-03 | Nguồn audio trên máy họp, quyền OS và phụ thuộc native | Kiểm tra thiết bị/source binding và mất/đổi nguồn | Chặn capture thật |
| OPEN-04 | Thời lượng chunk, dung lượng audio tạm, timeout, backlog và cleanup deadline | Phép đo FP-05 rồi pin profile; không có giá trị ngầm/unbounded | Chặn bật capture dài |
| OPEN-05 | Mục tiêu độ trễ/chất lượng có ích cho người dùng | Đo theo AT-05/AT-10, xem bản mẫu và chốt tiêu chí | Chặn nghiệm thu V1 |
| OPEN-06 | Cách cài/package và đúng surface của Claude Desktop trên máy người dùng | FP-01; không đồng nhất plugin với desktop extension | Chặn tuyên bố cài được |

Thay thế định hướng cũ: kiến trúc “app tự điều phối provider dịch” và cách dùng “ô hỏi trợ lý ngay trong V1” không còn là baseline. Lịch sử commit khởi tạo vẫn giữ nguyên để truy xuất.
