import { Router } from "express";

import { optionalAuth } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";
import { ticketSchemas } from "../types/index.js";
import * as ticketController from "../controllers/ticket.controller.js";

const router = Router();

router.post(
  "/",
  optionalAuth,
  validate(ticketSchemas.create),
  ticketController.createTicket,
);

router.get(
  "/",
  optionalAuth,
  ticketController.listTickets,
);

router.get(
  "/:id",
  optionalAuth,
  ticketController.getTicket,
);

router.patch(
  "/:id/status",
  optionalAuth,
  validate(ticketSchemas.updateStatus),
  ticketController.updateTicketStatus,
);

export default router;
