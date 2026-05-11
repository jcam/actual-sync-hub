declare module "@mono.co/connect.js" {
  export type MonoConnectSuccessPayload = {
    code?: string;
  };

  export type MonoConnectConfig = {
    key: string;
    scope?: string;
    data?: Record<string, unknown>;
    reference?: string;
    onSuccess: (payload: MonoConnectSuccessPayload & Record<string, unknown>) => void;
    onClose?: () => void;
    onLoad?: () => void;
    onEvent?: (eventName: string, data: Record<string, unknown>) => void;
  };

  export default class MonoConnect {
    constructor(config: MonoConnectConfig);
    setup(config?: Record<string, unknown>): void;
    reauthorise(accountId: string): void;
    open(): void;
    close(): void;
  }
}
