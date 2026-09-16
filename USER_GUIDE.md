# Polymarket BTC 5 分钟交易器使用手册

项目位置：

```text
C:\Users\czhang30\Desktop\poly\btc-5m-executor
```

## 1. 第一次使用

进入项目文件夹，用记事本打开 `config.txt`，填好配置并保存。

然后双击：

```text
start.cmd
```

`start.cmd` 只负责启动，不会修改配置。

建议第一次保持：

```ini
LIVE_TRADING=false
```

这样可以接收真实行情并测试 BUY、SELL、止盈和止损，但不会发送真实订单。

## 2. 完整配置

```ini
# ===== 界面语言 =====
LANGUAGE=zh

# ===== 账户与市场 =====
MARKET_OUTCOME=UP
PRIVATE_KEY=0x你的私钥
POLYMARKET_WALLET=AUTO
# 市场在启动菜单选择

# ===== 每次 BUY 花费 =====
ORDER_SIZE=1

# ===== 自动止盈 / 止损 =====
# 0.1=10%
TAKE_PROFIT_ENABLED=true
TAKE_PROFIT=0.1
STOP_LOSS_ENABLED=true
STOP_LOSS=0.1

# ===== 买入价格设置 =====
BUY_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0

# ===== 卖出价格设置 =====
SELL_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE=0

# ===== 运行模式 =====
LIVE_TRADING=false
DEBUG_UI=false

# ===== 轻量交易记录 =====
TRADE_LOG_ENABLED=true
TRADE_LOG_FILE=trade-history.csv
```

注意：等号两边不要有空格，不要给值加引号，`true` 和 `false` 必须小写。修改配置后需要重新启动程序。不要分享 `config.txt`，里面有你的私钥。

## 3. 每个参数是什么意思

### 界面语言

```ini
LANGUAGE=zh
```

- `LANGUAGE=zh`：终端显示中文。
- `LANGUAGE=en`：终端显示英文。

修改后保存 `config.txt` 并重新启动程序。交易方式和按键不会因为语言变化。

### 账户与市场

| 参数 | 怎么填写 |
| --- | --- |
| `MARKET_OUTCOME` | 选择 Bitcoin 五分钟时交易 `UP` 或 `DOWN` |
| `PRIVATE_KEY` | 控制 Polymarket 账户的本地钱包私钥，格式是 `0x` 加 64 位字符 |
| `POLYMARKET_WALLET` | `AUTO` 使用该私钥对应的 Polymarket Deposit Wallet；`EOA` 直接使用私钥地址；也可填写指定资金钱包地址 |

启动后只会出现两个选项：

- `Bitcoin 五分钟`
- `其他市场`

使用上下方向键选择，按 Enter 确认。这个选择只决定交易哪个市场，不会改变 BUY、SELL、金额、滑点、FAK 或自动退出方式。

- 选择 `Bitcoin 五分钟`：程序按照 `MARKET_OUTCOME=UP` 或 `DOWN` 自动寻找 Token，并在下一期自动更新。
- 选择 `其他市场`：程序会要求你输入该市场的 Token ID。

```ini
MARKET_OUTCOME=UP
```

想交易 Bitcoin 五分钟 DOWN 时，把它改成 `MARKET_OUTCOME=DOWN`。

一般保持 `POLYMARKET_WALLET=AUTO`。程序会通过官方 SDK 使用该私钥对应的 Polymarket Deposit Wallet，这通常就是网页账户持有余额的地址。如果你的账户是旧的 Proxy/Safe 钱包，可把这里改为 Polymarket 显示的完整资金钱包地址。只有资金直接放在私钥 EOA 地址中时才填写 `EOA`。

### 每次交易多少

```ini
LANGUAGE=zh

ORDER_SIZE=1
```

`ORDER_SIZE=1` 表示每按一次 `b` 花 1 美元买入，并把实际买到的份额记录为一个独立批次。

- 按一次 `b`：买约 1 美元，并记录实际成交份额。
- 按一次 `s`：卖掉最近一笔尚未卖完的 BUY 批次。
- 按三次：会分别尝试提交三笔订单。

例如用 1 美元在 0.50 买到约 2 份，之后价格跌到 0.25，按 `s` 仍然只卖这约 2 份，预计收回约 0.50 美元。程序不会按照新的价格重新凑出价值 1 美元的份额。FAK 如果只卖出一部分，剩余份额继续保留在该批次中。

Polymarket SDK 提交 SELL 时使用两位小数的份额并向下取整。例如 BUY 实际得到 `1.020409` 份，程序会提交 SELL `1.02` 份。成交后若只剩不足 `0.01` 份，程序会把它作为不可卖尾差从本次运行记录中清除，避免下一次按 `s` 生成 `invalid maker amount`。

### 自动止盈和止损

```ini
TAKE_PROFIT_ENABLED=true
TAKE_PROFIT=0.1
STOP_LOSS_ENABLED=true
STOP_LOSS=0.1
```

