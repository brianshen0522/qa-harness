process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL ??= "postgresql://x";
process.env.USER_JWT_SECRET ??= "u";
process.env.ADMIN_JWT_SECRET ??= "a";
import { CryptoService } from "./crypto.service";

describe("CryptoService", () => {
  it("round-trips and produces distinct ciphertexts", () => {
    const c = new CryptoService();
    const a = c.encrypt("secret-token");
    const b = c.encrypt("secret-token");
    expect(a).not.toEqual(b);
    expect(c.decrypt(a)).toEqual("secret-token");
    expect(c.decrypt(b)).toEqual("secret-token");
  });
  it("rejects tampered ciphertext", () => {
    const c = new CryptoService();
    const enc = Buffer.from(c.encrypt("x"), "base64");
    enc[enc.length - 1] ^= 0xff;
    expect(() => c.decrypt(enc.toString("base64"))).toThrow();
  });
  it("masks secrets", () => {
    expect(CryptoService.mask("sk-abcdef")).toEqual("****cdef");
    expect(CryptoService.mask("")).toBeNull();
  });
});
