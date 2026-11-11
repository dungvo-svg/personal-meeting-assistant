# Nghiệm thu trước tích hợp 0.12 (01/11/2026)

**Trạng thái:** đã làm và đã test trong worktree riêng.
- Chưa tích hợp vào nhánh của owner, chưa phát hành, chưa dùng ở họp thật.
- Tài liệu này chỉ chuẩn bị. Không commit, không merge, không push.

## 1. Ghim nguồn và phạm vi

| | Giá trị |
| --- | --- |
| Nền (owner) | `codex/personal-assistant-init` tại `a771aeb112426e4d07c6ef02a9e33b3d183a07c2` (0.11.0) |
| Ứng viên | `pma/v5-int` tại `55a039400ed4ed26fc5041c6517f1dc1de610141`, tree `8d3a4375101c265ba4c81bbce84cb40549ca9d89` |
| Bản đã test | `9e1aef0c6150e62e46a27cf728f32bb0bd7c798b`, tree `4b232d1169a94bc16c37a6d100f5161c00dbeb55` |
| Khác biệt sau bản đã test | `9e1aef0..55a0394`: chỉ `docs/HANDOFF_0_12.md` (+6/−2) |
| Quan hệ | `a771aeb` là tổ tiên của ứng viên, nên merge được dạng fast-forward |

`a771aeb..55a0394` gồm 13 commit, 31 file, +1639/−193:
- Mã: `src/cli.ts`, `src/daemon.ts`, `src/runtime.ts`, `src/text.ts`, `tools/audio_worker.py`, `tools/mic_state.py`, `tools/recorder.py`, `tools/meeting_stop_hook.mjs`, `tools/probe.mjs`, `tools/doctor.py`.
- Xoá: `web/index.html`. Bảng web bị gỡ hẳn: host chỉ còn `POST /rpc`, mọi đường khác trả 404, `panel.json` không còn được đọc.
- Test: `tests/share.test.mjs` và `tests/follow.test.mjs` (mới); `daemon`, `runtime`, `session`, `test_audio_worker`, `test_mic_state`, `test_recorder` (sửa).
- Tài liệu và khoá: `.claude/skills/hop/SKILL.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/{CHANGE_CONTROL,DECISION_LOG,PRODUCT_BASELINE,HANDOFF_0_12,PLAN_0_12}.md`, `package.json`, `project.json`, `baseline.lock.json`.
- Không đổi schema SQLite: diff không có `CREATE`, `ALTER` hay `user_version`.

## 2. Việc owner đang làm dở có đụng không

Các thư mục chưa track ở checkout owner:
- `docs/product-direction-20261101/`
- `tools/eval_lao_models.py`
- `tools/eval_translation_set.py`
- `workspace/`

Không đường dẫn nào trùng với 31 file của ứng viên. Fast-forward vì vậy không đụng và không ghi đè chúng.

Phần tài liệu trong `docs/product-direction-20261101/` (REFACTOR-PLAN, OWNER-MIC-OFF-DECISION…) là đầu vào của 0.12. Nó vẫn chưa track, sau tích hợp cũng vậy. Có đưa vào git hay không là việc owner quyết riêng.

## 3. Hành vi mong đợi sau tích hợp

- **Chỉ trong chat Claude.** Không còn trang web nào. Owner gõ tay bằng `pma say --text "…"`; trong RAW dòng đó ghi "nhập tay".
- **Vai dịch thô** (`follow --as dich`, `read --as dich`, mọi vai khác `chinh`) nhận các dòng sau:
  - tiếng người dự qua loa, kênh `CHANNEL_MIC` không có, có `SOURCE_LIVE_FOLLOW`: **được chiếu**;
  - lời "Tôi" (kênh micro): chỉ được chiếu khi có `MIC_SHARE_OK`. Điều kiện của cờ này:
    - bộ đọc tự động thấy micro ON suốt đoạn và thêm 1,5 s sau đó;
    - bộ đọc còn sống: có lần đọc trước mốc đầu và sau mốc cuối, không hở quá 4 s;
    - mốc thời gian ghi âm đã vượt qua mốc cuối đó;
  - micro OFF hoặc không rõ: **ẩn** khỏi vai dịch; vẫn có trong RAW và vai `chinh`;
  - dòng phát lại từ WAV (`SOURCE_REPLAY_MIXED`): ẩn khỏi vai dịch; `follow` in dòng `GIỚI HẠN`;
  - nhập tay và khoảng hở hệ thống (`operator_text`, `system_gap`): được chiếu.
