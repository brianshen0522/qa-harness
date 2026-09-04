# QA Harness

讓 LLM 代替人做 QA 的 web app。需求與架構見 [`qa-harness-spec.md`](./qa-harness-spec.md)。

## 目前進度（開發順序 §7）

| 步驟 | 狀態 |
|---|---|
| 1. Auth + Team / Project / Target CRUD + 權限規則（含測試） | ✅ |
| 2. Admin 後台：LLM provider 設定 + 測試 + fallback；LLM Gateway | ✅ |
| 3. Output Contract：所有 schema + 驗證 / 重試 / fallback | ✅ 含斷路器、探測復原與流程暫停續跑 |
| 4. 討論區（引導式對談 + 完整度面板 + Target 提案）+ Context Handoff | ✅ |
| 5. Test case 生成 pipeline（先 api 類型）+ features 結構 | ✅ |
| 6. 變更管理 | ⬜ |
| 7. Sandbox Manager + 容器 image + noVNC 串流 | ✅ |
| 8. Agent Worker + web 類型執行 + 執行中頁面（進度、Finding、即時編輯） | ✅ |
| 9. 結果頁 + 人工覆核 | ⬜ |
| 10. desktop、skills / MCP、用量、增量 Handoff | ⬜ |

## 結構

```
schemas/                 LLM 輸出 JSON schema（單一來源，§4.9）
packages/schemas/        @qa-harness/schemas：schema 匯出、Ajv 驗證、寬鬆 JSON 解析
apps/api/                NestJS API（REST；Prisma + PostgreSQL）
apps/web/                React + Vite + Tailwind 前端
docker-compose.yml       postgres(5433) / redis(6380) / minio(9000, 9001)
```

## 啟動

```bash
cp .env.example .env            # 填 CREDENTIAL_MASTER_KEY: openssl rand -base64 32
npm install
npm run infra:up                # 起 db / redis / minio
npm run build -w packages/schemas
npm run db:migrate              # prisma migrate dev
npm run db:seed                 # 建立 ADMIN_EMAIL / ADMIN_PASSWORD 的 admin
docker build -t qa-harness-sandbox:0.1 docker/sandbox   # sandbox 桌面 image
npm run dev:api                 # http://localhost:3001/api
npm run dev:web                 # http://localhost:5173
```

- 使用者登入：Google / GitHub OAuth（設定 `GOOGLE_*` / `GITHUB_*`），或 `DEV_LOGIN_ENABLED=true` 時用 email 直接登入。
- Admin 登入：`/admin/login`，帳號來自 seed。
- API key 與 Target 憑證以 AES-256-GCM 加密（`CREDENTIAL_MASTER_KEY`）。

## 測試

```bash
npm test -w packages/schemas    # schema 驗證
npm test -w apps/api            # 單元：權限規則、加密、gateway 重試 / fallback
npm run test:e2e -w apps/api    # e2e：auth、CRUD、權限規則 §2.3、admin LLM、chain（需 docker db）
```

## 討論區與 Context Handoff（§4.1 / §4.2）

**討論區**：Project 與 Target 各一條討論串。LLM 帶著 scope 對應的「必須釐清項目」清單主動提問，每輪最多 3 題，每題標註它要釐清哪一項；回覆同時更新完整度（未知 / 部分 / 清楚）與描述草稿。使用者訊息中的連結會自動抓取，內容送進 context 並存為 `project_attachments`。被測面清楚後 LLM 會提出 Target 提案卡，**只提案不建立**，由 Project owner 接受後才真的建立 Target。一鍵「儲存為描述」產生新的 description version（`source=discussion`）。

**Context Handoff**：依 scope 與 target kind 產生交接 prompt → 貼給 coding agent → 把回傳的 Markdown 貼回來 → 預覽解析結果 → 選擇覆蓋 / 合併 / 當作附件套用。解析採寬鬆策略：認得的 section 結構化匯入，未知 section 原樣保留，完全無法解析則強制走附件。偵測到疑似憑證時會標示行號與遮罩預覽，並**從寫入的描述中移除**，原始文件另存於 `handoff_documents`。

## 執行（§4.5 / §4.6）

按「開始執行」後，run 在背景跑，關掉瀏覽器不會中斷。

- **一個 Target 同時只有一個 run**：用一次條件式 UPDATE 搶鎖（`status = idle` 才搶得到），不排隊也不接手，兩個請求不可能同時贏。結束時一定釋放鎖並回收 sandbox。
- **兩種執行器**：`api` 類型不起 sandbox，直接送 HTTP；`web` / `desktop` 起容器，用 computer use 操作畫面。每步都截圖存進 MinIO。
- **憑證不進 prompt**：模型只看得到憑證的「名稱」，要用時寫 `{{名稱}}`，伺服器在送出前代入真值；存下來的紀錄裡憑證值一律遮蔽。實測確認資料庫中零外洩。
- **主機位址自動轉換**：容器裡的 `localhost` 是容器自己。設定寫 `localhost` 的被測站台會自動轉成 `host.docker.internal`，並在 prompt 裡告訴模型。
- **Finding 與 verdict 分開**：模型在執行中發現與本條案例無關的問題時用 `report_finding` 記下來就繼續，不會混進判定。判定是另一次呼叫，只看完整過程，fail 時強制寫重現步驟。
- **逐案例鎖定**：排隊中的案例可以改（本次 run 用新版本），正在跑的那條鎖住，跑完的可以改但結果會標記「已於執行後修改」。執行中還能跳過案例、加案例、中止。
- **LLM 掛掉不中斷**：同樣走暫停機制，保留進度，模型恢復後從中斷的那一步繼續。

