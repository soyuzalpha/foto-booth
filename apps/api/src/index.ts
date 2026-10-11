import { buildApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 5050);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} diterima — menutup server`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
