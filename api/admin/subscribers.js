/**
 * GET /api/admin/subscribers — mail listesini görme.
 *
 * Yetkilendirme: `Authorization: Bearer ${ADMIN_SECRET}`
 *
 * Çağrı:
 *   curl https://goldbalance.ai/api/admin/subscribers \
 *     -H "Authorization: Bearer <ADMIN_SECRET>"
 *
 * Response:
 *   { total: N, subscribers: [{email, created_at, ip, user_agent}, ...] }
 *   created_at desc sıralı.
 */
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const emails = (await redis.smembers("subscribers")) || [];

    const subscribers = await Promise.all(
      emails.map(async (email) => {
        const data = await redis.hgetall(`subscriber:${email}`);
        return data || { email };
      }),
    );

    subscribers.sort((a, b) => {
      const ta = a && a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b && b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });

    return res.status(200).json({
      total: emails.length,
      subscribers,
    });
  } catch (error) {
    console.error("Admin endpoint error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};
