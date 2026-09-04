import { Injectable, Logger } from "@nestjs/common";
import type { ExecutionStep } from "@qa-harness/schemas";
import { LlmExhaustedError, LlmGatewayService } from "../llm/llm-gateway.service";
import type { ContentPart, LlmMessage } from "../llm/providers";
import { ComputerService, HOST_ACTIONS } from "./computer.service";
import { SandboxService, parseResolution, type SandboxInstance } from "./sandbox.service";

export interface AgentStepEvent {
  type: "step";
  seq: number;
  phase: ExecutionStep["phase"];
  intent: string;
  observation: string;
  action: ExecutionStep["action"];
  /** Result of actually performing the action in the sandbox. */
  result: { ok: boolean; durationMs: number; error?: string; detail?: Record<string, unknown> };
  model: string;
  llmMs: number;
}

export type AgentEvent =
  | { type: "started"; instruction: string; maxSteps: number; screen: string; sandbox: string }
  | { type: "thinking"; seq: number }
  | AgentStepEvent
  | { type: "finished"; reason: "done" | "max_steps" | "aborted"; steps: number; summary: string }
  | { type: "error"; message: string; detail?: unknown };

export interface RunAgentOptions {
  instruction: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

/** How many recent screenshots stay in the prompt. Older turns keep their text only. */
const SCREENSHOT_WINDOW = 3;

@Injectable()
export class SandboxAgentService {
  private readonly log = new Logger(SandboxAgentService.name);

  constructor(
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
    private readonly gateway: LlmGatewayService,
  ) {}

  /**
   * Drives one sandbox from a natural-language instruction: screenshot, ask the
   * vision model for the next `execution_step`, perform it, repeat. This is the
   * agent loop the worker will reuse for real test cases (spec §4.5).
   */
  async *run(sandboxId: string, opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
    const settings = await this.sandbox.settings();
    const maxSteps = clamp(opts.maxSteps ?? settings.maxStepsPerCase, 1, 200);
    const stepTimeoutMs = settings.stepTimeoutSec * 1000;

    let instance: SandboxInstance;
    let port: number;
    try {
      ({ instance, port } = await this.sandbox.requireAgentPort(sandboxId));
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      return;
    }

    const [width, height] = parseResolution(instance.resolution ?? settings.resolution);
    yield {
      type: "started",
      instruction: opts.instruction,
      maxSteps,
      screen: `${width}x${height}`,
      sandbox: instance.name,
    };

    const system = buildSystemPrompt(opts.instruction, width, height);
    // Each turn is a pair: what the model decided, then what actually happened.
    const turns: { assistant: string; user: ContentPart[] }[] = [];
    let seq = 0;
    let summary = "";

    while (seq < maxSteps) {
      if (opts.signal?.aborted) {
        yield { type: "finished", reason: "aborted", steps: seq, summary: "使用者中止" };
        return;
      }
      seq++;
      yield { type: "thinking", seq };

      const shot = await this.computer.screenshot(port);
      if (!shot.ok || !shot.image) {
        yield { type: "error", message: `截圖失敗：${shot.error ?? "沒有回傳影像"}` };
        return;
      }

      const messages = buildMessages(turns, shot.image, seq, maxSteps);
      const startedLlm = Date.now();
      let step: ExecutionStep;
      let model: string;
      try {
        const res = await this.gateway.structured("execute", "execution_step", {
          system,
          messages,
          maxTokens: 2048,
          timeoutMs: Math.max(stepTimeoutMs, 60_000),
        });
        step = res.data;
        model = res.model;
      } catch (err) {
        const message =
          err instanceof LlmExhaustedError
            ? `${err.message}（${err.attempts.map((a) => `${a.configName}:${a.outcome}`).join(", ")}）`
            : (err as Error).message;
        yield { type: "error", message, detail: err instanceof LlmExhaustedError ? err.attempts : undefined };
        return;
      }
      const llmMs = Date.now() - startedLlm;

      if (step.action.type === "done") {
        summary = String(step.action.params?.summary ?? step.observation ?? "完成");
        yield {
          type: "step", seq, phase: step.phase, intent: step.intent, observation: step.observation,
          action: step.action, result: { ok: true, durationMs: 0 }, model, llmMs,
        };
        yield { type: "finished", reason: "done", steps: seq, summary };
        return;
      }

      const result = await this.performAction(port, step, stepTimeoutMs);
      yield {
        type: "step", seq, phase: step.phase, intent: step.intent, observation: step.observation,
        action: step.action, result, model, llmMs,
      };

      turns.push({
        assistant: JSON.stringify({ phase: step.phase, intent: step.intent, action: step.action }),
        user: [{ type: "text", text: describeResult(step, result) }],
      });
    }

    yield { type: "finished", reason: "max_steps", steps: seq, summary: summary || `已達步數上限（${maxSteps}）` };
  }

