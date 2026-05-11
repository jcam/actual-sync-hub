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

let belvoWidgetLoader: Promise<BelvoWidgetGlobal> | null = null;

function getBelvoWindow() {
  return window as Window & {
    belvoSDK?: BelvoWidgetGlobal;
  };
}

export function loadBelvoWidget() {
  const belvoWindow = getBelvoWindow();

  if (belvoWindow.belvoSDK) {
    return Promise.resolve(belvoWindow.belvoSDK);
  }

  if (belvoWidgetLoader) {
    return belvoWidgetLoader;
  }

  belvoWidgetLoader = new Promise<BelvoWidgetGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-belvo-widget="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (!belvoWindow.belvoSDK) {
          reject(new Error("Belvo widget failed to initialize"));
          return;
        }
        resolve(belvoWindow.belvoSDK);
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load the Belvo widget")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.belvo.io/belvo-widget-1-stable.js";
    script.async = true;
    script.dataset.belvoWidget = "true";
    script.addEventListener("load", () => {
      if (!belvoWindow.belvoSDK) {
        reject(new Error("Belvo widget failed to initialize"));
        return;
      }
      resolve(belvoWindow.belvoSDK);
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
