/**
 * GET /api/unsubscribe?email=...&token=... — listeden çıkarma endpoint'i.
 *
 * Token: HMAC-SHA256(email, ADMIN_SECRET) ilk 32 hex char.
 *   - Deterministik: aynı email+secret → aynı token. Expiry yok.
 *   - Brute force imkansız (HMAC), token sızsa bile yalnız o email için çalışır.
 *   - ADMIN_SECRET rotate edilirse tüm unsub linkleri geçersizleşir.
 *
 * RFC 8058 / Gmail Şubat 2024: List-Unsubscribe-Post bu endpoint'e
 * `application/x-www-form-urlencoded` POST atar (Gmail one-click).
 * GET de elle tıklamaya açıktır; ikisini de kabul ediyoruz.
 *
 * Env: KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_SECRET
 */
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function expectedToken(email) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_SECRET || "")
    .update(email.toLowerCase().trim())
    .digest("hex")
    .substring(0, 32);
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(type, data) {
  const isSuccess = type === "success";
  const title = isSuccess ? "Listeden çıktın" : "Hata";
  const heading = isSuccess
    ? "✓ Listeden çıkarıldın"
    : "Bağlantı geçersiz";
  const body = isSuccess
    ? `<p><span class="email">${htmlEscape(data)}</span> artık GOLD BALANCE listesinde değil.</p>
       <p>Bundan sonra senden mail göndermeyeceğiz.</p>
       <p class="small">Fikrini değiştirirsen <a href="https://www.goldbalance.ai">goldbalance.ai</a> sitesinden tekrar kayıt olabilirsin.</p>`
    : `<p>${htmlEscape(data)}</p>
       <p class="small"><a href="https://www.goldbalance.ai">Ana sayfaya dön</a></p>`;

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} — GOLD BALANCE</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Arial, sans-serif;
         background:#0a0a0a; color:#fff; margin:0; padding:40px 20px; min-height:100vh;
         display:flex; align-items:center; justify-content:center; }
  .container { max-width:480px; text-align:center; }
  h1 { color:#FFD700; font-size:28px; margin:0 0 16px; }
  p { color:#cccccc; line-height:1.6; font-size:16px; margin:12px 0; }
  .email { color:#FFD700; font-weight:600; }
  a { color:#FFD700; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .small { color:#888888; font-size:13px; margin-top:32px; }
  .brand { color:#FFD700; font-size:14px; letter-spacing:2px; margin-bottom:24px; opacity:0.7; }
</style>
</head>
<body>
  <div class="container">
    <div class="brand">GOLD BALANCE</div>
    <h1>${heading}</h1>
    ${body}
  </div>
</body>
</html>`;
}

async function processUnsubscribe(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const wasSubscribed = await redis.sismember("subscribers", normalizedEmail);
  if (wasSubscribed) {
    await redis.srem("subscribers", normalizedEmail);
    await redis.sadd("unsubscribed", normalizedEmail);
    await redis.hset(`subscriber:${normalizedEmail}`, {
      unsubscribed_at: new Date().toISOString(),
    });
  }
  return normalizedEmail;
}

module.exports = async (req, res) => {
  // GET (link tıklama) ve POST (RFC 8058 one-click) ikisini de kabul et.
  const method = req.method || "GET";
  if (method !== "GET" && method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send(renderPage("error", "İzin verilmeyen yöntem"));
  }

  const email = (req.query && req.query.email) || "";
  const token = (req.query && req.query.token) || "";

  if (!email || !token) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(renderPage("error", "Geçersiz bağlantı"));
  }

  // Token doğrulama — sabit zaman karşılaştırma (timing attack koruması).
  const expected = expectedToken(email);
  let valid = false;
  try {
    valid =
      token.length === expected.length &&
      crypto.timingSafeEqual(
        Buffer.from(token, "utf8"),
        Buffer.from(expected, "utf8"),
      );
  } catch {
    valid = false;
  }

  if (!valid) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res
      .status(403)
      .send(renderPage("error", "Bağlantı geçersiz veya süresi dolmuş"));
  }

  try {
    const normalizedEmail = await processUnsubscribe(email);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderPage("success", normalizedEmail));
  } catch (error) {
    console.error("Unsubscribe error:", error);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res
      .status(500)
      .send(
        renderPage(
          "error",
          "Bir hata oluştu, lütfen daha sonra tekrar deneyin",
        ),
      );
  }
};
