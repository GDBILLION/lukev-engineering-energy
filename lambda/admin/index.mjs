// Admin API for the owner. Routes (API Gateway checks the Cognito login before this code runs):
//   GET    /api/auth-config                 public: tells the admin page which Cognito app to sign in to
//   GET    /api/admin/inquiries?status=...  list enquiries (new | handled | all)
//   PATCH  /api/admin/inquiries/{id}        set status to "new" or "handled"
//   DELETE /api/admin/inquiries/{id}        delete an enquiry
//   GET    /api/content                     public: the edited service text the website shows
//   GET    /api/admin/content               the same, for the admin screen
//   PUT    /api/admin/services/{id}         save the text of one service (ndt | equipment | solar)
//   DELETE /api/admin/services/{id}         forget the edits, so the website shows its built-in text again
//   POST   /api/admin/photos                upload one photo (a JPEG the admin page has already resized) to a gallery
//   PATCH  /api/admin/photos/{id}           change a caption, or move the photo to the front of its gallery
//   DELETE /api/admin/photos/{id}           remove a photo
//   (GET /api/content and GET /api/admin/content also list the photos)
//
// Never answer 403 or 404 from here: CloudFront rewrites those two codes to the website's index.html.

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const STATUSES = ["new", "handled"];
const PHOTO_PREFIX = "photo-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_LIMIT = 200;

const SERVICE_IDS = ["ndt", "equipment", "solar"];
const MAX_BODY = 20000;
const MAX_UPLOAD_BODY = 4500000; // characters of JSON; the admin page resizes photos to well under this
const MAX_PHOTO_BYTES = 3000000;
const MAX_PHOTOS_PER_GALLERY = 12;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Single-line text: control characters (including line breaks) are removed, then trimmed.
const clean = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() : "");

// Checks the text of one service. Returns { value } or { error }.
export function validateService(input) {
  if (!input || typeof input !== "object") return { error: "Invalid request." };
  const title = clean(input.title);
  const summary = clean(input.summary);
  const heading = clean(input.heading);
  const intro = clean(input.intro);
  if (!title || title.length > 80) return { error: "The name is required (up to 80 characters)." };
  if (!summary || summary.length > 500) return { error: "The short description is required (up to 500 characters)." };
  if (!heading || heading.length > 200) return { error: "The headline is required (up to 200 characters)." };
  if (!intro || intro.length > 1500) return { error: "The paragraph is required (up to 1500 characters)." };
  if (!Array.isArray(input.bullets)) return { error: "Invalid request." };
  const bullets = input.bullets.map(clean).filter(Boolean);
  if (bullets.length < 1 || bullets.length > 20) return { error: "Add between 1 and 20 list items." };
  if (bullets.some((b) => b.length > 120)) return { error: "Each list item can have up to 120 characters." };
  return { value: { title, summary, heading, intro, bullets } };
}

const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

const plain = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v?.S ?? ""]));

