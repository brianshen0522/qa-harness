import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";
import * as argon2 from "argon2";
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
  await prisma.auditLog.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.llmConfig.deleteMany();
  await prisma.project.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.admin.deleteMany();
}

/** Log in via dev-login and return a cookie string for subsequent requests. */
export async function loginUser(app: INestApplication, email: string, name = email): Promise<string> {
  const res = await request(app.getHttpServer()).post("/api/auth/dev-login").send({ email, name }).expect(201);
  return extractCookie(res.headers["set-cookie"], "qa_user");
}

export async function loginAdmin(app: INestApplication, prisma: PrismaService, email = "admin@test.local", password = "pw-admin-1"): Promise<string> {
  await prisma.admin.upsert({
    where: { email },
    create: { email, passwordHash: await argon2.hash(password) },
    update: {},
  });
  const res = await request(app.getHttpServer()).post("/api/admin/auth/login").send({ email, password }).expect(201);
  return extractCookie(res.headers["set-cookie"], "qa_admin");
}

function extractCookie(setCookie: string | string[] | undefined, name: string): string {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = arr.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`cookie ${name} not set`);
  return hit.split(";")[0];
}

export const api = (app: INestApplication) => request(app.getHttpServer());