- `pma me` chỉ đổi nhãn trong RAW. Nó không tạo bằng chứng để chiếu.
- **Follow:**
  - `ack` báo đúng dòng đã nhận;
  - mỗi tiến trình giữ `lease` riêng; vai đang có người giữ thì in `CHỜ`, quá 100 s in `DỪNG`;
  - khi thoát thì `release`; phiên đã kết thúc thì in `KẾT THÚC`;
  - bật lại vai dịch chỉ in tối đa 40 dòng, phần cũ hơn in thành `BỎ QUA #a–#b`.
- **Stop hook:** owner đang cài hook trỏ thẳng vào `tools/meeting_stop_hook.mjs` của checkout owner, nên sau merge tự dùng bản 0.12. Với vai dịch, hook hướng sang `read --as <vai>`, không sang `read` đầy đủ.

## 4. Bằng chứng đã có và giới hạn chưa giải

Bằng chứng, đều trên tree `4b232d1`; chỉ dòng baseline chạy lại trên `8d3a437`:

| Lệnh | Kết quả |
| --- | --- |
| `PMA_TEST_PORT=8931 PMA_CAPTURE_TEST_PORT=8932 PMA_SESSION_TEST_PORT=8933 npm test` | exit 0, Node 100/100 |
| `.venv/Scripts/python.exe -m unittest discover -s tests -p "test_*.py"` | exit 0, 155 chạy: 154 qua, 1 bỏ qua (BuzzASR chưa cài) |
| `.venv/Scripts/python.exe -I tools/verify_baseline.py` (chạy lại 01/11 trên `8d3a437`) | `PASS: baseline 0.12.0, 67 files` |

Về nguồn của các con số:
- Codex không chạy lại hai bộ test trên. Codex đối chiếu log và mã test, rồi tự chạy riêng 15 ca ranh giới.
- Từ bản đã test tới nay không đổi mã, nên không chạy lại bộ test chỉ để lấy số báo cáo.

**Sai trong tài liệu ứng viên:** `docs/HANDOFF_0_12.md` dòng 52 ghi "65 file". Số đúng là **67** (`baseline.lock.json` có 67 mục, verify in 67). Chỉ ghi lại ở đây. Không sửa HANDOFF, để giữ đúng tree đã ghim.

Phần chưa được bất kỳ test nào chứng minh, chỉ kiểm được ở họp thật:
- **ASR thật:** chất lượng nghe Việt, Lào, Thái; tốc độ theo kịp thời gian thực.
- **Tắt micro thật:** nút micro của Zoom/Meet được đọc qua UIA, khoảng mỗi giây. Đây là đọc mẫu, không phải chặn tức thời:
  - bộ đọc còn sống mà đọc sai nút thì không phát hiện được;
  - đổi giao diện Zoom/Meet có thể làm bộ đọc trả UNKNOWN; lúc đó lời "Tôi" bị ẩn, an toàn nhưng mất câu.
  - Chính sách 0.12 là hành vi mong đợi. Nó **không** chứng minh việc nhận biết tắt micro vật lý luôn đúng. Không có cam kết riêng tư tuyệt đối.
- **Lời "Tôi" lúc mic bật** có thể bị ẩn khi bộ nghe theo sát thời gian thực, vì phải chờ mốc +1,5 s. Cần đo tỷ lệ.
- **Nhiều phiên đọc:** tên vai chỉ là quy ước, không phải xác thực. Tiến độ follower nằm trong bộ nhớ host, mất khi host khởi động lại. MCP không có lease, nên có khe ngay lúc lease cũ hết hạn.
- **Monitor:** chưa kiểm `Monitor` trên `pma follow` với bản 0.12. Lệnh Monitor gốc từng bị từ chối, và tài liệu này không chạy lại.

