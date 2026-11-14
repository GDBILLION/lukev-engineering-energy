// Run locally with:  node --test lambda/admin/test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./index.mjs";

const ID = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const jpeg = (n = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]).toString("base64");
const signedIn = { authorizer: { jwt: { claims: { sub: "abc", email: "owner@example.com" } } } };
const anonymous = {};

function setup(seed = {}) {
  const calls = [];
  const photos = seed.photos ?? [];
  const services = seed.services ?? [
    { id: "ndt", title: "NDT", summary: "s", heading: "h", intro: "i", bullets: ["a"], updatedAt: "2026-11-14T08:00:00.000Z" },
    { id: "junk", title: "x", summary: "x", heading: "x", intro: "x", bullets: [], updatedAt: "" },
  ];
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
    listContent: async () => (calls.push(["listContent"]), { services, photos }),
    savePhoto: async (p) => (calls.push(["savePhoto", p]), photos.push(p)),
    updatePhoto: async (id, c) => (calls.push(["updatePhoto", id, c]), photos.some((p) => p.id === id)),
    removePhoto: async (id) => (calls.push(["removePhoto", id]), photos.find((p) => p.id === id)?.key ?? null),
    saveService: async (id, v, t) => calls.push(["saveService", id, v, t]),
    resetService: async (id) => calls.push(["resetService", id]),
  };
  const files = {
    put: async (key, body, type) => calls.push(["filePut", key, body.length, type]),
    remove: async (key) => calls.push(["fileRemove", key]),
  };
  const handler = createHandler({
    db,
    files,
    newId: () => ID2,
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
  for (const route of ["GET /api/admin/inquiries", "PATCH /api/admin/inquiries/{id}", "DELETE /api/admin/inquiries/{id}", "GET /api/admin/content", "POST /api/admin/photos", "PATCH /api/admin/photos/{id}", "DELETE /api/admin/photos/{id}"]) {
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

const good = { title: "NDT", summary: "Short text", heading: "Headline", intro: "Paragraph.", bullets: ["One", " Two ", ""] };

test("public content returns edited services without internal fields", async () => {
  const { handler } = setup();
  const res = await handler(ev("GET /api/content", {}, anonymous));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(body.services), ["ndt"], "unknown ids are dropped");
  assert.equal("updatedAt" in body.services.ndt, false);
});

test("admin content includes the saved time and needs a login", async () => {
  const { handler } = setup();
  assert.equal((await handler(ev("GET /api/admin/content", {}, anonymous))).statusCode, 401);
  const body = JSON.parse((await handler(ev("GET /api/admin/content"))).body);
  assert.equal(body.services.ndt.updatedAt, "2026-11-14T08:00:00.000Z");
});

test("saving a service checks the login, the id and the text", async () => {
  const { handler, calls } = setup();
  const put = (id, body, auth) => handler(ev("PUT /api/admin/services/{id}", { pathParameters: { id }, body: JSON.stringify(body) }, auth));
  assert.equal((await put("ndt", good, anonymous)).statusCode, 401);
  assert.equal((await put("pizza", good)).statusCode, 400);
  assert.equal((await put("ndt", { ...good, title: "" })).statusCode, 400);
  assert.equal((await put("ndt", { ...good, bullets: [] })).statusCode, 400);
  assert.equal((await put("ndt", { ...good, bullets: ["x".repeat(121)] })).statusCode, 400);
  assert.equal((await put("ndt", { ...good, intro: "x".repeat(1501) })).statusCode, 400);
  assert.equal(calls.filter((c) => c[0] === "saveService").length, 0);

  const ok = await put("ndt", { ...good, title: "  NDT\n  Services " });
  assert.equal(ok.statusCode, 200);
  const saved = calls.find((c) => c[0] === "saveService");
  assert.equal(saved[1], "ndt");
  assert.equal(saved[2].title, "NDT Services", "line breaks and extra spaces are cleaned");
  assert.deepEqual(saved[2].bullets, ["One", "Two"], "blank list items are dropped");
  assert.equal(saved[3], "2026-11-13T12:00:00.000Z");
});

test("bad JSON and oversized bodies are refused with 400, never 403 or 404", async () => {
  const { handler } = setup();
  const send = (body) => handler(ev("PUT /api/admin/services/{id}", { pathParameters: { id: "ndt" }, body }));
  assert.equal((await send("{not json")).statusCode, 400);
  assert.equal((await send("x".repeat(20001))).statusCode, 400);
});

test("resetting a service forgets the edits", async () => {
  const { handler, calls } = setup();
  const res = await handler(ev("DELETE /api/admin/services/{id}", { pathParameters: { id: "solar" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.at(-1), ["resetService", "solar"]);
  assert.equal((await handler(ev("DELETE /api/admin/services/{id}", { pathParameters: { id: "x" } }))).statusCode, 400);
});

const upload = (handler, body, auth = signedIn) => handler(ev("POST /api/admin/photos", { body: typeof body === "string" ? body : JSON.stringify(body) }, auth));

test("uploading a photo stores the file, then the record, and returns its public path", async () => {
  const { handler, calls } = setup();
  const res = await upload(handler, { gallery: "solar", caption: "  Rooftop\n job ", data: jpeg() });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.photo, { id: ID2, gallery: "solar", caption: "Rooftop job", url: "/media/photos/" + ID2 + ".jpg" });
  const put = calls.find((c) => c[0] === "filePut");
  assert.deepEqual(put, ["filePut", "media/photos/" + ID2 + ".jpg", 104, "image/jpeg"]);
  const saved = calls.find((c) => c[0] === "savePhoto")[1];
  assert.equal(saved.key, "media/photos/" + ID2 + ".jpg");
  assert.equal(saved.position, new Date("2026-11-13T12:00:00.000Z").getTime());
  assert.ok(calls.findIndex((c) => c[0] === "filePut") < calls.findIndex((c) => c[0] === "savePhoto"));
});

test("uploads need a login and a valid JPEG in a known gallery", async () => {
  const { handler, calls } = setup();
  assert.equal((await upload(handler, { gallery: "ndt", data: jpeg() }, anonymous)).statusCode, 401);
  assert.equal((await upload(handler, { gallery: "pizza", data: jpeg() })).statusCode, 400);
  assert.equal((await upload(handler, { gallery: "ndt", data: "not base64!!" })).statusCode, 400);
  assert.equal((await upload(handler, { gallery: "ndt" })).statusCode, 400);
  assert.equal((await upload(handler, "{bad json")).statusCode, 400);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
  assert.equal((await upload(handler, { gallery: "ndt", data: png })).statusCode, 400, "a PNG is refused");
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3000001)]).toString("base64");
  assert.equal((await upload(handler, { gallery: "ndt", data: huge })).statusCode, 400, "over 3 MB is refused");
  assert.equal((await upload(handler, { gallery: "ndt", caption: "x".repeat(101), data: jpeg() })).statusCode, 400);
  assert.equal(calls.filter((c) => c[0] === "filePut").length, 0, "nothing was stored");
});

test("a gallery holds at most 12 photos", async () => {
  const photos = Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, gallery: "ndt", caption: "", key: "media/photos/p" + i + ".jpg", position: i, createdAt: "" }));
  const { handler, calls } = setup({ photos });
  assert.equal((await upload(handler, { gallery: "ndt", data: jpeg() })).statusCode, 400);
  assert.equal((await upload(handler, { gallery: "solar", data: jpeg() })).statusCode, 200, "other galleries are not affected");
  assert.equal(calls.filter((c) => c[0] === "filePut").length, 1);
});

