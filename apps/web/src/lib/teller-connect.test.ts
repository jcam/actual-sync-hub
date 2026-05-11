import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadTellerConnect", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete window.TellerConnect;
  });

  it("returns the existing global TellerConnect without injecting a script", async () => {
    const tellerConnect = {
      setup: vi.fn()
    };
    window.TellerConnect = tellerConnect;

    const { loadTellerConnect } = await import("./teller-connect");

    await expect(loadTellerConnect()).resolves.toBe(tellerConnect);
    expect(document.querySelector('script[data-teller-connect="true"]')).toBeNull();
  });

  it("loads the Teller script and resolves after initialization", async () => {
    const tellerConnect = {
      setup: vi.fn()
    };

    const { loadTellerConnect } = await import("./teller-connect");
    const promise = loadTellerConnect();

    const script = document.querySelector<HTMLScriptElement>('script[data-teller-connect="true"]');
    expect(script).not.toBeNull();

    window.TellerConnect = tellerConnect;
    script?.dispatchEvent(new Event("load"));

    await expect(promise).resolves.toBe(tellerConnect);
  });

  it("rejects when the Teller script loads without initializing the global", async () => {
    const { loadTellerConnect } = await import("./teller-connect");
    const promise = loadTellerConnect();

    const script = document.querySelector<HTMLScriptElement>('script[data-teller-connect="true"]');
    script?.dispatchEvent(new Event("load"));

    await expect(promise).rejects.toThrow("Teller Connect failed to initialize");
  });

  it("rejects when the Teller script fails to load", async () => {
    const { loadTellerConnect } = await import("./teller-connect");
    const promise = loadTellerConnect();

    const script = document.querySelector<HTMLScriptElement>('script[data-teller-connect="true"]');
    script?.dispatchEvent(new Event("error"));

    await expect(promise).rejects.toThrow("Failed to load Teller Connect");
  });
});
