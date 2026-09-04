import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  CreateBucketCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { env } from "../config/env";

export interface StoredEvidence {
  key: string;
  bytes: number;
}

/**
 * Screenshots, HTTP logs and anything else a verdict rests on (§4.7, §6.3).
 * Stored in S3-compatible object storage so evidence survives the container
 * that produced it and can be cleaned up by retention.
 */
@Injectable()
export class EvidenceService implements OnModuleInit {
  private readonly log = new Logger(EvidenceService.name);
  private readonly client: S3Client;
  private readonly bucket = env.S3_BUCKET;
  private ready = false;

  constructor() {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: "us-east-1",
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      // MinIO serves buckets as a path, not a subdomain.
      forcePathStyle: true,
    });
  }

  async onModuleInit() {
    await this.ensureBucket();
  }

  get available(): boolean {
    return this.ready;
  }

  private async ensureBucket(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.ready = true;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.ready = true;
        this.log.log(`created evidence bucket ${this.bucket}`);
      } catch (err) {
        this.log.warn(
          `object storage unavailable (${(err as Error).message}); evidence will not be stored`,
        );
        this.ready = false;
      }
    }
    return this.ready;
  }

  /**
   * Store a screenshot. Returns null rather than throwing when storage is down:
   * losing a screenshot must never take a whole run with it.
   */
  async putScreenshot(runId: string, caseId: string | null, seq: number, base64: string): Promise<StoredEvidence | null> {
    const key = `runs/${runId}/${caseId ?? "run"}/${String(seq).padStart(4, "0")}.png`;
    return this.put(key, Buffer.from(base64, "base64"), "image/png");
  }

  /** The screen recording for one case (§4.7 錄影). */
  async putVideo(runId: string, caseId: string, body: Buffer): Promise<StoredEvidence | null> {
    return this.put(`runs/${runId}/${caseId}/recording.mp4`, body, "video/mp4");
  }

  async putJson(runId: string, name: string, value: unknown): Promise<StoredEvidence | null> {
    const key = `runs/${runId}/${name}.json`;
    return this.put(key, Buffer.from(JSON.stringify(value, null, 2)), "application/json");
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredEvidence | null> {
    if (!(await this.ensureBucket())) return null;
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
      );
      return { key, bytes: body.byteLength };
    } catch (err) {
      this.log.warn(`failed to store ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Streams an object back for the results page. */
  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!(await this.ensureBucket())) return null;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return { body: Buffer.concat(chunks), contentType: res.ContentType ?? "application/octet-stream" };
    } catch (err) {
      this.log.warn(`failed to read ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Delete every object for a run, used by retention cleanup. */
  async deleteRun(runId: string): Promise<number> {
    if (!(await this.ensureBucket())) return 0;
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `runs/${runId}/`, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        deleted += keys.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}
