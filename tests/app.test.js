// Unit tests for the pure helpers in public/app.js, run with the built-in
// runner: `node --test`. No dependencies, no DOM — app.js guards its browser
// boot behind `typeof document`, so importing it here is side-effect-free.

import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  shortResource,
  formatDuration,
  normaliseGrant,
  createLimiter,
  readJSON,
  tokenIsFresh,
} from "../public/app.js";

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")&'`),
    "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;",
  );
  assert.equal(escapeHtml("plain"), "plain");
  // Non-strings are coerced, not crashed on.
  assert.equal(escapeHtml(42), "42");
});

test("shortResource trims the cloudresourcemanager prefix", () => {
  const base = "//cloudresourcemanager.googleapis.com";
  assert.equal(shortResource(`${base}/projects/my-proj`), "my-proj");
  assert.equal(shortResource(`${base}/folders/123`), "folder 123");
  assert.equal(shortResource(`${base}/organizations/789`), "organization 789");
  // Anything else is returned verbatim.
  assert.equal(shortResource("//compute.googleapis.com/x"), "//compute.googleapis.com/x");
  assert.equal(shortResource(""), "");
});

test("formatDuration renders human-readable spans", () => {
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(300), "5m");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(3660), "1h 1m");
  assert.equal(formatDuration(86400), "1d");
  assert.equal(formatDuration(90000), "1d 1h");
});

test("normaliseGrant flattens a PAM grant into the view model", () => {
  const g = {
    name: "projects/p/locations/global/entitlements/e/grants/g123",
    requester: "alice@example.com",
    requestedDuration: "3600s",
    justification: { unstructuredJustification: "need access" },
    requestedPrivilegedAccess: {
      gcpIamAccess: {
        resource: "//cloudresourcemanager.googleapis.com/projects/p",
        roleBindings: [{ role: "roles/owner" }, { role: "roles/viewer" }, { role: "" }],
      },
    },
    timeline: {
      events: [
        { eventTime: "2026-01-01T00:00:00Z", requested: { expireTime: "2030-01-01T00:00:00Z" } },
      ],
    },
    state: "APPROVAL_AWAITED",
  };

  const n = normaliseGrant(g, "p", "e", true);
  assert.equal(n.grantId, "g123");
  assert.equal(n.entitlementId, "e");
  assert.equal(n.project, "p");
  assert.equal(n.requester, "alice@example.com");
  assert.equal(n.justification, "need access");
  assert.equal(n.durationSeconds, 3600);
  assert.deepEqual(n.roles, ["roles/owner", "roles/viewer"]); // empty role filtered
  assert.equal(n.resource, "//cloudresourcemanager.googleapis.com/projects/p");
  assert.equal(n.requireApproverJustification, true);
  assert.equal(n.createdAt, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(n.expiresAt, Date.parse("2030-01-01T00:00:00Z"));
});

test("normaliseGrant tolerates a sparse grant", () => {
  const n = normaliseGrant({}, "p", "e", false);
  assert.equal(n.grantId, "");
  assert.deepEqual(n.roles, []);
  assert.equal(n.durationSeconds, 0);
  assert.equal(n.requireApproverJustification, false);
  assert.equal(n.createdAt, null);
  assert.equal(n.expiresAt, null);
});

test("tokenIsFresh respects the expiry buffer", () => {
  const now = 1_000_000;
  assert.equal(tokenIsFresh({ expires_at: now + 60_000 }, now), true);
  assert.equal(tokenIsFresh({ expires_at: now + 5_000 }, now), false); // inside 30s buffer
  assert.equal(tokenIsFresh({ expires_at: now - 1 }, now), false);
  assert.equal(tokenIsFresh(null, now), false);
  assert.equal(tokenIsFresh({}, now), false); // no numeric expires_at
});

test("readJSON parses, and swallows bad/missing values", () => {
  const store = (map) => ({ getItem: (k) => (k in map ? map[k] : null) });
  assert.deepEqual(readJSON(store({ a: '{"x":1}' }), "a"), { x: 1 });
  assert.equal(readJSON(store({ a: "not json" }), "a"), null);
  assert.equal(readJSON(store({}), "missing"), null);
});

test("createLimiter never exceeds its concurrency cap and preserves results", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = (v) => () =>
    new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        resolve(v);
      }, 10);
    });

  const results = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(task(v))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.ok(maxActive <= 2, `expected <=2 concurrent, saw ${maxActive}`);
});

test("createLimiter propagates rejection without stalling the queue", async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit(() => Promise.reject(new Error("boom"))), /boom/);
  // Queue still drains after a failure.
  assert.equal(await limit(() => Promise.resolve("ok")), "ok");
});
