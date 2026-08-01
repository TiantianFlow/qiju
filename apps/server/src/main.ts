import { buildApp } from "./app.js";

const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, "qiju server listening");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
