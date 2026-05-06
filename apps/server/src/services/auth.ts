import { prisma } from "../db.js";
import { env } from "../env.js";
import { verifyPassword } from "../lib/password.js";

export type AuthService = {
  authenticateUser(username: string, password: string): Promise<{ id: string; username: string } | null>;
  validateActualToken(token: string): Promise<boolean>;
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
    },

    async validateActualToken(token: string) {
      try {
        const response = await fetch(new URL("/account/validate", env.ACTUAL_SERVER_URL), {
          headers: {
            "X-ACTUAL-TOKEN": token
          }
        });

        if (!response.ok) {
          return false;
        }

        const body = (await response.json()) as {
          status?: string;
          reason?: string;
        };

        return body.status === "ok";
      } catch {
        return false;
      }
    }
  };
}

export const authService = createAuthService();
