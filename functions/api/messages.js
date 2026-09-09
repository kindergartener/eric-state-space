export async function onRequestGet(context) {
  const { results } = await context.env.DB.prepare(
    "SELECT id, name, url, message, created_at FROM messages ORDER BY created_at DESC, id DESC LIMIT 20"
  ).all();

  return Response.json(results);
}

async function verifyTurnstile(token, secret) {
  if (!token) return false;

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, response: token }),
  });
  const result = await response.json();
  return result.success === true;
}

const BLOCKLIST = ["viagra", "cialis", "casino", "xxx porn", "crypto airdrop"];

function containsBlockedTerm(message) {
  const lower = message.toLowerCase();
  return BLOCKLIST.some((term) => lower.includes(term));
}

function validate(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) return { error: "Message is required." };
  if (message.length > 100) return { error: "Message must be 100 characters or fewer." };
  if (name.length > 60) return { error: "Name must be 60 characters or fewer." };
  if (url && !/^https?:\/\//.test(url)) return { error: "Link must start with http:// or https://." };
  if (url.length > 300) return { error: "Link must be 300 characters or fewer." };

  return {
    name: name || "anonymous",
    url: url || null,
    message,
  };
}

export async function onRequestPost(context) {
  const body = await context.request.json();
  const validated = validate(body);
  if (validated.error) {
    return Response.json({ error: validated.error }, { status: 400 });
  }

  if (containsBlockedTerm(validated.message)) {
    return Response.json({ error: "Message rejected." }, { status: 400 });
  }

  const turnstileOk = await verifyTurnstile(body.turnstileToken, context.env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return Response.json({ error: "Verification failed. Please try again." }, { status: 400 });
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const row = await context.env.DB.prepare(
    "INSERT INTO messages (name, url, message, created_at) VALUES (?, ?, ?, ?) RETURNING id, name, url, message, created_at"
  ).bind(validated.name, validated.url, validated.message, createdAt).first();

  return Response.json(row, { status: 201 });
}
