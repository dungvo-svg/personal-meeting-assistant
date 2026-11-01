# Handoff 0.12 (Opus, 01/11/2026)

**Mức trạng thái:** implemented + tested trong worktree riêng.
- Chưa integrated vào nhánh `codex/personal-assistant-init` của owner.
- Chưa released. Chưa used ở họp thật.
- Không push. Không merge vào main checkout.

## Ghim nguồn

| | Giá trị |
| --- | --- |
| Nền | owner HEAD `a771aeb` (v0.11.0) |
| Nhánh tích hợp | `pma/v5-int` tại `.claude/worktrees/v5-int` |
| Bản đã test cuối | commit `9e1aef0`, tree `4b232d1169a94bc16c37a6d100f5161c00dbeb55`; sau đó chỉ có commit sửa riêng file handoff này |
| Nhánh worker | `pma/v5-host` `54aabdd` (Sonnet A: host/CLI) · `pma/v5-worker` `927950e` (Sonnet B: bộ nghe) · `pma/v5-panel` `c6c36e3` (Sonnet C: gỡ panel) |
| Gộp và sửa (local, theo thứ tự) | `ffffa2a` docs → `2a7aede` worker → `0c225f0` panel → `e1fb2c5` host → `724b474` sửa test → `9afe7ab` sửa theo review + bump + relock → `832bcc6` handoff → `214e99b` nhịp tim bộ đọc micro → `9e1aef0` tách nhãn thủ công khỏi bằng chứng chia sẻ |

## Quyết định kỹ thuật (Opus)

- Lọc chia sẻ đặt ở host: `next` và `read --as`, cho mọi vai khác `chinh`.
- Dòng micro chỉ được chia sẻ khi có bằng chứng dương, gồm cả hai cờ:
  - `MIC_SHARE_OK`: mic bật cả đoạn và còn bật thêm 1,5 s sau đó;
  - `SOURCE_LIVE_FOLLOW`: host gắn theo worker sinh ra dòng đó.
- Nhãn đa số chỉ dùng để hiển thị trong RAW.
- Không thêm batchId, epoch, CAS hay receipt vào workflow của model. Chỉ thêm `ack`, `lease`, `release`, đều là tham số tuỳ chọn và do CLI tự xử lý.
- Toàn bộ thiết kế và bảng xử lý review S4: [PLAN_0_12.md](PLAN_0_12.md).

## Review

- **Review độc lập bản tích hợp** (agent riêng, chỉ đọc), 6 điểm:
  - 1 nghiêm trọng: stop hook hướng vai dịch sang `read` đầy đủ của owner.
  - 2 vừa: nút micro đọc trễ; dòng `GIỚI HẠN` đọc sai chỗ nên không bao giờ in.
  - 3 nhẹ.
  - Đã sửa: 1, 2, 3, 5 (phần lỗi tạm thời) và 6. Điểm 4 và phần còn lại của 5 ghi thành giới hạn.
- **Peer review Codex PMA-MIC-READER-LIVENESS, PMA-LIVENESS-BOUNDARY, PMA-MANUAL-LABEL-PUBLICATION:** chấp nhận cả ba sau khi kiểm mã.
  - Bộ ghi viết nhịp tim mỗi 2 s.
  - Muốn chia sẻ phải có lần đọc tự động sau mốc cuối đoạn + 1,5 s, không hở quá 4 s.
  - `pma me` chỉ đổi nhãn RAW, không thành bằng chứng chia sẻ.
- **Peer review Codex** (PMA-SESSION-ISOLATION-REVIEW-20261101): chấp nhận cả 3 điểm.
  1. `follow` ghim cuộc họp; test A→B.
  2. `release` sau khi phiên kết thúc; test.
  3. Test Python có tiếng loa thật lúc mic tắt.

## Lệnh và kết quả

Chạy trong `.claude/worktrees/v5-int`, trên tree cuối.

| Lệnh | Kết quả |
| --- | --- |
| `PMA_TEST_PORT=8931 PMA_CAPTURE_TEST_PORT=8932 PMA_SESSION_TEST_PORT=8933 npm test` | exit 0; Node 100 test, 100 qua |
| `.venv/Scripts/python.exe -m unittest discover -s tests -p "test_*.py"` | exit 0; 155 test chạy: 154 qua, 1 bỏ qua (BuzzASR không cài) |
| `.venv/Scripts/python.exe -I tools/verify_baseline.py` | PASS 0.12.0, 65 file |

Lịch sử lỗi:
- Lần chạy tích hợp đầu: Node 97 qua, 1 hỏng. Test ack đếm số lần hỏi trong cửa sổ 1 s nên phụ thuộc tải máy; đã sửa test để giữ bất biến.
- Trong lúc sửa theo review có 3 test hỏng:
  - test cũ so tham số `read` chưa có `sessionId`;
  - host giả thiếu nhánh `read`;
  - test unread của tôi viết sai.
- Đã sửa cả ba; không nới guard nào.

## Giới hạn còn mở

Xem CHANGELOG 0.12.0:
- Không phát hiện tắt mic tức thời: bộ đọc hỏi nút micro khoảng mỗi giây (có nhịp tim 2 s; muốn chia sẻ phải có lần đọc sau cuối đoạn + 1,5 s). Bộ đọc còn sống mà đọc sai nút thì không phát hiện được.
- Lời "Tôi" lúc mic bật có thể bị ẩn khi bộ nghe theo kịp sát thời gian thực.
- MCP không có lease đúng lúc lease cũ hết hạn.
- Tiến độ của follower không bền qua host restart.

## Nghiệm thu ở buổi họp thật (owner)

- Cửa sổ dịch thô không có lời "Tôi" lúc mic tắt hoặc không rõ; tiếng người dự vẫn được dịch.
- Lời "Tôi" lúc mic bật có lên (đo tỷ lệ bị ẩn do chờ 1,5 s).
- Bật lại ở phút 29 không mất dòng và không in trùng nhiều.
- Không còn trang web nào. `pma say` ghi "nhập tay" trong RAW.
- WAV đủ, báo cáo đủ.

## Việc tiếp theo cần owner quyết

Muốn dùng 0.12 ở buổi họp tới thì phải đưa nhánh `pma/v5-int` vào nhánh chính. Việc này cần owner duyệt riêng.
