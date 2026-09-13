import { createSecureClient, OrderSide, OrderType } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { fetchOrderBook } from '@polymarket/client/actions';
import WebSocket from 'ws';
import { emitKeypressEvents } from 'node:readline';

const now = process.hrtime.bigint;
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ORDER_URL = 'https://clob.polymarket.com/order';
const GAMMA_URL = 'https://gamma-api.polymarket.com/markets/slug/';
const MARKET_SECONDS = 300;

function formatSessionRange(start: number): string {
  const clock = (seconds: number): string => {
    const date = new Date(seconds * 1000);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  };
  return `${clock(start)}–${clock(start + MARKET_SECONDS)} UTC`;
}

function fault(message: string): Error {
  const error = new Error(message);
  error.name = 'ExecutorError';
  return error;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw fault(`Missing ${name}`);
  return value;
}

function numeric(name: string, min: number, max: number, fallback?: number): number {
  const raw = process.env[name];
  const value = raw === undefined && fallback !== undefined ? fallback : Number(required(name));
  if (!Number.isFinite(value) || value < min || value > max) throw fault(`Invalid ${name}`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name] ?? String(fallback);
  if (value !== 'true' && value !== 'false') throw fault(`Invalid ${name}`);
  return value === 'true';
}

function validTokenId(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) > 0n && BigInt(value) < 2n ** 256n;
}

function quitFromMenu(): never {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\n');
  process.exit(0);
}

async function chooseOption(title: string, options: string[]): Promise<number> {
  let selected = 0;
  const render = (): void => {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`${title}\n\n`);
    for (let index = 0; index < options.length; index++) {
      process.stdout.write(`${index === selected ? '▶' : ' '} ${options[index]}\n`);
    }
    process.stdout.write('\n使用 ↑ ↓ 选择，按 Enter 确认。\n');
  };
  return new Promise(resolve => {
    const onKey = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === 'c') quitFromMenu();
      if (key?.name === 'up') selected = (selected - 1 + options.length) % options.length;
      else if (key?.name === 'down') selected = (selected + 1) % options.length;
      else if (key?.name === 'return' || key?.name === 'enter') {
        process.stdin.off('keypress', onKey);
        resolve(selected);
        return;
      } else return;
      render();
    };
    process.stdin.on('keypress', onKey);
    render();
  });
}

