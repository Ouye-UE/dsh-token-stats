# dsh-token-stats

DeepSeek Harness（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）的**部署级常驻客户端插件**：在左侧边栏底部（`sidebar.footer.action`）显示实时 Token 消耗面板。

## 功能

- **Tokens** —— 当前会话累计消耗（未命中输入 + 缓存读 + 缓存写 + 输出），紧凑 `K/M` 格式。
- **缓存命中** —— 计费输入中缓存命中的占比（与官方统计行同一公式）。
- **费用** —— 按「模型 × 价格时段」精确混合计价：每笔用量按其发生时刻的模型（flash/pro）与北京时间时段（新峰谷价生效前为现行价、之后分高峰/空闲）分别计价后求和。悬停该行可看分桶明细。
- **系统调用** —— 通过 `llm/stream` 拦截捕获的隐藏系统调用（会话标题生成、压缩摘要），仅在非零时显示。
- **余额** —— 真实账户余额（官方 `GET /user/balance`，服务端用 `DEEPSEEK_API_KEY` 解析，密钥不出 Host）。悬停可看充值/赠送构成。
- **上下文** —— 上下文占用进度条（`contextPressure` 投影），按占用率变色。

> 费用为**估算值，非账单**。DeepSeek 搜索提供方走原生 API 直连、绕过会话日志，搜索触发的 token 用量对任何 Harness 插件都不可见。

## 架构

双面包：

- `lib/index.js` —— Host 半边：在 webServer 注册 `GET /token-stats/stats?sessionId=<id>`（余额 30s 缓存；按模型×时段折叠会话事件日志；`llm/stream` 拦截隐藏系统调用）。
- `lib/client.js` —— 浏览器半边（module-loader 格式）：注册 `sidebar.footer.action` 面板；投影数据经 `useSessions` 列表行 `projectionValues` 实时读取，每 2s 轮询 stats 路由。

**零构建**——拷包 + 加一行组合配置即可用。

## 安装

1. 把本包（或 `lib/` 内容）拷入 web profile 的 node_modules：

   ```
   <DSH_HOME>/profiles/node_modules/dsh-token-stats/
   ```

2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 加一行：

   ```yaml
   - insert:
       - id: token-stats
         name: dsh-token-stats
   ```

   完整片段见 `examples/cordis.patch.yml`。

3. 重启 DSH（`dsh web`）。之后每次启动自动加载，无需批准。

## 配置

打开 `lib/client.js` 编辑 `PRICES`（元/百万 tokens）与 `CONFIG`：

```js
const CONFIG = {
  model: 'deepseek-v4-flash',   // 未知模型 id 时的回退价目表
  newPricingFrom: '2026-08-17', // 峰谷价生效日期（北京时间）
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

`current` 用于 `newPricingFrom` 之前；之后高峰（北京时间 9-12、14-18 点）用 `peak`，其余用 `offPeak`。官方调价时按实际修改即可。

余额接口需要部署的 `DEEPSEEK_API_KEY` 凭证（`<DSH_HOME>/.credentials.yaml` 或环境变量）——与 Harness 自身的 LLM 路由同一份凭证，包内不存任何密钥。

## 说明与局限

- 费用是估算值，权威数字以 DeepSeek 平台为准。
- `tokenUsage` / `contextPressure` 来自 Harness 自带投影，与官方统计行同源。
- 搜索提供方的 LLM 调用绕过 `ctx.llm`，Harness 不记录其用量（DSH 产品局限）；标题/压缩类调用已由 `llm/stream` 拦截器覆盖。

## License

MIT
