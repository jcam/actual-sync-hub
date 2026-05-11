import fs from "node:fs/promises";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { ZodIssue } from "zod";
import { createAppContext } from './app-context.js';
import type { AppContext } from './app-context.js';
import { registerRoutes } from "./routes.js";

export async function createServer({
  sessionSecret,
  nodeEnv = "development",
  enableStatic = true,
  requestLoggingEnabled = nodeEnv === "development",
  context = createAppContext()
}: {
  sessionSecret: string;
  nodeEnv?: "development" | "test" | "production";
  enableStatic?: boolean;
  requestLoggingEnabled?: boolean;
  context?: AppContext;
}) {
  const app = Fastify({
    logger: requestLoggingEnabled
  });

  const formatValidationIssue = (issue: ZodIssue) => {
    const rawIssue = issue as ZodIssue & Record<string, unknown>;
    const path =
      issue.path.length > 0
        ? String(issue.path[0])
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/_/g, " ")
            .replace(/\burl\b/gi, "URL")
            .replace(/^./, value => value.toUpperCase())
        : "Request";

    if (issue.code === "invalid_type" && rawIssue.input === undefined) {
      return `${path} is required.`;
    }

    if (issue.code === "too_small" && rawIssue.origin === "string") {
      return `${path} is required.`;
    }

    if (issue.code === "invalid_format" && rawIssue.format === "url") {
      return `${path} must be a valid URL.`;
    }

    if (issue.code === "invalid_value" && Array.isArray(rawIssue.values)) {
      return `${path} must be one of ${rawIssue.values.join(", ")}.`;
    }

    if (issue.code === "too_small" && issue.path.length > 0) {
      return `${path} is required.`;
    }

    if (issue.message && issue.message !== "Invalid input") {
      return issue.message;
    }

    return `${path} is invalid.`;
  };

  const formatValidationError = (error: ZodError) => {
    const messages = [...new Set(error.issues.map(formatValidationIssue).filter(Boolean))];
    return messages[0] ?? "Invalid request.";
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: formatValidationError(error),
        issues: error.issues.map(issue => ({
          ...issue,
          message: formatValidationIssue(issue)
        }))
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
