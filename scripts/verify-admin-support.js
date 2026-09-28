import assert from "node:assert";

const BASE_URL = "http://localhost:5000/api/v1";
const CLIENT_HEADER = { "X-PharmaHub-Client": "web" };

async function runTests() {
  console.log("=== Starting Admin Support Feature Verification ===");

  // 1. Test Admin Login
  console.log("\n1. Testing Admin Login with pharmahub.team@gmail.com / Pharmahub@123...");
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({
      email: "pharmahub.team@gmail.com",
      password: "Pharmahub@123",
    }),
  });

  const loginData = await loginRes.json();
  assert.strictEqual(loginData.success, true, "Login should succeed");
  assert.strictEqual(loginData.data.user.role, "Admin", "User role must be Admin");
  assert.strictEqual(loginData.data.user.email, "pharmahub.team@gmail.com", "Email must match");
  console.log("✓ Admin login successful! Role:", loginData.data.user.role);

  // Extract session cookie from Set-Cookie header
  const setCookie = loginRes.headers.get("set-cookie");
  const cookieHeader = setCookie ? setCookie.split(";")[0] : "";
  console.log("✓ Session cookie captured for role-based requests");

  // 2. Test GET Global Support Settings (Public / Read-only)
  console.log("\n2. Testing Public GET /support/settings...");
  const getSettingsRes = await fetch(`${BASE_URL}/support/settings`);
  const getSettingsData = await getSettingsRes.json();
  assert.strictEqual(getSettingsData.success, true, "GET /support/settings should succeed");
  assert.ok(getSettingsData.data.title, "Should return title");
  assert.ok(Array.isArray(getSettingsData.data.categories), "Should return categories array");
  console.log("✓ Public GET settings succeeded. Current title:", getSettingsData.data.title);

  // 3. Test Unauthorized PUT /support/settings (Should fail with 401)
  console.log("\n3. Testing Unauthorized PUT /support/settings (Security check)...");
  const unauthPutRes = await fetch(`${BASE_URL}/support/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({ title: "Unauthorized Title Change" }),
  });
  const unauthPutData = await unauthPutRes.json();
  assert.strictEqual(unauthPutData.success, false, "Unauthorized update must fail");
  console.log("✓ Unauthorized update correctly blocked (Status:", unauthPutRes.status, ")");

  // 4. Test Authorized Admin PUT /support/settings
  console.log("\n4. Testing Admin PUT /support/settings (Customizing title to 'PharmaHub Customer Support')...");
  const adminPutRes = await fetch(`${BASE_URL}/support/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      ...CLIENT_HEADER,
    },
    body: JSON.stringify({
      title: "PharmaHub Customer Support",
      description: "Dedicated pharmacy assistance, batch inquiries, and live ticket resolution.",
      supportEmail: "pharmahub.team@gmail.com",
      supportPhone: "1800-PHARMA-CARE",
      slaText: "Priority Live Helpdesk · 2-Hour Response Guarantee",
    }),
  });
  const adminPutData = await adminPutRes.json();
  assert.strictEqual(adminPutData.success, true, "Admin update should succeed");
  assert.strictEqual(adminPutData.data.title, "PharmaHub Customer Support", "Title must be updated");
  console.log("✓ Admin customization saved in database. Updated title:", adminPutData.data.title);

  // 5. Test Global Visibility (All users see the updated title)
  console.log("\n5. Testing global visibility of updated settings...");
  const verifySettingsRes = await fetch(`${BASE_URL}/support/settings`);
  const verifySettingsData = await verifySettingsRes.json();
  assert.strictEqual(verifySettingsData.data.title, "PharmaHub Customer Support");
  console.log("✓ Verified: All users globally receive the updated title:", verifySettingsData.data.title);

  // 6. Test User Raising Ticket
  console.log("\n6. Testing User Raising Support Ticket (Routing test)...");
  const testEmail = `staff_${Date.now()}@pharmacy.local`;
  const createTicketRes = await fetch(`${BASE_URL}/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
    body: JSON.stringify({
      title: "Scanner barcode collision on Batch B402",
      issueType: "medicines_batches",
      description: "Barcode scan fails at POS counter 2 when entering batch B402.",
      severity: "high",
      userName: "Harsha Vardhan",
      userEmail: testEmail,
      userRole: "Staff",
      orgName: "MedPlus Central",
    }),
  });
  const createTicketData = await createTicketRes.json();
  assert.strictEqual(createTicketData.success, true, "Ticket creation should succeed");
  const createdTicket = createTicketData.data;
  console.log("✓ User ticket created successfully! Ticket ID:", createdTicket.ticketId);

  // 7. Test Admin Support Inbox (Admin sees all user tickets)
  console.log("\n7. Testing Admin Support Inbox (Fetching all user tickets)...");
  const adminTicketsRes = await fetch(`${BASE_URL}/tickets`, {
    headers: { Cookie: cookieHeader },
  });
  const adminTicketsData = await adminTicketsRes.json();
  assert.strictEqual(adminTicketsData.success, true, "Admin tickets listing must succeed");
  assert.ok(Array.isArray(adminTicketsData.data), "Should return array of tickets");
  const foundInInbox = adminTicketsData.data.find((t) => t.ticketId === createdTicket.ticketId);
  assert.ok(foundInInbox, "Newly raised user ticket MUST appear in Admin Support Inbox");
  console.log("✓ User ticket found in Admin Inbox:", {
    ticketId: foundInInbox.ticketId,
    userName: foundInInbox.userName,
    userEmail: foundInInbox.userEmail,
    issue: foundInInbox.title,
    severity: foundInInbox.severity,
    status: foundInInbox.status,
  });

  // 8. Test Admin Replying to Ticket & Updating Status
  console.log("\n8. Testing Admin Replying to User Ticket & Updating Status to 'in_progress'...");
  const replyRes = await fetch(`${BASE_URL}/tickets/${createdTicket.ticketId}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      ...CLIENT_HEADER,
    },
    body: JSON.stringify({
      message: "Hello Harsha, our support team has received your report regarding batch B402. We are reviewing POS logs now.",
      status: "in_progress",
    }),
  });
  const replyData = await replyRes.json();
  assert.strictEqual(replyData.success, true, "Admin reply must succeed");
  assert.strictEqual(replyData.data.status, "in_progress", "Status should be updated to in_progress");
  assert.ok(
    replyData.data.messages.some((m) => m.message.includes("batch B402")),
    "Message must be stored in ticket messages",
  );
  console.log("✓ Admin reply successfully saved! New status:", replyData.data.status);
  console.log("✓ Message stored in conversation thread. Total messages:", replyData.data.messages.length);

  // 9. Test User Ticket Tracking View Sync
  console.log("\n9. Testing User Ticket Tracking View Synchronization...");
  const trackRes = await fetch(`${BASE_URL}/tickets/${createdTicket.ticketId}?userEmail=${encodeURIComponent(testEmail)}`);
  const trackData = await trackRes.json();
  assert.strictEqual(trackData.data.status, "in_progress", "User tracking must reflect updated status");
  assert.ok(
    trackData.data.activityTimeline.some((a) => a.event === "admin_reply" || a.title.includes("Reply")),
    "User tracking timeline must contain support team reply event",
  );
  console.log("✓ User tracking view synchronized: reflects status 'in_progress' and support reply!");

  console.log("\n=== ALL 9 VERIFICATION TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
