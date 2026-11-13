// Admin API for the owner. Routes (API Gateway checks the Cognito login before this code runs):
//   GET    /api/auth-config                 public: tells the admin page which Cognito app to sign in to
//   GET    /api/admin/inquiries?status=...  list enquiries (new | handled | all)
//   PATCH  /api/admin/inquiries/{id}        set status to "new" or "handled"
//   DELETE /api/admin/inquiries/{id}        delete an enquiry
//
// Never answer 403 or 404 from here: CloudFront rewrites those two codes to the website's index.html.

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const STATUSES = ["new", "handled"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_LIMIT = 200;

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

export function createHandler({ db, config, now = () => new Date() }) {
  return async (event) => {
    try {
      const route = event?.routeKey;

      // Public: the Cognito app id and region are not secrets (they are visible to anyone signing in).
      if (route === "GET /api/auth-config") {
        return reply(200, { ok: true, region: config.region, clientId: config.clientId });
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
