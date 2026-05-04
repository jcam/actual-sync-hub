import { prisma } from "../db.js";
import { verifyPassword } from "../lib/password.js";

export interface AuthService {
  authenticateUser(username: string, password: string): Promise<{ id: string; username: string } | null>;
}

export function createAuthService({
  prisma: database = prisma,
  verifyPasswordFn = verifyPassword
}: {
  prisma?: typeof prisma;
  verifyPasswordFn?: typeof verifyPassword;
} = {}): AuthService {
  return {
    async authenticateUser(username: string, password: string) {
      const user = await database.user.findUnique({
        where: {
          username
        }
      });

      if (!user) {
        return null;
      }

      const valid = await verifyPasswordFn(password, user.passwordHash);
      if (!valid) {
        return null;
      }

      return {
        id: user.id,
        username: user.username
      };
    }
  };
}

export const authService = createAuthService();
