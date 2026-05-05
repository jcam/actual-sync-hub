import { describe, expect, it } from "vitest";
import { ApiError, getDisplayErrorMessage } from "./errors";

describe("getDisplayErrorMessage", () => {
  it("replaces generic internal server errors with the caller fallback", () => {
    expect(getDisplayErrorMessage(new ApiError("Internal server error", 500), "Fallback message.")).toBe(
      "Fallback message."
    );
  });

  it("replaces network failures with a server unavailable message", () => {
    expect(
      getDisplayErrorMessage(new Error("Failed to fetch"), "Fallback message.", {
        serverUnavailableMessage: "Could not reach the API server."
      })
    ).toBe("Could not reach the API server.");
  });

  it("preserves specific backend error messages", () => {
    expect(getDisplayErrorMessage(new ApiError("Invalid credentials", 401), "Fallback message.")).toBe(
      "Invalid credentials"
    );
  });
});
