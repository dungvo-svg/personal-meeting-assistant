# S4 — Thiết kế độ tin cậy, kèm plan 0.12 (Opus, 01/11/2026)

**Trạng thái:**
- Draft thiết kế, đã sửa theo review độc lập S4 của Codex. Xem mục "Xử lý bản review độc lập S4".
- Chưa code, chưa test, chưa tích hợp.

**Lý do:** vòng triển khai bị chặn vì `.claude/settings.local.json` có `deny: Edit(//d/WORK/Agent/Agent-first/personal-meeting-assistant/**)`. Xem mục "Blocker" ở cuối.

**Nền và giới hạn:**
- Nền là owner HEAD `a771aeb` (v0.11.0). Pilot.3 chỉ để tham khảo.
- Bề mặt model không đổi:
  - phiên dịch thô chỉ dùng `pma follow --as dich --no-notes` và `pma translate`;
  - phiên tổng hợp dùng `pma follow` và `pma picture`.
- Không đưa batchId, epoch, CAS, readiness hay attribution vào workflow của model.

## A. Mic local OFF/UNKNOWN không tới phiên share

Owner chốt 01/11 (`OWNER-MIC-SHARE-DECISION.md`).

- Thêm hàm `shareable(row)` vào `src/text.ts`. Một dòng chỉ chia sẻ được khi thuộc một trong ba loại:
  - `origin` là `system_gap` hoặc `operator_text`;
  - dòng loa **có nguồn gốc nghe trực tiếp đã ghi**;
  - dòng mic có cờ mới `MIC_SHARE_OK`.
- Cờ nguồn gốc nghe trực tiếp (sửa theo review mục 2):
  - Host gắn `SOURCE_LIVE_FOLLOW` vào `boundary` lúc `ingest`, dựa trên `this.followMode` của capture đang chạy, không dựa trên cờ chung cả phiên.
  - Dòng replay lấy `SOURCE_REPLAY_MIXED`.
  - Dòng loa thiếu `SOURCE_LIVE_FOLLOW` (replay, dữ liệu cũ, nhãn lạ) bị ẩn khỏi vai share. Không có cờ mic không có nghĩa là tiếng từ xa.
- Mọi dòng mic khác đều bị ẩn: OFF, UNKNOWN, thiếu nhãn, nhãn lạ, chunk trộn trạng thái.
- Lọc ở đúng các đường RPC thật (sửa theo review mục 3):
  - `runtime.next()`, khi `as` khác `chinh`;
  - RPC `read` trong `src/daemon.ts:58`: thêm `as` tuỳ chọn, chỉ lọc khi `as` khác `chinh`;
  - `pma read --as <vai>`.
  - MCP `history_read` và `pma read` không có `as` vẫn đọc đủ như owner.
  - `as` chỉ là quy ước định tuyến cho vai share được chỉ định, **không phải ranh giới bảo mật** đối với một tiến trình local bất kỳ.
- Dòng bị ẩn mất cả nội dung lẫn `↳` alternatives. Cursor vẫn đi qua dòng đó (xem hợp đồng quét/giao ở mục D).
- `chinh` thấy đủ, kèm nhãn. RAW và WAV không đổi.
- Bộ nghe (`tools/mic_state.py`, `tools/audio_worker.py`):
  - chỉ gắn `MIC_SHARE_OK` khi **mọi khoảnh khắc** của chunk là ON (`whole_on()` dựa trên `effective_segments`, không nuốt nhấp nháy);
  - nhãn đa số giữ nguyên cho RAW và không bao giờ là bằng chứng để share;
  - chunk không tách tin cậy được thì bị giữ lại cả đoạn.
- Recheck, correction và bản dịch không đi qua `next` (đã kiểm `runtime.ts:794-797`). Giữ nguyên và có test chứng minh.
- RPC `recheck` trả chữ trực tiếp cho người gọi, và khoảng nghe lại có đệm ±1 s (`runtime.ts:773`) nên có thể vắt qua ranh giới bật/tắt mic. Cách xử lý:
  - Vai share **không được hỗ trợ** recheck, read đủ hay correction. Skill ghi rõ phiên dịch chỉ dùng follow và translate.
  - Không thêm cơ chế range-recheck của pilot.
  - Recheck của owner và RAW giữ nguyên (review mục 4, thu hẹp).
