import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";

export interface DockerPortBinding {
  HostIp: string;
  HostPort: string;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    StartedAt: string;
    Health?: { Status: string; FailingStreak: number };
  };
  Config: { Image: string; Labels: Record<string, string> };
  NetworkSettings: { Ports: Record<string, DockerPortBinding[] | null> };
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
}

export interface CreateContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Container ports to publish on an ephemeral host port, e.g. ["6080/tcp", "8000/tcp"]. */
  publish: string[];
  cpus: number;
  memoryMb: number;
  shmSizeMb?: number;
}

const SOCKET_CANDIDATES = [
  process.env.DOCKER_SOCKET,
  "/var/run/docker.sock",
  `${process.env.HOME}/.orbstack/run/docker.sock`,
  `${process.env.HOME}/.docker/run/docker.sock`,
  `${process.env.HOME}/.colima/default/docker.sock`,
].filter(Boolean) as string[];

/** Minimal Docker Engine API client over the unix socket (no extra dependency). */
@Injectable()
export class DockerService {
  private readonly log = new Logger(DockerService.name);
  private readonly socketPath: string | null;

  constructor() {
    this.socketPath = SOCKET_CANDIDATES.find((p) => existsSync(p)) ?? null;
    if (!this.socketPath) this.log.warn(`No Docker socket found. Tried: ${SOCKET_CANDIDATES.join(", ")}`);
    else this.log.log(`Docker socket: ${this.socketPath}`);
  }

  get available(): boolean {
    return !!this.socketPath;
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (!this.socketPath) return { ok: false, error: "找不到 Docker socket" };
    try {
      const v = await this.call<{ Version: string; Os: string; Arch: string }>("GET", "/version");
      return { ok: true, version: `${v.Version} (${v.Os}/${v.Arch})` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.call("GET", `/images/${encodeURIComponent(image)}/json`);
      return true;
    } catch {
      return false;
    }
  }

  /** Pull an image. Resolves when the stream ends; rejects if the daemon reports an error. */
  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const [name, tag] = splitImage(image);
    const { body } = await this.raw(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    );
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      let evt: { error?: string; status?: string };
      try {
        evt = JSON.parse(line) as { error?: string; status?: string };
      } catch {
        continue;
      }
      if (evt.error) throw new Error(evt.error);
      if (evt.status && onProgress) onProgress(evt.status);
    }
  }

  async createContainer(spec: CreateContainerSpec): Promise<string> {
    const exposed: Record<string, object> = {};
    const bindings: Record<string, DockerPortBinding[]> = {};
    for (const port of spec.publish) {
      exposed[port] = {};
      // Empty HostPort lets Docker allocate a free one; bound to loopback only.
      bindings[port] = [{ HostIp: "127.0.0.1", HostPort: "" }];
    }
    const res = await this.call<{ Id: string; Warnings?: string[] }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      {
        Image: spec.image,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        Labels: spec.labels,
        ExposedPorts: exposed,
        HostConfig: {
          PortBindings: bindings,
          NanoCpus: Math.round(spec.cpus * 1e9),
          Memory: spec.memoryMb * 1024 * 1024,
          ShmSize: (spec.shmSizeMb ?? 1024) * 1024 * 1024,
          AutoRemove: false,
          RestartPolicy: { Name: "no" },
        },
      },
    );
    return res.Id;
  }

  startContainer(id: string) {
    return this.call("POST", `/containers/${id}/start`);
  }

  async stopContainer(id: string, timeoutSec = 5) {
    try {
      await this.call("POST", `/containers/${id}/stop?t=${timeoutSec}`);
    } catch (err) {
      // 304 means it was already stopped.
      if (!/-> 304/.test((err as Error).message)) throw err;
    }
  }

  async removeContainer(id: string, force = true) {
    try {
      await this.call("DELETE", `/containers/${id}?force=${force}&v=true`);
    } catch (err) {
      if (!/-> 404/.test((err as Error).message)) throw err;
    }
  }

  inspect(id: string) {
    return this.call<ContainerInspect>("GET", `/containers/${id}/json`);
  }

  list(labelFilter: Record<string, string>): Promise<ContainerSummary[]> {
    const label = Object.entries(labelFilter).map(([k, v]) => `${k}=${v}`);
    const filters = encodeURIComponent(JSON.stringify({ label }));
    return this.call<ContainerSummary[]>("GET", `/containers/json?all=true&filters=${filters}`);
  }

  async logs(id: string, tail = 200): Promise<string> {
    const { bodyBuffer } = await this.rawBuffer(
      "GET",
      `/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}`,
    );
    return demultiplexDockerStream(bodyBuffer);
  }

  /** Host port that a container port was published on, e.g. "6080/tcp" gives 51234. */
  static hostPort(inspect: ContainerInspect, containerPort: string): number | null {
    const binding = inspect.NetworkSettings?.Ports?.[containerPort];
    const port = binding?.[0]?.HostPort;
    return port ? Number(port) : null;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: text } = await this.raw(method, path, body);
    if (status >= 400) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* keep the raw text */
      }
      throw new Error(`Docker ${method} ${path} -> ${status}: ${message.slice(0, 300)}`);
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async raw(method: string, path: string, body?: unknown) {
    const { status, bodyBuffer } = await this.rawBuffer(method, path, body);
    return { status, body: bodyBuffer.toString("utf8") };
  }

  private rawBuffer(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; bodyBuffer: Buffer }> {
    if (!this.socketPath) {
      throw new ServiceUnavailableException(
        "找不到 Docker socket，無法管理 sandbox。請確認 Docker 正在執行，或設定 DOCKER_SOCKET。",
      );
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath!,
          path: `/v1.43${path}`,
          method,
          headers: {
            host: "docker",
            ...(payload
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
          timeout: 300_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, bodyBuffer: Buffer.concat(chunks) }));
        },
      );
      req.on("error", (err) => reject(new Error(`Docker socket error: ${err.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Docker request timed out"));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function splitImage(image: string): [string, string] {
  const at = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  if (at > slash) return [image.slice(0, at), image.slice(at + 1)];
  return [image, "latest"];
}

/**
 * Container logs come back as frames of an 8-byte header followed by the payload,
 * unless the container was started with a TTY (then it is plain text).
 */
export function demultiplexDockerStream(buf: Buffer): string {
  const out: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    // A real frame header has a stream type of 0-2 and three zero bytes after it.
    if (streamType > 2 || buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) {
      return buf.toString("utf8");
    }
    const size = buf.readUInt32BE(offset + 4);
    out.push(buf.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  return out.join("");
}
