type StripeFinancialConnectionsAccount = {
  id: string;
};

type StripeFinancialConnectionsResult = {
  financialConnectionsSession?: {
    id: string;
    accounts?: StripeFinancialConnectionsAccount[];
    relink_result?: {
      failure_reason?: "no_account" | "no_authorization" | "other" | null;
    };
  };
};

type StripeFinancialConnectionsClient = {
  collectFinancialConnectionsAccounts(args: {
    clientSecret: string;
  }): Promise<StripeFinancialConnectionsResult>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeFinancialConnectionsClient;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadStripeScript() {
  if (window.Stripe) {
    return Promise.resolve();
  }

  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Stripe.js")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.dataset.stripeJs = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Stripe.js"));
      document.head.appendChild(script);
    });
  }

  return scriptPromise;
}

export async function loadStripeFinancialConnections(publishableKey: string) {
  await loadStripeScript();
  if (!window.Stripe) {
    throw new Error("Stripe.js did not initialize correctly.");
  }

  return window.Stripe(publishableKey);
}
