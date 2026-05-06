import fs from "node:fs/promises";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createAppContext } from './app-context.js';
import type { AppContext } from './app-context.js';
import { registerRoutes } from "./routes.js";

export async function createServer({
  sessionSecret,
  nodeEnv = "development",
  enableStatic = true,
  context = createAppContext()
}: {
  sessionSecret: string;
  nodeEnv?: "development" | "test" | "production";
  enableStatic?: boolean;
  context?: AppContext;
}) {
  const app = Fastify({
    logger: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Invalid request",
        issues: error.issues
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: "Internal server error"
    });
  });

  await app.register(cookie);
  await app.register(fastifySession, {
    secret: sessionSecret,
    cookie: {
      secure: nodeEnv === "production",
      httpOnly: true,
      sameSite: "lax"
    },
    saveUninitialized: false
  });

  await registerRoutes(app, context);

  if (enableStatic) {
    const webDist = path.resolve(process.cwd(), "apps/web/dist");
    try {
      await fs.access(webDist);
      await app.register(fastifyStatic, {
        root: webDist,
        wildcard: false
      });

      app.get("/*", async (_request, reply) => {
        return reply.sendFile("index.html");
      });
    } catch {
      app.log.info("Web dist not found, skipping static registration");
    }
  }

  return app;
}
