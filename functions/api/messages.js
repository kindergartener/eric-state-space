export async function onRequestGet(context) {
  const { results } = await context.env.DB.prepare(
    "SELECT id, name, url, message, created_at FROM messages ORDER BY created_at DESC, id DESC LIMIT 20"
  ).all();

  return Response.json(results);
}
