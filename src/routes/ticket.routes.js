import { Router } from "express";

import { auth, optionalAuth } from "../middlewares/auth.js";
import { validate } from "../middlewares/validate.js";
import { ticketSchemas } from "../types/index.js";
import * as ticketController from "../controllers/ticket.controller.js";

const router = Router();

// Raising a ticket stays PUBLIC: the support/contact form is reachable by
// visitors who have no account, so the reporter details are taken from the body
// and `userId` is left null. Everything that reads or mutates an existing ticket
// requires a session — the previous `optionalAuth` on these routes let an
// unauthenticated caller list any reporter's tickets and change any ticket's
// status by guessing an enumerable `PH-TKT-YYYY-#####` id.
router.post(
  "/",
  optionalAuth,
  validate(ticketSchemas.create),
  ticketController.createTicket,
);

router.get(
  "/",
  auth,
  ticketController.listTickets,
);

router.get(
  "/:id",
  auth,
  ticketController.getTicket,
);

router.patch(
  "/:id/status",
  auth,
  validate(ticketSchemas.updateStatus),
  ticketController.updateTicketStatus,
);

export default router;