- Phát lại file đã trộn:
  - nội dung bị chặn ở host trước khi giao, qua cờ nguồn gốc ở trên, cho cả `next` lẫn `read`;
  - follow in một dòng giới hạn không có nội dung;
  - không đoán.

## B. Gộp dòng giữ nhãn (G7)

- `foldRuns` không gộp hai dòng khác `micLabel` hoặc khác kênh.
- Nhóm lặp in kèm nhãn ở cả follow lẫn RAW.

## C. Gỡ panel (S3)

**S3.0, làm trước khi gỡ:**
- thêm RPC `manual` và lệnh `pma say --text "…"`, gọi `ingest(..., 'operator_text')`, giới hạn 8000 ký tự, cần phiên đang mở;
- chuyển `tools/probe.mjs` và `tools/doctor.py` sang `/rpc`.

**S3.1, gỡ:**
- bỏ `web/index.html`, `GET /`, cookie, `/api/*`, SSE và `panel.json`; mọi đường khác `/rpc` trả 404;
- bỏ nhánh panel trong stop hook.

## D. Độ tin cậy

### Lỗi thật trên HEAD

| Mã | Lỗi | Vị trí |
| --- | --- | --- |
| G1 | CLI gom lô tới 15 s trong bộ nhớ, nhưng lần gọi `next` kế tiếp đã gửi `after = nextCursor`, và host ghi cursor bằng giá trị đó. Follow chết hoặc bị cắt trước khi flush thì các dòng chưa in bị mất. | `cli.ts:126,134`, `runtime.ts:255-259` |
| G2 | Lưu lại picture cùng nội dung sinh thêm revision. | `runtime.ts:277-280` |
| G3 | Hai `follow --as dich` cùng lúc in trùng lên màn hình share. | `runtime.ts:259` |
| G5 | Follow thoát mà host không biết, hook phải chờ heartbeat 90 s hết hạn. | `meeting_stop_hook.mjs:61-63` |

### Thiết kế

**G1 — hợp đồng quét/giao (sửa theo review mục 5):**
- `next` trả `items`, tức các dòng **thấy được** sau khi lọc vai, và `nextCursor` = id dòng thô **cuối cùng đã quét**. Tính trên dòng thô, không trên `items`. Như vậy một trang toàn dòng ẩn vẫn tiến được, không kẹt.
- `next` nhận thêm `ack`, mặc định bằng `after`. Host ghi cursor của vai = `ack`.
- CLI giữ ba thứ:
  - `after`: đã quét tới đâu;
  - `batch`: các dòng thấy được chưa in;
  - `ack`, tính theo quy tắc sau:
    - nếu `batch` rỗng thì `ack = after`, vì dòng ẩn đã quét là bỏ an toàn;
    - nếu `batch` còn dòng thì `ack = batch[0].id − 1`.
  - Không bao giờ coi một dòng thấy được chưa in là đã giao chỉ vì đã quét qua một dòng ẩn sau nó.
- ID là autoincrement chung của mọi phiên. `ack` và `after` chỉ so trong cùng `session_id`, nên ID của phiên khác xen giữa không ảnh hưởng.
- Ngữ nghĩa giao:
  - `chinh` nhận **ít nhất một lần, không bỏ**.
  - Vai share nhận ít nhất một lần cho tối đa `--max` dòng gần nhất khi bật lại. Phần cũ hơn **bị bỏ có chủ ý**, in một dòng `BỎ QUA #a–#b` không kèm nội dung.
  - Đây là giới hạn được ghi rõ, không gọi là giao vô điều kiện.
- Một dòng đã ghi ra stdout chỉ có nghĩa là đã phát đi. Nó không chứng minh Claude đã nhận, đã dịch hay đã hiển thị.
- Cursor, `at` và lease nằm trong bộ nhớ của host. Host sống theo phiên họp, nên chúng **không bền qua host restart**; không mô tả chúng là bền.

**Bản đọc không giữ vai (sửa theo review mục 1):**
- Đã kiểm mã:
  - `src/server.ts:23` gọi `source_next` không có `as` và không có lease;
  - `daemon.ts:57` mặc định vai là `chinh`;
  - `runtime.ts:255-258` ghi `agentCursor = after` và ghi đè cursor của `chinh` kể cả khi `follower = false`.
