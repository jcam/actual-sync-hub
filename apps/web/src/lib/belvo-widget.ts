import type { BelvoWidgetSessionDto } from "@actual-sync/shared";

export type BelvoWidgetCallbacks = {
  callback: (linkId: string, institution: string) => void | Promise<void>;
  onExit?: (data: unknown) => void;
  onEvent?: (data: unknown) => void;
};

export type BelvoWidgetInstance = {
  build(): void;
};

export type BelvoWidgetGlobal = {
  createWidget(accessToken: string, config: BelvoWidgetCallbacks): BelvoWidgetInstance;
};

declare global {
  interface Window {
    belvoSDK?: BelvoWidgetGlobal;
  }
}

let belvoWidgetLoader: Promise<BelvoWidgetGlobal> | null = null;

export function loadBelvoWidget() {
  if (window.belvoSDK) {
    return Promise.resolve(window.belvoSDK);
  }

  if (belvoWidgetLoader) {
    return belvoWidgetLoader;
  }

  belvoWidgetLoader = new Promise<BelvoWidgetGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-belvo-widget="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (!window.belvoSDK) {
          reject(new Error("Belvo widget failed to initialize"));
          return;
        }
        resolve(window.belvoSDK);
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load the Belvo widget")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.belvo.io/belvo-widget-1-stable.js";
    script.async = true;
    script.dataset.belvoWidget = "true";
    script.addEventListener("load", () => {
      if (!window.belvoSDK) {
        reject(new Error("Belvo widget failed to initialize"));
        return;
      }
      resolve(window.belvoSDK);
    });
    script.addEventListener("error", () => reject(new Error("Failed to load the Belvo widget")));
    document.head.appendChild(script);
  });

  return belvoWidgetLoader;
}

export async function openBelvoWidget(
  session: BelvoWidgetSessionDto,
  callbacks: BelvoWidgetCallbacks
) {
  const belvo = await loadBelvoWidget();
  belvo.createWidget(session.accessToken, callbacks).build();
}
