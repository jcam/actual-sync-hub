import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BelvoLinkPanel } from "./BelvoLinkPanel";

const apiMocks = vi.hoisted(() => ({
  createBelvoConnectSession: vi.fn(),
  finalizeBelvoConnection: vi.fn()
}));

const belvoMocks = vi.hoisted(() => ({
  openBelvoWidget: vi.fn()
}));

vi.mock("../api", () => ({
  api: apiMocks
}));

vi.mock("../lib/belvo-widget", () => ({
  openBelvoWidget: belvoMocks.openBelvoWidget
}));

describe("BelvoLinkPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches Belvo Connect and finalizes the returned link", async () => {
    apiMocks.createBelvoConnectSession.mockResolvedValue({
      accessToken: "belvo-widget-token"
    });
    apiMocks.finalizeBelvoConnection.mockResolvedValue({
      connectionId: "conn-belvo-1",
      warning: "Belvo connected the link, but account data is still loading. Refresh the connection in a moment."
    });
    belvoMocks.openBelvoWidget.mockImplementation(async (_session, config) => {
      await config.callback("belvo-link-123", "Erebor");
    });
    const onConnected = vi.fn().mockResolvedValue(undefined);

    render(<BelvoLinkPanel enabled onConnected={onConnected} />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Connection label/i), "Household Belvo");
    await user.click(screen.getByRole("button", { name: /launch belvo connect/i }));

    await waitFor(() => {
      expect(apiMocks.createBelvoConnectSession).toHaveBeenCalledOnce();
      expect(apiMocks.finalizeBelvoConnection).toHaveBeenCalledWith("belvo-link-123", "Household Belvo");
      expect(onConnected).toHaveBeenCalledOnce();
    });

    expect(await screen.findByText(/Belvo connection saved\./i)).toBeInTheDocument();
  });

  it("surfaces widget event and exit errors", async () => {
    apiMocks.createBelvoConnectSession.mockResolvedValue({
      accessToken: "belvo-widget-token"
    });
    belvoMocks.openBelvoWidget.mockImplementation(async (_session, config) => {
      config.onEvent?.({
        message: "Belvo widget event failure"
      });
      config.onExit?.({
        data: [
          {
            last_encountered_error: {
              message: "Belvo widget exit failure"
            }
          }
        ]
      });
    });

    render(<BelvoLinkPanel enabled onConnected={vi.fn().mockResolvedValue(undefined)} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /launch belvo connect/i }));

    expect(await screen.findByText(/Belvo widget exit failure/i)).toBeInTheDocument();
  });

  it("shows a disabled-state hint when Belvo credentials are missing", () => {
    render(<BelvoLinkPanel enabled={false} onConnected={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByText(/Save a Belvo secret ID and secret password first\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /launch belvo connect/i })).toBeDisabled();
  });
});