- Vì vậy một lệnh gọi MCP có thể đẩy tiến độ của `chinh` vượt qua lô CLI chưa in.
- Quy tắc mới:
  - Một lệnh gọi **không có lease**, nhắm vào một vai **đang có lease còn sống**, không được đổi `cursor`, `ack`, `at`, `agentCursor` hay `lastFollowAt` của vai đó.
  - Lệnh gọi đó vẫn đọc được, với tiến độ đọc riêng của nó (`after` do nó tự giữ).
  - Khi vai không có lease nào, hành vi giữ như HEAD.
  - Quy tắc này áp dụng cho cả lệnh gọi trực tiếp `next as=dich` không có lease.

**G2:**
- Picture, theo thứ tự:
  1. Kiểm `sourceIds` thuộc phiên. Đây là cùng bước kiểm của `publish`, làm trước khi so, để không bị lách.
  2. Chuẩn hoá tập ID: bỏ trùng rồi sắp xếp.
  3. Nếu text và tập ID trùng với bản mới nhất thì trả `{ saved, revision, duplicate: true }`, không thêm revision.
- `translate` chỉ idempotent **về nội dung**. Gọi lại cùng chữ vẫn ghi đè hàng, đổi `created` và trả `replaced: 1` (`runtime.ts:987-996`). Test đúng ngữ nghĩa đó, không thêm revision bản dịch.

**G3:**
- `next` nhận thêm `lease` (`[a-z0-9]{8,64}`), mỗi tiến trình follow sinh một lần.
- Vai đang có lease khác mà heartbeat dưới 90 s thì báo `FOLLOWER_BUSY`; khi đó không đổi cursor, `at` hay `agentCursor`.
- Lease quá 90 s thì tiến trình mới chiếm vai.
- Gọi không có lease (MCP) thì không giữ vai và không bị chặn.
- CLI chờ, thử lại mỗi 5 s, tối đa 100 s; hết hạn thì in `DỪNG` và thoát mã 1.

- Lease không khớp thì **không đổi gì cả**: không cursor, không ack, không heartbeat.
- Kiểm lease ở đúng chỗ ghi.
  - `next` chỉ ghi tiến độ lúc bắt đầu yêu cầu, dưới lease hiện hành.
  - Một yêu cầu đang chờ (tới 25 s) mà bị chiếm vai trong lúc chờ thì không ghi gì khi trả về.
  - Lần gọi kế tiếp của nó sẽ nhận `FOLLOWER_BUSY`.
- Lease chỉ là token phối hợp, không phải quyền của hệ điều hành hay của người dùng.

**G5:**
- Thêm RPC `release { sessionId, as, lease, ack }`. Phạm vi gồm cả phiên họp, vai và lease.
  - Khớp cả ba thì xoá lease, ghi cursor = ack, `at = null`.
  - Không khớp, kể cả lệnh release cũ đến sau khi vai đã bị chiếm, thì trả `{ released: false }` và không xoá lease của chủ mới.
- CLI gọi `release` trước khi thoát ở BẬT LẠI, KẾT THÚC và DỪNG; lỗi ở bước này thì bỏ qua.
- Stop hook giữ nguyên quy tắc; `unread` tính theo ack.
- `finish`/drain không đổi.

**Không đưa lại:** G6 và G9–G12.

## Test bắt buộc

Dùng dữ liệu giả; không mic, không ASR, không host thật.

**Ma trận mic:**
- trạng thái: on, off, unknown, thiếu nhãn, nhãn lạ;
- kênh: mic, loa;
- vai: chinh, dich;
- thêm các ca: RAW, chunk trộn (đa số ON, hoà, dưới 1 giây), alternatives, gộp qua ranh giới, recheck/translation không lọt vào `next`, loa vẫn dịch khi mic OFF.

**Fault:**
- chết giữa lô;
- mất phản hồi;
- bật lại ở phút 29;
- hai follower cùng vai;
- lease hết hạn (đồng hồ giả);
- MCP không lease;
- picture và translate idempotent;
- KẾT THÚC thì gọi release.

