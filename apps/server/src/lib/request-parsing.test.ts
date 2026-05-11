import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getRawRequestBodyBuffer,
  getRawRequestBodyString,
  InvalidJsonBodyError,
  parseRawJsonBody,
  parseRequestBody,
  parseRequestParams,
  serializeRequestBody
} from "./request-parsing.js";

describe("request parsing helpers", () => {
  it("parses params using the provided schema", () => {
    expect(
      parseRequestParams(z.object({
        id: z.string().min(1)
      }), {
        params: {
          id: "abc"
        }
      } as never)
    ).toEqual({
      id: "abc"
    });
  });

  it("uses an empty object fallback when the request body is nullish", () => {
    expect(
      parseRequestBody(z.object({
        label: z.string().default("default")
      }), {
        body: undefined
      } as never, {
        fallbackToEmptyObject: true
      })
    ).toEqual({
      label: "default"
    });
  });

  it("returns the raw request body string when available", () => {
    expect(getRawRequestBodyString({
      body: "payload"
    } as never)).toBe("payload");
    expect(getRawRequestBodyString({
      body: {
        ok: true
      }
    } as never)).toBe("");
  });

  it("returns a request body buffer from either a string or existing buffer", () => {
    expect(getRawRequestBodyBuffer({
      body: "payload"
    } as never).toString("utf8")).toBe("payload");

    const buffer = Buffer.from("payload", "utf8");
    expect(getRawRequestBodyBuffer({
      body: buffer
    } as never)).toBe(buffer);
  });

  it("serializes JSON request bodies with a nullish fallback", () => {
    expect(serializeRequestBody({
      body: {
        ok: true
      }
    } as never)).toBe("{\"ok\":true}");
    expect(serializeRequestBody({
      body: undefined
    } as never)).toBe("{}");
  });

  it("parses raw JSON bodies through the provided schema", () => {
    expect(
      parseRawJsonBody(z.object({
        count: z.number()
      }), "{\"count\":2}")
    ).toEqual({
      count: 2
    });
  });

  it("throws a typed error for invalid JSON input", () => {
    expect(() => parseRawJsonBody(z.object({}), "{oops")).toThrow(InvalidJsonBodyError);
  });
});
