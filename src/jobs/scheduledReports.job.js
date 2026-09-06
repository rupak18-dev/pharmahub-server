import cron from "node-cron";
import { ScheduledReport } from "../models/ScheduledReport.js";
import { SavedReport } from "../models/SavedReport.js";
import { User } from "../models/User.js";
import { customReport, computeNextRunAt, isValidEmail } from "../services/report.service.js";
import { sendEmail as defaultSendEmail } from "../services/mailer.js";
import { buildScheduledReportEmail } from "../services/emailTemplates.js";
import { logger } from "../core/logger.js";

let workerStarted = false;

/* Resolves the same date presets the frontend uses, so a schedule stored as
   { module, fields, measures, filters, datePreset } can be re-run later. */
function resolveDatePreset(presetId, now = new Date()) {
  const n = new Date(now);
  const addDays = (d, days) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  };
  const presets = {
    today: () => [n, n],
    yesterday: () => {
      const y = addDays(n, -1);
      return [y, y];
    },
    week: () => [addDays(n, -n.getDay()), n],
    month: () => [
      new Date(n.getFullYear(), n.getMonth(), 1),
      new Date(n.getFullYear(), n.getMonth() + 1, 0),
    ],
    lastMonth: () => {
      const end = new Date(n.getFullYear(), n.getMonth(), 0);
      return [new Date(end.getFullYear(), end.getMonth(), 1), end];
    },
    last30: () => [addDays(n, -29), n],
    next90: () => [n, addDays(n, 90)],
    fy: () => {
      const startYear = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1;
      return [new Date(startYear, 3, 1), new Date(startYear + 1, 2, 31)];
    },
    prevFy: () => {
      const startYear = n.getMonth() >= 3 ? n.getFullYear() - 1 : n.getFullYear() - 2;
      return [new Date(startYear, 3, 1), new Date(startYear + 1, 2, 31)];
    },
  };
  const resolve = presets[presetId] ?? presets.month;
  const [from, to] = resolve();
  return { from, to };
}

function buildReportPayload(config = {}) {
  const { module, fields = [], measures = [], filters = [], datePreset, dateFrom, dateTo } = config;
  let resolvedFrom = dateFrom;
  let resolvedTo = dateTo;
  if (!resolvedFrom && !resolvedTo) {
    const range = resolveDatePreset(datePreset);
    resolvedFrom = range.from.toISOString();
    resolvedTo = range.to.toISOString();
  }
  return {
    module,
    groupBy: fields,
    summarizeBy: measures,
    filters,
    dateFrom: resolvedFrom,
    dateTo: resolvedTo,
  };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(report) {
  const { rows = [], totals = {} } = report;
  if (rows.length === 0) return "No data found for the selected criteria.";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  const totalRow = headers.map((h) =>
    Object.prototype.hasOwnProperty.call(totals, h) ? csvEscape(totals[h]) : "",
  );
  if (totalRow.some((v) => v !== "")) lines.push(totalRow.join(","));
  return lines.join("\n");
}

function safeFileName(name) {
  return (name || "scheduled-report").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60);
}

/* Atomically claim a single scheduled occurrence so it can never be emailed
   twice. The claim advances nextRunAt to the next occurrence, guarded by the
   exact current value (compare-and-swap). If two workers/tickers race, only
   one update matches and the other skips. If the process dies mid-run, the
   occurrence is already marked consumed — the report is never re-delivered. */
async function claimOccurrence(schedule, now) {
  const next = computeNextRunAt(schedule, now);
  const condition = {
    _id: schedule._id,
    status: "active",
    ...(schedule.nextRunAt == null ? { nextRunAt: null } : { nextRunAt: schedule.nextRunAt }),
  };
  const claimed = await ScheduledReport.findOneAndUpdate(condition, { $set: { nextRunAt: next } });
  return claimed != null;
}

// deps.sendEmail is injectable so tests can count deliveries without SMTP.
export async function processScheduledReports(now = new Date(), deps = {}) {
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const schedules = await ScheduledReport.find({
    status: "active",
    $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: null }],
  }).lean();

  for (const schedule of schedules) {
    if (!(await claimOccurrence(schedule, now))) continue;

    try {
      let rawConfig = schedule.config;
      if (!rawConfig?.module && schedule.savedReportId) {
        const saved = await SavedReport.findById(schedule.savedReportId).lean();
        if (saved) {
          rawConfig = {
            module: saved.module,
            fields: saved.groupBy ?? saved.fields ?? [],
            measures: saved.summarizeBy ?? [],
            filters: saved.filters ?? [],
            datePreset: saved.dateConfig?.presetId,
          };
        }
      }

      const report = await customReport(buildReportPayload(rawConfig), schedule.createdBy);
      const csv = buildCsv(report);

      const creator = schedule.createdBy ? await User.findById(schedule.createdBy).lean() : null;
      const { from: periodFrom, to: periodTo } =
        rawConfig?.dateFrom && rawConfig?.dateTo
          ? { from: rawConfig.dateFrom, to: rawConfig.dateTo }
          : resolveDatePreset(rawConfig?.datePreset, now);
      const periodLabel = `${new Date(periodFrom).toLocaleDateString()} – ${new Date(periodTo).toLocaleDateString()}`;

      const recipients = (schedule.recipients || []).filter(isValidEmail);
      const emailResult = recipients.length
        ? await sendEmail({
            to: recipients,
            ...buildScheduledReportEmail({
              reportName: schedule.reportName,
              orgName: creator?.orgName || "your organization",
              periodLabel,
              generatedAt: now,
              rowCount: report?.rows?.length ?? 0,
            }),
            attachments: [
              {
                filename: `${safeFileName(schedule.reportName)}-${new Date(now).toISOString().slice(0, 10)}.csv`,
                content: csv,
              },
            ],
          })
        : { skipped: true };

      await ScheduledReport.findByIdAndUpdate(schedule._id, {
        lastRunAt: now,
        lastSentAt: now,
        lastError: null,
      });

      logger.info(
        `Processed scheduled report: ${schedule.reportName || schedule._id} (email ${emailResult?.skipped ? "skipped" : "sent"})`,
      );
    } catch (err) {
      logger.error(`Error processing scheduled report ${schedule._id}:`, err);
      await ScheduledReport.findByIdAndUpdate(schedule._id, {
        lastRunAt: now,
        lastError: err?.message || "Unknown error",
      }).catch(() => {});
    }
  }
}

export function startScheduledReportWorker() {
  if (workerStarted) return;
  workerStarted = true;
  cron.schedule("0 * * * *", () => {
    processScheduledReports().catch((err) =>
      logger.error("Scheduled report worker run failed:", err),
    );
  });
  logger.info("Scheduled report background worker initialized");
}
