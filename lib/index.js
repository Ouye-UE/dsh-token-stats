/**
 * dsh-token-stats —— Host 半边（常驻插件）
 *
 * 通过本机 HTTP 路由把「真实账户余额 + 会话当前模型 + 隐藏 LLM 调用用量」
 * 暴露给浏览器端：
 *   GET /token-stats/stats?sessionId=<id>  →  { balance, model, breakdown, extra }
 *
 * - balance：DeepSeek 官方余额接口（30s 缓存，失败 15s 后重试），浏览器端
 *   无法带 API key 调余额接口，所以由 Host 读取凭证并请求。
 * - model：会话当前生效模型（session.requestHeader().config.model），随
 *   /model 切换与请求更新；供浏览器端选择 flash/pro 价目表。
 * - breakdown：按「模型 × 价格时段」折叠的会话主请求用量（精确计价数据源）。
 * - extra：tokenUsage 投影统计不到的「隐藏系统 LLM 调用」用量（标题生成、
 *   压缩摘要等走 ctx.llm.stream 且带 purpose 的调用），经 llm/stream waterfall
 *   拦截累计，按会话归属。
 *
 * Token / 上下文占用等投影数据不经由此处：浏览器端直接读客户端会话列表行
 * 的 projectionValues（与 shipped StatsLine 同一数据源）。
 */
const name = 'dsh-token-stats';

/** 需要注入的服务：路由注册 + 凭证解析 + 会话读取。 */
const inject = ['webServer', 'credentials', 'sessions'];

const BALANCE_TTL = 30000;
const FAIL_TTL = 15000;

