import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { Role } from "./models/Role.js";
import { ensureDevelopmentUser } from "./services/devUser.service.js";
import { startScheduledReportWorker } from "./jobs/scheduledReports.job.js";
import { validateEmailConfig } from "./services/mailer.js";

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
    await ensureDevelopmentUser();

    await validateEmailConfig();

    const app = createApp();
    app.listen(env.port, () => {
      logger.info(`PharmaHub API running at http://localhost:${env.port} (${env.nodeEnv})`);
    });

    // Start scheduled report background worker after server is up
    if (!env.isTest) {
      startScheduledReportWorker();
    }
  } catch (err) {
    logger.error(
      "Failed to start server. Check the MongoDB configuration (MONGO_URL / MONGO_URI) in .env — the backend refuses to start without a valid database connection.",
      err,
    );
    process.exit(1);
  }
}

bootstrap();