async function askTokenId(): Promise<string> {
  let value = '';
  process.stdout.write('\x1b[2J\x1b[H请输入其他市场的 Token ID，然后按 Enter：\n\n');
  return new Promise(resolve => {
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === 'c') quitFromMenu();
      if (key?.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        if (!validTokenId(value)) {
          process.stdout.write('\nToken ID 不正确，请重新输入：\n');
          value = '';
          return;
        }
        process.stdin.off('keypress', onKey);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (/^\d+$/.test(text)) {
        value += text;
        process.stdout.write(text);
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

type Trace = {
  source: 'AUTO' | 'MANUAL';
  ws?: bigint;
  parsed?: bigint;
  input?: bigint;
  trigger: bigint;
  invoke?: bigint;
  post?: bigint;
  response?: bigint;
};

type MarketOutcome = 'UP' | 'DOWN';
type Quote = { bid: number; ask: number; received: bigint };
type CostBasis = { shares: number; cost: number };

// Formatting and console I/O happen on a later turn, never before order dispatch.
function report(event: string, trace?: Trace, detail?: object): void {
  setImmediate(() => {
    const data = (detail ?? {}) as Record<string, unknown>;
    const value = (name: string): string => data[name] === undefined || data[name] === null
      ? '-' : String(data[name]);
    const reasonText = (raw: unknown): string => {
      const reason = String(raw ?? '');
      if (reason === 'The selected market has already ended') return '该场次已结束';
      if (reason === 'BTC five-minute market was not found') return '该场次不存在或尚未生成';
      if (reason === 'BTC five-minute market is not open for trading') return '该场次尚未开放交易';
      if (reason === 'An order is currently being submitted') return '上一笔订单还在提交';
      if (reason === 'Market switch already in progress') return '市场切换进行中';
      if (reason === 'Only available in Bitcoin five-minute mode') return '仅 Bitcoin 五分钟模式可用';
      return reason || '未知原因';
    };
    const interval = (a?: bigint, b?: bigint): string | undefined => {
      if (a === undefined || b === undefined) return undefined;
      const us = Number(b - a) / 1e3;
      return `${us.toFixed(1)}µs/${(us / 1e3).toFixed(3)}ms`;
    };
    const latency = trace ? [
      ['WS→解析', interval(trace.ws, trace.parsed)],
      ['解析→触发', interval(trace.parsed, trace.trigger)],
      ['触发→发送', interval(trace.trigger, trace.post)],
      ['发送→响应', interval(trace.post, trace.response)],
      ['WS→发送', interval(trace.ws, trace.post)],
      ['按键→发送', interval(trace.input, trace.post)],
    ].filter((item): item is [string, string] => item[1] !== undefined)
      .map(([name, duration]) => `${name} ${duration}`).join('，') : '';
    const withLatency = (line: string): string => latency ? `${line} | ${latency}` : line;
    let line: string;

    if (event === 'READY') {
      const session = value('session');
      line = `准备完成｜${data.live ? '真实交易' : '模拟模式'}｜场次 ${session}｜B买 S卖 A自动卖 Tab切UP/DOWN ←上一期 →下一期`;
    } else if (event === 'WS CONNECTED') {
      line = '行情已连接';
    } else if (event === 'WS DISCONNECTED') {
      line = '行情已断开，正在重连；自动卖出已关闭';
    } else if (event === 'MARKET SELECTED' || event === 'MARKET SWITCHED') {
      line = `当前市场｜场次 ${value('session')}｜${value('market')}｜${value('outcome')}｜Token ${value('tokenId')}`;
    } else if (event === 'MARKET SWITCHING') {
      line = `${data.direction === 'NEXT' ? '正在前往下一期' : '正在返回上一期'}｜${value('targetMarket')}`;
    } else if (event === 'MARKET SWITCH FAILED') {
      line = `${data.direction === 'NEXT' ? '无法前往下一期' : '无法返回上一期'}｜${reasonText(data.reason)}`;
    } else if (event === 'MARKET SEARCH RETRY') {
      line = `下一期暂未就绪，正在重试｜${reasonText(data.reason)}`;
    } else if (event === 'CURRENT TOKEN') {
      line = `当前品种｜场次 ${value('session')}｜${value('outcome')}｜买 ${value('bestAsk')} 卖 ${value('bestBid')}｜Token ${value('tokenId')}`;
    } else if (event === 'ARMED') {
      line = `自动卖出已开启｜${value('outcome')}｜目标价 ${value('autoSellTarget')}`;
    } else if (event === 'DISARMED') {
      line = '自动卖出已关闭';
    } else if (event === 'ARM FAILED') {
      line = `无法开启自动卖出｜${value('reason')}`;
    } else if (event === 'TAB SWITCH UNAVAILABLE' || event === 'OUTCOME SWITCH FAILED') {
      line = `无法切换品种｜${value('reason')}`;
    } else if (event === 'OUTCOME SWITCH QUEUED') {
      line = `市场切换完成后将使用 ${value('outcome')}`;
    } else if (event === 'TRADING DISABLED') {
      line = `交易已暂停｜${value('reason')}`;
    } else if (event.startsWith('DRY RUN ')) {
      const side = event.endsWith('BUY') ? 'BUY' : 'SELL';
      const dryUs = Number(data.dry_input_to_dispatch_us ?? data.dry_trigger_to_dispatch_us);
      const dryLatency = Number.isFinite(dryUs)
        ? ` | 按键/触发→模拟发送 ${dryUs.toFixed(1)}µs/${(dryUs / 1e3).toFixed(3)}ms` : '';
      line = `模拟 ${side}｜${value('configuredSize')} ${value('configuredUnit')}｜盘口 ${value('quotePrice')}｜限价 ${value('limitPrice')}｜提交 ${value('submittedAmount')} ${value('submittedUnit')}${dryLatency}`;
    } else if (event === 'MANUAL BUY' || event === 'MANUAL SELL'
      || event === 'AUTO BUY' || event === 'AUTO SELL') {
      line = withLatency(`${event.startsWith('AUTO') ? '自动' : '手动'} ${event.endsWith('BUY') ? 'BUY' : 'SELL'} 已发送｜盘口 ${value('quotePrice')}｜限价 ${value('limitPrice')}｜${value('submittedAmount')} ${value('submittedUnit')}`);
    } else if (event === 'ORDER SUCCESS') {
      line = withLatency(`成交返回成功｜${value('side')}｜均价 ${value('averageFillPrice')}｜成交编号 ${value('orderId')}`);
    } else if (event === 'ORDER FAILED') {
      line = withLatency(`下单失败｜${value('side')}｜${data.reason ?? data.code ?? 'Polymarket rejected the order'}`);
    } else {
      line = data.reason ? `${event}｜${value('reason')}` : event;
    }
    console.log(line);
  });
}

async function main(): Promise<void> {
  const key = required('PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw fault('Invalid PRIVATE_KEY format');
  const orderSize = numeric('ORDER_SIZE', 0.01, Number.MAX_SAFE_INTEGER);
  const orderSizeUnit = process.env.ORDER_SIZE_UNIT ?? 'USD';
  if (orderSizeUnit !== 'USD' && orderSizeUnit !== 'SHARES') {
    throw fault('Invalid ORDER_SIZE_UNIT; use USD or SHARES');
  }
  const autoSellProfitPercent = numeric('AUTO_SELL_PROFIT_PERCENT', 0, 100_000);
  const buySlippageEnabled = boolean('BUY_SLIPPAGE_ENABLED', true);
  const sellSlippageEnabled = boolean('SELL_SLIPPAGE_ENABLED', true);
  const buySlippage = numeric('BUY_SLIPPAGE', 0, 0.9999, 0);
  const sellSlippage = numeric('SELL_SLIPPAGE', 0, 0.9999, 0);
  const live = boolean('LIVE_TRADING', false);

  if (!process.stdin.isTTY || !process.stdout.isTTY) throw fault('Interactive terminal required; run start.cmd');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const marketChoice = await chooseOption('选择市场', ['Bitcoin 五分钟', '其他市场']);
  const autoFindMarket = marketChoice === 0;
  const configuredOutcome = (process.env.MARKET_OUTCOME ?? 'UP').trim().toUpperCase();
  if (configuredOutcome !== 'UP' && configuredOutcome !== 'DOWN') {
    throw fault('Invalid MARKET_OUTCOME; use UP or DOWN');
  }
  let marketOutcome = configuredOutcome as MarketOutcome;
  let configuredTokenId = '';
  if (!autoFindMarket) {
    configuredTokenId = await askTokenId();
  }
  process.stdout.write('\x1b[2J\x1b[H正在连接 Polymarket...\n');

  // A last-line network guard also blocks SDK cache misses and error-recovery GETs.
  // Install before creating the long-lived SDK HTTP clients (ky captures fetch).
  const nativeFetch = globalThis.fetch;
  let maintenance = true;
  let credentialsReady = false;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (!maintenance && !(live && method === 'POST' && url === ORDER_URL)) {
      return Promise.reject(fault('Runtime REST blocked; restart to refresh metadata'));
    }
    // Maintenance may read market metadata. Only initial API credential setup may mutate.
    if (maintenance && method !== 'GET' && !(credentialsReady === false && url.endsWith('/auth/api-key'))) {
      return Promise.reject(fault('Unexpected maintenance mutation blocked'));
    }
    return nativeFetch(input, init);
  };

  const signer = privateKey(key as `0x${string}`);
  // Explicit EOA avoids SDK default deposit-wallet creation/deployment.
  const client = await createSecureClient({ signer, wallet: await signer.getAddress() });
  credentialsReady = true;

  let tokenId = configuredTokenId;
  let subscribedTokenIds = configuredTokenId ? [configuredTokenId] : [];
  let marketAssets: Partial<Record<MarketOutcome, string>> = {};
  let selectedMarketStart = 0;
  let selectedMarketSlug = '';
  const tokenTicks = new Map<string, number>();
  const tokenMinOrderSizes = new Map<string, number>();
  const quotes = new Map<string, Quote>();
  const costBasisByToken = new Map<string, CostBasis>();
  let activeSelection = 0;
  let tick = NaN;
  let minOrderSize = NaN;
  let cacheDeadline = 0n;
  let bestBid: number = NaN;
  let bestAsk: number = NaN;
  let armed = false;
  let busy = false;
  let stopped = false;
  let blocked: string | undefined;
  let socket!: WebSocket;
  let connectionGeneration = 0;
  let reconnect: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let rotation: NodeJS.Timeout | undefined;
  let lastPong = 0;
  let lastQuote = 0n;

  function entryPriceFor(assetId = tokenId): number | undefined {
    const basis = costBasisByToken.get(assetId);
    if (!basis || basis.shares <= 0 || basis.cost <= 0) return undefined;
    return basis.cost / basis.shares;
  }

  function autoSellTargetFor(assetId = tokenId): number | undefined {
    const entryPrice = entryPriceFor(assetId);
    return entryPrice === undefined ? undefined : entryPrice * (1 + autoSellProfitPercent / 100);
  }

  function recordBuy(assetId: string, shares: number, cost: number): void {
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost <= 0) return;
    const previous = costBasisByToken.get(assetId);
    costBasisByToken.set(assetId, {
      shares: (previous?.shares ?? 0) + shares,
      cost: (previous?.cost ?? 0) + cost,
    });
  }

  function recordSell(assetId: string, shares: number): void {
    const previous = costBasisByToken.get(assetId);
    if (!previous || !Number.isFinite(shares) || shares <= 0) return;
    const remainingShares = previous.shares - shares;
    if (remainingShares <= 1e-12) {
      costBasisByToken.delete(assetId);
      return;
    }
    costBasisByToken.set(assetId, {
      shares: remainingShares,
      cost: previous.cost * remainingShares / previous.shares,
    });
  }

  function tokenDetail(): object {
    const entryPrice = entryPriceFor();
    const autoSellTarget = autoSellTargetFor();
    return {
      outcome: autoFindMarket ? marketOutcome : 'CUSTOM',
      market: selectedMarketSlug || null,
      session: selectedMarketStart ? formatSessionRange(selectedMarketStart) : null,
      tokenId,
      bestBid: Number.isFinite(bestBid) ? bestBid : null,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
      minOrderSize,
      entryPrice: entryPrice ?? null,
      autoSellProfitPercent,
      autoSellTarget: autoSellTarget ?? null,
    };
  }

  async function prepareToken(assetId: string): Promise<{
    tick: number; minOrderSize: number; deadline: bigint;
  }> {
    // One startup-only metadata read. Quotes still come exclusively from WebSocket.
    const book = await fetchOrderBook(client, { assetId });
    const preparedTick = book.tickSize;
    const preparedMinOrderSize = Number(book.minOrderSize);
    if (!Number.isFinite(preparedMinOrderSize) || preparedMinOrderSize <= 0) {
      throw fault('Invalid market minimum order size');
    }
    const cacheStarted = now();
    // Sign and discard to warm the SDK metadata and both signing paths.
    await client.createMarketOrder({ assetId, side: OrderSide.BUY,
      amount: orderSizeUnit === 'USD' ? orderSize : orderSize * 0.5,
      maxPrice: 0.5, orderType: OrderType.FAK });
    await client.createMarketOrder({ assetId, side: OrderSide.SELL,
      shares: orderSizeUnit === 'SHARES' ? orderSize : orderSize / 0.5,
      minPrice: 0.5, orderType: OrderType.FAK });
    return {
      tick: preparedTick,
      minOrderSize: preparedMinOrderSize,
      deadline: cacheStarted + 540_000_000_000n,
    };
  }

  function readStringArray(raw: unknown): string[] {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return []; }
    }
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
  }

  async function discoverMarket(start = Math.floor(Date.now() / 1000 / MARKET_SECONDS) * MARKET_SECONDS): Promise<{
    assets: Record<MarketOutcome, string>; slug: string; start: number;
  }> {
    const slug = `btc-updown-5m-${start}`;
    const response = await nativeFetch(`${GAMMA_URL}${slug}`);
    if (!response.ok) throw fault('BTC five-minute market was not found');
    const market = await response.json() as Record<string, unknown>;
    if (market.slug !== slug || market.active !== true || market.closed === true
      || market.acceptingOrders !== true || market.enableOrderBook !== true) {
      throw fault('BTC five-minute market is not open for trading');
    }
    const outcomes = readStringArray(market.outcomes);
    const assetIds = readStringArray(market.clobTokenIds);
    const upIndex = outcomes.findIndex(item => item.toUpperCase() === 'UP');
    const downIndex = outcomes.findIndex(item => item.toUpperCase() === 'DOWN');
    const up = assetIds[upIndex];
    const down = assetIds[downIndex];
    if (upIndex < 0 || downIndex < 0 || !up || !down || !validTokenId(up) || !validTokenId(down)) {
      throw fault('Current market does not contain valid UP and DOWN tokens');
    }
    return { assets: { UP: up, DOWN: down }, slug, start };
  }

  function retireConnection(): void {
    connectionGeneration++;
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  function finishPreparation(
    assetIds: string[],
    activeAssetId: string,
    preparedTokens: Array<{
      assetId: string; tick: number; minOrderSize: number; deadline: bigint;
    }>,
  ): void {
    subscribedTokenIds = assetIds;
    tokenTicks.clear();
    tokenMinOrderSizes.clear();
    cacheDeadline = preparedTokens[0]?.deadline ?? 0n;
    for (const prepared of preparedTokens) {
      tokenTicks.set(prepared.assetId, prepared.tick);
      tokenMinOrderSizes.set(prepared.assetId, prepared.minOrderSize);
      if (prepared.deadline < cacheDeadline) cacheDeadline = prepared.deadline;
    }
    quotes.clear();
    tokenId = activeAssetId;
    tick = tokenTicks.get(activeAssetId) ?? NaN;
    minOrderSize = tokenMinOrderSizes.get(activeAssetId) ?? NaN;
    activeSelection++;
    bestBid = bestAsk = NaN;
    lastQuote = 0n;
    blocked = undefined;
    maintenance = false;
    clearTimeout(expiry);
    expiry = setTimeout(() => invalidate('Metadata lifetime exceeded; restart'),
      Math.max(0, Number(cacheDeadline - now()) / 1e6));
    connect();
  }

  async function selectAutomaticMarket(
    initial: boolean,
    attempt = 0,
    requestedStart?: number,
    direction?: 'PREVIOUS' | 'NEXT',
  ): Promise<void> {
    if (stopped) return;
    if (blocked === 'Changing BTC 5-minute market') return;
    const previousBlocked = blocked;
    armed = false;
    blocked = 'Changing BTC 5-minute market';
    if (busy) {
      if (direction) {
        blocked = previousBlocked;
        report('MARKET SWITCH FAILED', undefined, { direction, reason: 'An order is currently being submitted' });
      } else {
        rotation = setTimeout(() => { void selectAutomaticMarket(false); }, 50);
      }
      return;
    }
    maintenance = true;
    try {
      const selected = await discoverMarket(requestedStart);
      const preparedUp = await prepareToken(selected.assets.UP);
      const preparedDown = await prepareToken(selected.assets.DOWN);
      if (Math.floor(Date.now() / 1000) >= selected.start + MARKET_SECONDS) {
        throw fault('The selected market has already ended');
      }
      if (stopped) {
        maintenance = false;
        return;
      }
      retireConnection();
      marketAssets = selected.assets;
      selectedMarketStart = selected.start;
      selectedMarketSlug = selected.slug;
      costBasisByToken.clear();
      finishPreparation(
        [selected.assets.UP, selected.assets.DOWN],
        selected.assets[marketOutcome],
        [
          { assetId: selected.assets.UP, ...preparedUp },
          { assetId: selected.assets.DOWN, ...preparedDown },
        ],
      );
      const nextChangeMs = (selected.start + MARKET_SECONDS) * 1000 - Date.now() + 100;
      clearTimeout(rotation);
      rotation = setTimeout(() => { void selectAutomaticMarket(false); }, Math.max(100, nextChangeMs));
      report(direction ? 'MARKET SWITCHED' : 'MARKET SELECTED', undefined, { mode: 'AUTO', direction,
        outcome: marketOutcome,
        tokenId: selected.assets[marketOutcome], minOrderSize, market: selected.slug,
        session: formatSessionRange(selected.start),
        endsAt: new Date((selected.start + MARKET_SECONDS) * 1000).toISOString() });
    } catch (error) {
      maintenance = false;
      const reason = error instanceof Error && error.name === 'ExecutorError'
        ? error.message : 'Automatic market search failed';
      if (direction) {
        blocked = previousBlocked;
        report('MARKET SWITCH FAILED', undefined, { direction, reason,
          currentMarket: selectedMarketSlug });
        return;
      }
      if (initial && attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        return selectAutomaticMarket(true, attempt + 1);
      }
      if (initial) throw fault(reason);
      blocked = reason;
      report('MARKET SEARCH RETRY', undefined, { reason });
      rotation = setTimeout(() => { void selectAutomaticMarket(false); }, 1_000);
    }
  }

  function requestMarketStep(direction: 'PREVIOUS' | 'NEXT'): void {
    if (!autoFindMarket) {
      report('MARKET SWITCH FAILED', undefined, {
        direction, reason: 'Only available in Bitcoin five-minute mode',
      });
      return;
    }
    if (blocked === 'Changing BTC 5-minute market') {
      report('MARKET SWITCH FAILED', undefined, { direction, reason: 'Market switch already in progress' });
      return;
    }
    if (!selectedMarketStart) {
      report('MARKET SWITCH FAILED', undefined, { direction, reason: 'Current market is not ready' });
      return;
    }
    const targetStart = selectedMarketStart + (direction === 'NEXT' ? MARKET_SECONDS : -MARKET_SECONDS);
    clearTimeout(rotation);
    rotation = undefined;
    report('MARKET SWITCHING', undefined, { direction,
      targetMarket: `btc-updown-5m-${targetStart}` });
    void selectAutomaticMarket(false, 0, targetStart, direction);
  }

  async function selectConfiguredMarket(): Promise<void> {
    maintenance = true;
    const prepared = await prepareToken(configuredTokenId);
    finishPreparation([configuredTokenId], configuredTokenId,
      [{ assetId: configuredTokenId, ...prepared }]);
    report('MARKET SELECTED', undefined, { mode: 'MANUAL', tokenId: configuredTokenId, minOrderSize,
      market: 'CUSTOM', session: null });
  }

  function requestOutcomeToggle(): void {
    if (!autoFindMarket) {
      report('TAB SWITCH UNAVAILABLE', undefined, { reason: 'Only available for Bitcoin five-minute market' });
      return;
    }
    marketOutcome = marketOutcome === 'UP' ? 'DOWN' : 'UP';
    if (blocked === 'Changing BTC 5-minute market') {
      report('OUTCOME SWITCH QUEUED', undefined, { outcome: marketOutcome });
      return;
    }
    const nextTokenId = marketAssets[marketOutcome];
    const nextTick = nextTokenId ? tokenTicks.get(nextTokenId) : undefined;
    const nextMinOrderSize = nextTokenId ? tokenMinOrderSizes.get(nextTokenId) : undefined;
    if (!nextTokenId || nextTick === undefined || nextMinOrderSize === undefined) {
      report('OUTCOME SWITCH FAILED', undefined, { reason: 'Token is not prepared' });
      return;
    }
    armed = false;
    tokenId = nextTokenId;
    tick = nextTick;
    minOrderSize = nextMinOrderSize;
    activeSelection++;
    const quote = quotes.get(nextTokenId);
    bestBid = quote?.bid ?? NaN;
    bestAsk = quote?.ask ?? NaN;
    lastQuote = quote?.received ?? 0n;
    report('CURRENT TOKEN', undefined, tokenDetail());
  }

  function invalidate(reason: string): void {
    bestBid = bestAsk = NaN;
    armed = false;
    blocked = reason;
    report('TRADING DISABLED', undefined, { reason });
  }

  function priceFor(side: OrderSide): number {
    const slippageEnabled = side === OrderSide.BUY ? buySlippageEnabled : sellSlippageEnabled;
    if (!slippageEnabled) {
      return Number((side === OrderSide.BUY ? 1 - tick : tick).toFixed(4));
    }
    const units = side === OrderSide.BUY
      ? Math.floor((bestAsk + buySlippage) / tick + 1e-9)
      : Math.ceil((bestBid - sellSlippage) / tick - 1e-9);
    // Round toward the quoted price so tick alignment never exceeds slippage.
    return Number(Math.max(tick, Math.min(1 - tick, units * tick)).toFixed(4));
  }

  async function execute(side: OrderSide, trace: Trace): Promise<void> {
    trace.invoke = now();
    const connection = socket;
    let price: number | undefined;
    let quotePrice: number | undefined;
    let estimatedSharesAtQuote: number | undefined;
    let ownsLock = false;
    try {
      if (busy) throw fault('Another order is in flight');
      if (blocked) throw fault(blocked);
      if (trace.invoke >= cacheDeadline) throw fault('Metadata expired; restart');
      if (socket.readyState !== WebSocket.OPEN || !lastQuote || trace.invoke - lastQuote > 5_000_000_000n) {
        throw fault('No fresh WebSocket quote');
      }
      quotePrice = side === OrderSide.BUY ? bestAsk : bestBid;
      if (!Number.isFinite(quotePrice) || quotePrice <= 0 || quotePrice >= 1) throw fault('Requested book side is empty');
      estimatedSharesAtQuote = orderSizeUnit === 'SHARES' ? orderSize : orderSize / quotePrice;
      if (estimatedSharesAtQuote + 1e-9 < minOrderSize) {
        throw fault(`Order is about ${estimatedSharesAtQuote.toFixed(4)} shares; market minimum is ${minOrderSize} shares`);
      }
      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > bestAsk) throw fault('Crossed quote');
      const selection = activeSelection;
      const assetId = tokenId;
      const bidAtInvoke = bestBid;
      busy = true;
      ownsLock = true;
      price = priceFor(side);
      let submittedAmount: number;
      let submittedUnit: 'USD' | 'SHARES';
      let order: Awaited<ReturnType<typeof client.createMarketOrder>>;
      if (side === OrderSide.BUY) {
        // The SDK's FAK BUY input is USD. In SHARES mode, limit price converts
        // the requested share count into the maximum signed USD amount.
        submittedAmount = orderSizeUnit === 'USD' ? orderSize : orderSize * price;
        submittedUnit = 'USD';
        order = await client.createMarketOrder({ assetId, side,
          amount: submittedAmount, maxPrice: price, orderType: OrderType.FAK });
      } else {
        // The SDK's FAK SELL input is shares. USD mode sizes those shares from
        // the current best bid; actual proceeds depend on partial fills/prices.
        submittedAmount = orderSizeUnit === 'SHARES' ? orderSize : orderSize / bidAtInvoke;
        submittedUnit = 'SHARES';
        order = await client.createMarketOrder({ assetId, side,
          shares: submittedAmount, minPrice: price, orderType: OrderType.FAK });
      }
      // A disconnect or tick change during the async signer must prevent posting.
      if (stopped || blocked || socket !== connection || socket.readyState !== WebSocket.OPEN || now() >= cacheDeadline
        || activeSelection !== selection || tokenId !== assetId
        || !lastQuote || now() - lastQuote > 5_000_000_000n) {
        throw fault('Trading state changed during signing');
      }
      if (!live) {
        // Dispatch boundary only, NOT a real postOrder timestamp or HTTP latency.
        const dryDispatch = now();
        if (side === OrderSide.BUY) {
          const simulatedShares = orderSizeUnit === 'SHARES' ? orderSize : submittedAmount / quotePrice;
          recordBuy(assetId, simulatedShares, simulatedShares * quotePrice);
        } else {
          recordSell(assetId, submittedAmount);
        }
        report(`DRY RUN ${side}`, trace, { tokenId: assetId, quotePrice, limitPrice: price,
          estimatedSharesAtQuote, minOrderSize,
          orderType: 'FAK',
          configuredSize: orderSize, configuredUnit: orderSizeUnit,
          submittedAmount, submittedUnit,
          dry_dispatch_ns: dryDispatch.toString(),
          dry_ws_to_dispatch_us: trace.ws === undefined ? null : Number(dryDispatch - trace.ws) / 1e3,
          dry_ws_to_dispatch_ms: trace.ws === undefined ? null : Number(dryDispatch - trace.ws) / 1e6,
          dry_trigger_to_dispatch_us: Number(dryDispatch - trace.trigger) / 1e3,
          dry_trigger_to_dispatch_ms: Number(dryDispatch - trace.trigger) / 1e6,
          dry_input_to_dispatch_us: trace.input === undefined ? null : Number(dryDispatch - trace.input) / 1e3,
          dry_input_to_dispatch_ms: trace.input === undefined ? null : Number(dryDispatch - trace.input) / 1e6 });
        return;
      }
      trace.post = now();
      const pending = client.postOrder(order);
      report(`${trace.source} ${side}`, { ...trace }, { tokenId: assetId,
        quotePrice, limitPrice: price, estimatedSharesAtQuote, minOrderSize, orderType: 'FAK',
        configuredSize: orderSize, configuredUnit: orderSizeUnit,
        submittedAmount, submittedUnit });
      const response = await pending;
      trace.response = now();
      let averageFillPrice: number | undefined;
      if (response.ok) {
        const makingAmount = Number(response.makingAmount);
        const takingAmount = Number(response.takingAmount);
        if (makingAmount > 0 && takingAmount > 0) {
          if (side === OrderSide.BUY) {
            recordBuy(assetId, takingAmount, makingAmount);
            averageFillPrice = makingAmount / takingAmount;
          } else {
            recordSell(assetId, makingAmount);
            averageFillPrice = takingAmount / makingAmount;
          }
        }
      }
      report(response.ok ? 'ORDER SUCCESS' : 'ORDER FAILED', trace,
        response.ok ? { side, tokenId: assetId, quotePrice, limitPrice: price,
          estimatedSharesAtQuote, minOrderSize, averageFillPrice,
          orderId: response.orderId, status: response.status,
          makingAmount: response.makingAmount, takingAmount: response.takingAmount }
          : { side, tokenId: assetId, quotePrice, limitPrice: price, code: response.code });
    } catch (error) {
      if (trace.post !== undefined && trace.response === undefined) trace.response = now();
      // Never print SDK errors wholesale: they can contain requests/auth headers.
      report('ORDER FAILED', trace, { side, tokenId, quotePrice, limitPrice: price,
        estimatedSharesAtQuote, minOrderSize,
        reason: error instanceof Error && error.name === 'ExecutorError' ? error.message : 'SDK request/signing failed',
        outcome: trace.post === undefined ? 'not submitted' : 'check exchange; no automatic retry' });
    } finally {
      // A rejected overlapping keypress must not release the active order's lock.
      if (ownsLock) busy = false;
    }
  }

  function quoteNumber(raw: unknown): number {
    if (typeof raw !== 'string' && typeof raw !== 'number') return NaN;
    if (raw === '') return NaN;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : NaN;
  }

  function storeQuote(assetId: string, bid: number, ask: number, received: bigint): boolean {
    quotes.set(assetId, { bid, ask, received });
    if (assetId !== tokenId) return false;
    bestBid = bid;
    bestAsk = ask;
    lastQuote = received;
    return true;
  }

  // Both BTC outcomes stay hot in memory; no network work is needed on Tab.
  function update(message: any, received: bigint): boolean {
    if (!message || typeof message !== 'object') return false;
    if (message.event_type === 'price_change') {
      if (!Array.isArray(message.price_changes)) return false;
      let activeChanged = false;
      for (const change of message.price_changes) {
        const assetId = change?.asset_id;
        if (typeof assetId !== 'string' || !subscribedTokenIds.includes(assetId)) continue;
        if (storeQuote(assetId, quoteNumber(change.best_bid), quoteNumber(change.best_ask), received)) {
          activeChanged = true;
        }
      }
      return activeChanged;
    }
    if (message.event_type === 'market_resolved'
      && subscribedTokenIds.some(assetId => message.assets_ids?.includes(assetId))) {
      invalidate('Market resolved');
      return false;
    }
    const assetId = message.asset_id;
    if (typeof assetId !== 'string' || !subscribedTokenIds.includes(assetId)) {
      return false;
    }
    if (message.event_type === 'best_bid_ask') {
      return storeQuote(assetId, quoteNumber(message.best_bid), quoteNumber(message.best_ask), received);
    }
    if (message.event_type === 'tick_size_change'
      && Number(message.new_tick_size) !== tokenTicks.get(assetId)) {
      invalidate('Tick size changed; restart to refresh SDK metadata');
    }
    if (message.event_type === 'book' && Array.isArray(message.bids) && Array.isArray(message.asks)) {
      let bid = NaN;
      let ask = NaN;
      for (const level of message.bids) {
        const price = quoteNumber(level.price);
        if (Number(level.size) > 0 && Number.isFinite(price) && (!Number.isFinite(bid) || price > bid)) bid = price;
      }
      for (const level of message.asks) {
        const price = quoteNumber(level.price);
        if (Number(level.size) > 0 && Number.isFinite(price) && (!Number.isFinite(ask) || price < ask)) ask = price;
      }
      return storeQuote(assetId, bid, ask, received);
    }
    return false;
  }

  function handle(item: any, received: bigint, parsed: bigint): void {
    if (!update(item, received)) return;
    const targetPrice = autoSellTargetFor();
    const fire = armed && !busy && !blocked
      && targetPrice !== undefined && bestBid >= targetPrice;
    const judged = now();
    if (fire) {
      armed = false;
      void execute(OrderSide.SELL, { source: 'AUTO', ws: received, parsed, trigger: judged });
    }
  }

  function connect(): void {
    quotes.clear();
    bestBid = bestAsk = NaN;
    lastQuote = 0n;
    const generation = ++connectionGeneration;
    const ws = new WebSocket(WS_URL, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    socket = ws;
    let pingTimer: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      ws.send(JSON.stringify({ assets_ids: subscribedTokenIds, type: 'market', custom_feature_enabled: true }));
      lastPong = Date.now();
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > 30_000) { ws.terminate(); return; }
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 10_000);
      heartbeat = pingTimer;
      report('WS CONNECTED');
    });
    ws.on('message', data => {
      const received = now();
      const text = data.toString();
      if (text === 'PONG') { lastPong = Date.now(); return; }
      let message: any;
      try { message = JSON.parse(text); } catch { return; }
      const parsed = now();
      if (Array.isArray(message)) { for (const item of message) handle(item, received, parsed); }
      else handle(message, received, parsed);
    });
    ws.on('error', () => { ws.terminate(); });
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (heartbeat === pingTimer) heartbeat = undefined;
      if (generation !== connectionGeneration || stopped) return;
      quotes.clear();
      bestBid = bestAsk = NaN;
      lastQuote = 0n;
      armed = false;
      report('WS DISCONNECTED', undefined, { armed: false });
      reconnect = setTimeout(connect, 1_000);
    });
  }

  if (autoFindMarket) await selectAutomaticMarket(true);
  else await selectConfiguredMarket();
  process.stdin.on('keypress', (text, key) => {
    const input = now();
    if (key?.ctrl && key.name === 'c') { stop(); return; }
    if (key?.name === 'left') {
      requestMarketStep('PREVIOUS');
    } else if (key?.name === 'right') {
      requestMarketStep('NEXT');
    } else if (key?.name === 'tab') {
      requestOutcomeToggle();
    } else if (text === 'a') {
      if (armed) {
        armed = false;
        report('DISARMED', undefined, tokenDetail());
      } else if (blocked) {
        report('ARM FAILED', undefined, { reason: blocked, ...tokenDetail() });
      } else if (entryPriceFor() === undefined) {
        report('ARM FAILED', undefined, {
          reason: 'No BUY entry recorded for current token in this run', ...tokenDetail(),
        });
      } else {
        armed = true;
        report('ARMED', undefined, tokenDetail());
      }
    } else if (text === 'b' || text === 's') {
      const side = text === 'b' ? OrderSide.BUY : OrderSide.SELL;
      void execute(side, { source: 'MANUAL', input, trigger: now() });
    }
  });
  function stop(): void {
    stopped = true;
    armed = false;
    clearTimeout(expiry);
    clearTimeout(rotation);
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    connectionGeneration++;
    socket.terminate();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  report('READY', undefined, { live, tick, account: 'EOA',
    keys: 'b=BUY s=SELL a=arm/disarm Tab=UP/DOWN Left=previous Right=next',
    orderSize, orderSizeUnit, minOrderSize, autoFindMarket, marketOutcome,
    autoSellProfitPercent, buySlippageEnabled, sellSlippageEnabled,
    market: selectedMarketSlug || null,
    session: selectedMarketStart ? formatSessionRange(selectedMarketStart) : null });
}

main().catch(error => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  // Configuration errors are ours; SDK error objects are intentionally suppressed.
  console.error(error instanceof Error && error.name === 'ExecutorError' ? error.message : 'Startup SDK/network/signing failed');
  process.exitCode = 1;
});
