declare module "belvo" {
  export type BelvoTransactionDirection = "INFLOW" | "OUTFLOW" | null;
  export type BelvoTransactionStatus = "PENDING" | "PROCESSED" | "UNCATEGORIZED" | null;

  export type BelvoLink = {
    id: string;
    institution?: string | null;
    external_id?: string | null;
    status?: string | null;
    access_mode?: string | null;
  };

  export type BelvoAccount = {
    id: string;
    institution?: string | null;
    name?: string | null;
    number?: string | null;
    category?: string | null;
    type?: string | null;
    subtype?: string | null;
    balance?: {
      current?: number | null;
      available?: number | null;
    } | null;
    public_identification_name?: string | null;
  };

  export type BelvoTransaction = {
    id: string;
    account?: string | { id?: string | null } | null;
    amount?: number | null;
    currency?: string | null;
    description?: string | null;
    merchant_name?: string | null;
    reference?: string | null;
    type?: BelvoTransactionDirection;
    status?: BelvoTransactionStatus;
    category?: string | null;
    subcategory?: string | null;
    accounting_date?: string | null;
    value_date?: string | null;
    collected_at?: string | null;
  };

  export type BelvoClientInstance = {
    links: {
      detail(id: string): Promise<BelvoLink>;
      delete(id: string): Promise<boolean>;
    };
    accounts: {
      retrieve(linkId: string, options?: { token?: string; saveData?: boolean }): Promise<BelvoAccount[]>;
    };
    transactions: {
      retrieve(
        linkId: string,
        dateFrom: string,
        options?: {
          account?: string;
          dateTo?: string;
          token?: string;
          saveData?: boolean;
        }
      ): Promise<BelvoTransaction[]>;
    };
    connect(): Promise<void>;
  };

  export default class BelvoClient implements BelvoClientInstance {
    constructor(secretKeyId: string, secretKeyPassword: string, url?: string | null);
    links: BelvoClientInstance["links"];
    accounts: BelvoClientInstance["accounts"];
    transactions: BelvoClientInstance["transactions"];
    connect(): Promise<void>;
  }
}
