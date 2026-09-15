# BTC 5-minute FAK executor

Node.js 24+。启动时用上下键选择 Bitcoin 五分钟或其他市场，无浏览器 UI、轮询行情、数据库或日志依赖。

完整参数、价格机制、操作步骤、延迟字段和故障排查见 [USER_GUIDE.md](./USER_GUIDE.md)。

## 最简单的启动方法

运行界面使用固定面板。盘口、持仓、订单设置和状态原地更新；内存中保留最近 10 条重要事件，较矮的终端会显示其中最新几条。两秒内连续出现的相同事件会合并计数。普通模式只显示三项最近延迟，Token ID 使用缩写。转场明确提示“切换成功”或“切换失败”；切换成功后的行情连接状态单独显示。

全部配置都在纯文本文件 `config.txt` 中。先用记事本编辑并保存它，然后双击 [start.cmd](./start.cmd) 启动。`start.cmd` 只读取配置并启动程序，不会创建、打开或修改配置文件。以后修改配置时仍直接编辑 `config.txt`，修改后需重启程序。

`config.txt` 的格式是每行一个配置，等号两边不要加空格，值不要加引号：

```ini
# ===== 账户与市场 =====
MARKET_OUTCOME=UP
PRIVATE_KEY=0x你的64位十六进制私钥
# 市场在启动菜单选择；其他市场的 Token ID 在启动时输入

# ===== 每次 BUY 花费 =====
ORDER_SIZE=1

# ===== 自动卖出 =====
AUTO_SELL_PROFIT_PERCENT=20

# ===== 成交价格与滑点 =====
BUY_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0
SELL_SLIPPAGE=0

# ===== 运行模式 =====
LIVE_TRADING=false
DEBUG_UI=false
```

完整无密钥模板是 `config.example.txt`。实际 `config.txt` 只保存在本机，并已被 `.gitignore` 排除；不要提交、分享或复制其中的私钥。建议先保持 `LIVE_TRADING=false` 测试。

如果双击后提示缺少 dependencies 或 build，再打开 PowerShell，在该目录执行一次：

```powershell
cd C:\Users\czhang30\Desktop\poly\btc-5m-executor
npm install
npm run build
```

默认 `LIVE_TRADING=false`。本地 signer 仍完成签名，但绝不调用 `postOrder`。
只有显式 `LIVE_TRADING=true` 才允许真实 FAK 订单。`config.txt` 已加入 `.gitignore`，不要提交或分享它。

| 变量 | 含义 |
| --- | --- |
| MARKET_OUTCOME | 选择 Bitcoin 五分钟时交易 `UP` 或 `DOWN` |
| PRIVATE_KEY | 本地 EOA 私钥，0x + 64 位十六进制 |
| ORDER_SIZE | 每按一次 `b` 花费的美元金额；SELL 不重新按美元换算 |
| AUTO_SELL_PROFIT_PERCENT | 最近一笔未卖完 BUY 批次的盈利百分比，例如 20 = 上涨 20% |
| BUY_SLIPPAGE_ENABLED | BUY 是否使用滑点限制；`false` 时有卖单就立即尝试买入 |
| SELL_SLIPPAGE_ENABLED | SELL 是否使用滑点限制；`false` 时有买单就立即尝试卖出 |
| BUY_SLIPPAGE / SELL_SLIPPAGE | 绝对价格增减，例如 0.01 = 1¢，默认 0 |
| LIVE_TRADING | 默认 false；只接受 true / false |
| DEBUG_UI | 默认 false；true 显示完整 Token、market slug 和完整延迟分解 |

`b` BUY，`s` SELL，`a` armed/disarmed，`Tab` 在 Bitcoin 五分钟的 UP/DOWN 间切换，`←` 返回上一期，`→` 前往下一期，Ctrl+C 退出。每按一次 `b` 花费 `ORDER_SIZE` 美元并记录为一个独立 BUY 批次。每按一次 `s` 卖出最近一笔尚未卖完的 BUY 批次；卖出数量不会随当前价格重新换算成 `ORDER_SIZE` 美元。自动卖出也使用最近一笔未卖完的 BUY 批次及其成本价。切换 UP/DOWN 会 disarm，并分别保留两个 Token 的批次；进入下一期市场后清空记录。

在 Bitcoin 五分钟模式中，`←`/`→` 会尝试切换到相邻场次。目标场次尚未开放、已经结束或查询失败时，终端会明确提示“无法返回上一期”或“无法前往下一期”，当前场次继续保持不变。程序到达当前场次结束时间后会自动寻找并切换到新的场次。

例如 `ORDER_SIZE=1`、BUY 成交均价 0.50 时，该批次约有 2 份。之后价格跌到 0.25，按一次 `s` 仍卖这约 2 份，预计收回约 0.50 美元；程序不会为了卖出 1 美元而改卖 4 份。FAK 部分成交时只扣除实际成交份额，未卖完的批次保留给下一次 SELL。

程序仍在启动时缓存市场返回的 `minOrderSize` 供状态与诊断使用，但不会再错误地用它阻止 FAK 小额 Market 订单；真实模式以 Polymarket CLOB 返回的最终校验结果为准。

## 订单路径

官方 SDK 固定为 `@polymarket/client@0.10.0`，使用 `privateKey`、`createSecureClient`、`createMarketOrder` 和 `postOrder`。显式 EOA 地址避免默认 deposit-wallet 创建流程。初始化时创建/派生 API credentials，预热 BUY/SELL 签名和 SDK metadata 缓存；预热签名丢弃，不提交。启动完成后 signer、credentials、HTTP client 复用。

