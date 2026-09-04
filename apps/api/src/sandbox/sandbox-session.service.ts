import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ExecutionStep } from "@qa-harness/schemas";
import { LlmExhaustedError } from "../llm/llm-gateway.service";
import { LlmHealthService } from "../llm/llm-health.service";
import { SandboxAgentService, clamp, type ActionOutcome, type AgentTurn } from "./sandbox-agent.service";
import { SandboxService, parseResolution } from "./sandbox.service";

export type SessionStatus = "idle" | "running" | "paused";

export interface SessionEventBase {
  seq: number;
  at: string;
}

export type SessionEventPayload =
  | { type: "status"; status: SessionStatus }
  /** `interjected` marks a message that arrived while a round was already running. */
  | { type: "user_message"; content: string; interjected: boolean }
  | { type: "run_started"; runId: string; maxSteps: number; screen: string; sandbox: string }
  | { type: "thinking"; step: number }
  | {
      type: "step";
      step: number;
      phase: ExecutionStep["phase"];
      intent: string;
      observation: string;
      action: ExecutionStep["action"];
      result: ActionOutcome;
      model: string;
      llmMs: number;
    }
  | { type: "finished"; reason: "done" | "max_steps" | "aborted"; steps: number; summary: string }
  | { type: "error"; message: string; detail?: unknown }
  /** No usable model: the round is waiting rather than failing. */
  | { type: "paused"; reason: string; message: string }
  | { type: "resumed"; message: string }
  | { type: "reset" };

export type SessionEvent = SessionEventBase & SessionEventPayload;

type Subscriber = (event: SessionEvent) => void;

interface Session {
  sandboxId: string;
  status: SessionStatus;
  turns: AgentTurn[];
  pending: string[];
  events: SessionEvent[];
  subscribers: Set<Subscriber>;
  seq: number;
  maxSteps: number;
  abort: AbortController;
  /** Guards against two loops running for one sandbox. */
  looping: boolean;
}

/** Events kept for replay when a browser reconnects. */
const EVENT_HISTORY = 500;

/**
 * A steerable conversation with one sandbox.
 *
 * The model runs until it says `done`, but the user can send a message at any
 * time: mid-run it is injected before the next step (spec §4.6 lets the operator
 * intervene while a run is in flight), and once idle it starts the next round
 * with the whole history intact.
 */