// Real DynamoDB calls. The SDK is loaded only when needed, which keeps local tests free of dependencies.
function dynamoAdapter(env) {
  let client;
  const load = async () => {
    const sdk = await import("@aws-sdk/client-dynamodb");
    client ??= new sdk.DynamoDBClient({});
    return { sdk, client };
  };
  const isMissing = (err) => err?.name === "ConditionalCheckFailedException";

  return {
    async listByStatus(status) {
      const { sdk, client } = await load();
      const out = await client.send(
        new sdk.QueryCommand({
          TableName: env.TABLE_NAME,
          IndexName: "status-createdAt-index",
          KeyConditionExpression: "#s = :s",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": { S: status } },
          ScanIndexForward: false, // newest first
          Limit: PAGE_LIMIT,
        }),
      );
      return (out.Items ?? []).map(plain);
    },

    // Returns false when the enquiry does not exist.
    async setStatus(id, status, nowIso) {
      const { sdk, client } = await load();
      const handled = status === "handled";
      try {
        await client.send(
          new sdk.UpdateItemCommand({
            TableName: env.TABLE_NAME,
            Key: { id: { S: id } },
            UpdateExpression: handled ? "SET #s = :s, handledAt = :t" : "SET #s = :s REMOVE handledAt",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: handled ? { ":s": { S: status }, ":t": { S: nowIso } } : { ":s": { S: status } },
            ConditionExpression: "attribute_exists(id)",
          }),
        );
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },

    // Edited service text and uploaded photo records live together in the content table.
    async listContent() {
      const { sdk, client } = await load();
      const services = [];
      const photos = [];
      let startKey;
      do {
        const out = await client.send(new sdk.ScanCommand({ TableName: env.CONTENT_TABLE, ExclusiveStartKey: startKey }));
        for (const item of out.Items ?? []) {
          const id = item.id?.S ?? "";
          if (id.startsWith(PHOTO_PREFIX)) {
            photos.push({
              id: id.slice(PHOTO_PREFIX.length),
              gallery: item.gallery?.S ?? "",
              caption: item.caption?.S ?? "",
              key: item.key?.S ?? "",
              position: Number(item.position?.N ?? 0),
              createdAt: item.createdAt?.S ?? "",
            });
          } else {
            services.push({
              id,
              title: item.title?.S ?? "",
              summary: item.summary?.S ?? "",
              heading: item.heading?.S ?? "",
              intro: item.intro?.S ?? "",
              bullets: (item.bullets?.L ?? []).map((b) => b.S ?? ""),
              updatedAt: item.updatedAt?.S ?? "",
            });
          }
        }
        startKey = out.LastEvaluatedKey;
      } while (startKey);
      return { services, photos };
    },

    async savePhoto(photo) {
      const { sdk, client } = await load();
      await client.send(
        new sdk.PutItemCommand({
          TableName: env.CONTENT_TABLE,
          Item: {
            id: { S: PHOTO_PREFIX + photo.id },
            gallery: { S: photo.gallery },
            caption: { S: photo.caption },
            key: { S: photo.key },
            position: { N: String(photo.position) },
            createdAt: { S: photo.createdAt },
          },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    },

    // Returns false when the photo does not exist.
    async updatePhoto(id, { caption, position }) {
      const { sdk, client } = await load();
      const sets = [];
      const values = {};
      if (caption !== undefined) {
        sets.push("caption = :c");
        values[":c"] = { S: caption };
      }
      if (position !== undefined) {
        sets.push("#p = :p");
        values[":p"] = { N: String(position) };
      }
      try {
        await client.send(
          new sdk.UpdateItemCommand({
            TableName: env.CONTENT_TABLE,
            Key: { id: { S: PHOTO_PREFIX + id } },
            UpdateExpression: "SET " + sets.join(", "),
            ExpressionAttributeNames: position !== undefined ? { "#p": "position" } : undefined,
            ExpressionAttributeValues: values,
            ConditionExpression: "attribute_exists(id)",
          }),
        );
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },

    // Returns the stored file key, or null when the photo does not exist.
    async removePhoto(id) {
      const { sdk, client } = await load();
      try {
        const out = await client.send(
          new sdk.DeleteItemCommand({
            TableName: env.CONTENT_TABLE,
            Key: { id: { S: PHOTO_PREFIX + id } },
            ConditionExpression: "attribute_exists(id)",
            ReturnValues: "ALL_OLD",
          }),
        );
        return out.Attributes?.key?.S ?? "";
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async saveService(id, value, nowIso) {
      const { sdk, client } = await load();
      await client.send(
        new sdk.PutItemCommand({
          TableName: env.CONTENT_TABLE,
          Item: {
            id: { S: id },
            title: { S: value.title },
            summary: { S: value.summary },
            heading: { S: value.heading },
            intro: { S: value.intro },
            bullets: { L: value.bullets.map((b) => ({ S: b })) },
            updatedAt: { S: nowIso },
          },
        }),
      );
    },

    async resetService(id) {
      const { sdk, client } = await load();
      await client.send(new sdk.DeleteItemCommand({ TableName: env.CONTENT_TABLE, Key: { id: { S: id } } }));
    },

    async remove(id) {
      const { sdk, client } = await load();
      try {
        await client.send(
          new sdk.DeleteItemCommand({
            TableName: env.TABLE_NAME,
            Key: { id: { S: id } },
            ConditionExpression: "attribute_exists(id)",
          }),
        );
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
  };
}

// The private media bucket. CloudFront serves these files to visitors at /media/...
function s3Adapter(env) {
  let loaded;
  const load = async () => {
    if (!loaded) {
      const sdk = await import("@aws-sdk/client-s3");
      loaded = { sdk, client: new sdk.S3Client({}) };
    }
    return loaded;
  };
  return {
    async put(key, body, contentType) {
      const { sdk, client } = await load();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: env.MEDIA_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000, immutable", // every photo has its own unique name
        }),
      );
    },
    async remove(key) {
      const { sdk, client } = await load();
      await client.send(new sdk.DeleteObjectCommand({ Bucket: env.MEDIA_BUCKET, Key: key }));
    },
  };
}

// Photos of every gallery, in display order. Visitors get no internal fields.
function photoList(photos, forOwner) {
  return [...photos]
    .filter((p) => SERVICE_IDS.includes(p.gallery) && p.key)
    .sort((a, b) => a.position - b.position || (a.createdAt < b.createdAt ? -1 : 1))
    .map((p) => ({
      id: p.id,
      gallery: p.gallery,
      caption: p.caption,
      url: "/" + p.key,
      ...(forOwner ? { createdAt: p.createdAt } : {}),
    }));
}

// { ndt: {...}, equipment: {...} } of the services that have been edited; visitors get no internal fields.
function toMap(rows, forOwner) {
  const out = {};
  for (const row of rows) {
    if (!SERVICE_IDS.includes(row.id)) continue;
    const { id, updatedAt, ...text } = row;
    out[id] = forOwner ? { ...text, updatedAt } : text;
  }
  return out;
}

export function createHandler({ db, files, config, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  return async (event) => {
    try {
      const route = event?.routeKey;

      // Public: the Cognito app id and region are not secrets (they are visible to anyone signing in).
      if (route === "GET /api/auth-config") {
        return reply(200, { ok: true, region: config.region, clientId: config.clientId });
      }

      // Public: the edited service text that the website itself shows to visitors.
      if (route === "GET /api/content") {
        const content = await db.listContent();
        return reply(200, { ok: true, services: toMap(content.services, false), photos: photoList(content.photos, false) });
      }

      // API Gateway has already checked the token. Check again, so a misconfigured route can never leak data.
      const claims = event?.requestContext?.authorizer?.jwt?.claims;
      if (!claims?.sub) return reply(401, { ok: false, error: "Please sign in." });

      if (route === "GET /api/admin/inquiries") {
        const wanted = event.queryStringParameters?.status ?? "all";
        if (wanted !== "all" && !STATUSES.includes(wanted)) {
          return reply(400, { ok: false, error: "Unknown status." });
        }
        const statuses = wanted === "all" ? STATUSES : [wanted];
        const lists = await Promise.all(statuses.map((s) => db.listByStatus(s)));
        const items = lists.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        return reply(200, { ok: true, items });
      }

      if (route === "PATCH /api/admin/inquiries/{id}" || route === "DELETE /api/admin/inquiries/{id}") {
        const id = event.pathParameters?.id ?? "";
        if (!UUID_RE.test(id)) return reply(400, { ok: false, error: "Invalid enquiry id." });

        if (route.startsWith("DELETE")) {
          const found = await db.remove(id);
          return found ? reply(200, { ok: true }) : reply(400, { ok: false, error: "That enquiry no longer exists." });
        }

        let input;
        try {
          input = JSON.parse(event.body ?? "");
        } catch {
          return reply(400, { ok: false, error: "Invalid request." });
        }
        if (!input || !STATUSES.includes(input.status)) {
          return reply(400, { ok: false, error: "Status must be new or handled." });
        }
        const found = await db.setStatus(id, input.status, now().toISOString());
        return found
          ? reply(200, { ok: true, status: input.status })
          : reply(400, { ok: false, error: "That enquiry no longer exists." });
      }

      if (route === "GET /api/admin/content") {
        const content = await db.listContent();
        return reply(200, { ok: true, services: toMap(content.services, true), photos: photoList(content.photos, true) });
      }

      if (route === "PUT /api/admin/services/{id}" || route === "DELETE /api/admin/services/{id}") {
        const id = event.pathParameters?.id ?? "";
        if (!SERVICE_IDS.includes(id)) return reply(400, { ok: false, error: "Unknown service." });

        if (route.startsWith("DELETE")) {
          await db.resetService(id);
          return reply(200, { ok: true });
        }

        if ((event.body ?? "").length > MAX_BODY) return reply(400, { ok: false, error: "That is too much text." });
        let input;
        try {
          input = JSON.parse(event.body ?? "");
        } catch {
          return reply(400, { ok: false, error: "Invalid request." });
        }
        const checked = validateService(input);
        if (checked.error) return reply(400, { ok: false, error: checked.error });
        await db.saveService(id, checked.value, now().toISOString());
        return reply(200, { ok: true });
      }

      if (route === "POST /api/admin/photos") {
        if ((event.body ?? "").length > MAX_UPLOAD_BODY) return reply(400, { ok: false, error: "That photo is too large." });
        let input;
        try {
          input = JSON.parse(event.body ?? "");
        } catch {
          return reply(400, { ok: false, error: "Invalid request." });
        }
        const gallery = input?.gallery;
        if (!SERVICE_IDS.includes(gallery)) return reply(400, { ok: false, error: "Unknown gallery." });
        const caption = clean(input.caption ?? "");
        if (caption.length > 100) return reply(400, { ok: false, error: "A caption can have up to 100 characters." });
        if (typeof input.data !== "string" || !BASE64_RE.test(input.data)) return reply(400, { ok: false, error: "That is not a valid photo." });
        const bytes = Buffer.from(input.data, "base64");
        if (bytes.length > MAX_PHOTO_BYTES) return reply(400, { ok: false, error: "That photo is too large." });
        if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
          return reply(400, { ok: false, error: "Only JPEG photos can be uploaded." });
        }
        const existing = (await db.listContent()).photos.filter((p) => p.gallery === gallery);
        if (existing.length >= MAX_PHOTOS_PER_GALLERY) {
          return reply(400, { ok: false, error: "This gallery already has " + MAX_PHOTOS_PER_GALLERY + " photos. Delete one first." });
        }
        const id = newId();
        const key = "media/photos/" + id + ".jpg";
        const createdAt = now().toISOString();
        await files.put(key, bytes, "image/jpeg");
        try {
          await db.savePhoto({ id, gallery, caption, key, position: now().getTime(), createdAt });
        } catch (err) {
          await files.remove(key).catch(() => {});
          throw err;
        }
        return reply(200, { ok: true, photo: { id, gallery, caption, url: "/" + key } });
      }

      if (route === "PATCH /api/admin/photos/{id}" || route === "DELETE /api/admin/photos/{id}") {
        const id = event.pathParameters?.id ?? "";
        if (!UUID_RE.test(id)) return reply(400, { ok: false, error: "Invalid photo id." });
        const gone = { ok: false, error: "That photo no longer exists." };

        if (route.startsWith("DELETE")) {
          const key = await db.removePhoto(id);
          if (key === null) return reply(400, gone);
          if (key) await files.remove(key).catch((err) => console.error("Could not delete file", { name: err?.name }));
          return reply(200, { ok: true });
        }

        let input;
        try {
          input = JSON.parse(event.body ?? "");
        } catch {
          return reply(400, { ok: false, error: "Invalid request." });
        }
        const change = {};
        if (input?.caption !== undefined) {
          const caption = clean(input.caption);
          if (caption.length > 100) return reply(400, { ok: false, error: "A caption can have up to 100 characters." });
          change.caption = caption;
        }
        if (input?.first === true) {
          const all = (await db.listContent()).photos;
          const mine = all.find((p) => p.id === id);
          if (!mine) return reply(400, gone);
          const front = Math.min(...all.filter((p) => p.gallery === mine.gallery).map((p) => p.position));
          change.position = front - 1;
        }
        if (change.caption === undefined && change.position === undefined) return reply(400, { ok: false, error: "Nothing to change." });
        const found = await db.updatePhoto(id, change);
        return found ? reply(200, { ok: true }) : reply(400, gone);
      }

      return reply(400, { ok: false, error: "Unknown request." });
    } catch (err) {
      console.error("Admin request failed", { route: event?.routeKey, name: err?.name, message: err?.message });
      return reply(500, { ok: false, error: "Something went wrong. Please try again." });
    }
  };
}

export const handler = createHandler({
  db: dynamoAdapter(process.env),
  files: s3Adapter(process.env),
  config: { region: process.env.COGNITO_REGION, clientId: process.env.COGNITO_CLIENT_ID },
});
