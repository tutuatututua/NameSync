import http from "node:http";

export interface Hit {
  url: string;
  contentType: string | undefined;
  bodyLength: number;
  body: string;
  /** Lower-cased, as Node delivers them. `x-comparison-id` tells the external workflow which
   *  run to write its results into, so it is part of the contract and worth asserting. */
  headers: Record<string, string | string[] | undefined>;
}

export interface MockServer {
  /** `compare` stays, and stays empty: the tests assert the comparison triggers nothing. */
  state: {
    company: Hit[];
    facebook: Hit[];
    compare: Hit[];
    /** Reject the next request. Lets a test drive the "the workflow never got the file" path,
     *  where the run has to fail rather than wait forever on work nobody is doing. */
    failNext: boolean;
  };
  close: () => Promise<void>;
}

/** Stand-in for the external ingestion webhooks (/:id/send-webhook). */
export function startMockWebhook(port: number): Promise<MockServer> {
  const state = {
    company: [] as Hit[],
    facebook: [] as Hit[],
    compare: [] as Hit[],
    failNext: false,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const hit: Hit = {
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        bodyLength: body.length,
        body,
        headers: req.headers,
      };
      if (req.url === "/company") state.company.push(hit);
      else if (req.url === "/facebook") state.facebook.push(hit);
      else if (req.url === "/compare") state.compare.push(hit);

      if (state.failNext) {
        state.failNext = false;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const handle: MockServer = {
    state,
    // `closeAllConnections` first, because `close` alone stops only NEW connections and then waits
    // for the live ones to end — and Node's fetch keeps sockets alive, so the callback can hang
    // well past the end of the file that opened it.
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };

  /**
   * Bind, and keep trying briefly if the port is still held.
   *
   * Every integration file starts one of these on the same port (`MOCK_PORT`), because `setup.ts`
   * points both webhook URLs at it before any module is imported. Files run one at a time
   * (`fileParallelism: false`) — but in SEPARATE FORKS, and a fork that has finished its last test
   * is not necessarily a fork the OS has finished reclaiming sockets from. So the next file can
   * reach `listen()` while 8199 is still held by a process on its way out.
   *
   * It used to resolve only from the `listening` callback with no `error` handler at all, which
   * turned that race into the worst possible symptom: the promise never settled, `beforeAll` sat
   * there until the 30s hook timeout, the suite was reported as failing to start, and the actual
   * EADDRINUSE arrived separately as an unhandled error blamed on whichever file was unlucky. A
   * short retry absorbs the handover; anything that survives it rejects immediately and says why.
   */
  const ATTEMPTS = 20;
  const RETRY_MS = 100;

  return new Promise((resolve, reject) => {
    let left = ATTEMPTS;

    const attempt = (): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && --left > 0) {
          setTimeout(attempt, RETRY_MS);
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        // Drop the retry handler once bound, so a LATER runtime error on this server is not
        // mistaken for a failed bind and silently swallowed by a retry that can never help.
        server.removeAllListeners("error");
        resolve(handle);
      });
    };

    attempt();
  });
}
