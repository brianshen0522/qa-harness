import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

/**
 * AES-256-GCM envelope for credentials / API keys.
 * Ciphertext format: base64( iv[12] | tag[16] | data )
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor() {
    const raw = Buffer.from(env.CREDENTIAL_MASTER_KEY, "base64");
    if (raw.length !== 32) {
      throw new Error("CREDENTIAL_MASTER_KEY must be 32 bytes base64 (openssl rand -base64 32)");
    }
    this.key = raw;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]).toString("base64");
  }

  decrypt(encoded: string): string {
    const buf = Buffer.from(encoded, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  /** Show only the tail of a secret for display. */
  static mask(secret: string | null | undefined): string | null {
    if (!secret) return null;
    return secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
  }
}
