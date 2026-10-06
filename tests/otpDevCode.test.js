import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { env } from "../src/config/env.js";
import { shouldEchoDevCode } from "../src/services/otp.service.js";

// The dev-code echo is the contract that lets a test deployment with no working
// SMTP still verify accounts, so its blast radius is worth pinning down:
//   - never echo a code that was actually emailed
//   - never echo on delivery_failed (a real provider exists, mail may be in flight)
//   - echo on email_unconfigured, unless explicitly disabled
describe("shouldEchoDevCode", () => {
  test("never echoes a delivered code by default", () => {
    const original = env.echoCodeAlways;
    env.echoCodeAlways = false;
    try {
      // The code provably reached a real inbox, so echoing it is a genuine
      // leak. This must stay off unless someone deliberately opts in.
      assert.equal(shouldEchoDevCode({ skipped: false, messageId: "abc" }), false);
      assert.equal(shouldEchoDevCode({ skipped: false, reason: null }), false);
    } finally {
      env.echoCodeAlways = original;
    }
  });

  test("echoes a delivered code when EMAIL_SHOW_CODE is set", () => {
    const original = env.echoCodeAlways;
    env.echoCodeAlways = true;
    try {
      assert.equal(shouldEchoDevCode({ skipped: false, messageId: "abc" }), true);
    } finally {
      env.echoCodeAlways = original;
    }
  });

  test("echoCodeAlways defaults to off so it can never be on by accident", () => {
    assert.equal(
      env.echoCodeAlways,
      process.env.EMAIL_SHOW_CODE === "true",
    );
  });

  test("treats a missing send result as not echoable", () => {
    assert.equal(shouldEchoDevCode(undefined), false);
    assert.equal(shouldEchoDevCode(null), false);
    assert.equal(shouldEchoDevCode({}), false);
  });

  test("never echoes on delivery_failed, even with the dev opt-ins set", () => {
    const original = env.echoDevCode;
    const originalProd = env.echoDevCodeInProduction;
    env.echoDevCode = true;
    env.echoDevCodeInProduction = true;
    try {
      // A provider IS configured here and the send failed — the code may have
      // been delivered after all, so it must never be handed to the client.
      assert.equal(
        shouldEchoDevCode({ skipped: true, reason: "delivery_failed" }),
        false,
      );
    } finally {
      env.echoDevCode = original;
      env.echoDevCodeInProduction = originalProd;
    }
  });

  test("echoes on email_unconfigured by default", () => {
    const original = env.autoEchoUnconfigured;
    env.autoEchoUnconfigured = true;
    try {
      assert.equal(
        shouldEchoDevCode({ skipped: true, reason: "email_unconfigured" }),
        true,
      );
    } finally {
      env.autoEchoUnconfigured = original;
    }
  });

  test("respects EMAIL_AUTO_ECHO_UNCONFIGURED=false as a kill switch", () => {
    const original = env.autoEchoUnconfigured;
    env.autoEchoUnconfigured = false;
    try {
      assert.equal(
        shouldEchoDevCode({ skipped: true, reason: "email_unconfigured" }),
        false,
      );
    } finally {
      env.autoEchoUnconfigured = original;
    }
  });

  test("autoEchoUnconfigured defaults to on so no dashboard change is needed", () => {
    // Guard the default: flipping this would silently break every test
    // deployment that has no SMTP configured.
    assert.equal(
      env.autoEchoUnconfigured,
      process.env.EMAIL_AUTO_ECHO_UNCONFIGURED !== "false",
    );
  });
});
