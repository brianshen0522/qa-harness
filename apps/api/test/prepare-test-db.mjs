// Creates the test database (if missing) and applies migrations to it.
import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const main = process.env.DATABASE_URL;
if (!main) throw new Error("DATABASE_URL not set");
const testUrl = process.env.TEST_DATABASE_URL ?? main.replace(/\/qa_harness(\?|$)/, "/qa_harness_test$1");
const dbName = new URL(testUrl).pathname.slice(1);

const prisma = new PrismaClient({ datasources: { db: { url: main } } });
const exists = await prisma.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
if (!Array.isArray(exists) || exists.length === 0) {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  console.log(`created database ${dbName}`);
}
await prisma.$disconnect();

execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } });
