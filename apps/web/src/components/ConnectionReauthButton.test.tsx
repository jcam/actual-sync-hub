import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionReauthButton } from "./ConnectionReauthButton";
import { renderWithRouter } from "../test-utils";

const { createConnectionReauthSession } = vi.hoisted(() => ({
  createConnectionReauthSession: vi.fn()
}));

vi.mock("../api", () => ({
  api: {
    createConnectionReauthSession
  }
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({
    ready: false,
    open: vi.fn()
  })
}));

describe("ConnectionReauthButton", () => {
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
    createConnectionReauthSession.mockResolvedValue({
      provider: "SALT_EDGE",
      connectionId: "conn-1",
      mode: "saltedge_connect",
      connectUrl: "https://www.saltedge.com/connect/reconnect-1"
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

  it("opens Salt Edge reauthentication in a separate window", async () => {
    const user = userEvent.setup();

    renderWithRouter(<ConnectionReauthButton connectionId="conn-1" provider="SALT_EDGE" />);

    await user.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(createConnectionReauthSession).toHaveBeenCalledWith("conn-1");
    });

    expect(window.open).toHaveBeenCalledWith(
      "",
      "_blank",
      "popup,width=540,height=760,resizable=yes,scrollbars=yes"
    );
    expect(popup.location.href).toBe("https://www.saltedge.com/connect/reconnect-1");
    expect(screen.getByText(/reauthentication is open in a separate window/i)).toBeInTheDocument();
  });
});
