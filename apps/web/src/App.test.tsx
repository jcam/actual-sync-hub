import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn()
}));

vi.mock("./api", () => ({
  api: {
    getSession
  }
}));

vi.mock("./routes/AccountsPage", () => ({
  AccountsPage: () => <div>Accounts Page</div>
}));
vi.mock("./routes/CategoryMappingsPage", () => ({
  CategoryMappingsPage: () => <div>Category Mappings</div>
}));
vi.mock("./routes/LoginPage", () => ({
  LoginPage: () => <div>Login Page</div>
}));
vi.mock("./routes/PlaidConnectionsPage", () => ({
  PlaidConnectionsPage: () => <div>Plaid Connections</div>
}));
vi.mock("./routes/StripeConnectionsPage", () => ({
  StripeConnectionsPage: () => <div>Stripe Connections</div>
}));
vi.mock("./routes/MonoConnectionsPage", () => ({
  MonoConnectionsPage: () => <div>Mono Connections</div>
}));
vi.mock("./routes/HomeValuesConnectionsPage", () => ({
  HomeValuesConnectionsPage: () => <div>Home Values</div>
}));
vi.mock("./routes/VehicleValuesConnectionsPage", () => ({
  VehicleValuesConnectionsPage: () => <div>Vehicle Values</div>
}));
vi.mock("./routes/ReviewPage", () => ({
  ReviewPage: () => <div>Review Page</div>
}));
vi.mock("./routes/SimpleFinConnectionsPage", () => ({
  SimpleFinConnectionsPage: () => <div>SimpleFIN Connections</div>
}));
vi.mock("./routes/TellerConnectionsPage", () => ({
  TellerConnectionsPage: () => <div>Teller Connections</div>
}));

describe("App", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a retryable startup error when the session bootstrap fails", async () => {
    const user = userEvent.setup();
    getSession.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce({
      authenticated: false
    });

    renderApp();

    expect(await screen.findByText("Could not start the app")).toBeInTheDocument();
    expect(
      screen.getByText("Could not reach the API server while loading the current session.")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Login Page")).toBeInTheDocument();
  });
});

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
}
