import { CredentialType } from "@prisma/client";
import { CREDENTIAL_NAME_RE, fieldNames, refKey, refKeys, rotatableRefKey, typeLabel } from "./credentials";

describe("credential type model", () => {
  it("maps a password to a username+password pair, everything else to a single value", () => {
    expect(fieldNames(CredentialType.password)).toEqual(["username", "password"]);
    expect(fieldNames(CredentialType.api_key)).toEqual(["value"]);
    expect(fieldNames(CredentialType.other)).toEqual(["value"]);
  });

  it("references a single secret by its bare name and a login field as name.field", () => {
    expect(refKey("api_key", "value")).toBe("api_key");
    expect(refKey("member", "username")).toBe("member.username");
    expect(refKey("member", "password")).toBe("member.password");
    expect(refKeys("member", CredentialType.password)).toEqual(["member.username", "member.password"]);
    expect(refKeys("api_key", CredentialType.api_key)).toEqual(["api_key"]);
  });

  it("rotates the password of a login, or the single value otherwise (never the username)", () => {
    expect(rotatableRefKey("member", CredentialType.password)).toBe("member.password");
    expect(rotatableRefKey("api_key", CredentialType.api_key)).toBe("api_key");
  });

  it("names allow unicode but not dots (dot is the field separator)", () => {
    expect(CREDENTIAL_NAME_RE.test("一般使用者")).toBe(true);
    expect(CREDENTIAL_NAME_RE.test("member_1-a")).toBe(true);
    expect(CREDENTIAL_NAME_RE.test("member.pw")).toBe(false);
    expect(CREDENTIAL_NAME_RE.test("has space")).toBe(false);
  });

  it("labels each type in Chinese for the prompt/UI", () => {
    expect(typeLabel(CredentialType.password)).toBe("帳號密碼");
    expect(typeLabel(CredentialType.api_key)).toBe("API key");
  });
});