  /** Container actions go to the agent; `wait` and unsupported ones are handled here. */
  private async performAction(port: number, step: ExecutionStep, timeoutMs: number) {
    const { type, params } = step.action;
    if (type === "wait") {
      const ms = clamp(waitMs(params), 100, 30_000);
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, durationMs: ms, detail: { waited_ms: ms } };
    }
    if (HOST_ACTIONS.has(type)) {
      return { ok: false, durationMs: 0, error: `這個 sandbox 不處理「${type}」動作`, detail: {} };
    }
    const res = await this.computer.perform(port, type, (params ?? {}) as Record<string, unknown>, timeoutMs);
    return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
  }
}

function buildSystemPrompt(instruction: string, width: number, height: number): string {
  return [
    "你是 QA Harness 的 sandbox 操作代理。你看到的是一台 Linux 桌面的截圖，上面跑著 Chromium。",
    "你要一步一步地操作這台桌面，完成使用者交付的任務。",
    "",
    "## 任務",
    instruction,
    "",
    "## 規則",
    `- 螢幕解析度是 ${width}x${height}，座標原點在左上角。點擊座標必須落在這個範圍內。`,
    "- 每次只回傳「一個」動作。動作執行後你會拿到新的截圖，再決定下一步。",
    "- 先看截圖，把你看到的畫面寫進 `observation`，把這一步想達成什麼寫進 `intent`。",
    "- 點擊前先確認目標元素在截圖上的實際位置，不要用猜的座標。",
    "- 任務完成時，回傳 `action.type = \"done\"`，並在 `action.params.summary` 寫下結果。",
    "- 如果卡住或無法完成，也回傳 `done`，在 summary 說明卡在哪裡。",
    "",
    "## 可用動作（`action.type` 與 `action.params`）",
    "- `screenshot`：重新截圖，不帶參數。畫面可能還在載入時使用。",
    "- `click`：`{ x, y, button }`，button 預設 1（左鍵）。",
    "- `double_click`：`{ x, y }`",
    "- `right_click`：`{ x, y }`",
    "- `move`：`{ x, y }` 只移動游標。",
    "- `type`：`{ text }` 在目前焦點輸入文字。",
    "- `key`：`{ key }` 按鍵，xdotool 語法，例如 `Return`、`Tab`、`ctrl+l`、`ctrl+a`。",
    "- `scroll`：`{ direction: up|down|left|right, amount, x, y }`",
    "- `navigate`：`{ url }` 直接開網址，比手動點網址列可靠。",
    "- `run_command`：`{ command }` 在容器內執行 shell 指令。",
    "- `wait`：`{ ms }` 等待畫面穩定。",
    "- `done`：`{ summary }` 結束。",
    "",
    "## phase 怎麼填",
    "`setup` 準備環境、`executing` 執行主要操作、`verifying` 確認結果、`judging` 做出結論。",
  ].join("\n");
}

function buildMessages(
  turns: { assistant: string; user: ContentPart[] }[],
  latestScreenshot: string,
  seq: number,
  maxSteps: number,
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  // Only the most recent turns keep their images; older ones would blow up the context.
  const imageFrom = Math.max(0, turns.length - SCREENSHOT_WINDOW);
  turns.forEach((turn, i) => {
    messages.push({ role: "assistant", content: turn.assistant });
    messages.push({
      role: "user",
      content: i >= imageFrom ? turn.user : turn.user.filter((p) => p.type === "text"),
    });
  });
  messages.push({
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", base64: latestScreenshot },
      {
        type: "text",
        text: `這是目前的畫面（第 ${seq} / ${maxSteps} 步）。請決定下一個動作。`,
      },
    ],
  });
  return messages;
}

function describeResult(step: ExecutionStep, result: { ok: boolean; error?: string; detail?: Record<string, unknown> }) {
  const head = result.ok
    ? `動作 ${step.action.type} 執行成功。`
    : `動作 ${step.action.type} 失敗：${result.error ?? "未知錯誤"}`;
  const detail = result.detail && Object.keys(result.detail).length
    ? `\n結果：${JSON.stringify(result.detail).slice(0, 1500)}`
    : "";
  return `${head}${detail}`;
}

/** Accepts `{ ms }` or `{ seconds }`; defaults to one second. */
function waitMs(params: Record<string, unknown> | undefined): number {
  if (params?.ms !== undefined) return Number(params.ms);
  if (params?.seconds !== undefined) return Number(params.seconds) * 1000;
  return 1000;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(Number.isFinite(v) ? v : lo, hi));
}
