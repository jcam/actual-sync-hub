import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});

process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef";
process.env.ADMIN_USERNAME ??= "admin";
process.env.ADMIN_PASSWORD ??= "changeme123";
process.env.DATABASE_URL ??= "file:../data/test-bootstrap.db";
process.env.ACTUAL_SERVER_URL ??= "http://localhost:5006";
process.env.ACTUAL_SERVER_PASSWORD ??= "test-password";
process.env.ACTUAL_BUDGET_SYNC_ID ??= "test-budget";
