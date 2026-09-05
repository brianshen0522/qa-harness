import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmExceptionFilter } from "../src/llm/llm-exception.filter";

export async function createApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new LlmExceptionFilter());
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma };
}

export async function resetDb(prisma: PrismaService) {
  // Order matters for FKs; cascades handle the rest.
  // Dropping the settings row makes it come back with the current schema defaults.
  await prisma.sandboxSettings.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.llmConfig.deleteMany();
  // Global-scoped rows have no project to cascade from, so clear them explicitly.
  await prisma.skill.deleteMany();
  await prisma.mcpServer.deleteMany();
  await prisma.project.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
}

/** Log in via dev-login and return a cookie string for subsequent requests. */
export async function loginUser(app: INestApplication, email: string, name = email): Promise<string> {
  const res = await request(app.getHttpServer()).post("/api/auth/dev-login").send({ email, name }).expect(201);
  return extractCookie(res.headers["set-cookie"], "qa_user");
}

/** Admin is now a role on the user identity: create an admin-flagged user and log in the normal way. */
export async function loginAdmin(app: INestApplication, prisma: PrismaService, email = "admin@test.local"): Promise<string> {
  await prisma.user.upsert({
    where: { email },
    create: { email, name: email, authProvider: "seed", isAdmin: true },
    update: { isAdmin: true },
  });
  const res = await request(app.getHttpServer()).post("/api/auth/dev-login").send({ email }).expect(201);
  return extractCookie(res.headers["set-cookie"], "qa_user");
}

function extractCookie(setCookie: string | string[] | undefined, name: string): string {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = arr.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`cookie ${name} not set`);
  return hit.split(";")[0];
}

export const api = (app: INestApplication) => request(app.getHttpServer());

/**
 * Node's global fetch keeps a connection pool alive between requests, which is
 * enough to stop the test process exiting after a suite that streams responses.
 * Closing the dispatcher is a no-op on runtimes that do not expose it.
 */
export async function closeFetchPool() {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void>; destroy?: () => Promise<void> } | undefined;
  await dispatcher?.close?.().catch(() => undefined);
}
