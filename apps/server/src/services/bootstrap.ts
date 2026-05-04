import { prisma } from "../db.js";
import { env } from "../env.js";
import { hashPassword } from "../lib/password.js";
import { verifyPassword } from "../lib/password.js";

export async function bootstrapAdminUser() {
  const existing = await prisma.user.findUnique({
    where: {
      username: env.ADMIN_USERNAME
    }
  });

  if (!existing) {
    await prisma.user.create({
      data: {
        username: env.ADMIN_USERNAME,
        passwordHash: await hashPassword(env.ADMIN_PASSWORD)
      }
    });
    return;
  }

  const matches = await verifyPassword(env.ADMIN_PASSWORD, existing.passwordHash);
  if (!matches) {
    const latestHash = await hashPassword(env.ADMIN_PASSWORD);
    await prisma.user.update({
      where: {
        id: existing.id
      },
      data: {
        passwordHash: latestHash
      }
    });
  }
}
