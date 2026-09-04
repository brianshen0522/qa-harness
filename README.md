# QA Harness

讓 LLM 代替人做 QA 的 web app。需求與架構見 [`qa-harness-spec.md`](./qa-harness-spec.md)。

## 目前進度（開發順序 §7）

| 步驟 | 狀態 |
|---|---|
| 1. Auth + Team / Project / Target CRUD + 權限規則（含測試） | ✅ |
| 2. Admin 後台：LLM provider 設定 + 測試 + fallback；LLM Gateway | ✅ |
| 3. Output Contract：所有 schema + 驗證 / 重試 / fallback | ✅ |
| 4. 討論區（引導式對談 + 完整度面板 + Target 提案）+ Context Handoff | ✅ |
| 5. Test case 生成 pipeline | ⬜ |
| 6. 變更管理 | ⬜ |
| 7. Sandbox Manager + noVNC | ⬜ |
| 8. Agent Worker + 執行中頁面 | ⬜ |
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

## Sandbox 主控台（§4.8 / §5.1）

Admin → Sandbox → 主控台可以直接起一個容器、看畫面、下指令給 LLM 操作它。

- **容器 image**（`docker/sandbox/`）：Debian + Xvfb + openbox + x11vnc + noVNC + Chromium，加一個純標準函式庫的 computer-use agent（`agent.py`），對外開 6080（noVNC）與 8000（動作 API）。動作集合就是 `execution_step` schema 的 action：screenshot / click / double_click / right_click / move / type / key / scroll / navigate / run_command。
- **Sandbox Manager**：直接走 Docker Engine API 的 unix socket，不額外裝套件。負責建立、健康檢查、ephemeral port 配置、TTL 到期回收，並套用 sandbox 設定的 CPU、記憶體、解析度與並行上限。
- **即時畫面**：容器內建的 noVNC，瀏覽器直接連 `127.0.0.1:<port>`（只綁 loopback）。第一版不經過 API 轉發，所以只有在跑 API 的那台機器上看得到。
- **LLM 操作**：輸入一句話，agent loop 就會「截圖 → 問 vision model 下一個 `execution_step` → 在容器裡執行 → 把結果餵回去」，直到模型回 `done` 或達到步數上限。過程以 SSE 串到前端，每步顯示 phase、動作、意圖、觀察、耗時與使用的 model。這個迴圈就是步驟 8 Agent Worker 要用的核心。

## LLM Gateway

`LlmGatewayService.structured(purpose, schemaName, request)`：

1. 依用途取 fallback chain（admin 可拖曳排序；`execute` 只用 supports_vision 的設定）
2. 呼叫 provider（anthropic / openai 相容 / ollama），schema 同時走 native structured output 與 prompt
3. 後端以 Ajv 驗證；失敗時把錯誤餵回模型重試（預設 2 次）
4. timeout / rate limit / 5xx / 拒答 / 重試用盡 → 下一個 config
5. 每次嘗試寫入 `llm_call_logs`（模型、耗時、token、原始輸出）
