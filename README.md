# QA Harness

讓 LLM 代替人做 QA 的 web app。需求與架構見 [`qa-harness-spec.md`](./qa-harness-spec.md)。

## 目前進度（開發順序 §7）

| 步驟 | 狀態 |
|---|---|
| 1. Auth + Team / Project / Target CRUD + 權限規則（含測試） | ✅ |
| 2. Admin 後台：LLM provider 設定 + 測試 + fallback；LLM Gateway | ✅ |
| 3. Output Contract：所有 schema + 驗證 / 重試 / fallback | ✅ |
| 4. 討論區 + Context Handoff | ⬜ |
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

## LLM Gateway

`LlmGatewayService.structured(purpose, schemaName, request)`：

1. 依用途取 fallback chain（admin 可拖曳排序；`execute` 只用 supports_vision 的設定）
2. 呼叫 provider（anthropic / openai 相容 / ollama），schema 同時走 native structured output 與 prompt
3. 後端以 Ajv 驗證；失敗時把錯誤餵回模型重試（預設 2 次）
4. timeout / rate limit / 5xx / 拒答 / 重試用盡 → 下一個 config
5. 每次嘗試寫入 `llm_call_logs`（模型、耗時、token、原始輸出）
