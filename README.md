# POLY ONECLICK

一个轻量级的 Polymarket BTC 五分钟 FAK 交易执行器，使用 TypeScript、Node.js、官方 SDK 和 Market WebSocket。

终端支持中文和英文。完整说明见 [USER_GUIDE.md](./USER_GUIDE.md)。

## 安装与启动

需要 Node.js 24 或更高版本。第一次使用时，在项目目录运行：

```powershell
npm install
npm run build
```

随后编辑 `config.txt`，保存后双击 `start.cmd`。启动脚本只负责启动，不会修改配置。

如果代码发生变化，需要重新执行 `npm run build`。

## 配置

所有设置都放在 `config.txt`。模板见 [config.example.txt](./config.example.txt)。

```ini
# zh=中文，en=English
LANGUAGE=zh

MARKET_OUTCOME=UP
PRIVATE_KEY=0x你的64位十六进制私钥
POLYMARKET_WALLET=AUTO

# 每按一次 B 花费的美元金额
ORDER_SIZE=1

# 0.1 表示 10%
TAKE_PROFIT_ENABLED=true
TAKE_PROFIT=0.1
STOP_LOSS_ENABLED=true
STOP_LOSS=0.1

BUY_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0
SELL_SLIPPAGE=0

LIVE_TRADING=false
DEBUG_UI=false

TRADE_LOG_ENABLED=true
TRADE_LOG_FILE=trade-history.csv
```

`config.txt` 已被 Git 忽略，不会推送到仓库。不要分享其中的私钥。

`POLYMARKET_WALLET=AUTO` 会使用该私钥对应的 Polymarket Deposit Wallet，适合通常的网页账户。只有资金确实直接放在私钥地址中时才使用 `EOA`；也可以填写 Polymarket 资金钱包的完整 `0x...` 地址。

### 语言

- `LANGUAGE=zh`：中文界面。
- `LANGUAGE=en`：English interface。

修改语言后需要重新启动。它只改变文字，不改变下单逻辑。

### 模拟与真实交易

- `LIVE_TRADING=false`：连接真实行情，完成判断和本地签名，但不发送订单。
- `LIVE_TRADING=true`：允许发送真实订单。

建议先使用模拟模式确认市场、UP/DOWN、价格和订单份额。

## 启动菜单

启动后用上下键选择：

- `Bitcoin 五分钟`：自动寻找当前市场并准备 UP、DOWN 两个 Token。
- `其他市场`：手动输入 Token ID。

Bitcoin 五分钟模式会自动转到新一期。也可以用左右键查看相邻场次。

## 按键

| 按键 | 操作 |
| --- | --- |
| `B` | 花 `ORDER_SIZE` 美元 BUY |
| `S` | SELL 最近一笔未卖完 BUY 的剩余份额 |
| `A` | 开启或关闭自动止盈/止损 |
| `Tab` | 切换 UP / DOWN |
| `←` | 上一期 |
| `→` | 下一期 |
| `Ctrl+C` | 退出 |

界面在价格区域上方显示：

```text
+++ UP +++
```

或：

```text
--- DOWN ---
```

## BUY 与 SELL

BUY 和 SELL 都使用 FAK：能立即成交的部分成交，其余立即取消，不会留在盘口等待。

`ORDER_SIZE=1` 表示每次按 `B` 花 1 美元。每次 BUY 都记录为一个独立批次；按 `S` 时卖出最近一笔未卖完 BUY 的实际份额。

SELL 份额按 Polymarket SDK 可提交的两位小数向下取整。例如最近一笔 BUY 得到 `1.020409` 份，SELL 会提交 `1.02` 份；成交后不足 `0.01` 份的不可卖尾差会从本次运行记录中清除，避免重复提交后出现 `invalid maker amount`。

例如用 1 美元在 0.50 买到约 2 份，价格跌到 0.25 后按 `S`，仍然卖约 2 份，预计收回约 0.50 美元。程序不会重新计算成卖出价值 1 美元的份额。

自动止盈和止损也使用最近一笔未卖完 BUY 的成本和剩余份额。`TAKE_PROFIT=0.1` 表示成本上涨 10% 时触发，`STOP_LOSS=0.1` 表示成本下跌 10% 时触发。两侧分别用 `TAKE_PROFIT_ENABLED` 和 `STOP_LOSS_ENABLED` 开关。按 `A` 会 armed 所有已打开的项目；触发一次后自动关闭。

批次只保存在内存中；重启或进入下一期市场后会清空。

## 交易记录

默认会在项目目录异步追加 `trade-history.csv`。每行记录一次 BUY/SELL 的 UTC 时间、场次、UP/DOWN、盘口价、限价、实际成交价格、美元、份额、结果、触发来源和延迟。模拟订单标记为 `DRY_RUN` / `SIMULATED`，真实成交才会带有 Polymarket 返回的成交数量。

写入发生在下单发送或响应之后，不会在签名和 `postOrder()` 前同步写文件。该 CSV 用于后续分析，不会在重启时恢复持仓。

## 价格

- BUY 从 WebSocket 内存中的 `Best Ask` 开始计算。
- SELL 从 WebSocket 内存中的 `Best Bid` 开始计算。
- `BUY_SLIPPAGE` 是 BUY 可以接受的额外价格。
- `SELL_SLIPPAGE` 是 SELL 可以接受的价格下降。
- 关闭某一侧的 slippage 开关会放弃该侧价格保护，可能得到很差的成交价。

界面中的 `+++ UP +++` 和 `--- DOWN ---` 会随 `Tab` 切换。盘口只在面板中原地更新，不会写成连续行情日志。

## 行情与下单

实时价格来自 Polymarket Market WebSocket，不使用 REST polling。真实订单由官方 TypeScript SDK 本地签名后，通过 `postOrder()` 发送。

正常界面显示最近一次操作延迟。设置 `DEBUG_UI=true` 后可以查看完整延迟分解、完整 Token ID 和 market slug。私钥、API secret、签名和完整 SDK 错误对象不会显示。

## 当前限制

- 不读取网页或本次启动前的持仓。
- SELL 只能使用本程序本次运行记录的 BUY 批次。
- 不显示余额、完整盘口或盈亏。
- 不保证 FAK 全部成交。
- 不自动重试失败订单。
- 市场信息缓存接近过期时需要重启。

官方参考：[TypeScript SDK](https://github.com/Polymarket/ts-sdk/tree/main/packages/client)、[Market WebSocket](https://docs.polymarket.com/market-data/realtime-data)。
