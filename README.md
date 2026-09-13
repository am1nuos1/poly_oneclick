# BTC 5-minute FAK executor

Node.js 24+。启动时用上下键选择 Bitcoin 五分钟或其他市场，无浏览器 UI、轮询行情、数据库或日志依赖。

完整参数、价格机制、操作步骤、延迟字段和故障排查见 [USER_GUIDE.md](./USER_GUIDE.md)。

## 最简单的启动方法

全部配置都在纯文本文件 `config.txt` 中。先用记事本编辑并保存它，然后双击 [start.cmd](./start.cmd) 启动。`start.cmd` 只读取配置并启动程序，不会创建、打开或修改配置文件。以后修改配置时仍直接编辑 `config.txt`，修改后需重启程序。

`config.txt` 的格式是每行一个配置，等号两边不要加空格，值不要加引号：

```ini
# ===== 账户与市场 =====
MARKET_OUTCOME=UP
PRIVATE_KEY=0x你的64位十六进制私钥
# 市场在启动菜单选择；其他市场的 Token ID 在启动时输入

# ===== 每次订单大小 =====
ORDER_SIZE=5
ORDER_SIZE_UNIT=USD

# ===== 自动卖出 =====
AUTO_SELL_PROFIT_PERCENT=20

# ===== 成交价格与滑点 =====
BUY_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0
SELL_SLIPPAGE=0

# ===== 运行模式 =====
LIVE_TRADING=false
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
| ORDER_SIZE | 每次按键或自动 SELL 使用的固定大小；必须满足当前市场最小份额 |
| ORDER_SIZE_UNIT | `USD` 表示美元目标金额；`SHARES` 表示 token 份额 |
| AUTO_SELL_PROFIT_PERCENT | 相对本程序本次平均买入价的盈利百分比，例如 20 = 上涨 20% |
| BUY_SLIPPAGE_ENABLED | BUY 是否使用滑点限制；`false` 时有卖单就立即尝试买入 |
| SELL_SLIPPAGE_ENABLED | SELL 是否使用滑点限制；`false` 时有买单就立即尝试卖出 |
| BUY_SLIPPAGE / SELL_SLIPPAGE | 绝对价格增减，例如 0.01 = 1¢，默认 0 |
| LIVE_TRADING | 默认 false；只接受 true / false |

`b` BUY，`s` SELL，`a` armed/disarmed，`Tab` 在 Bitcoin 五分钟的 UP/DOWN 间切换，`←` 返回上一期，`→` 前往下一期，Ctrl+C 退出。终端会在“当前市场”和“当前品种”行显示本期场次（UTC 起止时间）。每按一次 `b` 或 `s` 只提交一笔 `ORDER_SIZE`，按几次就提交几次。自动卖出使用本次运行中由程序买入的加权平均成本；例如平均买入价 0.50、`AUTO_SELL_PROFIT_PERCENT=20`，目标价就是 0.60。当 `bestBid` 达到目标时触发一次并立即 disarm；它也使用同一个 `ORDER_SIZE`。按 `a` 时若当前 Token 尚无本次买入记录，程序会显示 `ARM FAILED`。切换 UP/DOWN 会 disarm，并为两个 Token 分别保留本期内的买入成本；进入下一期市场后重新计算。

在 Bitcoin 五分钟模式中，`←`/`→` 会尝试切换到相邻场次。目标场次尚未开放、已经结束或查询失败时，终端会明确提示“无法返回上一期”或“无法前往下一期”，当前场次继续保持不变。程序到达当前场次结束时间后会自动寻找并切换到新的场次。

`ORDER_SIZE_UNIT=USD` 时，BUY 的 `ORDER_SIZE` 是美元名义金额（手续费可能另计）；SELL 会在触发时用 `ORDER_SIZE / bestBid` 换算卖出份额，所以它代表按当前最优买价计算的目标美元金额。FAK 可能只成交一部分，且启用 SELL slippage 时成交价可能低于触发时的 bestBid，因此实际卖出收入不保证刚好等于 `ORDER_SIZE`。`ORDER_SIZE_UNIT=SHARES` 时，BUY 和 SELL 都以固定 token 份额为目标；SDK 的 BUY 接口仍接收美元，因此程序用份额乘本次 BUY 限价换算签名金额。

程序启动时读取当前 Token 的最小订单份额并保存在内存中。BTC 五分钟市场当前通常要求至少 5 份；例如价格 0.59 时，1 美元只能换算成约 1.6949 份，程序会拒绝该订单，不会自动增加金额。希望固定金额可使用 `ORDER_SIZE=5`、`ORDER_SIZE_UNIT=USD`；希望固定份额可使用 `ORDER_SIZE=5`、`ORDER_SIZE_UNIT=SHARES`。

## 订单路径

官方 SDK 固定为 `@polymarket/client@0.10.0`，使用 `privateKey`、`createSecureClient`、`createMarketOrder` 和 `postOrder`。显式 EOA 地址避免默认 deposit-wallet 创建流程。初始化时创建/派生 API credentials，预热 BUY/SELL 签名和 SDK metadata 缓存；预热签名丢弃，不提交。启动完成后 signer、credentials、HTTP client 复用。

BUY：内存 `bestAsk + BUY_SLIPPAGE` → tick 对齐 / clamp → `maxPrice` + FAK → 本地签名 → `postOrder`。

SELL：内存 `bestBid - SELL_SLIPPAGE` → tick 对齐 / clamp → `minPrice` + FAK → 本地签名 → `postOrder`。

`BUY_SLIPPAGE_ENABLED=true` 时 BUY 使用 `bestAsk + BUY_SLIPPAGE`；`SELL_SLIPPAGE_ENABLED=true` 时 SELL 使用 `bestBid - SELL_SLIPPAGE`。价格 clamp 至 `[tick, 1-tick]`，tick 对齐朝原报价方向取整，不额外扩大 slippage。某一侧设为 `false` 时只忽略该侧的 slippage 数值：BUY 显式使用最高合法价 `1-tick`，SELL 显式使用最低合法价 `tick`，因此该侧有可用流动性就立即成交；这可能接受非常差的成交价。不调用未显式传价格的 SDK market-order 路径。FAK 可部分成交或零成交；成功响应不等于全部成交。

官方 Market WebSocket：`wss://ws-subscriptions-clob.polymarket.com/ws/market`。Bitcoin 五分钟模式同时订阅 UP 和 DOWN；按 `Tab` 只切换内存中的当前 Token，不重新查询市场或连接 WebSocket。处理 `best_bid_ask`、`price_change`，初始 `book` 仅扫描最高买价/最低卖价，不保存 depth。10 秒 PING，30 秒未收到 PONG 则断开，1 秒后重连。断线清空报价并 disarm；报价超过 5 秒未更新时拒单。

