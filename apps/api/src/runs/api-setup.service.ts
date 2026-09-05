import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { HttpExecutorService, type HttpActionResult, type HttpTargetConfig } from "./http-executor.service";

/** One request in the shared setup flow, plus what to capture from its response. */
export interface SetupRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}
export interface SetupCapture {
  /** The variable name; referenced elsewhere as `{{name}}`, like a credential. */
  name: string;
  /** Dotted path into the response: `body.access_token`, `status`, `headers.location`. */
  from: string;
}
export interface SetupStep {
  label: string;
  request: SetupRequest;
  captures: SetupCapture[];
}

/** Result of running the setup flow once, at the start of a run. */
export interface SetupOutcome {
  ok: boolean;
  /** name -> value; merged into the credential map so cases can use `{{name}}`. */
  captured: Record<string, string>;
  steps: {
    seq: number;
    label: string;
    request: SetupRequest;
    result: HttpActionResult;
    captured: string[];
    error?: string;
  }[];
  error?: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_STEPS = 20;

@Injectable()
export class ApiSetupService {
  private readonly log = new Logger(ApiSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly http: HttpExecutorService,
  ) {}

  async get(targetId: string, userId: string): Promise<{ steps: SetupStep[] }> {
    await this.perms.requireTarget(targetId, userId, Role.viewer);
    const row = await this.prisma.apiSetup.findUnique({ where: { targetId } });
    return { steps: (row?.steps as unknown as SetupStep[]) ?? [] };
  }

  async put(targetId: string, userId: string, steps: unknown): Promise<{ steps: SetupStep[] }> {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const target = await this.prisma.qaTarget.findUnique({ where: { id: targetId }, select: { kind: true } });
    if (!target) throw new NotFoundException("Target 不存在");
    if (target.kind !== "api") throw new BadRequestException("前置流程目前只支援 API 類型的 Target");
    const clean = normalizeSteps(steps);
    await this.prisma.apiSetup.upsert({
      where: { targetId },
      create: { targetId, steps: clean as unknown as Prisma.InputJsonValue },
      update: { steps: clean as unknown as Prisma.InputJsonValue },
    });
    return { steps: clean };
  }

  /** Read the persisted flow for a run (no permission check; caller owns the run). */
  async stepsFor(targetId: string): Promise<SetupStep[]> {
    const row = await this.prisma.apiSetup.findUnique({ where: { targetId } });
    return (row?.steps as unknown as SetupStep[]) ?? [];
  }

  /** Feature-level flow: scoped to one feature's cases. */
  async getFeature(featureId: string, userId: string): Promise<{ steps: SetupStep[] }> {
    const feature = await this.prisma.feature.findUnique({ where: { id: featureId }, select: { targetId: true } });
    if (!feature) throw new NotFoundException("Feature 不存在");
    await this.perms.requireTarget(feature.targetId, userId, Role.viewer);
    const row = await this.prisma.featureSetup.findUnique({ where: { featureId } });
    return { steps: (row?.steps as unknown as SetupStep[]) ?? [] };
  }

  async putFeature(featureId: string, userId: string, steps: unknown): Promise<{ steps: SetupStep[] }> {
    const feature = await this.prisma.feature.findUnique({ where: { id: featureId }, select: { targetId: true, target: { select: { kind: true } } } });
    if (!feature) throw new NotFoundException("Feature 不存在");
    await this.perms.requireTarget(feature.targetId, userId, Role.editor);
    if (feature.target.kind !== "api") throw new BadRequestException("前置流程目前只支援 API 類型的 Target");
    const clean = normalizeSteps(steps);
    await this.prisma.featureSetup.upsert({
      where: { featureId },
      create: { featureId, steps: clean as unknown as Prisma.InputJsonValue },
      update: { steps: clean as unknown as Prisma.InputJsonValue },
    });
    return { steps: clean };
  }

