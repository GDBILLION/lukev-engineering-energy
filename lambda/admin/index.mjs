// Admin API for the owner. Routes (API Gateway checks the Cognito login before this code runs):
//   GET    /api/auth-config                 public: tells the admin page which Cognito app to sign in to
//   GET    /api/admin/inquiries?status=...  list enquiries (new | handled | all)
//   PATCH  /api/admin/inquiries/{id}        set status to "new" or "handled"
//   DELETE /api/admin/inquiries/{id}        delete an enquiry
//   GET    /api/content                     public: the edited service text the website shows
//   GET    /api/admin/content               the same, for the admin screen
//   PUT    /api/admin/services/{id}         save the text of one service (ndt | equipment | solar)
//   DELETE /api/admin/services/{id}         forget the edits, so the website shows its built-in text again
//
// Never answer 403 or 404 from here: CloudFront rewrites those two codes to the website's index.html.

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const STATUSES = ["new", "handled"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_LIMIT = 200;

const SERVICE_IDS = ["ndt", "equipment", "solar"];
const MAX_BODY = 20000;

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

    // Edited service text. Each service is one small item in the content table.
    async listServices() {
      const { sdk, client } = await load();
      const out = await client.send(new sdk.ScanCommand({ TableName: env.CONTENT_TABLE }));
      return (out.Items ?? []).map((item) => ({
        id: item.id?.S ?? "",
        title: item.title?.S ?? "",
        summary: item.summary?.S ?? "",
        heading: item.heading?.S ?? "",
        intro: item.intro?.S ?? "",
        bullets: (item.bullets?.L ?? []).map((b) => b.S ?? ""),
        updatedAt: item.updatedAt?.S ?? "",
      }));
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

export function createHandler({ db, config, now = () => new Date() }) {
  return async (event) => {
    try {
      const route = event?.routeKey;

      // Public: the Cognito app id and region are not secrets (they are visible to anyone signing in).
      if (route === "GET /api/auth-config") {
        return reply(200, { ok: true, region: config.region, clientId: config.clientId });
      }

      // Public: the edited service text that the website itself shows to visitors.
      if (route === "GET /api/content") {
        return reply(200, { ok: true, services: toMap(await db.listServices(), false) });
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
        return reply(200, { ok: true, services: toMap(await db.listServices(), true) });
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

      return reply(400, { ok: false, error: "Unknown request." });
    } catch (err) {
      console.error("Admin request failed", { route: event?.routeKey, name: err?.name, message: err?.message });
      return reply(500, { ok: false, error: "Something went wrong. Please try again." });
    }
  };
}

export const handler = createHandler({
  db: dynamoAdapter(process.env),
  config: { region: process.env.COGNITO_REGION, clientId: process.env.COGNITO_CLIENT_ID },
});
