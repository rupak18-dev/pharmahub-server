import mongoose from "mongoose";

import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { buildPagination } from "../utils/pagination.js";
import { Ticket } from "../models/Ticket.js";
import { recordAudit } from "../services/audit.service.js";

/**
 * Generate a unique ticket ID in format PH-TKT-YYYY-#####
 */
export async function generateTicketId() {
  const year = new Date().getFullYear();
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const ticketId = `PH-TKT-${year}-${randomNum}`;
    const exists = await Ticket.exists({ ticketId });
    if (!exists) {
      return ticketId;
    }
    attempts++;
  }

  throw new Error("Failed to generate a unique ticketId");
}

/**
 * POST /api/v1/tickets
 * Raise a new ticket
 */
export const createTicket = asyncHandler(async (req, res) => {
  const ticketId = await generateTicketId();

  const isAuth = Boolean(req.user);

  const ticketData = {
    ticketId,
    title: req.body.title,
    issueType: req.body.issueType || "general_inquiry",
    description: req.body.description,
    severity: req.body.severity || "medium",
    screenshot: req.body.screenshot || null,
    status: "open",
    userId: isAuth ? req.user._id : null,
    userName: isAuth
      ? req.user.name || req.body.userName || "PharmaHub User"
      : req.body.userName || "PharmaHub User",
    userEmail: isAuth
      ? req.user.email || req.body.userEmail || ""
      : req.body.userEmail || "",
    userRole: isAuth
      ? req.user.role || req.body.userRole || "Staff"
      : req.body.userRole || "Staff",
    orgName: isAuth
      ? req.user.orgName || req.body.orgName || "PharmaHub Pharmacy"
      : req.body.orgName || "PharmaHub Pharmacy",
  };

  const ticket = await Ticket.create(ticketData);

  recordAudit({
    userId: ticket.userId,
    userName: ticket.userName,
    action: "Ticket created",
    entityType: "ticket",
    entityId: ticket._id,
    ip: req.ip,
  });

  return created(res, ticket, "Ticket has been raised successfully");
});

/**
 * GET /api/v1/tickets
 * List tickets with role-based scoping and query filters
 */
export const listTickets = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);

  const andClauses = [];

  // Scoping: Admin and Owner can view all tickets.
  // Authenticated staff can view tickets created by their userId or userEmail.
  // Unauthenticated requests can query by userEmail or userId in query params.
  const isAdminOrOwner = req.user && ["Admin", "Owner"].includes(req.user.role);

  if (!isAdminOrOwner) {
    if (req.user) {
      const userConditions = [{ userId: req.user._id }];
      if (req.user.email) {
        userConditions.push({ userEmail: req.user.email.toLowerCase() });
      }
      andClauses.push({ $or: userConditions });
    } else if (req.query.userEmail || req.query.userId) {
      const conditions = [];
      if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
        conditions.push({ userId: req.query.userId });
      }
      if (req.query.userEmail) {
        conditions.push({ userEmail: req.query.userEmail.toLowerCase().trim() });
      }
      if (conditions.length > 0) {
        andClauses.push({ $or: conditions });
      } else {
        throw ApiError.unauthorized("Authentication required");
      }
    } else {
      throw ApiError.unauthorized("Authentication required");
    }
  }

  // Filter by status
  if (req.query.status) {
    andClauses.push({ status: req.query.status });
  }

  // Filter by severity
  if (req.query.severity) {
    andClauses.push({ severity: req.query.severity });
  }

  // Filter by issueType
  if (req.query.issueType) {
    andClauses.push({ issueType: req.query.issueType });
  }

  // Search filter across ticketId, title, description, issueType
  const searchTerm = req.query.search || req.query.q;
  if (searchTerm && typeof searchTerm === "string" && searchTerm.trim() !== "") {
    const regex = { $regex: searchTerm.trim(), $options: "i" };
    andClauses.push({
      $or: [
        { ticketId: regex },
        { title: regex },
        { description: regex },
        { issueType: regex },
        { userName: regex },
        { userEmail: regex },
      ],
    });
  }

  const filter = andClauses.length > 0 ? { $and: andClauses } : {};

  const [tickets, total] = await Promise.all([
    Ticket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit) || 0;

  return ok(res, tickets, "Tickets list", {
    total,
    page,
    limit,
    totalPages,
  });
});

/**
 * GET /api/v1/tickets/:id
 * Retrieve a single ticket by MongoDB _id or human-readable ticketId
 */
export const getTicket = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.Types.ObjectId.isValid(id);

  const query = isObjectId
    ? { $or: [{ _id: id }, { ticketId: id.toUpperCase() }] }
    : { ticketId: id.toUpperCase() };

  const ticket = await Ticket.findOne(query).lean();
  if (!ticket) {
    throw ApiError.notFound("Ticket not found");
  }

  return res.status(200).json({
    success: true,
    data: ticket,
  });
});

/**
 * PATCH /api/v1/tickets/:id/status
 * Update ticket status
 */
export const updateTicketStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const isObjectId = mongoose.Types.ObjectId.isValid(id);
  const query = isObjectId
    ? { $or: [{ _id: id }, { ticketId: id.toUpperCase() }] }
    : { ticketId: id.toUpperCase() };

  const ticket = await Ticket.findOneAndUpdate(
    query,
    { $set: { status } },
    { new: true, runValidators: true },
  );

  if (!ticket) {
    throw ApiError.notFound("Ticket not found");
  }

  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: `Ticket status updated to ${status}`,
    entityType: "ticket",
    entityId: ticket._id,
    ip: req.ip,
  });

  return ok(res, ticket, "Ticket status updated");
});
