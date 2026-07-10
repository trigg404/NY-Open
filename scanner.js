/**
 * Pre-NY-Open Sentiment Scanner — ES / NQ / YM
 * ============================================
 * Every weekday at BRIEFING_HOUR ET (default 8:00 AM), aggregates:
 *   • ES / NQ / YM overnight futures action
 *   • VIX level + direction
 *   • Asia session results (Nikkei, Hang Seng)
 *   • Europe mid-session (DAX, FTSE)
 *   • Dollar Index + 10Y Treasury yield
 * ...scores it into a risk-on/risk-off lean, and sends a Telegram briefing.
 *
 * This AGGREGATES observable data. It does not predict the future.
 *
 * Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BRIEFING_HOUR (optional, ET hour, default 8)
 */

require("dotenv").config();
const https = require("https");

const CONFIG = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  briefingHourET: parseInt(process.env.BRIEFING_HOUR || "8"), // 8 = 8:00 AM ET
};

// ─── Instruments ──────────────────────────────────────────────────────────────
const INSTRUMENTS = {
  futures: [
    { symbol: "ES=F", name: "S&P 500 (ES)" },
    { symbol: "NQ=F", name: "Nasdaq (NQ)" },
    { symbol: "YM=F", name: "Dow (YM)" },
  ],
  risk: [
    { symbol: "^VIX", name: "VIX" },
  ],
  asia: [
    { symbol: "^N225", name: "Nikkei 225" },
    { symbol: "^HSI", name: "Hang Seng" },
  ],
  europe: [
    { symbol: "^GDAXI", name: "DAX" },
    { symbol: "^FTSE", name: "FTSE 100" },
  ],
  macro: [
    { symbol: "DX-Y.NYB", name: "Dollar Index" },
    { symbol: "^TNX", name: "10Y Yield" },
  ],
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed (${url.slice(0, 60)}...)`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── Quote fetcher (Yahoo Finance, with endpoint fallback) ───────────────────
async function fetchQuote(symbol) {
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
  ];
  for (const url of endpoints) {
    try {
      const data = await httpGet(url);
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      if (price == null) continue;

      // meta.chartPreviousClose / meta.previousClose have proven unreliable
      // (observed wrong-signed % changes vs verified real closes even when
      // the price level itself was correct). Compute prevClose from the
      // actual historical close-price series instead — far more trustworthy.
      const closes = result.indicators?.quote?.[0]?.close || [];
      const validCloses = closes.filter(c => c != null);

      let prevClose = null;
      if (validCloses.length >= 2) {
        // Last entry may be today's still-forming candle (~= current price);
        // the one before it is the last fully-closed session.
        const last = validCloses[validCloses.length - 1];
        const secondLast = validCloses[validCloses.length - 2];
        prevClose = Math.abs(last - price) < Math.abs(secondLast - price) ? secondLast : last;
      } else {
        // Fallback only if the historical series wasn't usable
        prevClose = meta.chartPreviousClose ?? meta.previousClose;
      }
      if (prevClose == null || prevClose === 0) continue;

      const changePct = ((price - prevClose) / prevClose) * 100;
      return {
        price,
        prevClose,
        changePct,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
      };
    } catch (e) { /* try next endpoint */ }
  }
  return null;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
function scoreSentiment(quotes) {
  let score = 0;
  const signals = [];

  const es = quotes["ES=F"];
  const nq = quotes["NQ=F"];
  const ym = quotes["YM=F"];
  const vix = quotes["^VIX"];
  const nikkei = quotes["^N225"];
  const hsi = quotes["^HSI"];
  const dax = quotes["^GDAXI"];
  const ftse = quotes["^FTSE"];
  const dxy = quotes["DX-Y.NYB"];
  const tnx = quotes["^TNX"];

  // Futures overnight action (weight: heavy)
  for (const [q, label] of [[es, "ES"], [nq, "NQ"], [ym, "YM"]]) {
    if (!q) continue;
    if (q.changePct > 0.3) { score += 2; signals.push(`${label} up strong overnight (+${q.changePct.toFixed(2)}%)`); }
    else if (q.changePct > 0.1) { score += 1; signals.push(`${label} mildly positive (+${q.changePct.toFixed(2)}%)`); }
    else if (q.changePct < -0.3) { score -= 2; signals.push(`${label} down hard overnight (${q.changePct.toFixed(2)}%)`); }
    else if (q.changePct < -0.1) { score -= 1; signals.push(`${label} mildly negative (${q.changePct.toFixed(2)}%)`); }
  }

  // VIX (weight: heavy, inverted)
  if (vix) {
    if (vix.changePct > 5) { score -= 3; signals.push(`VIX spiking +${vix.changePct.toFixed(1)}% — fear rising`); }
    else if (vix.changePct > 2) { score -= 1; signals.push(`VIX elevated +${vix.changePct.toFixed(1)}%`); }
    else if (vix.changePct < -3) { score += 2; signals.push(`VIX falling ${vix.changePct.toFixed(1)}% — fear easing`); }
    if (vix.price > 25) { score -= 2; signals.push(`VIX absolute level high (${vix.price.toFixed(1)})`); }
    else if (vix.price < 14) { score += 1; signals.push(`VIX complacent-low (${vix.price.toFixed(1)})`); }
  }

  // Asia (weight: medium)
  for (const [q, label] of [[nikkei, "Nikkei"], [hsi, "Hang Seng"]]) {
    if (!q) continue;
    if (q.changePct > 0.5) { score += 1; signals.push(`${label} closed strong (+${q.changePct.toFixed(2)}%)`); }
    else if (q.changePct < -0.5) { score -= 1; signals.push(`${label} closed weak (${q.changePct.toFixed(2)}%)`); }
  }

  // Europe (weight: medium — still trading during our briefing)
  for (const [q, label] of [[dax, "DAX"], [ftse, "FTSE"]]) {
    if (!q) continue;
    if (q.changePct > 0.5) { score += 1; signals.push(`${label} trading strong (+${q.changePct.toFixed(2)}%)`); }
    else if (q.changePct < -0.5) { score -= 1; signals.push(`${label} trading weak (${q.changePct.toFixed(2)}%)`); }
  }

  // Macro pressure (weight: light)
  if (dxy && dxy.changePct > 0.4) { score -= 1; signals.push(`Dollar bid (+${dxy.changePct.toFixed(2)}%) — mild risk-off`); }
  if (tnx && tnx.changePct > 2) { score -= 1; signals.push(`10Y yield jumping (+${tnx.changePct.toFixed(1)}%) — rates pressure`); }

  let lean, emoji;
  if (score >= 5) { lean = "RISK-ON — Bullish lean"; emoji = "🟢"; }
  else if (score >= 2) { lean = "Mildly risk-on"; emoji = "🟢"; }
  else if (score <= -5) { lean = "RISK-OFF — Bearish lean"; emoji = "🔴"; }
  else if (score <= -2) { lean = "Mildly risk-off"; emoji = "🔴"; }
  else { lean = "NEUTRAL / Mixed"; emoji = "⚪"; }

  return { score, lean, emoji, signals };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
      console.warn("⚠️  Telegram not configured.");
      return resolve();
    }
    const body = JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text,
      parse_mode: "Markdown",
      disable_notification: false,
    });
    const req = https.request(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const r = JSON.parse(data);
            if (r.ok) console.log("✅ Briefing sent to Telegram");
            else console.error("❌ Telegram:", r.description);
          } catch (e) {}
          resolve();
        });
      }
    );
    req.on("error", (e) => { console.error("Telegram error:", e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── Build & send the briefing ────────────────────────────────────────────────
function fmt(q, invertColor = false) {
  if (!q) return "  _(unavailable)_";
  const up = q.changePct >= 0;
  const arrow = up ? "▲" : "▼";
  const good = invertColor ? !up : up;
  const dot = good ? "🟢" : "🔴";
  return `${dot} ${arrow} ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%  (${q.price.toLocaleString("en-US", { maximumFractionDigits: 2 })})`;
}

async function runBriefing() {
  console.log(`\n📡 Fetching pre-open data... ${new Date().toISOString()}`);

  const allSymbols = Object.values(INSTRUMENTS).flat();
  const quotes = {};
  // Fetch sequentially with tiny gaps to be polite to the API
  for (const inst of allSymbols) {
    quotes[inst.symbol] = await fetchQuote(inst.symbol);
    await new Promise(r => setTimeout(r, 300));
  }

  const fetched = Object.values(quotes).filter(Boolean).length;
  console.log(`   ${fetched}/${allSymbols.length} instruments fetched`);

  if (fetched === 0) {
    console.error("❌ No data fetched — data provider may be blocking this server's IP.");
    await sendTelegram("⚠️ *Pre-open briefing failed* — no market data available this morning (data provider unreachable).");
    return;
  }

  const { score, lean, emoji, signals } = scoreSentiment(quotes);

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York",
  });

  const msg =
    `📊 *PRE-OPEN BRIEFING — ${dateStr}*\n` +
    `_${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET_\n\n` +
    `*Overnight Futures*\n` +
    `ES:  ${fmt(quotes["ES=F"])}\n` +
    `NQ: ${fmt(quotes["NQ=F"])}\n` +
    `YM: ${fmt(quotes["YM=F"])}\n\n` +
    `*Risk Gauge*\n` +
    `VIX: ${fmt(quotes["^VIX"], true)}\n\n` +
    `*Asia (closed)*\n` +
    `Nikkei: ${fmt(quotes["^N225"])}\n` +
    `Hang Seng: ${fmt(quotes["^HSI"])}\n\n` +
    `*Europe (live)*\n` +
    `DAX: ${fmt(quotes["^GDAXI"])}\n` +
    `FTSE: ${fmt(quotes["^FTSE"])}\n\n` +
    `*Macro*\n` +
    `DXY: ${fmt(quotes["DX-Y.NYB"], true)}\n` +
    `10Y: ${fmt(quotes["^TNX"], true)}\n\n` +
    `${emoji} *SENTIMENT: ${lean}*  _(score: ${score >= 0 ? "+" : ""}${score})_\n\n` +
    (signals.length ? `*Key signals:*\n${signals.map(s => `• ${s}`).join("\n")}\n\n` : "") +
    `_Informational aggregation of observable data — not financial advice or a prediction._`;

  await sendTelegram(msg);
  console.log(`   Sentiment: ${lean} (score ${score})`);
}

// ─── Scheduler — fire once per weekday at the target ET hour ──────────────────
let lastSentDate = null;

function checkSchedule() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  const dateKey = et.toDateString();

  if (day === 0 || day === 6) return;                    // weekends off
  if (et.getHours() !== CONFIG.briefingHourET) return;   // not the hour yet
  if (lastSentDate === dateKey) return;                  // already sent today

  lastSentDate = dateKey;
  runBriefing();
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════");
console.log("  Pre-NY-Open Sentiment Scanner — ES / NQ / YM");
console.log(`  Briefing time: ${CONFIG.briefingHourET}:00 AM ET, weekdays`);
console.log("══════════════════════════════════════════════");

if (process.argv.includes("--now")) {
  // Manual test run: node scanner.js --now
  runBriefing();
} else {
  console.log("⏰ Waiting for scheduled briefing time... (run with --now to test immediately)");
  checkSchedule();
  setInterval(checkSchedule, 60 * 1000); // check every minute
}