BUY：内存 `bestAsk + BUY_SLIPPAGE` → tick 对齐 / clamp → `maxPrice` + FAK → 本地签名 → `postOrder`。

SELL：最近一笔 BUY 的剩余份额 + 内存 `bestBid - SELL_SLIPPAGE` → tick 对齐 / clamp → `minPrice` + FAK → 本地签名 → `postOrder`。

`BUY_SLIPPAGE_ENABLED=true` 时 BUY 使用 `bestAsk + BUY_SLIPPAGE`；`SELL_SLIPPAGE_ENABLED=true` 时 SELL 使用 `bestBid - SELL_SLIPPAGE`。价格 clamp 至 `[tick, 1-tick]`，tick 对齐朝原报价方向取整，不额外扩大 slippage。某一侧设为 `false` 时只忽略该侧的 slippage 数值：BUY 显式使用最高合法价 `1-tick`，SELL 显式使用最低合法价 `tick`，因此该侧有可用流动性就立即成交；这可能接受非常差的成交价。不调用未显式传价格的 SDK market-order 路径。FAK 可部分成交或零成交；成功响应不等于全部成交。

官方 Market WebSocket：`wss://ws-subscriptions-clob.polymarket.com/ws/market`。Bitcoin 五分钟模式同时订阅 UP 和 DOWN；按 `Tab` 只切换内存中的当前 Token，不重新查询市场或连接 WebSocket。处理 `best_bid_ask`、`price_change`，初始 `book` 仅扫描最高买价/最低卖价，不保存 depth。10 秒 PING，30 秒未收到 PONG 则断开，1 秒后重连。断线清空报价并 disarm；报价超过 5 秒未更新时拒单。

## 延迟

`process.hrtime.bigint()` 记录 WS callback、JSON parse、trigger 判断、execute 调用、postOrder 调用和返回时间。普通界面只显示 Input/WS → Post、Post → Response 和 Total；`DEBUG_UI=true` 时显示完整分解：

- `ws_to_parse`
- `parse_to_trigger`（包含报价更新）
- `trigger_to_post`（包含本地签名）
- `post_to_response`（包含 SDK HTTP/HMAC、网络及响应处理）
- `ws_to_post`
- `input_to_post`、`invoke_to_post`

手动订单用键盘 callback 作为 input 起点，WS 相关指标为 null，避免把用户思考时间算作行情延迟。Dry run 用 `dry_dispatch_ns`、`dry_*_to_dispatch_us/ms` 记录签名后的模拟发送边界，真实 post/response 指标为 null。`postOrder` 调用时间不是 socket 实际写出时间。

普通行情只更新内存面板状态，不加入事件历史。订单日志中的 `quotePrice` 是按键或触发时的当前 `bestAsk`/`bestBid`，`limitPrice` 是订单允许的最差价格。订单/触发日志通过 `setImmediate` 延后格式化；界面以 dirty 标记和 100ms 定时器限制为最高约 10 FPS。签名到 `postOrder` 调用完成之前会暂停终端渲染。

## SDK 边界与限制

- 启动阶段读取一次 Token 的 tick 和最小订单份额；之后的行情只使用 WebSocket。SDK 的显式价格路径仍使用内部 metadata 缓存。固定版本缓存 TTL 为 10 分钟，本程序在预热开始后 9 分钟停止交易；tick size 变化也停止交易，需要重启。运行阶段的 fetch 保护只放行真实模式下的 `POST /order`，禁止隐含 REST 查价/查 market。
- 新官方 SDK 自身包含 Zod/ky 等依赖及内部校验。这是“使用当前官方 SDK”和“完全不使用 Zod”之间的实际冲突；应用源码无 Zod、schema 库或额外 HTTP client。未修改 SDK 内部实现来绕过校验。
- 只支持私钥对应的 EOA 资金/持仓；不配置 proxy、Safe 或 deposit wallet。资金、token 持仓与链上授权需预先准备，本程序不发送授权交易。
- BUY 批次只统计本程序当前运行期间成功返回的成交，不读取启动前、网页或其他程序的持仓；重启和进入下一期市场会清空批次。自动盈利目标使用最近一笔未卖完批次的成本价，暂不扣手续费。没有仓位查询、完整深度、重试或结算；失败/超时不自动重发。
- 不保证某个延迟或成交价格优于配置上限；需自行测量实际部署环境。事件循环调度、SDK 签名与网络耗时都仍然存在。

## 本次验证

- 使用 Node.js v24.19.0，通过 npm CLI 执行 `npm install`（依赖已是最新，audit 0 vulnerabilities）与 `npm run build`，TypeScript 编译通过。
- 当前 shell 没有 npm 命令，验证时将官方 npm CLI 临时解压至 `%TEMP%\poly-executor-npm`，执行 `node "$env:TEMP\poly-executor-npm\package\bin\npm-cli.js" install` / `run build`。标准安装 Node/npm 的终端可直接执行上面的命令。
- 用 `LIVE_TRADING=false` 启动程序并选择 Bitcoin 五分钟：官方 WS 成功连接，`bestBid` / `bestAsk` 持续更新。一次模拟 BUY 在 0.93 花费 1 USD，记录 1.0753 份；随后模拟 SELL 在 0.29 卖出同一笔 1.0753 份，预计收入 0.3118 USD。未调用真实 `postOrder()`，未发送订单。

官方参考：[SDK](https://github.com/Polymarket/ts-sdk/tree/main/packages/client)、[Market WebSocket](https://docs.polymarket.com/market-data/realtime-data)。
