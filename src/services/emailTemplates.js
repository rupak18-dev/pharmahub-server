import { env } from "../config/env.js";

// Pure email builders. Each returns { subject, html, text } so the mailer can
// send a rich HTML version with a plain-text fallback. Raw invitation/reset
// tokens are baked into the link here and never logged or stored.

function wrap({ subject, heading, htmlBody, textBody }) {
  const html = `
    <!doctype html>
    <html lang="en">
      <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" style="max-width:520px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb;">
                <tr>
                  <td style="background:linear-gradient(135deg,#0ea5e9,#2563eb);padding:20px 28px;">
                    <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;">PharmaHub</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:28px;">
                    <h1 style="margin:0 0 10px;font-size:20px;color:#111827;line-height:1.3;">${heading}</h1>
                    ${htmlBody}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 28px 22px;border-top:1px solid #eef0f2;">
                    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                      You received this email because you were invited to or registered with PharmaHub.
                      If this wasn't you, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>`;

  return {
    subject,
    html,
    text: `PharmaHub\n\n${heading}\n\n${textBody}`,
  };
}

function actionButton(label, link) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
      <tr>
        <td>
          <a href="${link}" style="display:inline-block;padding:12px 26px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

export function buildInvitationEmail({
  name,
  orgName,
  role,
  link,
  expiresInHours,
  message,
  email,
}) {
  const greeting = name?.trim() ? `Hello ${name.trim()},` : "Hello,";
  const org = orgName?.trim() || "your organization";
  const invitee = email?.trim() || "";
  const personalMessage = message?.trim()
    ? `<p style="margin:14px 0 0;padding:12px 14px;border-left:3px solid #2563eb;background:#f5f8ff;font-size:14px;color:#374151;line-height:1.6;font-style:italic;">"${escapeHtml(message.trim())}"</p>`
    : "";

  return wrap({
    subject: `${org} added you as ${role} on PharmaHub`,
    heading: `You've been added to ${org}`,
    htmlBody: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${greeting}</p>
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        <strong>${escapeHtml(org)}</strong> has added you to PharmaHub with the role of <strong>${role}</strong>.
      </p>
      ${personalMessage}
      <p style="margin:16px 0 4px;font-size:15px;color:#374151;line-height:1.6;">
        Click the button below to set up your account and get started.
      </p>
      ${actionButton("Set Up My Account", link)}
      <p style="margin:0 0 12px;font-size:12px;color:#9ca3af;line-height:1.6;">
        This link was sent to:<br/>
        ${escapeHtml(invitee)}
      </p>
      <p style="margin:0 0 12px;font-size:12px;color:#9ca3af;line-height:1.6;">
        This link expires in ${expiresInHours} hours and can only be used once.
      </p>
      <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
        If you were not expecting this, you can safely ignore this email.
      </p>`,
    textBody: `${greeting}

${org} has added you to PharmaHub with the role of ${role}.
${message?.trim() ? `\nMessage from your team:\n"${message.trim()}"\n` : ""}
Set up your account using the link below:
${link}

This link was sent to:
${invitee}

This link expires in ${expiresInHours} hours and can only be used once.

If you were not expecting this, you can safely ignore this email.

Regards,
${org} via PharmaHub`,
  });
}

// Labels mirror the app sidebar titles exactly (see constants.modules).
const ROLE_CHANGE_MODULE_LABELS = {
  dashboard: "Dashboard",
  medicines: "Medicines",
  batches: "Batches",
  expiry: "Expiry",
  audit: "Stock Monitor",
  purchases: "Orders",
  sales: "Sales & POS",
  shortbook: "Shortbook",
  reports: "Reports",
  users: "Users & Roles",
  admin: "Profile",
  integrations: "Integrations",
};

const ROLE_CHANGE_ACTION_LABELS = {
  view: "View",
  create: "Create",
  update: "Update",
  delete: "Delete",
  approve: "Approve",
  export: "Export",
};

// Reduce an effective permission matrix (module -> { action: boolean }) to a
// readable, sorted list of module rows with their enabled capabilities. Rows
// with no enabled action are omitted so the email only shows real access.
function formatEffectivePermissions(permissions) {
  const rows = [];
  for (const [mod, actions] of Object.entries(permissions ?? {})) {
    if (!actions || typeof actions !== "object") continue;
    const enabled = Object.entries(actions)
      .filter(([, value]) => value === true)
      .map(([action]) => ROLE_CHANGE_ACTION_LABELS[action] ?? action);
    if (enabled.length === 0) continue;
    rows.push({ module: ROLE_CHANGE_MODULE_LABELS[mod] ?? mod, actions: enabled });
  }
  rows.sort((a, b) => a.module.localeCompare(b.module));
  return rows;
}

// Render an access section (caption + module/capability table) in HTML.
function accessSectionHtml(caption, rows) {
  return `
      <p style="margin:16px 0 8px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">${caption}</p>
      ${
        rows.length > 0
          ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border:1px solid #e6e8eb;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="padding:10px 14px;background:#f9fafb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Module</td>
          <td style="padding:10px 14px;background:#f9fafb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Capabilities</td>
        </tr>
        ${rows
          .map(
            (r) => `
        <tr>
          <td style="padding:10px 14px;border-top:1px solid #eef0f2;font-size:14px;color:#111827;">${escapeHtml(r.module)}</td>
          <td style="padding:10px 14px;border-top:1px solid #eef0f2;font-size:13px;color:#374151;">${escapeHtml(r.actions.join(", "))}</td>
        </tr>`,
          )
          .join("")}
      </table>`
          : `<p style="margin:0 0 14px;font-size:14px;color:#9ca3af;">No modules granted.</p>`
      }`;
}

function accessSectionText(caption, rows) {
  return `${caption}:\n${
    rows.length > 0
      ? rows.map((r) => `- ${r.module}: ${r.actions.join(", ")}`).join("\n")
      : "- No modules granted."
  }`;
}

// Calculate added and removed access between previous and new permissions matrices
function diffPermissions(previousPermissions, newPermissions) {
  const prevRows = formatEffectivePermissions(previousPermissions);
  const newRows = formatEffectivePermissions(newPermissions);

  const prevMap = new Map(prevRows.map((r) => [r.module, new Set(r.actions)]));
  const newMap = new Map(newRows.map((r) => [r.module, new Set(r.actions)]));

  const added = [];
  const removed = [];

  // Check additions in new
  for (const [mod, newActions] of newMap.entries()) {
    if (!prevMap.has(mod)) {
      added.push(mod);
    } else {
      const prevActions = prevMap.get(mod);
      const addedActions = [...newActions].filter((a) => !prevActions.has(a));
      if (addedActions.length > 0) {
        if (prevActions.size === 0) {
          added.push(mod);
        } else {
          added.push(`${mod} (${addedActions.join(", ")})`);
        }
      }
    }
  }

  // Check removals from prev
  for (const [mod, prevActions] of prevMap.entries()) {
    if (!newMap.has(mod)) {
      removed.push(mod);
    } else {
      const newActions = newMap.get(mod);
      const removedActions = [...prevActions].filter((a) => !newActions.has(a));
      if (removedActions.length > 0) {
        if (newActions.size === 0) {
          removed.push(mod);
        } else {
          removed.push(`${mod} (${removedActions.join(", ")})`);
        }
      }
    }
  }

  return { added, removed, currentRows: newRows, previousRows: prevRows };
}

function diffFeatures(previousFeatures, newFeatures) {
  if (!previousFeatures || !newFeatures) return [];
  const FEATURE_LABELS = {
    processSales: "Process Sales & POS",
    stockAudit: "Stock Audit & Adjustments",
    purchasing: "Supplier Purchase Orders",
    dataExport: "Data Export & Reports",
    notifications: "Automated Expiry & Stock Alerts",
    userAdmin: "Staff & Security Administration",
  };
  const diffs = [];
  for (const [key, label] of Object.entries(FEATURE_LABELS)) {
    const prevVal = Boolean(previousFeatures[key]);
    const newVal = Boolean(newFeatures[key]);
    if (prevVal !== newVal) {
      diffs.push(`${label}: ${newVal ? "Enabled" : "Disabled"}`);
    }
  }
  return diffs;
}

// Sent to the affected user whenever an Owner/Admin changes their role or permissions.
export function buildRoleChangeEmail({
  name,
  orgName,
  previousRole,
  newRole,
  permissions,
  previousPermissions,
  features,
  previousFeatures,
  changedBy: _changedBy,
  link,
}) {
  const greeting = name?.trim() ? `Hello ${name.trim()},` : "Hello,";
  const _org = orgName?.trim() || "PharmaHub";
  const roleChanged = Boolean(previousRole && newRole && previousRole !== newRole);
  const loginLink = link || `${env.frontendUrl}/login`;

  const { added, removed, currentRows } = diffPermissions(previousPermissions, permissions);
  const featureDiffs = diffFeatures(previousFeatures, features);
  const hasAccessDiff = added.length > 0 || removed.length > 0 || featureDiffs.length > 0;

  const subject = "Your PharmaHub access points and permissions have been updated";
  const heading = "Access & Permissions Updated";

  let leadHtml = "";
  let leadText = "";

  if (roleChanged && !hasAccessDiff) {
    leadHtml = `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        Your PharmaHub account role and access points have been updated by an administrator.
      </p>
      <div style="margin:0 0 16px;padding:12px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;color:#111827;">
        <div>Previous Role: <strong>${escapeHtml(previousRole)}</strong></div>
        <div style="margin-top:4px;">New Role: <strong>${escapeHtml(newRole)}</strong></div>
      </div>
      <p style="margin:0 0 14px;font-size:14px;color:#4b5563;line-height:1.5;">
        Your role was changed from <strong>${escapeHtml(previousRole)}</strong> to <strong>${escapeHtml(newRole)}</strong>.
      </p>
    `;
    leadText = `Your PharmaHub account role and access points have been updated by an administrator.\n\nPrevious Role: ${previousRole}\nNew Role: ${newRole}\n\nYour role was changed from ${previousRole} to ${newRole}.\n\n`;
  } else {
    leadHtml = `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        Your PharmaHub account access points and security permissions have been updated by an administrator.
      </p>
    `;
    leadText = `Your PharmaHub account access points and security permissions have been updated by an administrator.\n\n`;

    if (roleChanged) {
      leadHtml += `
        <div style="margin:0 0 16px;padding:12px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;color:#111827;">
          <div>Previous Role: <strong>${escapeHtml(previousRole)}</strong></div>
          <div style="margin-top:4px;">New Role: <strong>${escapeHtml(newRole)}</strong></div>
        </div>
      `;
      leadText += `Previous Role: ${previousRole}\nNew Role: ${newRole}\n\n`;
    }
  }

  let diffHtml = "";
  let diffText = "";

  if (added.length > 0) {
    diffHtml += `
      <div style="margin:16px 0 14px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.4px;">
          Added Access:
        </p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1f2937;line-height:1.6;">
          ${added.map((item) => `<li><strong>${escapeHtml(item)}</strong></li>`).join("")}
        </ul>
      </div>
    `;
    diffText += `Added Access:\n${added.map((item) => `- ${item}`).join("\n")}\n\n`;
  }

  if (removed.length > 0) {
    diffHtml += `
      <div style="margin:16px 0 14px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.4px;">
          Removed Access:
        </p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1f2937;line-height:1.6;">
          ${removed.map((item) => `<li><strong>${escapeHtml(item)}</strong></li>`).join("")}
        </ul>
      </div>
    `;
    diffText += `Removed Access:\n${removed.map((item) => `- ${item}`).join("\n")}\n\n`;
  }

  if (featureDiffs.length > 0) {
    diffHtml += `
      <div style="margin:16px 0 14px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:0.4px;">
          Feature Changes:
        </p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1f2937;line-height:1.6;">
          ${featureDiffs.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </div>
    `;
    diffText += `Feature Changes:\n${featureDiffs.map((item) => `- ${item}`).join("\n")}\n\n`;
  }

  const reloginCalloutHtml = `
    <div style="margin:20px 0;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#1e40af;">
        Action Required: Re-login to Apply Changes
      </p>
      <p style="margin:0;font-size:13px;color:#1e3a8a;line-height:1.5;">
        To ensure your session reflects these updated permissions and security settings, please log out and re-login to PharmaHub. Your changes will take full effect immediately upon re-login.
      </p>
    </div>
  `;

  const reloginCalloutText = `\nACTION REQUIRED: RE-LOGIN TO APPLY CHANGES\nTo ensure your session reflects these updated permissions and security settings, please log out and re-login to PharmaHub. Your changes will take full effect immediately upon re-login.\n\nLog in here: ${loginLink}\n`;

  const htmlBody = `
    <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${greeting}</p>
    ${leadHtml}
    ${reloginCalloutHtml}
    ${diffHtml}
    ${accessSectionHtml("Current Active Access", currentRows)}
    ${actionButton("Log In to PharmaHub", loginLink)}
    <p style="margin:16px 0 12px;font-size:12px;color:#6b7280;line-height:1.6;">
      If you are currently logged in, please sign out and sign back in to refresh your access tokens.
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
      If you believe this change was made in error, please contact your organization administrator.
    </p>
  `;

  const textBody = `${greeting}\n\n${leadText}${reloginCalloutText}${diffText}${accessSectionText("Current Active Access", currentRows)}\n\nIf you are currently logged in, please sign out and sign back in to refresh your access tokens.\n\nIf you believe this change was made in error, please contact your organization administrator.\n\nRegards,\nPharmaHub Team`;

  return wrap({
    subject,
    heading,
    htmlBody,
    textBody,
  });
}

// Sent to the staff member AFTER a successful removal from the organization.
export function buildStaffRemovalEmail({ name, orgName: _orgName }) {
  const greeting = name?.trim() ? `Hello ${name.trim()},` : "Hello,";

  return wrap({
    subject: "Your PharmaHub account has been removed",
    heading: "Account Removed",
    htmlBody: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${greeting}</p>
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        Your PharmaHub account/access has been removed by the administrator.
      </p>
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        You can no longer access the PharmaHub application using this account.
      </p>
      <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
        If you believe this was done by mistake, please contact your organization administrator.
      </p>`,
    textBody: `${greeting}

Your PharmaHub account/access has been removed by the administrator.

You can no longer access the PharmaHub application using this account.

If you believe this was done by mistake, please contact your organization administrator.

Regards,
PharmaHub Team`,
  });
}

export function buildScheduledReportEmail({
  reportName,
  orgName,
  periodLabel,
  generatedAt,
  rowCount,
}) {
  const org = orgName?.trim() || "your organization";
  const generated = generatedAt
    ? new Date(generatedAt).toLocaleString()
    : new Date().toLocaleString();
  const summaryLine =
    rowCount != null
      ? `${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"} of data included.`
      : "";

  return wrap({
    subject: `PharmaHub — ${reportName || "Scheduled Report"}`,
    heading: "Your scheduled report is ready",
    htmlBody: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        The scheduled report <strong>${reportName || "Scheduled Report"}</strong> has been generated.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border:1px solid #e6e8eb;border-radius:10px;overflow:hidden;">
        <tr><td style="padding:10px 14px;background:#f9fafb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Organization</td></tr>
        <tr><td style="padding:8px 14px;font-size:14px;color:#111827;">${org}</td></tr>
        <tr><td style="padding:10px 14px;background:#f9fafb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Report period</td></tr>
        <tr><td style="padding:8px 14px;font-size:14px;color:#111827;">${periodLabel || "—"}</td></tr>
        <tr><td style="padding:10px 14px;background:#f9fafb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;">Generated</td></tr>
        <tr><td style="padding:8px 14px;font-size:14px;color:#111827;">${generated}</td></tr>
      </table>
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${summaryLine}</p>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">
        The full report is attached to this email as a CSV file.
      </p>`,
    textBody: `Your scheduled report "${reportName || "Scheduled Report"}" has been generated.

Organization: ${org}
Report period: ${periodLabel || "—"}
Generated: ${generated}
${summaryLine ? `\n${summaryLine}\n` : ""}
The full report is attached to this email as a CSV file.`,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildResetEmail({ name, link, expiresInMinutes }) {
  const greeting = name?.trim() ? `Hi ${name.trim()},` : "Hi,";

  return wrap({
    subject: "Reset your PharmaHub password",
    heading: "Reset your password",
    htmlBody: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${greeting}</p>
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        We received a request to reset your PharmaHub password. If you made this request, use the
        button below to choose a new one:
      </p>
      ${actionButton("Reset Password", link)}
      <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
        This link expires in ${expiresInMinutes} minutes and can only be used once.
      </p>`,
    textBody: `${greeting}

We received a request to reset your PharmaHub password. Open this link within ${expiresInMinutes} minutes to choose a new one (one-time use):
${link}

If you didn't request a password reset, you can safely ignore this email — your password won't change.`,
  });
}

const TICKET_ISSUE_TYPE_LABELS = {
  billing_pos: "Billing, POS & Invoicing Issue",
  inventory_stock: "Inventory & Stock Discrepancy",
  medicines_batches: "Medicine Catalog & Batch Tracking",
  expiry_returns: "Expiry & Returns Management",
  purchases_suppliers: "Purchase Orders & Supplier Sync",
  user_access: "User Access, Roles & Permissions",
  reports_export: "Reports, Analytics & Data Export",
  hardware_printers: "Hardware, Printers & Scanner Integration",
  general_inquiry: "General Inquiry or Feature Request",
};

export function buildTicketConfirmationEmail({ ticket, link }) {
  const greeting = ticket.userName?.trim()
    ? `Hello ${escapeHtml(ticket.userName.trim())},`
    : "Hello,";
  const ticketId = escapeHtml(ticket.ticketId || "Pending");
  const title = escapeHtml(ticket.title || "");
  const categoryLabel = escapeHtml(
    TICKET_ISSUE_TYPE_LABELS[ticket.issueType] ||
      ticket.issueType?.replace(/_/g, " ") ||
      "General Inquiry",
  );
  const severity = escapeHtml((ticket.severity || "medium").toLowerCase());
  const status = escapeHtml(ticket.status || "open");
  const createdDate = new Date(ticket.createdAt || Date.now()).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const exactDescription = escapeHtml(ticket.description || "");
  const trackLink = link || `${env.frontendUrl}/support`;

  const severityColors = {
    low: { bg: "#ecfdf5", text: "#065f46", border: "#a7f3d0" },
    medium: { bg: "#fffbeb", text: "#92400e", border: "#fde68a" },
    high: { bg: "#fff7ed", text: "#9a3412", border: "#fed7aa" },
    critical: { bg: "#fef2f2", text: "#991b1b", border: "#fecaca" },
  };
  const badgeStyle = severityColors[ticket.severity?.toLowerCase()] || severityColors.medium;

  return wrap({
    subject: `[${ticket.ticketId}] Support Request Received: ${ticket.title}`,
    heading: "Your Support Request Has Been Received",
    htmlBody: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">${greeting}</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
        Thank you for contacting PharmaHub Support. Your ticket has been registered with our support team and assigned the unique reference ID below:
      </p>

      <div style="margin:16px 0;padding:14px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;text-align:center;">
        <span style="font-size:12px;text-transform:uppercase;color:#64748b;font-weight:600;letter-spacing:0.5px;">Ticket Reference ID</span>
        <div style="font-family:Consolas, Monaco, 'Courier New', monospace;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:1px;margin-top:4px;">
          ${ticketId}
        </div>
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid #e6e8eb;border-radius:8px;overflow:hidden;font-size:14px;">
        <tr style="background:#f9fafb;border-bottom:1px solid #e6e8eb;">
          <td style="padding:8px 14px;color:#6b7280;width:35%;font-weight:600;">Issue Title</td>
          <td style="padding:8px 14px;color:#111827;font-weight:600;">${title}</td>
        </tr>
        <tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:8px 14px;color:#6b7280;">Category</td>
          <td style="padding:8px 14px;color:#111827;">${categoryLabel}</td>
        </tr>
        <tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:8px 14px;color:#6b7280;">Severity</td>
          <td style="padding:8px 14px;">
            <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:capitalize;background:${badgeStyle.bg};color:${badgeStyle.text};border:1px solid ${badgeStyle.border};">
              ${severity}
            </span>
          </td>
        </tr>
        <tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:8px 14px;color:#6b7280;">Status</td>
          <td style="padding:8px 14px;color:#111827;text-transform:capitalize;">${status}</td>
        </tr>
        <tr>
          <td style="padding:8px 14px;color:#6b7280;">Submitted At</td>
          <td style="padding:8px 14px;color:#111827;">${createdDate}</td>
        </tr>
      </table>

      <div style="margin:18px 0;">
        <span style="font-size:13px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:0.4px;">Submitted Description</span>
        <div style="margin-top:6px;padding:12px 14px;background:#f8fafc;border-left:3px solid #2563eb;border-radius:4px;font-size:14px;color:#334155;line-height:1.6;white-space:pre-wrap;">${exactDescription}</div>
      </div>

      <div style="margin:20px 0 10px;padding:14px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
        <strong style="color:#166534;font-size:14px;display:block;margin-bottom:6px;">Next Steps & Support SLA</strong>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#15803d;line-height:1.6;">
          <li>Our pharmacy support engineers review priority issues within 1–2 hours and standard tickets within 24 hours.</li>
          <li>Please quote your Ticket ID <strong>${ticketId}</strong> if you contact our support phone line or follow up via email.</li>
          <li>You can monitor updates, responses, and resolution status live in PharmaHub.</li>
        </ul>
      </div>

      ${actionButton("Track Ticket in PharmaHub", trackLink)}
      <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
        If you did not submit this support request, please contact your store administrator immediately.
      </p>`,
    textBody: `${greeting}

Thank you for contacting PharmaHub Support. Your ticket has been registered with our support team.

Ticket ID: ${ticket.ticketId}
Title: ${ticket.title}
Category: ${categoryLabel}
Severity: ${ticket.severity}
Status: ${ticket.status || "open"}
Submitted At: ${createdDate}

Submitted Description:
${ticket.description}

Next Steps & Support SLA:
- Our pharmacy support engineers review priority issues within 1-2 hours and standard tickets within 24 hours.
- Please quote your Ticket ID (${ticket.ticketId}) if you contact our support phone line or follow up via email.
- You can monitor updates and resolution status live in PharmaHub.

Track your ticket online:
${trackLink}

Regards,
PharmaHub Support Team`,
  });
}
