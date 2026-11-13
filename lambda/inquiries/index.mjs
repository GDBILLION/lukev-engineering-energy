// POST /api/inquiries
// Validates the website enquiry form, stores it in DynamoDB, then emails a notification through SES.
// The AWS SDK v3 is already included in the Node.js Lambda runtime, so nothing needs to be installed.

import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 20 * 1024;
const MIN_FILL_MS = 1500; // a human needs more than this to fill the form

const LIMITS = { name: 100, email: 254, company: 150, service: 100, details: 5000 };
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

// Remove control characters; keep normal text and newlines (for the details field only).
const clean = (value, { multiline = false } = {}) => {
  if (typeof value !== "string") return "";
  const re = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return value.replace(re, " ").trim();
};

export function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Invalid request." };
  }

  // Bot traps: a hidden field real visitors never fill, and a form that was submitted too fast.
  const trapped =
    (typeof input.website === "string" && input.website.trim() !== "") ||
    (typeof input.elapsedMs === "number" && input.elapsedMs < MIN_FILL_MS);
  if (trapped) return { bot: true };

  const data = {
    name: clean(input.name),
    email: clean(input.email).toLowerCase(),
    company: clean(input.company),
    service: clean(input.service),
    details: clean(input.details, { multiline: true }),
  };

  for (const [field, max] of Object.entries(LIMITS)) {
    if (data[field].length > max) return { error: `The ${field} field is too long.` };
  }
  if (!data.name) return { error: "Please enter your name." };
  if (!data.email || !EMAIL_RE.test(data.email)) return { error: "Please enter a valid email address." };
  if (!data.service) return { error: "Please choose a service." };

  return { data };
}

function notificationMessage(item) {
  const lines = [
    "A new enquiry was submitted on the LUKEV website.",
    "",
    `Name:    ${item.name}`,
    `Email:   ${item.email}`,
    `Company: ${item.company || "-"}`,
    `Service: ${item.service}`,
    "",
    "Details:",
    item.details || "-",
    "",
    `Reference: ${item.id}`,
    `Received:  ${item.createdAt}`,
    "",
    "Reply to this email to answer the customer directly.",
  ];
  return lines.join("\n");
}

// Real AWS calls. The SDK is loaded only when needed, which keeps local tests free of dependencies.
function awsAdapters(env) {
  let ddb;
  let ses;
  return {
    async putItem(item) {
      const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      ddb ??= new DynamoDBClient({});
      const Item = {};
      for (const [key, value] of Object.entries(item)) {
        if (value !== "" && value !== undefined) Item[key] = { S: String(value) };
      }
      await ddb.send(
        new PutItemCommand({
          TableName: env.TABLE_NAME,
          Item,
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    },
    async sendEmail(item) {
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      ses ??= new SESv2Client({});
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: env.SES_FROM,
          Destination: { ToAddresses: [env.NOTIFY_TO] },
          ReplyToAddresses: [item.email],
          Content: {
            Simple: {
              Subject: { Data: `New website enquiry: ${item.service} - ${item.name}`.slice(0, 150) },
              Body: { Text: { Data: notificationMessage(item) } },
            },
          },
        }),
      );
    },
  };
}

export function createHandler({ putItem, sendEmail, now = () => new Date(), newId = randomUUID }) {
  return async (event) => {
    try {
      const method = event?.requestContext?.http?.method;
      if (method && method !== "POST") return reply(405, { ok: false, error: "Method not allowed." });

      let raw = event?.body ?? "";
      if (event?.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
        return reply(413, { ok: false, error: "The message is too large." });
      }

      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply(400, { ok: false, error: "Invalid request." });
      }

      const result = validate(input);
      if (result.error) return reply(400, { ok: false, error: result.error });
      // Bots get the same friendly answer, but nothing is stored or emailed.
      if (result.bot) return reply(200, { ok: true });

      const item = {
        id: newId(),
        createdAt: now().toISOString(),
        status: "new",
        ...result.data,
      };

      await putItem(item);

      // The enquiry is already saved. A failed email must not make the visitor think it was lost.
      try {
        await sendEmail(item);
      } catch (err) {
        console.error("Notification email failed", { id: item.id, name: err?.name, message: err?.message });
      }

      return reply(200, { ok: true, id: item.id });
    } catch (err) {
      console.error("Enquiry failed", { name: err?.name, message: err?.message });
      return reply(500, { ok: false, error: "Something went wrong. Please try again or email us directly." });
    }
  };
}

export const handler = createHandler(awsAdapters(process.env));
