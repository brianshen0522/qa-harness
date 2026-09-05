import { Injectable, Logger } from "@nestjs/common";
import type { DiscoveryResult } from "./discovery.service";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import { SandboxService } from "../sandbox/sandbox.service";
import { ComputerService } from "../sandbox/computer.service";

const INVENTORY_SYSTEM = [
  "你是 QA Harness 的桌面現況探索員。給你一張桌面應用程式的截圖。",
  "請盤點畫面上「實際看得到」的結構,作為之後設計測試案例的依據:",
  "- 主視窗的用途與標題",
  "- 可見的選單、工具列、按鈕、輸入欄位、清單/表格",
  "- 對話框或彈出視窗(若有)",
  "- 從畫面推得的主要操作路徑(例如「填 X → 按 Y → 應該出現 Z」)",
  "只根據畫面上真的有的東西,不要臆造。用條列、精簡的中文回覆,不要客套。",
].join("\n");

/**
 * Desktop 現況探索(§4.3 / §3.2 desktop):api/web 靠讀 schema 或抓 HTML,desktop
 * 沒有那種東西,只能真的把 app 開起來看。這裡起一個 sandbox、跑設定的啟動命令、
 * 截圖,再用視覺模型盤點視窗結構,產出和 api/web 一致的 discovery 摘要餵給生成。
 */
@Injectable()
export class DesktopDiscoveryService {
  private readonly log = new Logger(DesktopDiscoveryService.name);

  constructor(
    private readonly gateway: LlmGatewayService,
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
  ) {}

  async discover(config: Record<string, unknown>, userId: string): Promise<DiscoveryResult> {
    const launch = typeof config.launch_command === "string" ? config.launch_command.trim() : "";
    let sandboxId: string | null = null;
    try {
      const instance = await this.sandbox.create(userId, { purpose: "run", ttlMinutes: 30 });
      sandboxId = instance.id;
      const port = instance.agentPort;
      if (!port) throw new Error("sandbox 沒有開放 agent 連接埠");

      // Launch the app under test, if one was configured; the image already has a
      // desktop (openbox) so a bare command lands on a real screen.
      if (launch) {
        await this.computer.perform(port, "run_command", { command: `${launch} &` }, 15_000);
      }
      // Give the window time to paint, then look.
      await this.computer.perform(port, "wait", { ms: 2500 }, 5_000).catch(() => undefined);
      const shot = await this.computer.screenshot(port);
      if (!shot.ok || !shot.image) {
        return { kind: "desktop", ok: false, source: "sandbox 截圖", note: `截圖失敗:${shot.error ?? "沒有影像"}`, summary: "" };
      }

      const res = await this.gateway.complete(
        "execute",
        {
          system: INVENTORY_SYSTEM,
          messages: [{ role: "user", content: [
            { type: "text", text: launch ? `已執行啟動命令:${launch}。請盤點目前畫面。` : "請盤點目前畫面。" },
            { type: "image", mediaType: "image/png", base64: shot.image },
          ] }],
          maxTokens: 1500,
          reasoningEffort: "low",
        },
        { requireVision: true },
      );
      const summary = res.text.trim();
      return {
        kind: "desktop", ok: !!summary, source: "sandbox 截圖 + 視覺盤點",
        note: summary ? "已在 sandbox 開啟並盤點視窗結構。" : "模型沒有產出盤點結果。",
        summary: summary ? `# 桌面現況(視覺盤點)\n${summary}` : "",
      };
    } catch (err) {
      this.log.warn(`desktop discovery failed: ${(err as Error).message}`);
      return { kind: "desktop", ok: false, source: "sandbox 截圖", note: `探索失敗:${(err as Error).message}`, summary: "" };
    } finally {
      if (sandboxId) await this.sandbox.remove(sandboxId).catch(() => undefined);
    }
  }
}
