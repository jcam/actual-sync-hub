import type { ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";
import { render } from "@testing-library/react";

export function renderWithRouter(children: ReactNode) {
  return render(<BrowserRouter>{children}</BrowserRouter>);
}
