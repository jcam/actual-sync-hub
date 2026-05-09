import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate port"));
        return;
      }

      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServer(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401 || response.status === 403) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for Actual server at ${url}`);
}

async function bootstrapActualPassword(serverURL: string, password: string) {
  const response = await fetch(`${serverURL}/account/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | { status?: string; reason?: string }
    | null;

  if (!response.ok || payload?.status !== "ok") {
    throw new Error(`Failed to bootstrap Actual password: ${JSON.stringify(payload)}`);
  }
}

export async function startActualTestContainer({
  image = process.env.ACTUAL_TEST_IMAGE || "ghcr.io/actualbudget/actual:26.5.0-alpine",
  port: requestedPort,
  network,
  containerName: requestedContainerName,
  dataDir: requestedDataDir
}: {
  image?: string;
  port?: number;
  network?: string;
  containerName?: string;
  dataDir?: string;
} = {}) {
  const port = requestedPort ?? (await getFreePort());
  const dataDir = requestedDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "actual-live-data-")));
  const containerName =
    requestedContainerName ??
    `actual-sync-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  if (requestedDataDir) {
    await fs.mkdir(requestedDataDir, { recursive: true });
  }

  const runArgs = [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    ...(network ? ["--network", network] : []),
    "-p",
    `${port}:5006`,
    "-v",
    `${dataDir}:/data`,
    image
  ];

  await execFileAsync("docker", runArgs);

  const serverURL = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(serverURL);
  } catch (error) {
    await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    containerName,
    dataDir,
    serverURL,
    async setPassword(password: string) {
      await bootstrapActualPassword(serverURL, password);
    },
    async stop() {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}
