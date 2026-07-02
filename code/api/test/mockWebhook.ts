import http from "node:http";

export interface Hit {
  url: string;
  contentType: string | undefined;
  bodyLength: number;
  body: string;
}

export interface MockServer {
  state: { company: Hit[]; facebook: Hit[]; compare: Hit[] };
  close: () => Promise<void>;
}

/** Stand-in for the external matcher's ingestion + compare webhooks. */
export function startMockWebhook(port: number): Promise<MockServer> {
  const state = { company: [] as Hit[], facebook: [] as Hit[], compare: [] as Hit[] };

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
      };
      if (req.url === "/company") state.company.push(hit);
      else if (req.url === "/facebook") state.facebook.push(hit);
      else if (req.url === "/compare") state.compare.push(hit);
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
