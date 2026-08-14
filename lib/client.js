/* dsh-token-stats —— 浏览器端（常驻插件）
 *
 * 与动态插件不同，shipped 客户端插件运行在页面真实环境中：可以用原生
 * fetch（拉取本机 Host 路由拿余额），投影数据直接来自 root 作用域标准钩子
 * useSessions 的会话列表行 projectionValues（tokenUsage / contextPressure
 * 由 Host 投影实时推送，列表随投影帧重建，数据是实时的）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-stats',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let React = require('react');

    // ── 配置与价目表 ──────────────────────────────────────────────
    const CONFIG = {
      model: 'deepseek-v4-flash',   // deepseek-v4-flash 或 deepseek-v4-pro
      newPricingFrom: '2026-08-17', // 峰谷价生效日期（北京时间）
    };

    const PRICES = {
      'deepseek-v4-flash': {
        current: { hit: 0.02, miss: 1, out: 2 },
        offPeak: { hit: 0.05, miss: 1.5, out: 4.5 },
        peak: { hit: 0.1, miss: 3.0, out: 9.0 },
      },
      'deepseek-v4-pro': {
        current: { hit: 0.025, miss: 3, out: 6 },
        offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
        peak: { hit: 0.3, miss: 9.0, out: 27.0 },
      },
    };

    // 按检测到的会话模型自动选择价目表（flash/pro；未知模型回退到 CONFIG.model）
    function priceTableFor(model) {
      const m = typeof model === 'string' ? model.toLowerCase() : '';
      if (m.includes('pro')) return PRICES['deepseek-v4-pro'];
      if (m.includes('flash')) return PRICES['deepseek-v4-flash'];
      return PRICES[CONFIG.model] || PRICES['deepseek-v4-flash'];
    }

    function priceFor(model) {
      const tz = 'Asia/Shanghai';
      const now = new Date();
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
      const hourPart = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(now);
      const hour = Number(hourPart.find((p) => p.type === 'hour').value) % 24;
      const table = priceTableFor(model);
      if (dateKey < CONFIG.newPricingFrom) return table.current;
      const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
      return peak ? table.peak : table.offPeak;
    }

    function estimateCost(usage, price) {
      if (!usage) return 0;
      const billedInput = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
      const cost =
        billedInput * price.miss +
        (usage.cacheReadTokens || 0) * price.hit +
        (usage.outputTokens || 0) * price.out;
      return Math.max(0, cost / 1e6);
    }

    function totalTokens(usage) {
      if (!usage) return 0;
      return (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
    }

    function cacheHitPercent(usage) {
      if (!usage) return null;
      const denominator = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
      return denominator === 0 ? null : Math.round(((usage.cacheReadTokens || 0) / denominator) * 100);
    }

    // 某模型某时段的价格（current/peak/offPeak 直接查表，不再用「当下时刻」判断）
    function priceOf(model, period) {
      const table = PRICES[model] || priceTableFor(model);
      return (table && table[period]) || table.current;
    }

    // 精确计价：按「模型 × 时段」分桶，各桶用该模型该时段的价目表计费后求和
    function mixedCost(breakdown) {
      let total = 0;
      for (const model in breakdown) {
        const periods = breakdown[model];
        if (!periods || typeof periods !== 'object') continue;
        for (const period in periods) {
          const buckets = periods[period];
          if (!buckets || typeof buckets !== 'object') continue;
          total += estimateCost(buckets, priceOf(model, period));
        }
      }
      return total;
    }

    // 分桶明细（悬浮提示用）：flash/现行 ¥0.00 · flash/高峰 ¥0.00 · pro/空闲 ¥0.00 …
    function breakdownSummary(breakdown) {
      if (!breakdown || typeof breakdown !== 'object') return '';
      const parts = [];
      for (const model in breakdown) {
        const periods = breakdown[model];
        if (!periods || typeof periods !== 'object') continue;
        for (const period in periods) {
          const buckets = periods[period];
          if (!buckets || typeof buckets !== 'object') continue;
          const cost = estimateCost(buckets, priceOf(model, period));
          const short = String(model).split('-').pop() || model;
          const label = period === 'current' ? '现行' : period === 'peak' ? '高峰' : '空闲';
          parts.push(short + '/' + label + ' ¥' + cost.toFixed(4));
        }
      }
      return parts.join(' · ');
    }

    // 隐藏系统 LLM 调用（标题生成/压缩摘要等）：tokens + 按模型/时段计价
    function extraStats(extra) {
      if (!extra || typeof extra !== 'object') return null;
      let tokens = 0;
      let cost = 0;
      for (const purpose in extra) {
        const e = extra[purpose];
        if (!e || !e.buckets || typeof e.buckets !== 'object') continue;
        tokens += (e.buckets.uncachedInputTokens || 0) + (e.buckets.cacheReadTokens || 0) + (e.buckets.cacheWriteTokens || 0) + (e.buckets.outputTokens || 0);
        cost += estimateCost(e.buckets, priceOf(e.model, e.period));
      }
      return { tokens, cost };
    }

    // 行隐藏：localStorage 持久化（点击行隐藏，恢复按钮还原）
    const HIDDEN_KEY = 'dsh-token-stats.hidden';
    function loadHidden() {
      try {
        const arr = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    function saveHidden(arr) {
      try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
    }

    function fmt(n, digits) {
      if (n === undefined || n === null || Number.isNaN(n)) return '—';
      return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    // 紧凑 token 格式（向 shipped StatsLine 学习）：120K / 1.2M / 80.1M
    function compactTokens(n) {
      if (n === undefined || n === null || Number.isNaN(n)) return '—';
      if (n < 1e3) return String(Math.round(n));
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
      if (n < 1e6) return scaled(n / 1e3) + 'K';
      return scaled(n / 1e6) + 'M';
    }

    function occupancyColor(p) {
      if (p >= 85) return 'var(--dsw-alias-state-error-primary)';
      if (p >= 60) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-success-primary)';
    }

    const CSS = `
      [class*="footerActions"] { flex-wrap: wrap; }
      [data-slot="sidebar.footer.action"] > * { min-width: 100%; box-sizing: border-box; }
      [data-slot="sidebar.footer.action"] > *:last-child { order: -1; }
      [class*="collapsed"] [data-slot="sidebar.footer.action"] > * { min-width: auto; order: 0; }
      [class*="collapsed"] [data-slot="sidebar.footer.action"] > *:last-child { display: none; }
      .ts-wrap { width: 100%; box-sizing: border-box; padding: 9px 10px 7px; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); font-size: 14px; line-height: 1.55; user-select: none; }
      .ts-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; cursor: pointer; border-radius: 4px; }
      .ts-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
      .ts-restore { justify-content: center; opacity: 0.75; font-size: 12px; }
      .ts-label { opacity: 0.6; flex: none; }
      .ts-val { font-variant-numeric: tabular-nums; flex: none; }
      .ts-bar { flex: 1; min-width: 56px; height: 8px; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
      .ts-bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
    `;

    // ── 插件 ──────────────────────────────────────────────────────
    const name = 'dsh-token-stats';
    const inject = ['slots'];

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', 'dsh-token-stats');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'dsh-token-stats: styles');

      function TokenStatsView(props) {
        // 注意：useSessions 是 React hook，必须无条件调用（数量跨渲染恒定），
        // 否则会话列表从 pending 到达时会触发 rules-of-hooks 崩溃导致 entry 退位。
        const currentId = typeof props.useSessions === 'function'
          ? props.useSessions((s) => s.current)
          : undefined;
        const proj = typeof props.useSessions === 'function'
          ? props.useSessions((s) => (typeof currentId === 'string' && s.byId && s.byId[currentId] ? s.byId[currentId].projectionValues : undefined))
          : undefined;
        const [stats, setStats] = React.useState({ balance: null, balanceDetail: null, model: null, breakdown: null, extra: null });
        const [hidden, setHidden] = React.useState(loadHidden);

        const toggleRow = (label) => {
          const next = hidden.includes(label) ? hidden.filter((x) => x !== label) : [...hidden, label];
          setHidden(next);
          saveHidden(next);
        };

        React.useEffect(() => {
          let alive = true;
          const tick = () => {
            const query = typeof currentId === 'string' && currentId ? '?sessionId=' + encodeURIComponent(currentId) : '';
            fetch('/token-stats/stats' + query, { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (!alive || !d) return;
                setStats({
                  balance: typeof d.balance === 'number' ? d.balance : null,
                  balanceDetail: d.balanceDetail && typeof d.balanceDetail === 'object' ? d.balanceDetail : null,
                  model: typeof d.model === 'string' && d.model ? d.model : null,
                  breakdown: d.breakdown && typeof d.breakdown === 'object' ? d.breakdown : null,
                  extra: d.extra && typeof d.extra === 'object' ? d.extra : null,
                });
              })
              .catch(() => {});
          };
          tick();
          const id = setInterval(tick, 2000);
          return () => { alive = false; clearInterval(id); };
        }, [currentId]);

        if (props.wide === false) {
          const total = totalTokens(proj ? proj.tokenUsage : undefined);
          return React.createElement('div', { className: 'ts-wrap', title: 'Token 消耗' },
            React.createElement('span', { className: 'ts-val' }, total ? fmt(total, 0) + ' tok' : '—'));
        }

        const usage = proj ? proj.tokenUsage : undefined;
        const pressure = proj ? proj.contextPressure : undefined;
        // 优先用按模型分段折叠的用量做混合计价；无分段数据时回退单表估算
        const cost = stats.breakdown ? mixedCost(stats.breakdown) : estimateCost(usage, priceFor(stats.model));
        const hit = usage ? cacheHitPercent(usage) : null;

        const usedTokens = pressure ? (typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : pressure.pressureTokens) : undefined;
        const contextWindow = pressure ? pressure.contextWindow : undefined;
        const percent = typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0
          ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
          : null;

        const row = (label, value) =>
          React.createElement('div', {
            className: 'ts-row',
            key: label,
            title: '点击隐藏该行',
            onClick: () => toggleRow(label),
          },
            React.createElement('span', { className: 'ts-label' }, label),
            React.createElement('span', { className: 'ts-val' }, value));

        const summary0 = breakdownSummary(stats.breakdown);
        const extra = extraStats(stats.extra);
        // 系统调用（标题/压缩等）费用直接并入总费用，悬停明细中体现
        const totalCost = cost + (extra ? extra.cost : 0);
        const summary = summary0 + (extra && extra.tokens > 0 ? ' · 系统调用 ¥' + fmt(extra.cost, 4) : '');
        // 余额 hover 明细：充值 / 赠送
        const bd = stats.balanceDetail;
        let balanceTip;
        if (stats.balance !== null && bd) {
          const parts = [];
          if (bd.toppedUp != null) parts.push('充值 ¥' + fmt(bd.toppedUp, 2));
          if (bd.granted != null) parts.push('赠送 ¥' + fmt(bd.granted, 2));
          balanceTip = '总余额 ¥' + fmt(stats.balance, 2) + (parts.length > 0 ? '（' + parts.join(' · ') + '）' : '');
        }

        const children = [];
        if (!hidden.includes('Tokens')) {
          children.push(row('Tokens', usage ? compactTokens(totalTokens(usage)) : '—'));
        }
        if (!hidden.includes('缓存命中')) {
          children.push(row('缓存命中', hit !== null ? hit + '%' : '—'));
        }
        if (!hidden.includes('费用')) {
          children.push(React.createElement('div', {
            className: 'ts-row',
            key: '费用',
            title: summary || '点击隐藏该行',
            onClick: () => toggleRow('费用'),
          },
            React.createElement('span', { className: 'ts-label' }, '费用'),
            React.createElement('span', { className: 'ts-val' }, usage ? '¥' + fmt(totalCost, 4) : '—')));
        }
        if (!hidden.includes('余额')) {
          children.push(React.createElement('div', {
            className: 'ts-row',
            key: '余额',
            title: balanceTip || '点击隐藏该行',
            onClick: () => toggleRow('余额'),
          },
            React.createElement('span', { className: 'ts-label' }, '余额'),
            React.createElement('span', { className: 'ts-val' }, stats.balance !== null ? '¥' + fmt(stats.balance, 2) : '—')));
        }
        if (!hidden.includes('上下文')) {
          children.push(React.createElement('div', {
            className: 'ts-row',
            key: '上下文',
            title: '点击隐藏该行',
            onClick: () => toggleRow('上下文'),
          },
            React.createElement('span', { className: 'ts-label' }, '上下文'),
            React.createElement('div', { className: 'ts-bar' },
              React.createElement('div', {
                className: 'ts-bar-fill',
                style: percent !== null ? { width: percent + '%', background: occupancyColor(percent) } : { width: '0%' },
              })
            ),
            React.createElement('span', { className: 'ts-val' }, percent !== null ? percent + '%' : '—')));
        }
        if (hidden.length > 0) {
          children.push(React.createElement('div', {
            className: 'ts-row ts-restore',
            key: 'restore',
            title: '恢复全部显示',
            onClick: () => { setHidden([]); saveHidden([]); },
          },
            React.createElement('span', { className: 'ts-label' }, '恢复全部显示')));
        }

        return React.createElement('div', { className: 'ts-wrap' }, children);
      }

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'token-stats', order: 1 },
        TokenStatsView,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
