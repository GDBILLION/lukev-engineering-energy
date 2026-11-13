// Run locally with:  node --test lambda/admin/test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./index.mjs";

const ID = "11111111-1111-1111-1111-111111111111";
const signedIn = { authorizer: { jwt: { claims: { sub: "abc", email: "owner@example.com" } } } };
const anonymous = {};

function setup(seed = {}) {
  const calls = [];
  const store = {
    new: seed.new ?? [
      { id: "a", createdAt: "2026-11-10T10:00:00.000Z", status: "new", name: "Older" },
      { id: "b", createdAt: "2026-11-12T10:00:00.000Z", status: "new", name: "Newer" },
    ],
    handled: seed.handled ?? [{ id: "c", createdAt: "2026-11-11T10:00:00.000Z", status: "handled", name: "Middle" }],
  };
  const db = {
    listByStatus: async (s) => (calls.push(["list", s]), store[s]),
    setStatus: async (id, s, t) => (calls.push(["set", id, s, t]), id === ID),
    remove: async (id) => (calls.push(["del", id]), id === ID),
  };
  const handler = createHandler({
    db,
    config: { region: "us-east-1", clientId: "client123" },
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  });
  return { handler, calls };
}

const ev = (routeKey, extra = {}, auth = signedIn) => ({ routeKey, requestContext: auth, ...extra });

test("auth-config is public and returns only region and client id", async () => {
  const { handler } = setup();
  const res = await handler(ev("GET /api/auth-config", {}, anonymous));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, region: "us-east-1", clientId: "client123" });
});

test("every admin route refuses a request with no verified login", async () => {
  const { handler, calls } = setup();
  for (const route of ["GET /api/admin/inquiries", "PATCH /api/admin/inquiries/{id}", "DELETE /api/admin/inquiries/{id}"]) {
    const res = await handler(ev(route, { pathParameters: { id: ID }, body: '{"status":"handled"}' }, anonymous));
    assert.equal(res.statusCode, 401, route);
  }
  assert.equal(calls.length, 0, "no database calls without a login");
});

test("lists all enquiries newest first", async () => {
  const { handler } = setup();
  const res = await handler(ev("GET /api/admin/inquiries"));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.items.map((i) => i.name), ["Newer", "Middle", "Older"]);
});

test("filters by status and rejects unknown statuses", async () => {
  const { handler, calls } = setup();
  const res = await handler(ev("GET /api/admin/inquiries", { queryStringParameters: { status: "handled" } }));
  assert.deepEqual(JSON.parse(res.body).items.map((i) => i.name), ["Middle"]);
  assert.deepEqual(calls, [["list", "handled"]]);
  const bad = await handler(ev("GET /api/admin/inquiries", { queryStringParameters: { status: "spam" } }));
  assert.equal(bad.statusCode, 400);
});

test("marks an enquiry handled, and reopens it", async () => {
  const { handler, calls } = setup();
  const done = await handler(ev("PATCH /api/admin/inquiries/{id}", { pathParameters: { id: ID }, body: '{"status":"handled"}' }));
  assert.equal(done.statusCode, 200);
  assert.deepEqual(calls[0], ["set", ID, "handled", "2026-11-13T12:00:00.000Z"]);
  const back = await handler(ev("PATCH /api/admin/inquiries/{id}", { pathParameters: { id: ID }, body: '{"status":"new"}' }));
  assert.equal(back.statusCode, 200);
});

test("rejects bad ids, bad statuses and bad JSON", async () => {
  const { handler } = setup();
  const patch = (id, body) => handler(ev("PATCH /api/admin/inquiries/{id}", { pathParameters: { id }, body }));
  assert.equal((await patch("not-a-uuid", '{"status":"new"}')).statusCode, 400);
  assert.equal((await patch(ID, '{"status":"deleted"}')).statusCode, 400);
  assert.equal((await patch(ID, "{nope")).statusCode, 400);
  assert.equal((await patch(ID, "")).statusCode, 400);
});

test("a missing enquiry is a 400, never 403 or 404 (CloudFront rewrites those)", async () => {
  const { handler } = setup();
  const other = "22222222-2222-2222-2222-222222222222";
  const patched = await handler(ev("PATCH /api/admin/inquiries/{id}", { pathParameters: { id: other }, body: '{"status":"new"}' }));
  const deleted = await handler(ev("DELETE /api/admin/inquiries/{id}", { pathParameters: { id: other } }));
  for (const res of [patched, deleted]) {
    assert.equal(res.statusCode, 400);
    assert.notEqual(res.statusCode, 403);
    assert.notEqual(res.statusCode, 404);
  }
});

test("deletes an enquiry", async () => {
  const { handler, calls } = setup();
  const res = await handler(ev("DELETE /api/admin/inquiries/{id}", { pathParameters: { id: ID } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], ["del", ID]);
});

test("a database failure gives a generic 500", async () => {
  const handler = createHandler({
    db: { listByStatus: async () => { throw new Error("secret internal detail"); } },
    config: {},
  });
  const res = await handler(ev("GET /api/admin/inquiries"));
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("secret"));
});

test("unknown routes are refused", async () => {
  const { handler } = setup();
  assert.equal((await handler(ev("GET /api/admin/other"))).statusCode, 400);
});