**Bổ sung theo review:**
- Lô CLI của `chinh` chưa in, MCP `source_next` gọi với `after = N`, rồi CLI chết và bật lại: phải nhận lại các dòng chưa in.
- Gọi `next as=dich` không lease khi `dich` đang có lease: tiến độ của `dich` không đổi.
- Yêu cầu cũ đang chờ thì vai bị chiếm: không ghi gì. Release cũ đến sau khi vai bị chiếm: không xoá lease mới.
- Trang toàn dòng ẩn vẫn tiến được. Chuỗi thấy → ẩn → chết vẫn giữ lại dòng thấy được. ID của phiên khác xen giữa không làm hỏng ack. stdout lỗi giữa chừng không làm mất dòng.
- Replay trộn bị chặn ở cả `next` lẫn `read`, kể cả dòng replay cũ sau khi phiên chuyển sang nghe trực tiếp. Dòng loa nghe trực tiếp vẫn đi qua khi mic OFF hoặc UNKNOWN.
- `read --as dich`, ở cả dạng JSON lẫn dạng in ra: trang toàn dòng ẩn và phân trang đúng. `read` không có `as` vẫn đọc đủ.
- `whole_on`: chuyển ON↔OFF và ON↔UNKNOWN, kể cả dưới 1 giây; override thủ công rồi nhả; hoà; mốc đầu chưa có số đọc.
- Picture có `sourceIds` ngoài phiên vẫn bị từ chối, kể cả khi text trùng bản mới nhất.

**Panel:**
- `/live` và `/api/state` trả 404;
- `pma say` ghi "nhập tay" trong RAW;
- stop hook chạy với transcript giả.

## Xử lý bản review độc lập S4 (Codex, 01/11/2026)

Opus đã đối chiếu từng nhận định với mã HEAD `a771aeb` bằng công cụ đọc. Không chạy code, không chạy test.

| # | Nhận định | Kết luận | Bằng chứng trong mã | Sửa trong plan |
| --- | --- | --- | --- | --- |
| 1 | Lệnh đọc không có lease đè tiến độ của vai đang có lease | **Chấp nhận** | `server.ts:23` gửi `source_next` không có `as`; `daemon.ts:57` mặc định `chinh`; `runtime.ts:255-258` ghi `agentCursor = after` và ghi đè cursor `chinh` khi `follower = false`; `runtime.ts:101` giữ cursor trong bộ nhớ | Thêm mục "Bản đọc không giữ vai"; ghi rõ cursor/lease không bền qua host restart |
| 2 | Thiếu `CHANNEL_MIC` không chứng minh đó là tiếng từ xa | **Chấp nhận** | `audio_worker.py:708-723`: replay đưa mọi thứ vào kênh `speaker`; `runtime.ts:541`: chỉ lưu `session.replay`; `ingest` không ghi nguồn gốc theo từng dòng | Thêm cờ dương `SOURCE_LIVE_FOLLOW` cho từng dòng, gắn lúc ingest theo `followMode` của capture; chặn ở cả `next` lẫn `read` |
| 3 | `read` theo vai đặt ở chỗ không có trong mã | **Chấp nhận** | `daemon.ts:58` gọi thẳng `runtime.sources`; CLI `read` (`cli.ts:226-230`) và MCP `history_read` (`server.ts:28`) không có tham số vai | Thêm `as` vào RPC `read` và `pma read --as`; mặc định đọc đủ như owner; `as` chỉ là quy ước, không phải ranh giới bảo mật |
| 4 | Recheck chỉ được cô lập khỏi `next`, chưa phải bảo đảm riêng tư chung | **Thu hẹp** | `runtime.ts:794-797`: kết quả ghi vào bảng `rechecks`, `next` không đọc lại, nên không có lỗi recheck lọt vào `next`; `runtime.ts:773` đệm ±1 s; RPC trả chữ cho người gọi | Vai share không được hỗ trợ recheck/read đủ/correction, skill ghi rõ; không thêm cơ chế của pilot |
| 5 | `ack` và lọc dòng cần hợp đồng quét/giao rõ ràng | **Chấp nhận** | `runtime.ts:267-268`: `nextCursor` lấy từ `items`, nên lọc trước sẽ kẹt ở trang toàn dòng ẩn; plan cũ vừa hứa "không mất" vừa bỏ dòng cũ | Định nghĩa lại G1 theo quét/giao; ghi rõ vai share bỏ dòng cũ có chủ ý; stdout chỉ là đã phát đi |
| — | Cờ `whole_on`, nhập tay, khử trùng picture, lease/release, RAW/WAV không đổi | **Giữ, kèm điều kiện** | `mic_state.py:79-90` đang tính theo đa số; `runtime.ts:277-282`, `:987-996` | Picture kiểm ID trước khi so; translate chỉ idempotent về nội dung; release có phạm vi phiên + vai + lease |

