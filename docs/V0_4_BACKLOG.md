# Backlog v0.4 — Claude cùng họp công việc, nội dung và ngôn ngữ hỗn hợp

Lập 28/10/2026 sau buổi họp Zoom chạy thật đầu tiên; sửa lại cùng ngày theo quyết định của owner. Đây là danh sách việc, chưa phải bản đã nghiệm thu. Ghi các quyết định dưới đây vào DECISION_LOG ở commit đầu tiên của v0.4.

## Quyết định của owner (28/10)

| # | Quyết định | Hệ quả |
| --- | --- | --- |
| D1 | Host chính: **Claude Desktop, tab Code** | Dùng được hook và Monitor của Claude Code để Claude theo dõi liền mạch |
| D2 | Micro: bật được thì ưu tiên; không được thì chỉ dùng loa (loopback) | Kênh micro là tùy chọn, không bắt buộc |
| D3 | Chỉ dùng **mã nguồn mở có giấy phép mở (MIT/Apache/BSD) và có cộng đồng** để học và kế thừa | Loại SeamlessM4T, MMS, NLLB (CC-BY-NC) |
| D4 | Chỉ Claude là AI; **không thêm AI hay dịch vụ ngoài Claude** (không AGY/Gemini, không API dịch). Qua Anthropic là bình thường | Âm thanh, ASR, dịch chạy trên máy; Claude đọc text, tóm tắt, có thể soát dịch |
| D5 | Họp dài: Claude **theo dõi đến khi người dùng nói kết thúc hoặc đóng**, không ngắt giữa chừng | Hook giữ lượt là việc số 1 |
| D6 | **Không cồng kềnh:** mọi yêu cầu và thao tác đi qua Claude | Bảng web chỉ để xem (tùy chọn); chọn nguồn, bắt đầu, dừng đều qua lời nói với Claude |
| D7 | Học từ AIOS / call.md: chỉ lấy cái khớp nhu cầu, không đi theo mặc định | Danh sách dưới đây đã lọc |
| D8 | Tùy máy: CPU hoặc GPU đủ tốt thì bổ sung công cụ mã nguồn mở | Tự dò GPU; máy này có RTX 3050 6 GB |

## Bằng chứng từ buổi 28/10 (không trích nội dung họp)

- Claude ngắt lượt ~12 lần, quãng không đọc dài nhất ~10 phút → vi phạm D5.
- Host khởi động lại kéo bộ thu chết theo, mất ~2 phút; phiên cũ bị ghi “ended” sai.
- Quá tải ASR một lần làm bộ thu tự dừng.
- Tiếng Lào ~15% đoạn, whisper small ra chữ Thái. Tiếng Việt đọc được ý nhưng sai tên riêng, có câu ảo khi im lặng và lặp từ.
- Người dùng phải sang trình duyệt cấp quyền nguồn → vi phạm D6.
- `session_status` trả ~50 KB.

## P0 — Claude theo dõi liền mạch, mọi thứ qua Claude

| ID | Việc | Xong khi |
| --- | --- | --- |
| T01 | **Hook giữ lượt (Stop hook) trong Claude Code:** khi phiên họp còn chạy, Claude không được kết thúc lượt mà phải đọc tiếp `source_next`. Chỉ nhả khi người dùng nói kết thúc/đóng, phiên `ended`, hoặc bấm Stop. Cài theo project, không đụng thiết lập toàn máy | Họp 60 phút trên bản ghi phát lại: 0 lần phải nhắn “tiếp tục theo dõi”; nói “kết thúc” thì dừng ngay |
| T02 | **Chọn nguồn qua Claude:** tool `source_select` thay cho nút trên bảng. Claude đề xuất nguồn đang có tiếng, người dùng đồng ý trong chat; quyền gọi tool để Claude Code hỏi xác nhận | Từ “nghe họp giúp tôi” đến lúc đang nghe không cần mở trình duyệt |
| T03 | **Bộ thu sống độc lập host:** tách tiến trình nghe khỏi MCP server; host khởi động lại thì gắn lại vào phiên đang chạy, không mất đoạn, không cấp quyền lại | Tắt/mở Claude giữa họp: 0 đoạn mất |
| T04 | **Không chết khi quá tải:** hàng đợi đầy thì gộp đoạn, bỏ bớt bước phụ, ghi đoạn GAP có khoảng thời gian; chỉ dừng ở trần cứng | Ép chậm trong test: phiên vẫn chạy, có GAP |
| T05 | **Lọc câu ảo và lặp từ:** dùng ngưỡng sẵn có của faster-whisper (`compression_ratio`, `log_prob`, `no_speech`) + danh sách câu ảo khi im lặng + gộp từ lặp; gắn cờ thay vì xóa | 5 phút im lặng không sinh text; lặp > 5 lần bị gộp |
| T06 | **Phản hồi gọn:** các tool trạng thái < 4 KB, không kèm agenda; sửa vòng đời phiên (không ghi `ended` sai, không tạo phiên thừa) | Test tự động |

