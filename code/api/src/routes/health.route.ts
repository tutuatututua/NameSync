import { FastifyInstance } from "fastify";

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "UP" }));
}
