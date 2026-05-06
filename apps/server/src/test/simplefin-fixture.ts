import http from "node:http";
import { type AddressInfo } from "node:net";

export function createSimpleFinFixtureServer() {
  let accountRequests = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/claim/demo-token") {
      res.writeHead(200, {
        "Content-Type": "text/plain"
      });
      res.end(`http://demo-user:demo-pass@127.0.0.1:${(server.address() as AddressInfo).port}`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/accounts") {
      accountRequests += 1;
      const balancesOnly = url.searchParams.get("balances-only") === "1";
      const requestedAccountIds = url.searchParams.getAll("account");
      const accounts = [
        {
          id: "acct-checking",
          conn_id: "conn-fixture",
          conn_name: "Fixture CU - Primary",
          name: "Fixture Checking",
          balance: "123.45",
          "available-balance": "120.00",
          org: {
            id: "org-fixture",
            name: "Fixture CU",
            domain: "fixture.example"
          },
          transactions: balancesOnly
            ? []
            : [
                {
                  id: "txn-fixture-1",
                  amount: "-14.20",
                  payee: "Bookstore",
                  description: "Bookstore Purchase",
                  posted: 1777804800,
                  extra: {
                    category: "shopping"
                  }
                }
              ]
        }
      ].filter(account => requestedAccountIds.length === 0 || requestedAccountIds.includes(account.id));

      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(
        JSON.stringify({
          connections: [
            {
              conn_id: "conn-fixture",
              name: "Fixture CU - Primary",
              org_id: "org-fixture",
              org_name: "Fixture CU",
              org_url: "https://fixture.example",
              sfin_url: "https://sfin.fixture.example"
            }
          ],
          accounts
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: 0, host: "127.0.0.1" }, () => {
          server.off("error", reject);
          resolve();
        });
      });

      const address = server.address() as AddressInfo;
      return {
        port: address.port,
        setupToken: Buffer.from(`http://127.0.0.1:${address.port}/claim/demo-token`).toString("base64")
      };
    },
    getAccountRequestCount() {
      return accountRequests;
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