## Test case 生成 pipeline（§4.3）

Target 頁的「測試清單」分頁可以一鍵生成，過程以 SSE 串到前端。

1. **現況探索**：api 類型讀 `openapi_url` 或貼上的 schema，抽出每個 endpoint 的方法、路徑、參數、request body 欄位與回應碼；web 類型抓首頁，抽出標題階層、連結與表單欄位。desktop 目前只依描述生成。
2. **功能清單**：描述 + 設定 + 探索結果 + 討論區附件 + 交接文件建議案例一起送進 `feature_list` schema。
3. **逐功能展開**：每個功能各一次呼叫，要求覆蓋 happy / edge / negative 與 P0–P3。
4. **去重與排序**：用「標題 + 預期結果」的字元 bigram 相似度（門檻 0.75）去掉改寫重複，再依功能、優先級、類型排序。刻意偏向保留 —— 多留一條使用者按一下就刪掉，誤刪一條是靜默的覆蓋缺口。
5. **寫入**：`features` 與 `test_cases`，每條案例同時建立第 1 版。`replace` 只清掉先前生成的案例，手寫的一律保留。

Target 設定裡若含 `Authorization` 之類的欄位，送進模型前會遮蔽。每次編輯案例都會寫一個新版本，可回溯。

## Sandbox 主控台（§4.8 / §5.1）

Admin → Sandbox → 主控台可以直接起一個容器、看畫面、下指令給 LLM 操作它。

- **容器 image**（`docker/sandbox/`）：Debian + Xvfb + openbox + x11vnc + noVNC + Chromium，加一個純標準函式庫的 computer-use agent（`agent.py`），對外開 6080（noVNC）與 8000（動作 API）。動作集合就是 `execution_step` schema 的 action：screenshot / click / double_click / right_click / move / type / key / scroll / navigate / run_command。
- **Sandbox Manager**：直接走 Docker Engine API 的 unix socket，不額外裝套件。負責建立、健康檢查、ephemeral port 配置、TTL 到期回收，並套用 sandbox 設定的 CPU、記憶體、解析度與並行上限。
- **即時畫面**：容器內建的 noVNC，瀏覽器直接連 `127.0.0.1:<port>`（只綁 loopback）。第一版不經過 API 轉發，所以只有在跑 API 的那台機器上看得到。
- **與 LLM 對話**：每個 sandbox 有一條常駐對話。送出訊息後 agent loop 就會「截圖 → 問 vision model 下一個 `execution_step` → 在容器裡執行 → 把結果餵回去」，直到模型回 `done` 或達到步數上限。
  - **執行中可以插話**：發現方向不對時直接再送一則訊息，它會在下一步之前插進 context，模型會改做法。訊息在畫面上標成「插話」。
  - **對話會延續**：`done` 之後再送訊息就是新的一輪，前面的歷史都還在，所以可以講「剛剛那個頁面…」。
  - 進度以 SSE（GET + EventSource）串到前端，重新整理會重播完整對話。每步顯示 phase、動作、意圖、觀察、耗時與使用的 model。這個迴圈就是步驟 8 Agent Worker 要用的核心。

## LLM 失效與復原（斷路器 + 探測）

一個依賴 LLM 的長流程不會因為某個 model 壞掉就中斷。

- **斷路器**：連續 3 次失敗的設定會被標記 `down`，選 fallback chain 時直接跳過，不會再拖累任何流程。成功一次就把計數歸零，所以偶發失敗不會誤判。一旦 `down` 就維持 `down`，只有探測成功或管理者修改才會放回去 —— 這點很重要，否則失敗會把它彈回 `degraded`、立刻又被叫到，變成空轉。
- **探測機制**：背景迴圈每 15 秒掃一次（`LLM_PROBE_TICK_MS` 可調），對每個 `down` 的設定送一個極短的 prompt。退避從 30 秒倍增到上限 5 分鐘，但**迴圈本身不會停**，也不會放棄任何一個設定。單一設定的例外或資料庫錯誤都被吞掉，不影響其他設定與下一輪。
- **流程暫停而不是失敗**：所有設定都不能用時，生成 pipeline 與 sandbox 對話都會進入 `paused`，保留已完成的進度，並在畫面上說明在等什麼。任何一個設定恢復（自己好了、或管理者改設定）就自動從中斷的地方接續，不需要重新下指令。生成 run 甚至在 API 重啟後也會從 `generation_runs.progress` 續跑。
- **互動式請求不暫停**：討論區的一則訊息是同步請求，沒有可用 model 時直接回 503 並說明原因，比讓使用者對著轉圈等更誠實。

## LLM Gateway

`LlmGatewayService.structured(purpose, schemaName, request)`：

1. 依用途取 fallback chain（admin 可拖曳排序；`execute` 只用 supports_vision 的設定）
2. 呼叫 provider（anthropic / openai 相容 / ollama），schema 同時走 native structured output 與 prompt
3. 後端以 Ajv 驗證；失敗時把錯誤餵回模型重試（預設 2 次）
4. timeout / rate limit / 5xx / 拒答 / 重試用盡 → 下一個 config
5. 每次嘗試寫入 `llm_call_logs`（模型、耗時、token、原始輸出）