test("photos are listed in display order, with a public path and no internal key", async () => {
  const photos = [
    { id: "b", gallery: "ndt", caption: "Second", key: "media/photos/b.jpg", position: 20, createdAt: "t2" },
    { id: "a", gallery: "ndt", caption: "First", key: "media/photos/a.jpg", position: 10, createdAt: "t1" },
    { id: "x", gallery: "unknown", caption: "", key: "media/photos/x.jpg", position: 1, createdAt: "t0" },
  ];
  const { handler } = setup({ photos });
  const pub = JSON.parse((await handler(ev("GET /api/content", {}, anonymous))).body);
  assert.deepEqual(pub.photos, [
    { id: "a", gallery: "ndt", caption: "First", url: "/media/photos/a.jpg" },
    { id: "b", gallery: "ndt", caption: "Second", url: "/media/photos/b.jpg" },
  ]);
  const owner = JSON.parse((await handler(ev("GET /api/admin/content"))).body);
  assert.equal(owner.photos[0].createdAt, "t1");
});

test("editing a caption and moving a photo to the front", async () => {
  const photos = [
    { id: ID, gallery: "ndt", caption: "", key: "media/photos/1.jpg", position: 50, createdAt: "" },
    { id: ID2, gallery: "ndt", caption: "", key: "media/photos/2.jpg", position: 10, createdAt: "" },
    { id: "z", gallery: "solar", caption: "", key: "media/photos/z.jpg", position: -500, createdAt: "" },
  ];
  const { handler, calls } = setup({ photos });
  const patch = (id, body, auth) => handler(ev("PATCH /api/admin/photos/{id}", { pathParameters: { id }, body: JSON.stringify(body) }, auth));
  assert.equal((await patch(ID, { caption: "Hi" }, anonymous)).statusCode, 401);
  assert.equal((await patch("nope", { caption: "Hi" })).statusCode, 400);
  assert.equal((await patch(ID, {})).statusCode, 400);
  assert.equal((await patch(ID, { caption: "x".repeat(101) })).statusCode, 400);
  assert.equal((await patch("33333333-3333-3333-3333-333333333333", { caption: "Hi" })).statusCode, 400, "unknown photo is 400, never 404");
  assert.equal((await patch(ID, { caption: " Welding\ncheck " })).statusCode, 200);
  assert.deepEqual(calls.findLast((c) => c[0] === "updatePhoto"), ["updatePhoto", ID, { caption: "Welding check" }]);
  assert.equal((await patch(ID, { first: true })).statusCode, 200);
  assert.deepEqual(calls.findLast((c) => c[0] === "updatePhoto"), ["updatePhoto", ID, { position: 9 }], "one before the smallest position in its own gallery");
});

test("deleting a photo removes the record and its file", async () => {
  const photos = [{ id: ID, gallery: "ndt", caption: "", key: "media/photos/1.jpg", position: 1, createdAt: "" }];
  const { handler, calls } = setup({ photos });
  const del = (id, auth) => handler(ev("DELETE /api/admin/photos/{id}", { pathParameters: { id } }, auth));
  assert.equal((await del(ID, anonymous)).statusCode, 401);
  assert.equal((await del(ID)).statusCode, 200);
  assert.deepEqual(calls.at(-1), ["fileRemove", "media/photos/1.jpg"]);
  assert.equal((await del("33333333-3333-3333-3333-333333333333")).statusCode, 400);
});