## 延迟

`process.hrtime.bigint()` 记录 WS callback、JSON parse、trigger 判断、execute 调用、postOrder 调用和返回时间，输出原始 ns 时间戳与 us/ms 间隔：

- `ws_to_parse`
- `parse_to_trigger`（包含报价更新）
- `trigger_to_post`（包含本地签名）
- `post_to_response`（包含 SDK HTTP/HMAC、网络及响应处理）
- `ws_to_post`
- `input_to_post`、`invoke_to_post`

手动订单用键盘 callback 作为 input 起点，WS 相关指标为 null，避免把用户思考时间算作行情延迟。Dry run 用 `dry_dispatch_ns`、`dry_*_to_dispatch_us/ms` 记录签名后的模拟发送边界，真实 post/response 指标为 null。`postOrder` 调用时间不是 socket 实际写出时间。

普通行情不打印。订单日志中的 `quotePrice` 是按键或触发时的当前 `bestAsk`/`bestBid`，`limitPrice` 是订单允许的最差价格。订单/触发日志通过 `setImmediate` 延后格式化输出，不在发送前同步写日志；连接、armed 状态与停止交易原因只在状态变化时输出。

## SDK 边界与限制

- 启动阶段读取一次 Token 的 tick 和最小订单份额；之后的行情只使用 WebSocket。SDK 的显式价格路径仍使用内部 metadata 缓存。固定版本缓存 TTL 为 10 分钟，本程序在预热开始后 9 分钟停止交易；tick size 变化也停止交易，需要重启。运行阶段的 fetch 保护只放行真实模式下的 `POST /order`，禁止隐含 REST 查价/查 market。
- 新官方 SDK 自身包含 Zod/ky 等依赖及内部校验。这是“使用当前官方 SDK”和“完全不使用 Zod”之间的实际冲突；应用源码无 Zod、schema 库或额外 HTTP client。未修改 SDK 内部实现来绕过校验。
- 只支持私钥对应的 EOA 资金/持仓；不配置 proxy、Safe 或 deposit wallet。资金、token 持仓与链上授权需预先准备，本程序不发送授权交易。
- 自动盈利目标只统计本程序当前运行期间提交并成功返回的 BUY，不读取启动前、网页或其他程序的持仓；重启和进入下一期市场会清空成本记录。目标计算暂不扣手续费。没有仓位查询、完整深度、重试或结算；失败/超时不自动重发。
- 不保证某个延迟或成交价格优于配置上限；需自行测量实际部署环境。事件循环调度、SDK 签名与网络耗时都仍然存在。

## 本次验证

- 使用 Node.js v24.19.0，通过 npm CLI 执行 `npm install`（34 个包，audit 0 vulnerabilities）与 `npm run build`。
- 当前 shell 没有 npm 命令，验证时将官方 npm CLI 临时解压至 `%TEMP%\poly-executor-npm`，执行 `node "$env:TEMP\poly-executor-npm\package\bin\npm-cli.js" install` / `run build`。标准安装 Node/npm 的终端可直接执行上面的命令。
- 随机生成、未存盘、未输出的测试 EOA：启动成功，连接真实官方 WS，手动 BUY/SELL 与一次自动 SELL 完成本地签名并 dry run。测试 token 来自 `btc-updown-5m-1789190400`，仅为验证时临时选择，不写入程序或示例配置。未发送真实订单。
- 一次自动触发样本：WS→parse 14.5 us；parse→trigger 41.7 us；WS→dry dispatch 1263.9 us / 1.2639 ms。不是 p50/p99 或实际 HTTP 延迟。
- 临时隔离检查脚本覆盖手动/自动 FAK、单次触发、盘口解析、并发锁、无效/过期报价、tick/缓存失效、断线、slippage/clamp、模拟 post 延迟、禁止隐藏 REST、失败不重试及数组消息。真实提交分支仅使用内存 fake transport。

官方参考：[SDK](https://github.com/Polymarket/ts-sdk/tree/main/packages/client)、[Market WebSocket](https://docs.polymarket.com/market-data/realtime-data)。
