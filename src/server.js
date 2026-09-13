import { createApp } from "./app.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { Role } from "./models/Role.js";
import { startScheduledReportWorker } from "./jobs/scheduledReports.job.js";
import { validateEmailConfig } from "./services/mailer.js";
import { autoRestoreSessions } from "./services/baileys.service.js";

async function bootstrap() {
  try {
    if (!env.mongoUriConfigured) {
      throw new Error(
        "MONGO_URI is not set. Add it to the environment (Render dashboard > your service > " +
          "Environment > add MONGO_URI with your MongoDB connection string) and redeploy.",
      );
    }

    await connectDB();
    await Role.ensureSystemRoles();

    await validateEmailConfig();

    const app = createApp();
    const server = app.listen(env.port, () => {
      logger.info(`PharmaHub API running at http://localhost:${env.port} (${env.nodeEnv})`);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        logger.error(`Port ${env.port} is already in use. Run "npm run kill:port" to free it, or change PORT in .env.`);
      } else {
        logger.error(`Server listen error: ${err.message}`, err);
      }
      process.exit(1);
    });

    // Scheduled report background worker & WhatsApp session auto-restoration
    if (!env.isTest) {
      startScheduledReportWorker();
      autoRestoreSessions();
    }

    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        await disconnectDB();
        logger.info("Server closed");
        process.exit(0);
      });
      setTimeout(() => {
        logger.error("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    logger.error(
      "Failed to start server. Check the MongoDB configuration (MONGO_URI) in .env — the backend refuses to start without a valid database connection.",
      err,
    );
    process.exit(1);
  }
}

bootstrap();
