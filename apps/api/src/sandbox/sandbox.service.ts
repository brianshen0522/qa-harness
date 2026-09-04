import {
  BadRequestException, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit, ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ComputerService } from "./computer.service";
import { DockerService, type ContainerInspect } from "./docker.service";

export const SANDBOX_LABEL = "qa-harness.role";
export const SANDBOX_LABEL_VALUE = "sandbox";
const PURPOSE_LABEL = "qa-harness.purpose";
const CREATED_BY_LABEL = "qa-harness.created-by";
const EXPIRES_LABEL = "qa-harness.expires-at";
const RESOLUTION_LABEL = "qa-harness.resolution";

const NOVNC_PORT = "6080/tcp";
const AGENT_PORT = "8000/tcp";

export type SandboxPurpose = "admin-test" | "run";

export interface SandboxInstance {
  id: string;
  name: string;
  purpose: string;
  image: string;
  status: string;
  health: string;
  running: boolean;
  createdAt: string;
  expiresAt: string | null;
  novncPort: number | null;
  agentPort: number | null;
  /** noVNC page for the live view (loopback only). */
  viewUrl: string | null;
  createdBy: string | null;
  resolution: string | null;
}

export interface CreateSandboxOptions {
  purpose?: SandboxPurpose;
  /** Page to open in Chromium at boot. */
  startUrl?: string;
  /** Auto-reclaim after this many minutes. */
  ttlMinutes?: number;
}

