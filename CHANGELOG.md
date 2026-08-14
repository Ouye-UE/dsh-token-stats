# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-14

Initial release.

### Added

- Sidebar panel (`sidebar.footer.action`) with live **Tokens** (compact K/M), **缓存命中** (cache-hit rate), **费用** (cost estimate), **余额** (real account balance), **上下文** (context-occupancy progress bar), and a conditional **系统调用** row.
- **Mixed model × price-period costing** — per-request usage folded by model (flash/pro) and Beijing-time price period (`current` / `peak` / `offPeak`), with per-bucket hover breakdown.
- **Real balance** from the official `GET /user/balance` endpoint via the deployment's `DEEPSEEK_API_KEY` (30s cache), with topped-up / granted hover split.
- **`llm/stream` interceptor** capturing hidden system LLM calls (session-title generation, compaction summaries).
- Host route `GET /token-stats/stats?sessionId=<id>` serving balance, per-model×period breakdown, and extra usage.
- Zero-build dual-face package layout (`lib/index.js` + `lib/client.js`), MIT license, bilingual README, deploy example, CI (syntax checks).
