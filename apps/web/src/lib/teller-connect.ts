import type { TellerConnectConfigDto } from "@actual-sync/shared";

export type TellerConnectSetupConfig = TellerConnectConfigDto & {
  enrollmentId?: string;
};

export type TellerEnrollmentResult = {
  accessToken: string;
  user?: {
    id?: string;
  };
  enrollment?: {
    id?: string;
    institution?: {
      name?: string;
    };
  };
}

export type TellerConnectInstance = {
  open(): void;
}

export type TellerConnectGlobal = {
  setup(config: TellerConnectSetupConfig & {
    onSuccess: (enrollment: TellerEnrollmentResult) => void | Promise<void>;
    onExit?: () => void;
    onInit?: () => void;
  }): TellerConnectInstance;
}

declare global {
  interface Window {
    TellerConnect?: TellerConnectGlobal;
  }
}

let tellerConnectLoader: Promise<TellerConnectGlobal> | null = null;

export function loadTellerConnect() {
  if (window.TellerConnect) {
    return Promise.resolve(window.TellerConnect);
  }

  if (tellerConnectLoader) {
    return tellerConnectLoader;
  }

  tellerConnectLoader = new Promise<TellerConnectGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-teller-connect="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (!window.TellerConnect) {
          reject(new Error("Teller Connect failed to initialize"));
          return;
        }
        resolve(window.TellerConnect);
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load Teller Connect")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.teller.io/connect/connect.js";
    script.async = true;
    script.dataset.tellerConnect = "true";
    script.addEventListener("load", () => {
      if (!window.TellerConnect) {
        reject(new Error("Teller Connect failed to initialize"));
        return;
      }
      resolve(window.TellerConnect);
    });
    script.addEventListener("error", () => reject(new Error("Failed to load Teller Connect")));
    document.head.appendChild(script);
  });

  return tellerConnectLoader;
}