@Injectable()
export class SandboxSessionService {
  private readonly log = new Logger(SandboxSessionService.name);
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly sandbox: SandboxService,
    private readonly agent: SandboxAgentService,
    private readonly health: LlmHealthService,
  ) {}

  /** Current transcript, for the first render before the stream attaches. */
  snapshot(sandboxId: string) {
    const s = this.sessions.get(sandboxId);
    if (!s) return { status: "idle" as SessionStatus, events: [], turns: 0, pending: 0 };
    return { status: s.status, events: s.events, turns: s.turns.length, pending: s.pending.length };
  }

  subscribe(sandboxId: string, subscriber: Subscriber): () => void {
    const session = this.ensure(sandboxId);
    session.subscribers.add(subscriber);
    for (const event of session.events) subscriber(event);
    subscriber(this.make(session, { type: "status", status: session.status }, false));
    return () => session.subscribers.delete(subscriber);
  }

  /**
   * Queue a message from the user. Starts a round when idle; when a round is in
   * flight the message is picked up before the next step.
   */
  async send(sandboxId: string, content: string, maxSteps?: number) {
    const text = content.trim();
    if (!text) throw new BadRequestException("訊息是空的");
    // Fails fast with a clear reason if the container is gone.
    await this.sandbox.requireAgentPort(sandboxId);

    const session = this.ensure(sandboxId);
    if (maxSteps) session.maxSteps = clamp(maxSteps, 1, 200);
    // A round that is parked waiting for an LLM is still in flight, so a message
    // sent now is an interjection into it rather than the start of a new round.
    const interjected = session.status !== "idle";
    session.pending.push(text);
    this.emit(session, { type: "user_message", content: text, interjected });

    if (!session.looping) {
      session.looping = true;
      session.abort = new AbortController();
      void this.loop(session).catch((err) => {
        this.log.error(`session loop crashed: ${(err as Error).message}`);
        this.emit(session, { type: "error", message: (err as Error).message });
        session.status = "idle";
        session.looping = false;
        this.emit(session, { type: "status", status: "idle" });
      });
    }
    return { queued: true, interjected, status: session.status };
  }

  /**
   * Stop the current round. History is kept, so the user can carry on afterwards.
   * A round parked waiting for an LLM is stoppable too, otherwise the only way
   * out of a long outage would be to delete the conversation.
   */
  stop(sandboxId: string) {
    const session = this.sessions.get(sandboxId);
    if (!session || session.status === "idle") return { stopped: false };
    session.abort.abort();
    return { stopped: true };
  }

  /** Drop the transcript and start over. */
  reset(sandboxId: string) {
    const session = this.sessions.get(sandboxId);
    if (!session) return { ok: true };
    session.abort.abort();
    session.turns = [];
    session.pending = [];
    session.events = [];
    session.seq = 0;
    this.emit(session, { type: "reset" });
    this.emit(session, { type: "status", status: session.status });
    return { ok: true };
  }

  /** Called when the sandbox is removed so nothing lingers. */
  discard(sandboxId: string) {
    const session = this.sessions.get(sandboxId);
    if (!session) return;
    session.abort.abort();
    session.subscribers.clear();
    this.sessions.delete(sandboxId);
  }

  private ensure(sandboxId: string): Session {
    let session = this.sessions.get(sandboxId);
    if (!session) {
      session = {
        sandboxId,
        status: "idle",
        turns: [],
        pending: [],
        events: [],
        subscribers: new Set(),
        seq: 0,
        maxSteps: 40,
        abort: new AbortController(),
        looping: false,
      };
      this.sessions.set(sandboxId, session);
    }
    return session;
  }

  private async loop(session: Session) {
    const settings = await this.sandbox.settings();
    const stepTimeoutMs = Math.max(settings.stepTimeoutSec * 1000, 60_000);

    session.status = "running";
    this.emit(session, { type: "status", status: "running" });

    try {
      let stepInRound = 0;
      // Steps allowed before the round is cut off. A new instruction extends it
      // from where we are, so the step numbers the user sees never go backwards.
      let budget = session.maxSteps;
      let roundOpen = false;

      while (!session.abort.signal.aborted) {
        const incoming = session.pending.splice(0, session.pending.length);
        if (incoming.length) {
          for (const message of incoming) {
            session.turns.push({
              assistant: "",
              user: [{ type: "text", text: roundOpen ? `使用者插話：${message}` : message }],
              fromUser: true,
            });
          }
          // A new instruction gets a fresh step budget, measured from here.
          budget = stepInRound + session.maxSteps;
          if (!roundOpen) {
            stepInRound = 0;
            budget = session.maxSteps;
            roundOpen = true;
            const instance = await this.sandbox.get(session.sandboxId);
            const [w, h] = parseResolution(instance.resolution ?? settings.resolution);
            this.emit(session, {
              type: "run_started",
              runId: randomUUID().slice(0, 8),
              maxSteps: session.maxSteps,
              screen: `${w}x${h}`,
              sandbox: instance.name,
            });
          }
        } else if (!roundOpen) {
          break; // model is done and the user has said nothing new
        }

        if (stepInRound >= budget) {
          this.emit(session, {
            type: "finished", reason: "max_steps", steps: stepInRound,
            summary: `已達步數上限（${budget}）。可以再下指令繼續。`,
          });
          roundOpen = false;
          continue;
        }

        stepInRound++;
        this.emit(session, { type: "thinking", step: stepInRound });

        const { port, instance } = await this.sandbox.requireAgentPort(session.sandboxId);
        const [width, height] = parseResolution(instance.resolution ?? settings.resolution);

        const shot = await this.agent.screenshot(port);
        if (!shot.ok || !shot.image) {
          this.emit(session, { type: "error", message: `截圖失敗：${shot.error ?? "沒有回傳影像"}` });
          roundOpen = false;
          continue;
        }

        const startedLlm = Date.now();
        let step: ExecutionStep;
        let model: string;
        try {
          ({ step, model } = await this.agent.decideStep({
            system: this.agent.buildSystemPrompt(width, height),
            turns: session.turns,
            screenshot: shot.image,
            seq: stepInRound,
            maxSteps: budget,
            timeoutMs: stepTimeoutMs,
          }));
        } catch (err) {
          // Losing every model is a pause, not a failure: wait for one to come
          // back (or for an admin to fix one) and retake the same step.
          if (err instanceof LlmExhaustedError && err.recoverable) {
            const resumed = await this.pauseUntilLlmReturns(session, err);
            if (!resumed) {
              this.emit(session, {
                type: "finished", reason: "aborted", steps: stepInRound,
                summary: "等待 LLM 期間被中止，對話紀錄保留。",
              });
              return;
            }
            stepInRound--; // that step never happened
            continue;
          }
          this.emit(session, { type: "error", message: (err as Error).message });
          roundOpen = false;
          continue;
        }
        const llmMs = Date.now() - startedLlm;

        if (step.action.type === "done") {
          this.emit(session, {
            type: "step", step: stepInRound, phase: step.phase, intent: step.intent,
            observation: step.observation, action: step.action,
            result: { ok: true, durationMs: 0 }, model, llmMs,
          });
          this.emit(session, {
            type: "finished", reason: "done", steps: stepInRound,
            summary: String(step.action.params?.summary ?? step.observation ?? "完成"),
          });
          session.turns.push({
            assistant: JSON.stringify({ phase: step.phase, intent: step.intent, action: step.action }),
            user: [{ type: "text", text: "你已回報完成。等待使用者的下一個指示。" }],
          });
          roundOpen = false;
          continue;
        }

        const result = await this.agent.performAction(port, step, stepTimeoutMs);
        this.emit(session, {
          type: "step", step: stepInRound, phase: step.phase, intent: step.intent,
          observation: step.observation, action: step.action, result, model, llmMs,
        });
        session.turns.push({
          assistant: JSON.stringify({ phase: step.phase, intent: step.intent, action: step.action }),
          user: [{ type: "text", text: this.agent.describeResult(step, result) }],
        });
      }

      if (session.abort.signal.aborted) {
        this.emit(session, { type: "finished", reason: "aborted", steps: 0, summary: "已中止，對話紀錄保留。" });
      }
    } finally {
      session.status = "idle";
      session.looping = false;
      this.emit(session, { type: "status", status: "idle" });
      // A message that landed during teardown must not be stranded.
      if (session.pending.length && !session.abort.signal.aborted) {
        session.looping = true;
        void this.loop(session);
      }
    }
  }

  /**
   * Hold the round until a model for `execute` is usable again. Returns false
   * only when the user aborted while it was waiting.
   */
  private async pauseUntilLlmReturns(session: Session, err: LlmExhaustedError): Promise<boolean> {
    const detail = err.attempts.length
      ? `（${err.attempts.map((a) => `${a.configName}:${a.outcome}`).join(", ")}）`
      : "";
    session.status = "paused";
    this.emit(session, {
      type: "paused",
      reason: err.reason,
      message: `${err.message}${detail} 一旦有可用的 LLM 就會自動接續，不需要重新下指令。`,
    });
    this.emit(session, { type: "status", status: "paused" });

    const ok = await this.health.waitForPurpose("execute", true, session.abort.signal);
    if (!ok) return false;

    session.status = "running";
    this.emit(session, { type: "resumed", message: "LLM 已恢復，從中斷的那一步繼續。" });
    this.emit(session, { type: "status", status: "running" });
    return true;
  }

  private emit(session: Session, event: SessionEventPayload) {
    const full = this.make(session, event, true);
    for (const subscriber of session.subscribers) {
      try {
        subscriber(full);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }

  private make(session: Session, event: SessionEventPayload, record: boolean): SessionEvent {
    const full: SessionEvent = { ...event, seq: ++session.seq, at: new Date().toISOString() };
    if (record) {
      session.events.push(full);
      if (session.events.length > EVENT_HISTORY) session.events.splice(0, session.events.length - EVENT_HISTORY);
    }
    return full;
  }
}
