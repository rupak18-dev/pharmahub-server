import { connectDB, disconnectDB } from "../src/config/db.js";
import { Ticket } from "../src/models/Ticket.js";

async function updateTicketHistory() {
  await connectDB();

  const ticketId = "PH-TKT-2026-43841";
  const ticket = await Ticket.findOne({ ticketId });

  if (!ticket) {
    console.error(`[update-ticket-history] Ticket ${ticketId} not found in database!`);
    await disconnectDB();
    process.exit(1);
  }

  // Create real timestamps for Sep 13, 2026 as per user example
  const dRaised = new Date("2026-09-13T18:41:00.000+05:30");
  const dAck = new Date("2026-09-13T18:42:00.000+05:30");
  const dAssigned = new Date("2026-09-13T18:48:00.000+05:30");
  const dInProgress = new Date("2026-09-13T19:10:00.000+05:30");

  const activityTimeline = [
    {
      event: "ticket_raised",
      status: "open",
      title: "Ticket Raised",
      description: "Ticket was created successfully.",
      timestamp: dRaised,
      by: ticket.userName || "User",
    },
    {
      event: "acknowledged",
      status: "acknowledged",
      title: "Ticket Acknowledged",
      description: "Support team received the ticket.",
      timestamp: dAck,
      by: "Support Desk",
    },
    {
      event: "assigned",
      status: "assigned",
      title: "Ticket Assigned",
      description: "Ticket assigned to support team.",
      timestamp: dAssigned,
      by: "Support Lead",
    },
    {
      event: "in_progress",
      status: "in_progress",
      title: "In Progress",
      description: "Support team is investigating the issue.",
      timestamp: dInProgress,
      by: "Technical Specialist",
    },
  ];

  ticket.status = "in_progress";
  ticket.activityTimeline = activityTimeline;
  ticket.updatedAt = dInProgress;
  await ticket.save();

  console.log(`[update-ticket-history] Successfully updated ${ticketId} with status 'in_progress' and 4 activity timeline events!`);
  await disconnectDB();
}

updateTicketHistory().catch((err) => {
  console.error("[update-ticket-history] failed:", err);
  process.exit(1);
});
