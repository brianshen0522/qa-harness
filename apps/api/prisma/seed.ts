import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "admin12345";
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (!existing) {
    await prisma.admin.create({ data: { email, passwordHash: await argon2.hash(password) } });
    console.log(`Created admin ${email}`);
  } else {
    console.log(`Admin ${email} already exists`);
  }
  await prisma.sandboxSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
}

main().finally(() => prisma.$disconnect());
