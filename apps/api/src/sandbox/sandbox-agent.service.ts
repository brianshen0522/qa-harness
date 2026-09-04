import { Injectable } from "@nestjs/common";
import type { ExecutionStep } from "@qa-harness/schemas";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import type { ContentPart, LlmMessage } from "../llm/providers";
import { ComputerService, HOST_ACTIONS } from "./computer.service";

/** One exchange: what the model decided, and what came back from the desktop. */
export interface AgentTurn {
  assistant: string;
  user: ContentPart[];
  /** True for turns the human typed, so they are never dropped from the prompt. */
  fromUser?: boolean;
}

export interface ActionOutcome {
  ok: boolean;
  durationMs: number;
  error?: string;
  detail?: Record<string, unknown>;
}

/** How many recent screenshots stay in the prompt. Older turns keep their text only. */
const SCREENSHOT_WINDOW = 3;

/**
 * The pieces of the computer-use loop: build the prompt, ask the vision model for
 * one `execution_step`, and carry it out in the sandbox. The loop itself lives in
 * SandboxSessionService so a run can be interrupted and continued.
 */
@Injectable()
export class SandboxAgentService {
  constructor(
    private readonly computer: ComputerService,
    private readonly gateway: LlmGatewayService,
  ) {}

  buildSystemPrompt(width: number, height: number): string {
    return [
      "你是 QA Harness 的 sandbox 操作代理。你看到的是一台 Linux 桌面的截圖，上面跑著 Chromium。",
      "使用者會用文字交代任務，你要一步一步操作這台桌面把它完成。",
      "",
      "## 規則",
      `- 螢幕解析度是 ${width}x${height}，座標原點在左上角。點擊座標必須落在這個範圍內。`,
      "- 每次只回傳「一個」動作。動作執行後你會拿到新的截圖，再決定下一步。",
      "- 先看截圖，把你看到的畫面寫進 `observation`，把這一步想達成什麼寫進 `intent`。",
      "- 點擊前先確認目標元素在截圖上的實際位置，不要用猜的座標。",
      "- 使用者可能在你操作到一半時插話（訊息會標成「使用者插話」）。插話的優先權高於原本的計畫：",
      "  先照他說的調整，必要時放棄原本的做法，不要假裝沒看到。",
      "- 任務完成、或使用者的問題已經回答完時，回傳 `action.type = \"done\"`，在 `action.params.summary` 寫下結果。",
      "- 卡住或做不到時也回傳 `done`，在 summary 說明卡在哪裡、需要使用者提供什麼。",
      "- `done` 之後對話不會結束，使用者可能接著交代下一件事，屆時你會拿到新的訊息。",
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
      "- `done`：`{ summary }` 這一輪結束，把結果講清楚。",
      "",
      "## phase 怎麼填",
      "`setup` 準備環境、`executing` 執行主要操作、`verifying` 確認結果、`judging` 做出結論。",
    ].join("\n");
  }

  /** Ask the model for the next step, given the history and the current screen. */
  async decideStep(args: {
    system: string;
    turns: AgentTurn[];
    screenshot: string;
    seq: number;
    maxSteps: number;
    timeoutMs: number;
  }): Promise<{ step: ExecutionStep; model: string }> {
    const res = await this.gateway.structured("execute", "execution_step", {
      system: args.system,
      messages: buildMessages(args.turns, args.screenshot, args.seq, args.maxSteps),
      maxTokens: 2048,
      timeoutMs: args.timeoutMs,
    });
    return { step: res.data, model: res.model };
  }

  screenshot(port: number) {
    return this.computer.screenshot(port);
  }

  /** Container actions go to the agent; `wait` and unsupported ones are handled here. */
  async performAction(port: number, step: ExecutionStep, timeoutMs: number): Promise<ActionOutcome> {
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

  /** Text the model sees after its action ran. */
  describeResult(step: ExecutionStep, result: ActionOutcome): string {
    const head = result.ok
      ? `動作 ${step.action.type} 執行成功。`
      : `動作 ${step.action.type} 失敗：${result.error ?? "未知錯誤"}`;
    const detail = result.detail && Object.keys(result.detail).length
      ? `\n結果：${JSON.stringify(result.detail).slice(0, 1500)}`
      : "";
    return `${head}${detail}`;
  }
}

export function buildMessages(
  turns: AgentTurn[],
  latestScreenshot: string,
  seq: number,
  maxSteps: number,
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  // Only the most recent turns keep their images; older ones would blow up the context.
  const imageFrom = Math.max(0, turns.length - SCREENSHOT_WINDOW);
  turns.forEach((turn, i) => {
    if (turn.assistant) messages.push({ role: "assistant", content: turn.assistant });
    messages.push({
      role: "user",
      content: i >= imageFrom ? turn.user : turn.user.filter((p) => p.type === "text"),
    });
  });
  messages.push({
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", base64: latestScreenshot },
      { type: "text", text: `這是目前的畫面（本輪第 ${seq} / ${maxSteps} 步）。請決定下一個動作。` },
    ],
  });
  return messages;
}

/** Accepts `{ ms }` or `{ seconds }`; defaults to one second. */
export function waitMs(params: Record<string, unknown> | undefined): number {
  if (params?.ms !== undefined) return Number(params.ms);
  if (params?.seconds !== undefined) return Number(params.seconds) * 1000;
  return 1000;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(Number.isFinite(v) ? v : lo, hi));
}
