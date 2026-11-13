// Run locally with:  node --test lambda/inquiries/test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, validate } from "./index.mjs";

const fixedNow = () => new Date("2026-11-13T10:00:00.000Z");

function setup({ failEmail = false, failSave = false } = {}) {
  const saved = [];
  const sent = [];
  const handler = createHandler({
    putItem: async (item) => {
      if (failSave) throw new Error("dynamo down");
      saved.push(item);
    },
    sendEmail: async (item) => {
      if (failEmail) throw new Error("ses down");
      sent.push(item);
    },
    now: fixedNow,
    newId: () => "11111111-1111-1111-1111-111111111111",
  });
  return { handler, saved, sent };
}

const good = {
  name: "Ada Okafor",
  email: "Ada@Example.com",
  company: "Okafor Ltd",
  service: "NDT Inspection",
  details: "We need ultrasonic testing on two pressure vessels.",
  website: "",
  elapsedMs: 9000,
};

const post = (body, extra = {}) => ({
  requestContext: { http: { method: "POST" } },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...extra,
});

test("saves a valid enquiry and sends the notification", async () => {
  const { handler, saved, sent } = setup();
  const res = await handler(post(good));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, id: "11111111-1111-1111-1111-111111111111" });
  assert.equal(saved.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(saved[0].email, "ada@example.com"); // lower-cased
  assert.equal(saved[0].status, "new");
  assert.equal(saved[0].createdAt, "2026-11-13T10:00:00.000Z");
  assert.equal(saved[0].website, undefined); // trap fields are never stored
  assert.equal(saved[0].elapsedMs, undefined);
});

test("details and company are optional", async () => {
  const { handler, saved } = setup();
  const res = await handler(post({ name: "A", email: "a@b.co", service: "Solar Energy", elapsedMs: 5000 }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved[0].details, "");
});

test("rejects missing name, bad email, missing service", async () => {
  const { handler, saved } = setup();
  for (const patch of [{ name: "  " }, { email: "not-an-email" }, { email: "a@b" }, { service: "" }]) {
    const res = await handler(post({ ...good, ...patch }));
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(JSON.parse(res.body).ok, false);
  }
  assert.equal(saved.length, 0);
});

test("rejects over-long fields", async () => {
  const { handler } = setup();
  const res = await handler(post({ ...good, details: "x".repeat(5001) }));
  assert.equal(res.statusCode, 400);
});

test("honeypot and too-fast submissions look successful but store nothing", async () => {
  const { handler, saved, sent } = setup();
  const trap = await handler(post({ ...good, website: "http://spam.example" }));
  const fast = await handler(post({ ...good, elapsedMs: 200 }));
  for (const res of [trap, fast]) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  }
  assert.equal(saved.length, 0);
  assert.equal(sent.length, 0);
});

test("a failed email does not fail the request", async () => {
  const { handler, saved } = setup({ failEmail: true });
  const res = await handler(post(good));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
});

test("a failed save returns a generic 500 with no internals", async () => {
  const { handler } = setup({ failSave: true });
  const res = await handler(post(good));
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("dynamo"));
});

test("bad JSON, arrays and wrong methods are refused", async () => {
  const { handler } = setup();
  assert.equal((await handler(post("{not json"))).statusCode, 400);
  assert.equal((await handler(post("[1,2]"))).statusCode, 400);
  assert.equal((await handler({ requestContext: { http: { method: "GET" } }, body: "" })).statusCode, 405);
});

test("oversized body is refused", async () => {
  const { handler } = setup();
  const res = await handler(post({ ...good, details: "y".repeat(30000) }));
  assert.equal(res.statusCode, 413);
});

test("base64 bodies are decoded", async () => {
  const { handler, saved } = setup();
  const res = await handler(post(Buffer.from(JSON.stringify(good)).toString("base64"), { isBase64Encoded: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
});

test("control characters and header-injection attempts are neutralised", () => {
  const { data } = validate({ ...good, name: "Ada\r\nBcc: evil@example.com", elapsedMs: 5000 });
  assert.ok(!/[\r\n]/.test(data.name));
});
