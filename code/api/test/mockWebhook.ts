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

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
