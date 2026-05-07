/**
 * POST /api/subscribe — landing page mail listesi endpoint'i.
 *
 * Vercel Node.js Function (plain HTML repo, build adımı yok).
 *
 * Akış:
 *   1. Honeypot bot check (sessizce yut)
 *   2. Email validation (regex)
 *   3. Rate limit (IP başına saatte 5 deneme)
 *   4. Duplicate check
 *   5. KV'ye ekle (subscribers Set + subscriber:<email> Hash)
 *   6. Kullanıcıya hoş geldin maili (Resend, fail tolerant)
 *   7. Admin'e bildirim maili (Resend, fail tolerant)
 *
 * Env: KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY, ADMIN_EMAIL
 */
const { Redis } = require("@upstash/redis");
const { Resend } = require("resend");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  return "unknown";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // Vercel Node Functions otomatik JSON parse eder, ama bazı durumlarda string gelir.
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ ok: false, error: "Geçersiz istek" });
      }
    }
    if (!body || typeof body !== "object") {
      return res.status(400).json({ ok: false, error: "Geçersiz istek" });
    }

    const { email, honeypot } = body;

    // 1. Honeypot bot check — botlar görünmez input'u dolduracak.
    if (honeypot && String(honeypot).trim() !== "") {
      return res.status(200).json({ ok: true });
    }

    // 2. Email validation
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res
        .status(400)
        .json({ ok: false, error: "Geçerli bir e-posta adresi girin" });
    }
    const normalizedEmail = email.toLowerCase().trim();

    // 3. Rate limit (IP başına saatte 5 deneme)
    const ip = getClientIp(req);
    const rateKey = `rate:${ip}`;
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 3600);
    }
    if (count > 5) {
      return res.status(429).json({
        ok: false,
        error: "Çok fazla deneme, 1 saat sonra tekrar dene",
      });
    }

    // 4. Duplicate check
    const exists = await redis.sismember("subscribers", normalizedEmail);
    if (exists) {
      return res.status(200).json({
        ok: true,
        message: "Zaten kayıtlısın, lansmanda haber vereceğiz",
      });
    }

    // 5. KV'ye ekle
    await redis.sadd("subscribers", normalizedEmail);
    await redis.hset(`subscriber:${normalizedEmail}`, {
      email: normalizedEmail,
      created_at: new Date().toISOString(),
      ip,
      user_agent: req.headers["user-agent"] || "",
    });

    const total = await redis.scard("subscribers");

    // 6. Kullanıcıya hoş geldin maili (fail tolerant)
    try {
      await resend.emails.send({
        from: "GOLD BALANCE <noreply@goldbalance.ai>",
        to: normalizedEmail,
        subject: "Hoş geldin! GOLD BALANCE'a kaydoldun",
        replyTo: "goldbalance.business@gmail.com",
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#0a0a0a;color:#ffffff;border-radius:12px;">
            <h1 style="color:#FFD700;margin:0 0 16px;font-size:32px;">GOLD BALANCE</h1>
            <p style="color:#cccccc;font-size:16px;line-height:1.6;">Merhaba,</p>
            <p style="color:#cccccc;font-size:16px;line-height:1.6;">
              Lansman listemize eklendin. Türkiye'nin akıllı piyasa platformu hazır olduğunda
              <strong style="color:#FFD700;">ilk sen haberdar olacaksın</strong>.
            </p>
            <div style="background:#1a1a1a;border-left:3px solid #FFD700;padding:16px;margin:24px 0;border-radius:4px;">
              <p style="margin:0 0 8px;color:#FFD700;font-weight:600;">Bu süreçte seni bekleyenler:</p>
              <ul style="color:#cccccc;margin:0;padding-left:20px;line-height:1.8;">
                <li>Lansmanda 14 gün ücretsiz Pro deneme (kart bilgisi gerektirmez)</li>
                <li>Anlık fiyat takibi ve canlı haber akışı</li>
                <li>Akıllı risk analizi ve profesyonel hesaplayıcılar</li>
              </ul>
            </div>
            <p style="color:#888888;font-size:13px;margin-top:32px;line-height:1.5;">
              Yatırım tavsiyesi değildir. Bu maili istemediysen yok say veya
              <a href="mailto:goldbalance.business@gmail.com" style="color:#FFD700;text-decoration:none;">bize ulaş</a>.
            </p>
            <p style="color:#555555;font-size:12px;margin-top:16px;">
              © 2026 GOLD BALANCE · goldbalance.ai
            </p>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Welcome email failed:", emailError);
    }

    // 7. Admin'e bildirim (fail tolerant)
    try {
      await resend.emails.send({
        from: "GOLD BALANCE Bot <noreply@goldbalance.ai>",
        to: process.env.ADMIN_EMAIL,
        subject: `🎯 Yeni kayıt: ${normalizedEmail} (toplam: ${total})`,
        html: `
          <h2>Yeni mail listesi kaydı</h2>
          <p><strong>Email:</strong> ${normalizedEmail}</p>
          <p><strong>IP:</strong> ${ip}</p>
          <p><strong>Tarih:</strong> ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}</p>
          <p><strong>User-Agent:</strong> ${req.headers["user-agent"] || "unknown"}</p>
          <hr>
          <p style="font-size:18px;"><strong>Toplam abone: ${total}</strong></p>
        `,
      });
    } catch (adminError) {
      console.error("Admin notification failed:", adminError);
    }

    return res.status(200).json({
      ok: true,
      message: "Teşekkürler! Lansman duyurusunda haber edeceğiz.",
      total,
    });
  } catch (error) {
    console.error("Subscribe endpoint error:", error);
    return res
      .status(500)
      .json({ ok: false, error: "Bir hata oluştu, lütfen tekrar dene" });
  }
};
