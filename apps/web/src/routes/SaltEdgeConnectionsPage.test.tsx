import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaltEdgeConnectionsPage } from "./SaltEdgeConnectionsPage";
import { renderWithRouter } from "../test-utils";

const { listConnections, getRuntimeInfo, createSaltEdgeConnectSession } = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getRuntimeInfo: vi.fn(),
  createSaltEdgeConnectSession: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    listConnections,
    getRuntimeInfo,
    createSaltEdgeConnectSession
  }
}));

vi.mock("../components/ProviderReadinessPanel", () => ({
  ProviderReadinessPanel: () => null
}));

vi.mock("../components/ProviderSettingsPanel", () => ({
  ProviderSettingsPanel: () => null
}));

vi.mock("../components/SaltEdgeConnectionCard", () => ({
  SaltEdgeConnectionCard: () => null
}));

describe("SaltEdgeConnectionsPage", () => {
  const popupState = {
    closed: false
  };
  const popup = {
    get closed() {
      return popupState.closed;
    },
    close: vi.fn(() => {
      popupState.closed = true;
    }),
    focus: vi.fn(),
    location: {
      href: ""
    }
  } as unknown as Window;

  beforeEach(() => {
    listConnections.mockResolvedValue([]);
    getRuntimeInfo.mockResolvedValue({
      instanceLabel: "Dev",
      providers: [
        {
          provider: "SALT_EDGE",
          label: "Salt Edge",
          enabled: true,
          ready: true,
          environment: "sandbox",
          issues: [],
          notes: []
        }
      ],
      settings: {
        SALT_EDGE: {
          appId: "",
          secret: "",
          environment: "sandbox",
          consentDays: 90,
          automaticRefresh: true
        }
      },
      saltEdge: {
        enabled: true,
        environment: "sandbox",
        includeSandboxes: true
      }
    });
    createSaltEdgeConnectSession.mockResolvedValue({
      connectUrl: "https://www.saltedge.com/connect/session-1",
      expiresAt: "2026-05-08T12:00:00.000Z",
      customerId: "customer-1"
    });
    popupState.closed = false;
    popup.close = vi.fn(() => {
      popupState.closed = true;
    });
    popup.focus = vi.fn();
    popup.location.href = "";
    vi.spyOn(window, "open").mockReturnValue(popup);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("opens Salt Edge connect in a separate window", async () => {
    const user = userEvent.setup();

    renderWithRouter(<SaltEdgeConnectionsPage />);

    await user.click(await screen.findByRole("button", { name: /start salt edge connect/i }));

    await waitFor(() => {
      expect(createSaltEdgeConnectSession).toHaveBeenCalledWith(undefined);
    });

    expect(window.open).toHaveBeenCalledWith(
      "",
      "_blank",
      "popup,width=540,height=760,resizable=yes,scrollbars=yes"
    );
    expect(popup.location.href).toBe("https://www.saltedge.com/connect/session-1");
    expect(screen.getByText(/opened in a separate window/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/salt edge connect/i)).not.toBeInTheDocument();
  });
});
