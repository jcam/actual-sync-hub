import { afterEach, describe, expect, it, vi } from "vitest";

describe("belvo-widget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete window.belvoSDK;
    document.head.querySelectorAll('script[data-belvo-widget="true"]').forEach(node => node.remove());
  });

  it("uses an already-loaded Belvo widget global", async () => {
    const build = vi.fn();
    window.belvoSDK = {
      createWidget: vi.fn().mockReturnValue({
        build
      })
    };

    const { openBelvoWidget } = await import("./belvo-widget");
    await openBelvoWidget(
      {
        accessToken: "widget-token"
      },
      {
        callback: vi.fn()
      }
    );

    expect(window.belvoSDK.createWidget).toHaveBeenCalledWith("widget-token", {
      callback: expect.any(Function)
    });
    expect(build).toHaveBeenCalledOnce();
  });

  it("loads the widget script when Belvo is not already present", async () => {
    const sdk = {
      createWidget: vi.fn().mockReturnValue({
        build: vi.fn()
      })
    };
    const appendSpy = vi.spyOn(document.head, "appendChild").mockImplementation(node => {
      setTimeout(() => {
        window.belvoSDK = sdk;
        node.dispatchEvent(new Event("load"));
      }, 0);
      return node;
    });

    const { loadBelvoWidget } = await import("./belvo-widget");
    const loaded = await loadBelvoWidget();

    expect(loaded).toBe(sdk);
    expect(appendSpy).toHaveBeenCalledOnce();
    const script = appendSpy.mock.calls[0]?.[0] as HTMLScriptElement | undefined;
    expect(script?.dataset.belvoWidget).toBe("true");
    expect(script?.src).toBe("https://cdn.belvo.io/belvo-widget-1-stable.js");
  });
});