这两个值使用比率：`0.1` 表示 10%，`0.2` 表示 20%。例如最近一笔 BUY 的均价是 50¢：

- `TAKE_PROFIT=0.1`：最高买价达到 55¢ 时止盈。
- `STOP_LOSS=0.1`：最高买价降到 45¢ 时止损。

两个 `ENABLED` 开关互相独立：

- 只要止盈：`TAKE_PROFIT_ENABLED=true`、`STOP_LOSS_ENABLED=false`。
- 只要止损：`TAKE_PROFIT_ENABLED=false`、`STOP_LOSS_ENABLED=true`。
- 两个都要：两项都设为 `true`。
- 两个都不要：两项都设为 `false`，此时按 `a` 不会 armed。

先用程序按 `b` 买入，再按 `a` 同时开启止盈和止损。当前最高买价触及任一条线时，程序会按现有 FAK SELL 逻辑尝试卖出一次。没有本次买入记录时按 `a` 会显示无法开启。

程序为 UP 和 DOWN 分别记录本次运行中的 BUY 批次。它不会读取启动前、网页或其他程序买入的持仓；重启或进入下一期市场后会清空内存批次。目标暂时不扣手续费。触发一次后会自动关闭，想再次启用需要再按一次 `a`。

### 交易记录

```ini
TRADE_LOG_ENABLED=true
TRADE_LOG_FILE=trade-history.csv
```

默认在项目目录保存 `trade-history.csv`。每行包含 UTC 时间、场次、方向、盘口价、限价、实际成交价、美元、份额、成功或失败状态、手动/止盈/止损来源和延迟。模拟交易会明确标为 `DRY_RUN` 和 `SIMULATED`。

记录采用异步追加方式，在发送或收到结果以后才写入，不会在签名和发单前同步写文件。CSV 方便后期分析，但程序重启时不会从 CSV 恢复持仓。

### BUY 滑点

```ini
BUY_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0
```

这表示 BUY 只接受当前最低卖价，不主动接受更高价格。

`BUY_SLIPPAGE=0.01` 表示最多允许比当前最低卖价高 1¢。例如当前最低卖价为 50¢：

- 滑点 `0`：最高接受约 50¢。
- 滑点 `0.01`：最高接受约 51¢。
- 滑点 `0.02`：最高接受约 52¢。

如果设置 `BUY_SLIPPAGE_ENABLED=false`，程序会优先尽快买到，不再保护 BUY 的最高价格，可能买得非常贵。

### SELL 滑点

```ini
SELL_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE=0
```

这表示 SELL 只接受当前最高买价，不主动接受更低价格。

`SELL_SLIPPAGE=0.01` 表示最多允许比当前最高买价低 1¢。例如当前最高买价为 60¢：

- 滑点 `0`：最低接受约 60¢。
- 滑点 `0.01`：最低接受约 59¢。
- 滑点 `0.02`：最低接受约 58¢。

如果设置 `SELL_SLIPPAGE_ENABLED=false`，程序会优先尽快卖出，不再保护 SELL 的最低价格，可能卖得非常便宜。

### 模拟与真实交易

`LIVE_TRADING=false` 是模拟模式：接收真实市场行情，执行完整判断和本地签名，但不把订单发送到 Polymarket。

`LIVE_TRADING=true` 是真实交易模式：按 `b`、`s` 或自动止盈/止损触发时，会发送真实订单。

## 4. 按键操作

终端顶部固定显示当前场次、方向、盘口、本次运行持仓、订单设置和交易状态。内存中保留最近 10 条重要事件；较矮的终端显示最新几条，两秒内连续出现的相同事件会合并为计数。普通行情只更新盘口，不会增加事件。看到“切换成功”代表已选中目标场次；行情栏显示“已连接”代表新连接已建立。切换失败时保留原场次，并说明原因。

普通模式使用缩短的 Token ID，并只显示三项最近延迟。需要排查问题时把 `DEBUG_UI=false` 改成 `DEBUG_UI=true`，重启后会显示完整 Token ID、market slug 和完整延迟分解。调试界面仍不会显示私钥、签名或完整 SDK 错误对象。

场次旁会显示【当期】、【下一期】、【未来场次】或【已结束】，按当前时间自动更新，无需按键刷新。

程序显示 `READY` 后直接按键，不需要按 Enter。

| 按键 | 作用 |
| --- | --- |
| `b` | BUY 一次 |
| `s` | SELL 一次 |
| `a` | 同时开启或关闭自动止盈/止损 |
| `Tab` | Bitcoin 五分钟运行中切换 UP / DOWN |
| `←` | 尝试返回上一期五分钟市场 |
| `→` | 尝试前往下一期五分钟市场 |
| `Ctrl+C` | 退出程序 |

程序一次只处理一笔订单。上一笔还没完成时继续按键，新的订单不会排队。

