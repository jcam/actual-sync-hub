import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaidLinkPanel } from "./PlaidLinkPanel";

const {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  refreshAllConnections,
  seedPlaidSandboxConnection
} = vi.hoisted(() => ({
  createPlaidLinkToken: vi.fn(),
  exchangePlaidPublicToken: vi.fn(),
  refreshAllConnections: vi.fn(),
  seedPlaidSandboxConnection: vi.fn()
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({
    ready: true,
    open: vi.fn()
  })
}));

vi.mock("../api", () => ({
  api: {
    createPlaidLinkToken,
    exchangePlaidPublicToken,
    refreshAllConnections,
    seedPlaidSandboxConnection
  }
}));

describe("PlaidLinkPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a friendly error when Plaid Link setup cannot be loaded", async () => {
    createPlaidLinkToken.mockRejectedValue(new Error("Failed to fetch"));

    render(
      <PlaidLinkPanel
        sandboxToolsEnabled={false}
        onConnected={vi.fn().mockResolvedValue(undefined)}
        onRefreshAll={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      await screen.findByText("Could not reach the API server to prepare Plaid Link.")
    ).toBeInTheDocument();
  });

  it("shows a friendly error when refreshing Plaid connections fails", async () => {
    createPlaidLinkToken.mockResolvedValue({
      linkToken: "link-token"
    });
    refreshAllConnections.mockRejectedValue(new Error("Failed to fetch"));

    render(
      <PlaidLinkPanel
        sandboxToolsEnabled={false}
        onConnected={vi.fn().mockResolvedValue(undefined)}
        onRefreshAll={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      expect(createPlaidLinkToken).toHaveBeenCalledOnce();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh all Plaid accounts" }));

    expect(
      await screen.findByText("Could not reach the API server to refresh Plaid connections.")
    ).toBeInTheDocument();
  });
});
