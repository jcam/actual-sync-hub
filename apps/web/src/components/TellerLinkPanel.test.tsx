import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TellerLinkPanel } from "./TellerLinkPanel";

const { getTellerConnectConfig, enrollTellerConnection, refreshAllConnections, seedTellerSandboxConnection, reuseCachedTellerConnection } = vi.hoisted(() => ({
  getTellerConnectConfig: vi.fn(),
  enrollTellerConnection: vi.fn(),
  refreshAllConnections: vi.fn(),
  seedTellerSandboxConnection: vi.fn(),
  reuseCachedTellerConnection: vi.fn()
}));

const { loadTellerConnect } = vi.hoisted(() => ({
  loadTellerConnect: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    getTellerConnectConfig,
    enrollTellerConnection,
    refreshAllConnections,
    seedTellerSandboxConnection,
    reuseCachedTellerConnection
  }
}));

vi.mock("../lib/teller-connect", () => ({
  loadTellerConnect
}));

describe("TellerLinkPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches Teller Connect and persists the successful enrollment", async () => {
    getTellerConnectConfig.mockResolvedValue({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });
    enrollTellerConnection.mockResolvedValue({
      connectionId: "conn-teller-1"
    });

    loadTellerConnect.mockResolvedValue({
      setup: vi.fn(config => ({
        open: () => {
          void config.onSuccess({
            accessToken: "test_token_123",
            user: {
              id: "usr_123"
            },
            enrollment: {
              id: "enr_123",
              institution: {
                name: "Security Credit Union"
              }
            }
          });
        }
      }))
    });

    const onConnected = vi.fn().mockResolvedValue(undefined);
    render(
      <TellerLinkPanel enabled mtlsConfigured={false} onConnected={onConnected} onRefreshAll={vi.fn()} />
    );

    const user = userEvent.setup();
    await waitFor(() => {
      expect(getTellerConnectConfig).toHaveBeenCalledOnce();
    });

    await user.click(screen.getByRole("button", { name: /launch teller connect/i }));

    await waitFor(() => {
      expect(enrollTellerConnection).toHaveBeenCalledWith({
        accessToken: "test_token_123",
        enrollmentId: "enr_123",
        userId: "usr_123",
        institutionName: "Security Credit Union"
      });
      expect(onConnected).toHaveBeenCalledOnce();
    });
  });

  it("seeds a Teller sandbox connection without opening the iframe", async () => {
    getTellerConnectConfig.mockResolvedValue({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });
    seedTellerSandboxConnection.mockResolvedValue({
      connectionId: "conn-teller-seeded"
    });

    const onConnected = vi.fn().mockResolvedValue(undefined);
    render(
      <TellerLinkPanel enabled mtlsConfigured={false} onConnected={onConnected} onRefreshAll={vi.fn()} />
    );

    const user = userEvent.setup();
    await waitFor(() => {
      expect(getTellerConnectConfig).toHaveBeenCalledOnce();
    });

    await user.click(screen.getByRole("button", { name: /seed teller sandbox connection/i }));

    await waitFor(() => {
      expect(seedTellerSandboxConnection).toHaveBeenCalledOnce();
      expect(onConnected).toHaveBeenCalledOnce();
    });
    expect(loadTellerConnect).not.toHaveBeenCalled();
  });

  it("shows a friendly error when Teller Connect config cannot be loaded", async () => {
    getTellerConnectConfig.mockRejectedValue(new Error("Failed to fetch"));

    render(
      <TellerLinkPanel enabled mtlsConfigured={false} onConnected={vi.fn()} onRefreshAll={vi.fn()} />
    );

    expect(
      await screen.findByText("Could not reach the API server to load Teller Connect.")
    ).toBeInTheDocument();
  });

  it("reuses a cached Teller fixture without opening Connect", async () => {
    getTellerConnectConfig.mockResolvedValue({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });
    reuseCachedTellerConnection.mockResolvedValue({
      connectionId: "conn-teller-cached"
    });

    const onConnected = vi.fn().mockResolvedValue(undefined);
    render(
      <TellerLinkPanel enabled mtlsConfigured={false} onConnected={onConnected} onRefreshAll={vi.fn()} />
    );

    const user = userEvent.setup();
    await waitFor(() => {
      expect(getTellerConnectConfig).toHaveBeenCalledOnce();
    });

    await user.click(screen.getByRole("button", { name: /reuse cached teller fixture/i }));

    await waitFor(() => {
      expect(reuseCachedTellerConnection).toHaveBeenCalledOnce();
      expect(onConnected).toHaveBeenCalledOnce();
    });
    expect(loadTellerConnect).not.toHaveBeenCalled();
  });
});
