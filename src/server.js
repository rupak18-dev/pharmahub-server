import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { Role } from "./models/Role.js";

async function bootstrap() {
  try {
    await connectDB();
    await Role.ensureSystemRoles();

    const app = createApp();
    app.listen(env.port, () => {
      logger.info(`PharmaHub API running at http://localhost:${env.port} (${env.nodeEnv})`);
    });
  } catch (err) {
    logger.error("Failed to start server", err);
    process.exit(1);
  }
}

bootstrap();