Kết quả:
- Không thêm tính năng.
- Không thêm quy trình receipt, CAS, epoch hay attribution vào workflow của model.
- Bề mặt model vẫn là follow, translate, picture.

## Chia việc dự kiến

Mỗi vùng file chỉ có một người ghi.

| Worker | Phần | File |
| --- | --- | --- |
| Sonnet A | A + B + D | `src/runtime.ts`, `src/cli.ts`, `src/text.ts`, `tests/runtime.test.mjs`, `tests/session.test.mjs`, test mới |
| Sonnet B | Phần bộ nghe của A | `tools/mic_state.py`, `tools/audio_worker.py`, `tests/test_mic_state.py`, `tests/test_audio_worker.py` |
| Sonnet C | C + nối RPC cho D (`next` thêm `ack`/`lease`, `release`, `manual`) | `src/daemon.ts`, `tools/probe.mjs`, `tools/doctor.py`, `tools/meeting_stop_hook.mjs`, `web/`, `tests/daemon.test.mjs` |
| Opus | S1: tài liệu, skill, relock | Làm sau khi tích hợp, có một agent review độc lập |

## Blocker (01/11/2026)

- `.claude/settings.local.json` dòng 27 có `deny: Edit(//d/WORK/Agent/Agent-first/personal-meeting-assistant/**)`. Luật này phủ cả worktree trong `.claude/worktrees/`.
- Write và Edit vào dự án bị từ chối, kể cả tại `.claude/worktrees/v5-int/docs/PLAN_0_12.md`.
- Không lách:
  - không ghi bằng shell;
  - không dời worktree sang thư mục được phép;
  - không sửa settings.
- Đã tạo sẵn 4 worktree rỗng tại commit `a771aeb` bằng `git worktree add`, chưa ghi file nào: `.claude/worktrees/v5-host`, `v5-worker`, `v5-panel`, `v5-int`, trên các nhánh `pma/v5-*`, có junction tới `node_modules` và `.venv`. Có thể giữ để dùng tiếp hoặc gỡ.
- **Phạm vi tối thiểu cần owner tự duyệt** (Opus không sửa config):
  - Luật `deny` luôn thắng `allow` và không có phủ định. Vì vậy phải bỏ luật rộng ở dòng 27 và thay bằng các luật deny theo từng vùng.
  - Các vùng giữ deny, cùng gốc `//d/WORK/Agent/Agent-first/personal-meeting-assistant/`:
    - `src/**`
    - `tools/**`
    - `tests/**`
    - `docs/**`
    - `web/**`
    - `.claude/skills/**`
    - `.claude/settings*.json`
    - `.local/**`
    - `workspace/**`
    - các file ở gốc: `*.md`, `*.json`, `pma*`
  - Các mẫu này neo ở gốc dự án, nên không trùng với `.claude/worktrees/...`.
  - Thêm allow: `Edit(//d/WORK/Agent/Agent-first/personal-meeting-assistant/.claude/worktrees/v5-*/**)`.
  - Kết quả: chỉ 4 worktree được ghi. Main checkout, `docs/product-direction-20261101` của owner, `.local` và settings vẫn bị cấm.
- Peer `personal-meeting-assistant-a2` (07:0x) xác nhận chẩn đoán. Gửi phản hồi thất bại vì pipe của peer đã đóng (ENOINBOX), nên phạm vi được ghi tại đây.
- Cần owner chọn một trong hai:
  - (A) tự gỡ luật deny này, hoặc thu hẹp nó;
  - (B) cho phép làm worktree trong thư mục preflight được phép ghi.