## 5. Điểm phát hiện ảnh hưởng tới tích hợp

0. **Khoá baseline 0.12.0 sai trên bản đã commit** (phát hiện 03/11).
   - `baseline.lock.json` hash ba file `AGENTS.md`, `README.md`, `docs/PRODUCT_BASELINE.md` theo bản trong worktree này, vốn có xuống dòng CRLF.
   - Git lưu các file đó dạng LF (`.gitattributes`: `* text=auto eol=lf`). Checkout mới nào cũng ra LF.
   - Hệ quả: sau khi merge, `verify_baseline` ở checkout owner sẽ **FAIL** ba file này. "PASS 67 file" ở mục 4 chỉ đúng trong worktree `v5-int`.
   - Kiểm bằng cách so SHA-256 của `git show HEAD:<file>` với lock: đúng ba file trên lệch.
   - Không sửa ở đây, để giữ tree đã ghim. Nhánh `pma/v5-cursor` (0.12.1) khoá lại từ một checkout sạch dạng LF.

1. **`dist/` bị gitignore.** Merge xong, checkout owner vẫn chạy bản build 0.11 cho tới khi chạy `npm run build`. CLI `pma`, MCP `dist/server.js` và host `dist/daemon.js` đều chạy từ `dist/`.
2. **Mọi lệnh `pma` tự khởi động host** (`ensureDaemon`). Host đã chạy từ trước vẫn phục vụ mã cũ cho tới khi dừng.
   - Quan sát lúc chuẩn bị (01/11): checkout owner không có `.local/runtime/daemon.json`.
   - Giới hạn: điều này chỉ cho biết không có host nào **đã ghi địa chỉ**. Nó không chứng minh không còn tiến trình host hay bộ ghi mồ côi nào. Em không liệt kê tiến trình và không đọc token.
   - Trước khi tích hợp phải xác nhận host và bộ ghi của PMA đều đang nghỉ: không có cuộc họp đang chạy, không có tiến trình `dist/daemon.js` hay `tools/recorder.py` của checkout này. Chỉ dừng bằng `./pma shutdown`, không kill. Đến lúc đó trạng thái này vẫn coi là **chưa biết**.
3. **Ba thứ cần làm mới, mỗi thứ một cách:**
   - **File biên dịch cho CLI** (`dist/*.js`): `npm run build`. Lệnh `pma` sau đó dùng mã mới ngay.
   - **Host đang chạy** (nếu có): là tiến trình riêng, phải dừng bằng `./pma shutdown` lúc không họp. Lệnh `pma` kế tiếp khởi động host mới từ `dist/`.
   - **MCP server đã đăng ký** (`dist/server.js`, do `tools/install_claude.py` ghi vào cấu hình Claude Desktop): tiến trình đang chạy vẫn giữ mã cũ cho tới khi kết nối MCP đó được nạp lại.
     - Cách làm: nạp lại hoặc khởi động lại đúng kết nối MCP đó bằng cách điều khiển mà Claude Desktop hỗ trợ.
     - Chỉ khởi động lại cả Claude Desktop khi cách đăng ký hiện có cần như vậy. Tài liệu cài đặt hiện có (`Hoan-tat-cai-Claude.cmd`) chỉ dẫn cách thoát rồi mở lại Desktop; em không có nguồn nào khẳng định đó là cách duy nhất.
4. **Lời nhắn lỗi thời ngoài phạm vi 31 file:** `Hoan-tat-cai-Claude.cmd` dòng 11 vẫn bảo mở `http://127.0.0.1:8796/`. Trang này đã bị gỡ (404). Không chặn tích hợp, nên sửa một dòng ở bản sau.
   - `config/personal.example.json` còn giá trị `"output": "personal_live_translation_panel"`. Mã không đọc giá trị này; chỉ là nhãn cũ.