选择 Bitcoin 五分钟后，可以随时按 `Tab` 切换方向。面板会原地更新当前方向、缩写 Token、`bestBid`、`bestAsk`、最近一笔未卖完 BUY 的成本、止盈价和止损价。切换不需要重新连接，并会关闭当前自动退出状态；需要自动止盈/止损时再按一次 `a`。按 `←` 或 `→` 可手动尝试切换到上一期或下一期；如果目标场次不存在、未开放或已结束，程序会提示无法切换并保留当前连接。当前场次结束后程序仍会自动切换。

选择“其他市场”时，程序只有你输入的一个 Token ID，因此 `Tab` 不切换品种。

## 5. 订单是什么类型

BUY 和 SELL 都是 FAK：立即成交现在能成交的数量，剩余部分马上取消。

例如想买 10 份，但当前符合价格要求的只有 4 份，可能只成交 4 份，剩余 6 份取消，不会挂在市场中等待。

所以看到下单成功，不一定代表设定数量全部成交。

## 6. 哪些因素会影响价格

### 网页价格和实际买卖价格不同

Polymarket 网页显示的价格通常只是参考价格。BUY 使用当前最低卖价，SELL 使用当前最高买价。

例如网页显示 50¢，实际可能是 BUY 要 52¢，SELL 只能得到 48¢。中间的差距就是买卖价差。

### 市场里的可成交数量

当前价格的数量不足时，大一点的订单可能只成交一部分、成交到更差的下一档价格，或者完全没有成交。

当前程序只看最好的一个买价和卖价，不提前计算后面每一档有多少数量。

### 滑点设置

滑点越大，越容易成交，但可能得到更差的价格。滑点为 0，价格保护更严格，但更容易部分成交或没有成交。关闭滑点开关表示放弃该方向的价格保护，风险最高。

### 市场变化

从程序看到价格到订单到达 Polymarket 之间，市场仍然会变化。BTC 突然上涨或下跌、临近本期结束、其他交易者撤单或下大单，都可能快速改变 UP/DOWN 的价格。

### 手续费

某些市场会收取手续费。手续费不一定改变显示的成交价，但会增加 BUY 的实际成本，或减少 SELL 的实际收入。

### 订单大小

订单越大，越可能吃掉当前价格上的全部数量并成交到更差价格。小订单通常更容易接近当前最佳价格成交。

### 网络和服务器时间

电脑网络和 Polymarket 服务器处理都需要时间，期间价格可能变化。模拟模式只能测本地准备订单的时间，不能模拟真实网络和成交时间。

### 选错 Token

UP 和 DOWN 是两个不同 Token。填错 `TOKEN_ID` 会直接交易错误方向。

## 7. 建议的第一次配置

```ini
ORDER_SIZE=1
TAKE_PROFIT_ENABLED=true
TAKE_PROFIT=0.1
STOP_LOSS_ENABLED=true
STOP_LOSS=0.1

MARKET_OUTCOME=UP

BUY_SLIPPAGE_ENABLED=true
SELL_SLIPPAGE_ENABLED=true
BUY_SLIPPAGE=0
SELL_SLIPPAGE=0

LIVE_TRADING=false
DEBUG_UI=false
TRADE_LOG_ENABLED=true
TRADE_LOG_FILE=trade-history.csv
```

测试步骤：

1. 启动后确认顶部显示“可以交易”。
2. 按 `b`，应看到“模拟 BUY”，并显示花费美元和买到的份额。
3. 按 `a`，应看到“自动卖出已开启”以及根据这笔 BUY 成本算出的止盈价和止损价。
4. 再按 `a` 关闭自动卖出，然后按 `s`，应看到“模拟 SELL”，卖出份额应与最近一笔 BUY 的记录相同。
5. 确认操作和价格正确后再考虑真实模式。

## 8. 常见问题

### 为什么按 Enter 没反应？

程序不需要 Enter。看到 `READY` 后直接按 `b`、`s` 或 `a`。

### 为什么没有成交？

常见原因：当前没有可成交订单、价格已经变化、滑点太严格、FAK 可成交数量为零、余额或持仓不足、填错 Token ID，或者仍处于模拟模式。

### 为什么日志中的 SELL limitPrice 是 0.01？

这是关闭 SELL 滑点保护时使用的最低可接受限价，不代表当前盘口价或预计成交价。建议使用 `SELL_SLIPPAGE_ENABLED=true` 和 `SELL_SLIPPAGE=0`，这样 SELL 限价就是按键时的当前最高买价。日志中的 `quotePrice` 是当前盘口价，`limitPrice` 是允许的最差价格。

### 为什么自动止盈或止损只执行一次？

每次按 `a` 只开启一次。触发后自动关闭，避免连续重复卖出。

### 为什么运行一段时间后要求重启？

为了避免使用过期的市场信息，程序大约运行 9 分钟后会停止交易。重新双击 `start.cmd` 即可。

## 9. 当前没有的功能

- 不显示账户余额和持仓。
- 不读取本次启动前的买入成本。
- 不显示完整盘口。
- 不统计盈亏。
- 不保证订单全部成交。
- 不会自动重复下单。
- 不会自动处理市场结算。

日常使用只需要修改 `config.txt`，保存后双击 `start.cmd`。
