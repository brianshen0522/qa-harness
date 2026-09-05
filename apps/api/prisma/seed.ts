import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Admin is now a role on the user identity: seed an admin-flagged user.
  // Login is the same for everyone (OAuth/dev-login); this account just lands
  // in the admin area. No password — there is no separate admin credential.
  const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  await prisma.user.upsert({
    where: { email },
    create: { email, name: email, authProvider: "seed", isAdmin: true },
    update: { isAdmin: true },
  });
  console.log(`Ensured admin user ${email}`);

  await prisma.sandboxSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
}

main().finally(() => prisma.$disconnect());
