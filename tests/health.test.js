import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";

let server;
let base;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("GET / returns service metadata", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.name, "PharmaHub");
});

test("GET /api/v1/health reports service health", async () => {
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, "ok");
  assert.equal(typeof body.data.uptime, "number");
});

test("GET /api/v1/info returns version info", async () => {
  const res = await fetch(`${base}/api/v1/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.name, "PharmaHub");
  assert.equal(body.data.version, "1.0.0");
});

test("unknown route returns 404 JSON", async () => {
  const res = await fetch(`${base}/api/v1/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
});

test("protected route without token returns 401", async () => {
  const res = await fetch(`${base}/api/v1/medicines`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
});