@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SandboxService.name);
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly docker: DockerService,
    private readonly computer: ComputerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    // Reclaim expired containers so a forgotten test sandbox cannot hold a slot forever.
    this.sweeper = setInterval(() => {
      this.sweep().catch((err) => this.log.warn(`sweep failed: ${(err as Error).message}`));
    }, 60_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  settings() {
    return this.prisma.sandboxSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
  }

  /** Everything the admin page needs to decide whether a sandbox can be started. */
  async status() {
    const [ping, settings] = await Promise.all([this.docker.ping(), this.settings()]);
    const imagePresent = ping.ok ? await this.docker.imageExists(settings.image) : false;
    const instances = ping.ok ? await this.list() : [];
    return {
      docker: ping,
      image: { name: settings.image, present: imagePresent },
      settings,
      running: instances.filter((i) => i.running).length,
      maxConcurrent: settings.maxConcurrent,
      instances,
    };
  }

  async list(): Promise<SandboxInstance[]> {
    if (!this.docker.available) return [];
    const summaries = await this.docker.list({ [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE });
    const inspected = await Promise.all(
      summaries.map((s) => this.docker.inspect(s.Id).catch(() => null)),
    );
    return inspected.filter((i): i is ContainerInspect => !!i).map((i) => toInstance(i));
  }

  async get(id: string): Promise<SandboxInstance> {
    const inspect = await this.docker.inspect(id).catch(() => null);
    if (!inspect || inspect.Config.Labels?.[SANDBOX_LABEL] !== SANDBOX_LABEL_VALUE) {
      throw new NotFoundException("Sandbox 不存在");
    }
    return toInstance(inspect);
  }

  /** The agent port of a running, healthy sandbox. */
  async requireAgentPort(id: string): Promise<{ instance: SandboxInstance; port: number }> {
    const instance = await this.get(id);
    if (!instance.running) throw new BadRequestException("Sandbox 沒有在執行");
    if (!instance.agentPort) throw new ServiceUnavailableException("Sandbox 沒有開放 agent 連接埠");
    return { instance, port: instance.agentPort };
  }

  async create(createdBy: string, opts: CreateSandboxOptions = {}): Promise<SandboxInstance> {
    const settings = await this.settings();
    const ping = await this.docker.ping();
    if (!ping.ok) throw new ServiceUnavailableException(`Docker 無法使用：${ping.error}`);

    const existing = await this.list();
    const running = existing.filter((i) => i.running).length;
    if (running >= settings.maxConcurrent) {
      throw new BadRequestException(
        `已達並行上限（${running}/${settings.maxConcurrent}）。請先停止一個 sandbox，或在設定中提高上限。`,
      );
    }
    if (!(await this.docker.imageExists(settings.image))) {
      throw new BadRequestException(
        `找不到 image「${settings.image}」。請先建置：docker build -t ${settings.image} docker/sandbox`,
      );
    }

    const [width, height] = parseResolution(settings.resolution);
    const ttlMinutes = opts.ttlMinutes ?? 60;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const name = `qa-sandbox-${(opts.purpose ?? "admin-test").replace(/[^a-z0-9]/gi, "")}-${randomUUID().slice(0, 8)}`;

    const id = await this.docker.createContainer({
      name,
      image: settings.image,
      env: {
        SCREEN_WIDTH: String(width),
        SCREEN_HEIGHT: String(height),
        START_URL: opts.startUrl ? toSandboxUrl(opts.startUrl) : "about:blank",
      },
      labels: {
        [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE,
        [PURPOSE_LABEL]: opts.purpose ?? "admin-test",
        [CREATED_BY_LABEL]: createdBy,
        [EXPIRES_LABEL]: expiresAt,
        [RESOLUTION_LABEL]: `${width}x${height}`,
      },
      publish: [NOVNC_PORT, AGENT_PORT],
      cpus: settings.cpu,
      memoryMb: settings.memoryMb,
    });

    try {
      await this.docker.startContainer(id);
    } catch (err) {
      await this.docker.removeContainer(id);
      throw new ServiceUnavailableException(`Sandbox 啟動失敗：${(err as Error).message}`);
    }

    const instance = await this.waitUntilReady(id);
    this.log.log(`sandbox ${name} ready (novnc=${instance.novncPort} agent=${instance.agentPort})`);
    return instance;
  }

  /** Polls the container agent until it answers, so callers get a usable sandbox. */
  private async waitUntilReady(id: string, timeoutMs = 90_000): Promise<SandboxInstance> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.get(id);
    while (Date.now() < deadline) {
      last = await this.get(id);
      if (!last.running) {
        const logs = await this.docker.logs(id, 40).catch(() => "");
        await this.docker.removeContainer(id);
        throw new ServiceUnavailableException(`Sandbox 啟動後隨即結束。\n${logs.slice(-1000)}`);
      }
      if (last.agentPort) {
        const health = await this.computer.health(last.agentPort, 2000);
        if (health.ok) return last;
      }
      await sleep(1000);
    }
    throw new ServiceUnavailableException("Sandbox 在時限內沒有就緒");
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.get(id); // 404 unless it is one of ours
    await this.docker.stopContainer(id);
    await this.docker.removeContainer(id);
    return { ok: true };
  }

  async logs(id: string, tail = 200): Promise<string> {
    await this.get(id);
    return this.docker.logs(id, tail);
  }

  /** Remove expired or dead sandboxes. */
  async sweep(): Promise<number> {
    if (!this.docker.available) return 0;
    const now = Date.now();
    let removed = 0;
    for (const instance of await this.list()) {
      const expired = instance.expiresAt ? Date.parse(instance.expiresAt) < now : false;
      const dead = !instance.running && instance.status !== "created";
      if (expired || dead) {
        this.log.log(`reclaiming sandbox ${instance.name} (${expired ? "expired" : instance.status})`);
        await this.docker.removeContainer(instance.id).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }
}

function toInstance(i: ContainerInspect): SandboxInstance {
  const novncPort = DockerService.hostPort(i, NOVNC_PORT);
  const agentPort = DockerService.hostPort(i, AGENT_PORT);
  const labels = i.Config.Labels ?? {};
  return {
    id: i.Id,
    name: i.Name.replace(/^\//, ""),
    purpose: labels[PURPOSE_LABEL] ?? "admin-test",
    image: i.Config.Image,
    status: i.State.Status,
    health: i.State.Health?.Status ?? "none",
    running: i.State.Running,
    createdAt: i.Created,
    expiresAt: labels[EXPIRES_LABEL] ?? null,
    novncPort,
    agentPort,
    viewUrl: novncPort
      ? `http://127.0.0.1:${novncPort}/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1`
      : null,
    createdBy: labels[CREATED_BY_LABEL] ?? null,
    resolution: labels[RESOLUTION_LABEL] ?? null,
  };
}

/** Loopback on the host, as seen from inside a container. */
export const HOST_ALIAS = "host.docker.internal";
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

/**
 * A URL the user wrote for their own machine is rewritten so the sandbox can
 * actually reach it. Anything else is left untouched.
 */
export function toSandboxUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK.test(parsed.hostname)) return url;
    parsed.hostname = HOST_ALIAS;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseResolution(value: string): [number, number] {
  const m = /^(\d{3,5})\s*[x*]\s*(\d{3,5})$/i.exec(value.trim());
  if (!m) return [1280, 800];
  return [Number(m[1]), Number(m[2])];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