## P1 — Nghe lẫn Việt–Lào trên máy (D3, D8)

Công cụ mở được chọn: faster-whisper (MIT), Silero VAD (MIT, đã có trong faster-whisper), CTranslate2 (MIT), BuzzASR/lao (MIT, Whisper large-v3 fine-tune tiếng Lào, CER ~22 trên FLEURS), Meta Omnilingual ASR (Apache, có chữ Lào), SpeechBrain VoxLingua107 (Apache, nhận lo/vi), MADLAD-400 (Apache, có tiếng Lào). Không dùng model CC-BY-NC.

| ID | Việc | Xong khi |
| --- | --- | --- |
| T07 | **[Xong 0.6.0; 0.7.0: tiếng Việt dùng large-v3-turbo, CER 9,9% → 4,8%]** **Tự dò phần cứng:** có GPU NVIDIA thì chạy CUDA, không có thì CPU; model để ở ổ D | Cùng một lệnh cài chạy được cả máy có và không có GPU |
| T08 | **Bộ đo không cần người gõ** (thay cho việc nhờ người gõ bản chuẩn): độ chính xác đo trên mẫu công khai FLEURS vi/lo có sẵn đáp án; bản ghi hình họp 26/10 và 28/10 chỉ dùng để đo những thứ không cần đáp án: chữ Lào hay chữ Thái, nhận đúng ngôn ngữ, độ trễ, câu ảo. Claude đọc kết quả để soát những đoạn vô nghĩa | Báo cáo đo lặp lại được, file chỉ nằm trong `.local/` |
| T09 | **[Xong 0.6.0: BuzzASR/lao, CER 36,3%; Omnilingual chưa thử]** **Chọn ASR tiếng Lào:** so BuzzASR/lao và Omnilingual CTC trên GPU 6 GB | Chọn engine có CER Lào thấp nhất mà vẫn kịp thời gian thực; chữ Thái trong đầu ra tiếng Lào = trượt |
| T10 | **[Xong 0.6.0: Whisper small, 100% trên FLEURS; VoxLingua107 chưa cần]** **Nhận ngôn ngữ và định tuyến:** mỗi đoạn vi → Whisper, lo → engine T09; đối chiếu VoxLingua107 khi Whisper không chắc; không chắc thì gắn `unknown` thay vì đoán | Nhận đúng ngôn ngữ ≥ 90% trên FLEURS và bản ghi |
| T11 | **Dịch trên máy:** MADLAD-400 qua CTranslate2 cho Lào → Việt (kiểm tra lỗi tokenizer khi chuyển đổi). Bản dịch kém thì Claude soát/dịch lại khi tóm tắt (D4 cho phép) | Đoạn tiếng Lào có bản tiếng Việt đọc hiểu được trong RAW |
| T12 | **Cắt đoạn theo điểm dừng lời** (ý từ AIOS): cắt khi người nói ngừng 0,6–1 s, kèm vài giây ngữ cảnh, không lặp chữ ở ranh giới | Ít câu bị cắt đôi hơn bản 0.3.0 trên cùng bản ghi |

## P2 — Họp công việc

| ID | Việc | Xong khi |
| --- | --- | --- |
| T13 | **Kênh micro “Tôi”** (D2): thu thêm micro khi người dùng đồng ý trong chat; loa = “Người khác”. Không bật được thì chạy chỉ loa như hiện nay | RAW ghi rõ đoạn của người dùng khi có micro |
| T14 | **Ghi chú cuốn chiếu cho họp dài:** cứ ~10 phút Claude ghi tóm tắt khúc có source ID; tóm tắt cuối ghép từ các khúc | Họp 2 giờ vẫn tóm tắt được mà không phải đọc lại toàn bộ |
| T15 | **Tóm tắt theo mục tiêu:** nội dung họp người dùng gửi lúc đầu được dùng làm mục tiêu; SUMMARY nêu mục nào đã chốt, mục nào còn mở; TASKS có cột thời điểm | Mẫu đầu ra ổn định |
| T16 | **Lưu theo ngày + mục lục** (ý từ call.md): `reports/YYYY/MM/DD/<tên>/` và `index.md` để Claude tìm lại cuộc họp cũ khi được hỏi | “Cuộc họp tuần trước chốt gì?” trả lời được |

Đã bỏ khỏi backlog cũ: bảng song ngữ phức tạp, nút đánh dấu, mô hình PRIMARY/GAP/CORRECTION đầy đủ, chế độ “chỉ trên máy” cho phần Claude đọc, kiểm tra giấy phép phi thương mại, so sánh nhiều host. Thử Codex/Antigravity giữ ở mức thấp vì host chính là Claude Code.

## Thứ tự làm

1. T01 → T02 → T06 (Claude theo dõi liền mạch, điều khiển hoàn toàn qua chat).
2. T03–T05 (độ bền).
3. T07–T08, rồi T09–T12 (tiếng Lào trên GPU).
4. T13–T16.