  /** Feature flow for a run (no permission check; caller owns the run). */
  async featureStepsFor(featureId: string): Promise<SetupStep[]> {
    const row = await this.prisma.featureSetup.findUnique({ where: { featureId } });
    return (row?.steps as unknown as SetupStep[]) ?? [];
  }

  /**
   * Run the setup flow once, deterministically (no LLM). Each request may use
   * `{{credential}}` and `{{captured}}` placeholders; after each request the
   * declared captures are extracted from the response and merged into the map so
   * later steps — and every case in the run — can reference them.
   */
  async run(
    steps: SetupStep[],
    config: HttpTargetConfig,
    baseCredentials: Record<string, string>,
    timeoutMs?: number,
  ): Promise<SetupOutcome> {
    const captured: Record<string, string> = {};
    const out: SetupOutcome["steps"] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const vars = { ...baseCredentials, ...captured };
      const result = await this.http.perform(step.request as unknown as Record<string, unknown>, config, vars, timeoutMs);
      const gotNames: string[] = [];
      let stepError = result.ok ? undefined : result.error ?? "請求失敗";

      if (result.ok) {
        for (const cap of step.captures) {
          const value = extractPath(result.detail, cap.from);
          if (value === undefined || value === null) {
            stepError = `擷取 \`${cap.name}\` 失敗:回應裡找不到 \`${cap.from}\``;
            break;
          }
          captured[cap.name] = typeof value === "string" ? value : JSON.stringify(value);
          gotNames.push(cap.name);
        }
      }

      out.push({ seq: i + 1, label: step.label, request: step.request, result, captured: gotNames, error: stepError });
      if (stepError) {
        this.log.warn(`setup step ${i + 1} (${step.label}) failed: ${stepError}`);
        return { ok: false, captured, steps: out, error: `前置流程第 ${i + 1} 步「${step.label}」失敗:${stepError}` };
      }
    }
    return { ok: true, captured, steps: out };
  }
}

/** Validate and canonicalize the incoming steps into a stored shape. */
function normalizeSteps(input: unknown): SetupStep[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new BadRequestException("steps 必須是陣列");
  if (input.length > MAX_STEPS) throw new BadRequestException(`前置流程最多 ${MAX_STEPS} 步`);
  const seenNames = new Set<string>();
  return input.map((raw, i) => {
    const step = raw as Record<string, unknown>;
    const label = String(step.label ?? "").trim() || `第 ${i + 1} 步`;
    const req = (step.request ?? {}) as Record<string, unknown>;
    const method = String(req.method ?? "GET").toUpperCase().trim();
    const path = String(req.path ?? req.url ?? "").trim();
    if (!path) throw new BadRequestException(`第 ${i + 1} 步缺少 path`);
    const request: SetupRequest = {
      method,
      path,
      headers: asStringMap(req.headers),
      query: asStringMap(req.query),
      body: req.body ?? undefined,
    };
    const capturesRaw = Array.isArray(step.captures) ? step.captures : [];
    const captures: SetupCapture[] = capturesRaw.map((c) => {
      const cap = c as Record<string, unknown>;
      const name = String(cap.name ?? "").trim();
      const from = String(cap.from ?? "").trim();
      if (!NAME_RE.test(name)) throw new BadRequestException(`擷取變數名稱不合法:「${name}」(只能用英數與底線,且不以數字開頭)`);
      if (seenNames.has(name)) throw new BadRequestException(`擷取變數名稱重複:「${name}」`);
      if (!from) throw new BadRequestException(`擷取變數「${name}」缺少來源路徑 from`);
      seenNames.add(name);
      return { name, from };
    });
    return { label, request, captures };
  });
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    out[k] = String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Walk a dotted path through the http result detail ({ status, headers, body }). */
export function extractPath(detail: Record<string, unknown>, path: string): unknown {
  let cur: unknown = detail;
  for (const rawKey of path.split(".")) {
    const key = rawKey.trim();
    if (!key) continue;
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}
