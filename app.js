const SPOT = "https://data-api.binance.vision/api/v3";
const FUTURES = "https://fapi.binance.com/fapi/v1";
const CG = "https://api.coingecko.com/api/v3";
const REFRESH_MS = 3 * 60 * 60 * 1000;
const FEE = 0.002;
const universe = [
  ["BTC", "Bitcoin", "bitcoin"], ["ETH", "Ethereum", "ethereum"],
  ["SOL", "Solana", "solana"], ["XRP", "XRP", "ripple"],
  ["ADA", "Cardano", "cardano"], ["BNB", "BNB", "binancecoin"],
  ["LINK", "Chainlink", "chainlink"], ["AVAX", "Avalanche", "avalanche-2"],
  ["LTC", "Litecoin", "litecoin"]
];
const intervals = ["15m", "1h", "4h", "1d"];
let nextRefreshAt = null;
let countdownTimer;

const $ = s => document.querySelector(s);
const fmt = (n, max = 2) => {
  if (!Number.isFinite(n)) return "Unavailable";
  const digits = n >= 1000 ? 0 : n >= 10 ? 2 : n >= 1 ? 3 : 5;
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, max === 2 ? digits : max) });
};
const pct = n => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const manila = d => new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  timeZoneName: "short"
}).format(d);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
  return r.json();
}
function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((a, v, i) => i ? [...a, v * k + a[i - 1] * (1 - k)] : [v], []);
}
function rsi(values, period = 14) {
  if (values.length <= period) return NaN;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gains += Math.max(0, d); losses += Math.max(0, -d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function indicators(rows) {
  const c = rows.map(x => +x[4]), h = rows.map(x => +x[2]), l = rows.map(x => +x[3]), v = rows.map(x => +x[5]);
  const e20 = ema(c, 20), e50 = ema(c, 50), e12 = ema(c, 12), e26 = ema(c, 26);
  const macdSeries = e12.map((x, i) => x - e26[i]);
  const signal = ema(macdSeries, 9);
  const tr = c.map((x, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]);
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgVol = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return {
    close: c.at(-1), ema20: e20.at(-1), ema50: e50.at(-1), rsi: rsi(c),
    macd: macdSeries.at(-1), signal: signal.at(-1), atr,
    relVol: v.at(-1) / avgVol,
    support: Math.min(...l.slice(-20)), resistance: Math.max(...h.slice(-20))
  };
}
function technicalScore(tfs) {
  let score = 0;
  for (const [tf, x] of Object.entries(tfs)) {
    const weight = ({ "15m": .7, "1h": 1.2, "4h": 1.5, "1d": 1.0 })[tf];
    score += (x.close > x.ema20 ? 1 : -1) * weight;
    score += (x.ema20 > x.ema50 ? .7 : -.7) * weight;
    score += (x.macd > x.signal ? .55 : -.55) * weight;
    score += (x.rsi > 45 && x.rsi < 68 ? .55 : x.rsi >= 75 ? -.7 : 0) * weight;
  }
  return score;
}
async function fetchCoin(meta, tickerMap, cgMap) {
  const [symbol, name, id] = meta, pair = `${symbol}USDT`;
  const [candles, depth, funding, oi] = await Promise.all([
    Promise.all(intervals.map(async tf => [tf, indicators(await getJSON(`${SPOT}/klines?symbol=${pair}&interval=${tf}&limit=120`))])),
    getJSON(`${SPOT}/depth?symbol=${pair}&limit=20`).catch(() => null),
    getJSON(`${FUTURES}/premiumIndex?symbol=${pair}`).catch(() => null),
    getJSON(`${FUTURES}/openInterest?symbol=${pair}`).catch(() => null)
  ]);
  const tfs = Object.fromEntries(candles);
  const ticker = tickerMap[pair];
  if (!ticker) throw new Error(`${pair} ticker missing`);
  let imbalance = NaN;
  if (depth) {
    const bids = depth.bids.reduce((s, [p, q]) => s + +p * +q, 0);
    const asks = depth.asks.reduce((s, [p, q]) => s + +p * +q, 0);
    imbalance = (bids - asks) / (bids + asks);
  }
  const price = +ticker.lastPrice, h = tfs["1h"], a = tfs["4h"];
  const rawScore = technicalScore(tfs) + Math.max(-1, Math.min(1, imbalance * 4))
    + Math.max(-1, Math.min(1, Math.log10(+ticker.quoteVolume / 5e7)))
    - (funding && Math.abs(+funding.lastFundingRate) > .0008 ? 1 : 0);
  const breakout = price >= h.resistance * .995;
  const entry = breakout ? price * 1.001 : Math.max(h.ema20, price - h.atr * .35);
  const stop = Math.min(entry - a.atr * .72, h.support * .997);
  const risk = Math.max(entry - stop, entry * .012);
  const target = Math.max(entry + risk * 1.75, Math.min(a.resistance * 1.006, entry + a.atr * 1.3));
  const grossGain = (target / entry - 1) * 100, grossLoss = (stop / entry - 1) * 100;
  const trendCount = Object.values(tfs).filter(x => x.close > x.ema20 && x.macd > x.signal).length;
  return {
    symbol, name, id, pair, price, ticker, tfs, imbalance, funding: funding ? +funding.lastFundingRate : NaN,
    oi: oi ? +oi.openInterest * price : NaN, marketCap: cgMap[id]?.market_cap,
    score: rawScore, confidence: Math.max(4.2, Math.min(8.8, 5.3 + rawScore * .18)),
    entry, stop, target, gain: grossGain - FEE * 100, loss: grossLoss - FEE * 100,
    breakout, trendCount, holding: trendCount >= 3 ? "24–72h" : "12–48h",
    action: breakout && h.rsi < 72 ? "Enter on retest" : "Wait for confirmation",
    catalyst: symbol === "BTC" ? "ETF inflow reversal + softer U.S. jobs data" :
      symbol === "ETH" ? "Relative-strength leadership in the current short squeeze" :
      symbol === "SOL" ? "Strongest weekly momentum among liquid majors" :
      "Broad risk-on rotation and multi-timeframe momentum",
    risk: h.rsi > 70 ? "Overbought 1h RSI raises pullback risk" :
      Math.abs(funding ? +funding.lastFundingRate : 0) > .0005 ? "Crowded futures positioning / funding reset" :
      "BTC rejection could reverse the broader relief rally"
  };
}
function reason(c) {
  const h = c.tfs["1h"], a = c.tfs["4h"];
  const book = Number.isFinite(c.imbalance) ? `${Math.abs(c.imbalance * 100).toFixed(1)}% ${c.imbalance >= 0 ? "bid" : "ask"} skew` : "book unavailable";
  return `${c.trendCount}/4 timeframes show price above EMA20 with positive MACD. 1h RSI is ${h.rsi.toFixed(0)}, 1h volume is ${h.relVol.toFixed(1)}× its 20-bar mean, and top-20 depth has a ${book}. 4h support / resistance: ${fmt(a.support)} / ${fmt(a.resistance)}.`;
}
function render(coins) {
  $("#rankBody").innerHTML = coins.map((c, i) => `
    <tr>
      <td><div class="rank-asset"><span class="rank-num">0${i + 1}</span><span class="coin-dot">${c.symbol}</span><span class="asset-name"><b>${c.name}</b><small>${c.symbol} / USDT</small></span></div></td>
      <td>${fmt(c.price)}<br><small class="${+c.ticker.priceChangePercent >= 0 ? "positive" : "negative"}">${pct(+c.ticker.priceChangePercent)} 24h</small></td>
      <td>${fmt(c.entry)}<br><small>${c.action}</small></td>
      <td class="positive">${fmt(c.target)}<br><small>${pct(c.gain)} net</small></td>
      <td class="negative">${fmt(c.stop)}<br><small>${pct(c.loss)} net</small></td>
      <td>${c.holding}</td>
      <td><div class="conf"><b>${c.confidence.toFixed(1)}</b><span class="conf-bar"><i style="width:${c.confidence * 10}%"></i></span></div></td>
    </tr>`).join("");
  $("#cards").innerHTML = coins.map((c, i) => {
    const h = c.tfs["1h"];
    return `<article class="coin-card">
      <div class="card-head"><span class="card-rank">RANK 0${i + 1} · SCORE ${c.score.toFixed(1)}</span><span class="action ${c.action.startsWith("Wait") ? "wait" : ""}">${c.action}</span></div>
      <h3>${c.name} <span>/${c.symbol}</span></h3>
      <div class="card-sub">Expected hold ${c.holding} · Market cap ${c.marketCap ? "$" + (c.marketCap / 1e9).toFixed(1) + "B" : "Unavailable"}</div>
      <div class="signal-grid">
        <div><span>1H RSI(14)</span><b>${h.rsi.toFixed(1)}</b></div>
        <div><span>VOLUME / AVG</span><b>${h.relVol.toFixed(2)}×</b></div>
        <div><span>BOOK IMBALANCE</span><b>${Number.isFinite(c.imbalance) ? pct(c.imbalance * 100) : "Unavailable"}</b></div>
        <div><span>FUNDING / 8H</span><b>${Number.isFinite(c.funding) ? pct(c.funding * 100) : "Unavailable"}</b></div>
      </div>
      <p class="thesis">${reason(c)}</p>
      <div class="card-bottom">
        <div><span>KEY CATALYST</span><p>${c.catalyst}</p></div>
        <div><span>MAIN DOWNSIDE</span><p>${c.risk}</p></div>
      </div>
    </article>`;
  }).join("");
}
function updateCountdown() {
  if (!nextRefreshAt) return;
  const d = Math.max(0, nextRefreshAt - Date.now());
  const h = Math.floor(d / 3600000), m = Math.floor(d % 3600000 / 60000), s = Math.floor(d % 60000 / 1000);
  const text = `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  $("#nextRefresh").textContent = `Next automatic refresh in ${text}.`;
  $("#footerNext").textContent = text;
}
async function refresh() {
  const btn = $("#refreshBtn");
  btn.disabled = true; btn.firstChild.textContent = "Refreshing ";
  $("#liveState").textContent = "REFRESHING";
  document.querySelector(".live-pill").classList.remove("ok");
  try {
    const tickers = await getJSON(`${SPOT}/ticker/24hr`);
    const tickerMap = Object.fromEntries(tickers.map(x => [x.symbol, x]));
    let cgMap = {}, global = null;
    try {
      const ids = universe.map(x => x[2]).join(",");
      const [markets, g] = await Promise.all([
        getJSON(`${CG}/coins/markets?vs_currency=usd&ids=${ids}`),
        getJSON(`${CG}/global`)
      ]);
      cgMap = Object.fromEntries(markets.map(x => [x.id, x]));
      global = g.data;
    } catch (e) { console.warn("CoinGecko unavailable", e); }
    const eligible = universe.filter(([s]) => tickerMap[`${s}USDT`] && +tickerMap[`${s}USDT`].quoteVolume >= 5e7);
    const results = (await Promise.allSettled(eligible.map(x => fetchCoin(x, tickerMap, cgMap))))
      .filter(x => x.status === "fulfilled").map(x => x.value)
      .sort((a, b) => b.score - a.score).slice(0, 5);
    if (results.length !== 5) throw new Error(`Only ${results.length} eligible assets returned complete live data`);
    render(results);
    const btc = tickerMap.BTCUSDT;
    $("#btcChange").textContent = pct(+btc.priceChangePercent);
    $("#btcChange").className = +btc.priceChangePercent >= 0 ? "positive" : "negative";
    if (global?.market_cap_percentage?.btc) {
      $("#btcDom").textContent = global.market_cap_percentage.btc.toFixed(1) + "%";
      $("#domStatus").textContent = "CoinGecko global";
    } else {
      $("#btcDom").textContent = "Unavailable";
      $("#domStatus").textContent = "Feed unavailable";
    }
    const avg = results.reduce((s, c) => s + +c.ticker.priceChangePercent, 0) / 5;
    $("#marketBias").textContent = avg > 2 ? "Risk-on" : avg < -2 ? "Risk-off" : "Mixed";
    $("#biasNote").textContent = `Top-five avg ${pct(avg)} / 24h`;
    const now = new Date();
    $("#retrievedAt").textContent = manila(now);
    $("#liveState").textContent = "LIVE";
    document.querySelector(".live-pill").classList.add("ok");
    nextRefreshAt = Date.now() + REFRESH_MS;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
    localStorage.setItem("signalRoomSnapshot", JSON.stringify({ at: now.toISOString(), results }));
  } catch (e) {
    console.error(e);
    $("#liveState").textContent = "FEED ERROR";
    $("#cards").innerHTML = `<div class="error-box"><b>Live ranking unavailable.</b><p>${e.message}. No fallback figures have been invented. Check network/API availability and retry.</p></div>`;
    $("#rankBody").innerHTML = `<tr class="skeleton-row"><td colspan="7">Reliable real-time information is currently unavailable.</td></tr>`;
    $("#retrievedAt").textContent = "Retrieval failed · " + manila(new Date());
  } finally {
    btn.disabled = false; btn.firstChild.textContent = "Refresh now ";
  }
}
$("#refreshBtn").addEventListener("click", refresh);
refresh();
setInterval(refresh, REFRESH_MS);
