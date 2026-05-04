import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import { renderWithRouter } from "../test-utils";

describe("LoginPage", () => {
  it("submits the entered credentials to onLogin", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue(undefined);

    renderWithRouter(<LoginPage onLogin={onLogin} />);

    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "jesse");
    await user.type(screen.getByLabelText("Password"), "super-secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith("jesse", "super-secret");
    });
  });

  it("shows the thrown error message when login fails", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockRejectedValue(new Error("Invalid credentials"));

    renderWithRouter(<LoginPage onLogin={onLogin} />);

    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
  });
});
