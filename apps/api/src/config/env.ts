import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes"].includes(v.toLowerCase());
}

export const env = {
  NODE_ENV: opt("NODE_ENV", "development"),
  PORT: Number(opt("PORT", "3001")),
  WEB_ORIGIN: opt("WEB_ORIGIN", "http://localhost:5173"),
  DATABASE_URL: req("DATABASE_URL"),
  USER_JWT_SECRET: req("USER_JWT_SECRET"),
  COOKIE_SECURE: bool("COOKIE_SECURE", false),
  CREDENTIAL_MASTER_KEY: req("CREDENTIAL_MASTER_KEY"),
  GOOGLE_CLIENT_ID: opt("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: opt("GOOGLE_CLIENT_SECRET"),
  GITHUB_CLIENT_ID: opt("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: opt("GITHUB_CLIENT_SECRET"),
  OAUTH_CALLBACK_BASE: opt("OAUTH_CALLBACK_BASE", "http://localhost:3001"),
  DEV_LOGIN_ENABLED: bool("DEV_LOGIN_ENABLED", false),
  ADMIN_EMAIL: opt("ADMIN_EMAIL"),
  ADMIN_PASSWORD: opt("ADMIN_PASSWORD"),

  // Object storage for run evidence (screenshots, HTTP logs).
  S3_ENDPOINT: opt("S3_ENDPOINT", "http://localhost:9000"),
  S3_ACCESS_KEY: opt("S3_ACCESS_KEY", "minio"),
  S3_SECRET_KEY: opt("S3_SECRET_KEY", "minio12345"),
  S3_BUCKET: opt("S3_BUCKET", "qa-harness"),
};

export const USER_COOKIE = "qa_user";
