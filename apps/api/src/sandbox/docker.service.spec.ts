import { demultiplexDockerStream, DockerService, type ContainerInspect } from "./docker.service";
import { parseResolution, toSandboxUrl } from "./sandbox.service";

function frame(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demultiplexDockerStream", () => {
  it("joins stdout and stderr frames in order", () => {
    const buf = Buffer.concat([frame(1, "starting Xvfb\n"), frame(2, "warn: no audio\n"), frame(1, "ready\n")]);
    expect(demultiplexDockerStream(buf)).toBe("starting Xvfb\nwarn: no audio\nready\n");
  });

  it("passes through plain output from a TTY container", () => {
    expect(demultiplexDockerStream(Buffer.from("plain log line\n"))).toBe("plain log line\n");
  });

  it("handles an empty body and a partial trailing frame", () => {
    expect(demultiplexDockerStream(Buffer.alloc(0))).toBe("");
    const partial = Buffer.concat([frame(1, "complete\n"), Buffer.from([1, 0, 0, 0])]);
    expect(demultiplexDockerStream(partial)).toBe("complete\n");
  });
});

describe("DockerService.hostPort", () => {
  const inspect = {
    NetworkSettings: {
      Ports: {
        "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32768" }],
        "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "32769" }],
        "5900/tcp": null,
      },
    },
  } as unknown as ContainerInspect;

  it("reads the published host port", () => {
    expect(DockerService.hostPort(inspect, "6080/tcp")).toBe(32768);
    expect(DockerService.hostPort(inspect, "8000/tcp")).toBe(32769);
  });

  it("returns null for unpublished or unknown ports", () => {
    expect(DockerService.hostPort(inspect, "5900/tcp")).toBeNull();
    expect(DockerService.hostPort(inspect, "9999/tcp")).toBeNull();
  });
});

describe("parseResolution", () => {
  it("parses the configured resolution", () => {
    expect(parseResolution("1920x1080")).toEqual([1920, 1080]);
    expect(parseResolution(" 1280 x 800 ")).toEqual([1280, 800]);
  });

  it("falls back to 1280x800 on anything unusable", () => {
    for (const bad of ["", "big", "1280", "12x8", "abcxdef"]) {
      expect(parseResolution(bad)).toEqual([1280, 800]);
    }
  });
});

describe("toSandboxUrl", () => {
  it("points loopback at the host, which is what the user meant", () => {
    expect(toSandboxUrl("http://localhost:3000/login")).toBe("http://host.docker.internal:3000/login");
    expect(toSandboxUrl("http://127.0.0.1:8080")).toBe("http://host.docker.internal:8080/");
    expect(toSandboxUrl("https://0.0.0.0:443/x")).toBe("https://host.docker.internal/x");
  });

  it("leaves a real host and anything unparseable alone", () => {
    expect(toSandboxUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(toSandboxUrl("http://192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
    expect(toSandboxUrl("not a url")).toBe("not a url");
  });
});
