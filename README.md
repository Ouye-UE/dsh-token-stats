# dsh-token-stats

A permanent (deployment-level) client plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that shows a live token-usage panel at the bottom of the left sidebar (`sidebar.footer.action`).

## Features

- **Tokens** — current session's cumulative tokens (uncached input + cache read + cache write + output), compact `K/M` formatting.
- **缓存命中** — cache-hit share of billed prompt-side input (same formula as the shipped stats line).
- **费用** — cost estimate priced per `model × price period`: each request's usage is folded by its own model (flash/pro) and Beijing-time period (`current` before the new peak/off-peak scheme, `peak`/`offPeak` after), then summed. Hover the row for the per-bucket breakdown.
- **系统调用** — hidden system LLM calls (session-title generation, compaction summaries) captured via an `llm/stream` interceptor; shown only when non-zero.
- **余额** — real account balance from the official `GET /user/balance` endpoint (resolved server-side with `DEEPSEEK_API_KEY`; never exposed to the browser). Hover for the topped-up / granted split.
- **上下文** — context-occupancy progress bar (`contextPressure` projection), colored by usage.

> Costs are **estimates**, not billing. The DeepSeek search provider makes direct API calls that bypass the session log, so search-triggered token usage is not visible to any Harness plugin.

## Architecture

Dual-face package:

- `lib/index.js` — Host half: registers `GET /token-stats/stats?sessionId=<id>` on the web server (balance with 30s cache, per-session per-model×period usage fold from the session event log, and the `llm/stream` interceptor for hidden system calls).
- `lib/client.js` — Browser half (module-loader format): registers the panel in `sidebar.footer.action`; reads projections live from the session list (`useSessions` → `projectionValues`), polls the stats route every 2s.

Zero build step — copy the package and add one composition row.

## Install

1. Copy this package (or the `lib/` folder contents) into the web profile's `node_modules`:

   ```
   <DSH_HOME>/profiles/node_modules/dsh-token-stats/
   ```

2. Add a row to `<DSH_HOME>/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: token-stats
         name: dsh-token-stats
   ```

   See `examples/cordis.patch.yml` for the full snippet.

3. Restart DSH (`dsh web`). The panel loads automatically on every start.

## Configuration

Open `lib/client.js` and edit `PRICES` (CNY per million tokens) and `CONFIG`:

```js
const CONFIG = {
  model: 'deepseek-v4-flash',   // fallback model for unknown model ids
  newPricingFrom: '2026-08-17', // Beijing-time date the peak/off-peak scheme takes effect
};

const PRICES = {
  'deepseek-v4-flash': {
    current: { hit: 0.02, miss: 1,    out: 2   },
    offPeak: { hit: 0.05, miss: 1.5,  out: 4.5 },
    peak:    { hit: 0.10, miss: 3.0,  out: 9.0 },
  },
  'deepseek-v4-pro': {
    current: { hit: 0.025, miss: 3,    out: 6   },
    offPeak: { hit: 0.15,  miss: 4.5,  out: 13.5 },
    peak:    { hit: 0.30,  miss: 9.0,  out: 27.0 },
  },
};
```

`current` applies before `newPricingFrom`; after that date, `peak` applies 9:00–12:00 and 14:00–18:00 Beijing time and `offPeak` otherwise. Adjust the values to the actual official pricing when it changes.

The balance endpoint requires the deployment's `DEEPSEEK_API_KEY` credential (`<DSH_HOME>/.credentials.yaml` or the environment) — same credential the Harness LLM route uses; no key is stored in this package.

## Notes / limitations

- Costs are an estimate; the authoritative figure is the DeepSeek platform.
- `tokenUsage`/`contextPressure` come from Harness's own projections — identical to the shipped stats line.
- Search-provider LLM calls bypass `ctx.llm` and their usage is not logged by Harness (DSH product limitation); title/compaction calls are captured via the `llm/stream` interceptor.

## License

MIT
