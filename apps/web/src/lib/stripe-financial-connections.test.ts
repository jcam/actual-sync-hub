import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadStripeFinancialConnections", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete (window as Window & { Stripe?: unknown }).Stripe;
  });

  it("returns the existing Stripe constructor without injecting a script", async () => {
    const stripeClient = {
      collectFinancialConnectionsAccounts: vi.fn()
    };
    const stripeConstructor = vi.fn().mockReturnValue(stripeClient);
    (window as Window & { Stripe?: typeof stripeConstructor }).Stripe = stripeConstructor;

    const { loadStripeFinancialConnections } = await import("./stripe-financial-connections");
    const result = await loadStripeFinancialConnections("pk_test_123");

    expect(result).toBe(stripeClient);
    expect(stripeConstructor).toHaveBeenCalledWith("pk_test_123");
    expect(document.querySelector('script[data-stripe-js="true"]')).toBeNull();
  });

  it("loads Stripe.js and resolves after the script initializes", async () => {
    const stripeClient = {
      collectFinancialConnectionsAccounts: vi.fn()
    };
    const stripeConstructor = vi.fn().mockReturnValue(stripeClient);

    const { loadStripeFinancialConnections } = await import("./stripe-financial-connections");
    const promise = loadStripeFinancialConnections("pk_test_123");

    const script = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');
    expect(script).not.toBeNull();

    (window as Window & { Stripe?: typeof stripeConstructor }).Stripe = stripeConstructor;
    script?.onload?.(new Event("load"));

    await expect(promise).resolves.toBe(stripeClient);
    expect(stripeConstructor).toHaveBeenCalledWith("pk_test_123");
  });

  it("rejects when Stripe.js loads but does not initialize the global", async () => {
    const { loadStripeFinancialConnections } = await import("./stripe-financial-connections");
    const promise = loadStripeFinancialConnections("pk_test_123");

    const script = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');
    script?.onload?.(new Event("load"));

    await expect(promise).rejects.toThrow("Stripe.js did not initialize correctly.");
  });

  it("rejects when the Stripe.js script errors", async () => {
    const { loadStripeFinancialConnections } = await import("./stripe-financial-connections");
    const promise = loadStripeFinancialConnections("pk_test_123");

    const script = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');
    script?.onerror?.(new Event("error"));

    await expect(promise).rejects.toThrow("Failed to load Stripe.js");
  });
});