5. **Lệnh có chạm âm thanh**, không chạy khi kiểm sau tích hợp:
   - chạm thiết bị: `pma sources` (mặc định đo mức, mở thiết bị), `select`, `select-mic`;
   - ghi âm: `listen`, `start`, `replay`;
   - ghi nhãn micro thủ công vào timeline cuộc họp: `pma me`.
   - Cũng không chạy `Hoan-tat-cai-Claude.cmd`, vì nó ghi cấu hình Claude Desktop.

## 6. Đề xuất tích hợp và kiểm tối thiểu

**Cần owner (Dũng) duyệt riêng.**
- Mọi lệnh trong mục này và mục 7 là việc **tương lai**, chỉ làm khi owner cho phép. Lúc soạn tài liệu, chưa bước nào được làm: không merge, build, shutdown, nạp lại MCP hay khởi động lại.
- Bản thân tài liệu này chưa commit, không nằm trong 67 file của `baseline.lock.json`, và không phải hiện vật đã test.

Trong checkout owner, khi không có cuộc họp nào đang chạy và host/bộ ghi đã xác nhận nghỉ (mục 5.2):

```bash
git merge --ff-only refs/heads/pma/v5-int
```

Kiểm sau tích hợp. Không bước nào ghi âm, mở micro hay mở thiết bị:
1. `git rev-parse HEAD` = `55a0394…`; `git status` chỉ còn 4 mục chưa track như cũ.
2. `npm run build` exit 0.
3. `.venv/Scripts/python.exe -I tools/verify_baseline.py`. Với `55a0394`, lệnh này sẽ báo lệch ba file ở mục 5.0, nên trước hết phải chọn: tích hợp nhánh đã khoá lại đúng (`pma/v5-cursor`), hoặc khoá lại sau khi merge.
4. `./pma status`: host vừa khởi động; `daemon.json` ghi `version` `0.12.0`; không có phiên nào.
5. `./pma shutdown` để không để host chạy không.
6. Nạp lại kết nối MCP của PMA bằng cách điều khiển được hỗ trợ (mục 5.3). Chỉ khởi động lại cả Claude Desktop nếu cách đăng ký hiện có cần.

Không cần chạy lại bộ test, vì tree mã giống hệt bản đã test. Nếu owner muốn chắc hơn, chạy lại đúng hai lệnh test ở mục 4 bằng các cổng test. Test dùng fixture; không ghi âm thật.

## 7. Ranh giới quay lui

- Chưa push nên không có gì phải thu hồi trên remote.
- Quay lui trong checkout owner, lúc không họp:
  - `git reset --keep a771aeb`, giữ nguyên 4 mục chưa track;
  - `npm run build`, `./pma shutdown`, nạp lại kết nối MCP như mục 5.3.
- Dữ liệu `.local/runtime` (SQLite, WAV) không đổi schema, nên 0.11 đọc lại được.
- Các dòng 0.12 đã ghi có thêm cờ `SOURCE_LIVE_FOLLOW` và `MIC_SHARE_OK` trong `boundary`; 0.11 chỉ coi đó là chuỗi.
- Nhánh `pma/v5-int` và các worktree `v5-*` giữ nguyên làm điểm tham chiếu. Không xoá worktree bằng tay.

## 8. Còn lại cho nghiệm thu ở họp thật

Theo `docs/HANDOFF_0_12.md`, mục "Nghiệm thu ở buổi họp thật":
- cửa sổ dịch thô không có lời "Tôi" lúc mic tắt hoặc không rõ, mà tiếng người dự vẫn được dịch;
- đo tỷ lệ lời "Tôi" lúc mic bật bị ẩn;
- bật lại ở phút 29 không mất dòng và không in trùng nhiều;
- không còn trang web; `pma say` hiện "nhập tay" trong RAW;
- WAV đủ, báo cáo đủ;
- `Monitor` trên `pma follow` vẫn giữ được lượt.
