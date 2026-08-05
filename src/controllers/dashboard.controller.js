import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import { dashboardStats, getDashboardNotifications } from "../services/dashboard.service.js";

export const getStats = asyncHandler(async (_req, res) => {
  const stats = await dashboardStats();
  return ok(res, stats, "Dashboard stats");
});

export const getNotifications = asyncHandler(async (req, res) => {
  const data = await getDashboardNotifications(parseInt(req.query.limit ?? "20", 10) || 20);
  return ok(res, data.notifications, "Dashboard notifications");
});