function apply(ctx) {
  let balanceCache = { value: null, at: 0 };

  async function fetchBalance() {
    try {
      const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY');
      if (!resolved || !resolved.value) return null;
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + resolved.value },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const parsed = await res.json();
      const infos = Array.isArray(parsed && parsed.balance_infos) ? parsed.balance_infos : [];
      const entry = infos.find((item) => item && item.currency === 'CNY') || infos[0];
      if (!entry) return null;
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const total = num(entry.total_balance);
      if (total === null) return null;
      return {
        total,
        granted: num(entry.granted_balance),
        toppedUp: num(entry.topped_up_balance),
      };
    } catch (error) {
      console.error('token-stats: balance fetch failed', error);
      return null;
    }
  }

  async function getBalance() {
    const now = Date.now();
    const ttl = balanceCache.value !== null ? BALANCE_TTL : FAIL_TTL;
    if (now - balanceCache.at < ttl) return balanceCache.value;
    const value = await fetchBalance();
    balanceCache = { value, at: now };
    return value;
  }

  function readModel(sessionId) {
    try {
      const session = typeof sessionId === 'string' && sessionId ? ctx.sessions.get(sessionId) : undefined;
      const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
      const model = header && header.config && typeof header.config.model === 'string' ? header.config.model : undefined;
      return model || null;
    } catch (error) {
      console.error('token-stats: readModel failed', error);
      return null;
    }
  }

  // ── 按「模型 × 价格时段」分桶折叠用量（精确计价的数据源） ─────────
  // 与 token-meter 同源：request/header 事件标记其后请求的模型，
  // assistant/chunk(usage) 与 assistant/message 事件携带该步用量及时间戳；
  // 同一 turn/step 的 chunk→message 只替换、不重复累计。
  // 每笔用量按其发生时刻归类价格时段（北京时间）：
  //   2026-08-17 之前 → current；之后 → peak(9-12/14-18) / offPeak。
  const NEW_PRICING_FROM = '2026-08-17'; // 与 client CONFIG.newPricingFrom 保持一致

  function periodOf(timeMs) {
    const d = new Date(timeMs);
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
    if (dateKey < NEW_PRICING_FROM) return 'current';
    const hourPart = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).formatToParts(d);
    const hour = Number(hourPart.find((p) => p.type === 'hour').value) % 24;
    const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    return peak ? 'peak' : 'offPeak';
  }

  const ZERO_BUCKETS = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

  function addBuckets(total, b) {
    total.uncachedInputTokens += b.uncachedInputTokens;
    total.cacheReadTokens += b.cacheReadTokens;
    total.cacheWriteTokens += b.cacheWriteTokens;
    total.outputTokens += b.outputTokens;
    return total;
  }

  function subBuckets(total, b) {
    total.uncachedInputTokens -= b.uncachedInputTokens;
    total.cacheReadTokens -= b.cacheReadTokens;
    total.cacheWriteTokens -= b.cacheWriteTokens;
    total.outputTokens -= b.outputTokens;
    return total;
  }

  function foldPerModelUsage(session) {
    const byModelPeriod = new Map();
    let currentModel = null;
    let last = null;
    const events = session && typeof session.events === 'object' && session.events ? session.events : [];
    for (const event of events) {
      const d = event && event.data ? event.data : null;
      if (event && event.type === 'request/header') {
        const cfg = d && d.header && d.header.config;
        if (cfg && typeof cfg.model === 'string') currentModel = cfg.model;
        continue;
      }
      let turn;
      let step;
      let usage;
      if (event && event.type === 'assistant/message' && d && d.usage) {
        turn = d.turn;
        step = d.step;
        usage = d.usage;
      } else if (event && event.type === 'assistant/chunk' && d && d.chunk && d.chunk.type === 'usage') {
        turn = d.turn;
        step = d.step;
        usage = d.chunk.usage;
      } else {
        continue;
      }
      if (!usage || !currentModel) continue;
      const buckets = {
        uncachedInputTokens: usage.inputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
        outputTokens: usage.outputTokens || 0,
      };
      const period = typeof event.time === 'number' ? periodOf(event.time) : 'current';
      let periods = byModelPeriod.get(currentModel);
      if (!periods) {
        periods = new Map();
        byModelPeriod.set(currentModel, periods);
      }
      let total = periods.get(period) || ZERO_BUCKETS();
      if (last && last.turn === turn && last.step === step && last.model === currentModel && last.period === period) {
        total = subBuckets(total, last.buckets);
      }
      total = addBuckets(total, buckets);
      periods.set(period, total);
      last = { turn, step, model: currentModel, period, buckets };
    }
    const out = {};
    for (const [model, periods] of byModelPeriod) {
      out[model] = {};
      for (const [period, buckets] of periods) out[model][period] = buckets;
    }
    return out;
  }

  let breakdownCache = { sessionId: null, seq: -1, value: null };
  function readBreakdown(sessionId) {
    try {
      const session = typeof sessionId === 'string' && sessionId ? ctx.sessions.get(sessionId) : undefined;
      if (!session) return null;
      const seq = typeof session.seq === 'number' ? session.seq : -1;
      if (breakdownCache.sessionId === sessionId && breakdownCache.seq === seq) return breakdownCache.value;
      const value = foldPerModelUsage(session);
      breakdownCache = { sessionId, seq, value };
      return value;
    } catch (error) {
      console.error('token-stats: readBreakdown failed', error);
      return null;
    }
  }

  // ── 截获「隐藏系统 LLM 调用」用量（标题生成 / 压缩摘要等） ─────────
  // tokenUsage 投影只统计会话日志里的 assistant/message 与 usage chunk；
  // 走 ctx.llm.stream 且带 purpose + sessionId 的调用（如
  // purpose='session-title' / 'compaction'）真实计费但不在投影里。
  // 这里用 llm/stream waterfall 包一层流，取每个流最后一次 usage chunk，
  // 按 会话 + 用途 累计（含模型与发生时段，供客户端精确计价）。
  const extraUsage = new Map(); // sessionId -> { purpose -> { buckets, model, period } }

  function recordExtra(sessionId, purpose, usage, model) {
    try {
      let rec = extraUsage.get(sessionId);
      if (!rec) {
        rec = {};
        extraUsage.set(sessionId, rec);
      }
      const buckets = {
        uncachedInputTokens: usage.inputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
        outputTokens: usage.outputTokens || 0,
      };
      const prev = rec[purpose] || {
        buckets: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        model,
        period: periodOf(Date.now()),
      };
      prev.buckets.uncachedInputTokens += buckets.uncachedInputTokens;
      prev.buckets.cacheReadTokens += buckets.cacheReadTokens;
      prev.buckets.cacheWriteTokens += buckets.cacheWriteTokens;
      prev.buckets.outputTokens += buckets.outputTokens;
      rec[purpose] = prev;
    } catch (error) {
      console.error('token-stats: recordExtra failed', error);
    }
  }

  async function* wrapStream(stream, onUsage) {
    let lastUsage = null;
    try {
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) lastUsage = chunk.usage;
        yield chunk;
      }
    } finally {
      if (lastUsage) onUsage(lastUsage);
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const purpose = options && options.purpose;
    const sessionId = options && options.sessionId;
    const model = options && options.model;
    if (typeof sessionId === 'string' && purpose) {
      return wrapStream(next(), (usage) => recordExtra(sessionId, purpose, usage, model));
    }
    return next();
  }, { global: true });

  function readExtra(sessionId) {
    const rec = typeof sessionId === 'string' ? extraUsage.get(sessionId) : undefined;
    if (!rec) return null;
    const out = {};
    for (const purpose in rec) {
      out[purpose] = rec[purpose];
    }
    return out;
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/token-stats/stats',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://x');
        const sessionId = url.searchParams.get('sessionId') || undefined;
        const balance = await getBalance();
        const model = readModel(sessionId);
        const breakdown = readBreakdown(sessionId);
        const extra = readExtra(sessionId);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          balance: balance ? balance.total : null,
          balanceDetail: balance ? { granted: balance.granted, toppedUp: balance.toppedUp } : null,
          model,
          breakdown,
          extra,
        }));
      } catch (error) {
        console.error('token-stats: stats route failed', error);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ balance: null, balanceDetail: null, model: null, breakdown: null, extra: null }));
      }
    },
  }), 'token-stats: stats route');
}

export { apply, inject, name };
