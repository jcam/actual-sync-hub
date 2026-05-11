import type { FastifyRequest } from "fastify";
import type { z } from "zod";

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

export function parseRequestParams<TSchema extends z.ZodType>(schema: TSchema, request: FastifyRequest): z.infer<TSchema> {
  return schema.parse(request.params);
}

export function parseRequestBody<TSchema extends z.ZodType>(
  schema: TSchema,
  request: FastifyRequest,
  options: { fallbackToEmptyObject?: boolean } = {}
): z.infer<TSchema> {
  const input = options.fallbackToEmptyObject && request.body == null ? {} : request.body;
  return schema.parse(input);
}

export function getRawRequestBodyString(request: FastifyRequest): string {
  return typeof request.body === "string" ? request.body : "";
}

export function getRawRequestBodyBuffer(request: FastifyRequest): Buffer {
  return Buffer.isBuffer(request.body)
    ? request.body
    : Buffer.from(typeof request.body === "string" ? request.body : "", "utf8");
}

export function serializeRequestBody(request: FastifyRequest): string {
  return JSON.stringify(request.body ?? {});
}

export function parseRawJsonBody<TSchema extends z.ZodType>(schema: TSchema, rawBody: string): z.infer<TSchema> {
  let parsed: unknown = {};

  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    throw new InvalidJsonBodyError();
  }

  return schema.parse(parsed);
}
