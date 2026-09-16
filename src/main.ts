import { createSecureClient, OrderSide, OrderType } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { fetchOrderBook } from '@polymarket/client/actions';
import WebSocket from 'ws';
import { emitKeypressEvents } from 'node:readline';

const now = process.hrtime.bigint;
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ORDER_URL = 'https://clob.polymarket.com/order';
const GAMMA_URL = 'https://gamma-api.polymarket.com/markets/slug/';
const POLYGON_RPC_URL = 'https://polygon.drpc.org';
const MARKET_SECONDS = 300;
type Language = 'zh' | 'en';
let language: Language = 'zh';

function tr(chinese: string, english: string): string {
  return language === 'en' ? english : chinese;
}

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

function safeOrderFailure(error: unknown): { reason: string; errorType?: string; status?: number; code?: string } {
  if (!(error instanceof Error)) return { reason: tr('SDK 请求失败', 'SDK request failed') };
  if (error.name === 'ExecutorError') return { reason: error.message, errorType: error.name };

  const record = error as Error & { status?: unknown; code?: unknown };
  const status = typeof record.status === 'number' ? record.status : undefined;
  const code = typeof record.code === 'string' && record.code.length <= 80 ? record.code : undefined;
  // Keep only the SDK's short message. Never stringify the error/cause/request because those may contain auth headers.
  const message = error.message
    .replace(/\s*\(https?:\/\/[^)]+\)\s*/gi, ' ')
    .replace(/0x[0-9a-f]{64,}/gi, '0x…')
    .replace(/\b\d{40,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const normalized = `${code ?? ''} ${message}`.toLowerCase();

  let reason: string;
  if (/no orders found to match.*fak/.test(normalized)) {
    reason = tr('FAK 未成交：订单到达时，限价内已无可卖订单；没有扣款',
      'FAK not filled: no sell order remained within the limit price when it arrived; no funds were spent');
  } else if (/balance|allowance|funds|collateral/.test(normalized)
    && /insufficient|not enough|exceed|low|allowance/.test(normalized)) {
    reason = tr('资金地址余额或交易授权不足', 'Funder balance or trading allowance is insufficient');
  } else if (/invalid signature|signature.*invalid|could not sign/.test(normalized)) {
    reason = tr('签名无效：请检查私钥与资金地址是否属于同一账户',
      'Invalid signature: check that the private key controls the configured funder wallet');
  } else if (/unauthorized|api key|authentication|auth /.test(normalized) || status === 401) {
    reason = tr('API 凭证无效，请重新启动以重新派生凭证',
      'API credentials were rejected; restart to derive them again');
  } else if (/trading is currently disabled|closed.only|post.only/.test(normalized) || status === 503) {
    reason = tr('Polymarket 当前暂停接受此订单', 'Polymarket is currently not accepting this order');
  } else if (error.name === 'RateLimitError' || status === 429) {
    reason = tr('请求过于频繁，请稍后再试', 'Rate limited; try again shortly');
  } else if (error.name === 'TransportError') {
    reason = tr(`网络请求失败${message ? `：${message}` : ''}`, `Network request failed${message ? `: ${message}` : ''}`);
  } else {
    const prefix = error.name === 'RequestRejectedError'
      ? tr('Polymarket 拒绝订单', 'Polymarket rejected the order')
      : tr('SDK 请求或签名失败', 'SDK request or signing failed');
    reason = `${prefix}${status === undefined ? '' : ` (HTTP ${status})`}${message ? `：${message}` : ''}`;
  }
  return { reason, errorType: error.name, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) };
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
    process.stdout.write(`\n${tr('使用 ↑ ↓ 选择，按 Enter 确认。', 'Use ↑ ↓ to select, then press Enter.')}\n`);
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
  process.stdout.write(`\x1b[2J\x1b[H${tr('请输入其他市场的 Token ID，然后按 Enter：', 'Enter the other market Token ID, then press Enter:')}\n\n`);
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
          process.stdout.write(`\n${tr('Token ID 不正确，请重新输入：', 'Invalid Token ID. Please enter it again:')}\n`);
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
type BuyLot = { shares: number; cost: number };
type UiTone = 'normal' | 'success' | 'warning' | 'error';
type UiDuration = { us: number; ms: number };
type UiLatency = {
  firstLabel: string;
  first?: UiDuration;
  response?: UiDuration;
  total?: UiDuration;
  breakdown: Array<{ label: string; duration: UiDuration }>;
};
type UiState = {
  mode: string;
  connection: string;
  readiness: string;
  market: string;
  marketSlug: string;
  session: string;
  sessionStart: number;
  outcome: string;
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  tick: number;
  minOrderSize: number;
  armed: boolean;
  entryPrice: number;
  positionShares: number;
  sellLotShares: number;
  buyLotCount: number;
  autoSellTarget: number;
  autoSellProfitPercent: number;
  orderSize: number;
  buySlippageEnabled: boolean;
  sellSlippageEnabled: boolean;
  buySlippage: number;
  sellSlippage: number;
  debug: boolean;
  latency?: UiLatency;
};
type UiEvent = { at: string; atMs: number; message: string; tone: UiTone; count: number; debug?: string };

const uiState: UiState = {
  mode: '准备中', connection: '连接中', readiness: '正在准备', market: '—', marketSlug: '',
  session: '—', sessionStart: 0, outcome: '—', tokenId: '', bestBid: NaN, bestAsk: NaN,
  tick: NaN, minOrderSize: NaN, armed: false, entryPrice: NaN, positionShares: 0,
  sellLotShares: 0, buyLotCount: 0,
  autoSellTarget: NaN, autoSellProfitPercent: 0, orderSize: NaN,
  buySlippageEnabled: true, sellSlippageEnabled: true, buySlippage: 0, sellSlippage: 0,
  debug: false,
};
const uiEvents: UiEvent[] = [];
let uiDirty = true;
let uiRenderBlocked = false;

function markUiDirty(): void {
  uiDirty = true;
}

function updateUiState(update: Partial<UiState>): void {
  Object.assign(uiState, update);
  markUiDirty();
}

function sessionStatus(): string {
  if (!uiState.sessionStart) return '';
  const current = Math.floor(Date.now() / 1000 / MARKET_SECONDS) * MARKET_SECONDS;
  return uiState.sessionStart === current ? tr('【当期】', '[CURRENT]')
    : uiState.sessionStart < current ? tr('【已结束】', '[ENDED]')
      : uiState.sessionStart === current + MARKET_SECONDS ? tr('【下一期】', '[NEXT]')
        : tr('【未来场次】', '[FUTURE]');
}

function sessionIndicator(): { label: string; tone: UiTone } {
  if (!uiState.sessionStart) return { label: tr('未知', 'Unknown'), tone: 'warning' };
  const current = Math.floor(Date.now() / 1000 / MARKET_SECONDS) * MARKET_SECONDS;
  if (uiState.sessionStart === current) return { label: tr('当期进行中', 'Current session'), tone: 'success' };
  if (uiState.sessionStart < current) return { label: tr('已过期', 'Expired'), tone: 'error' };
  if (uiState.sessionStart === current + MARKET_SECONDS) {
    return { label: tr('下一期（未开始）', 'Next session (not started)'), tone: 'warning' };
  }
  return { label: tr('未来场次（未开始）', 'Future session (not started)'), tone: 'warning' };
}

function numberText(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function shortToken(tokenId: string): string {
  return tokenId.length > 14 ? `${tokenId.slice(0, 7)}...${tokenId.slice(-5)}` : tokenId || '—';
}

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };

function paint(text: string, tone: UiTone): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined || tone === 'normal') return text;
  const color = tone === 'success' ? ANSI.green : tone === 'warning' ? ANSI.yellow : ANSI.red;
  return `${color}${text}${ANSI.reset}`;
}

function emphasize(text: string): string {
  return process.stdout.isTTY ? `${ANSI.bold}${text}${ANSI.reset}` : text;
}

function renderPanel(): void {
  const width = Math.max(38, Math.min(76, (process.stdout.columns || 80) - 2));
  const outcomeTone: UiTone = uiState.outcome === 'UP' ? 'success'
    : uiState.outcome === 'DOWN' ? 'error' : 'normal';
  const clip = (text: string, maximum: number): { text: string; width: number } => {
    let result = '', used = 0;
    for (const char of text.replace(/[\x00-\x1f\x7f]/g, ' ')) {
      const size = /[\u2e80-\uffff]/u.test(char) ? 2 : 1;
      if (used + size > maximum) break;
      result += char;
      used += size;
    }
    return { text: result, width: used };
  };
  const fitContent = (text: string): string => {
    const clipped = clip(text, width - 2);
    return ` ${clipped.text}${' '.repeat(width - clipped.width - 1)}`;
  };
  const styleContent = (text: string, tone: UiTone, bold: boolean): string => {
    if (!process.stdout.isTTY) return text;
    if (process.env.NO_COLOR !== undefined || tone === 'normal') return bold ? emphasize(text) : text;
    const color = tone === 'success' ? ANSI.green : tone === 'warning' ? ANSI.yellow : ANSI.red;
    return `${color}${bold ? ANSI.bold : ''}${text}${ANSI.reset}`;
  };
  const side = outcomeTone === 'normal' ? '│' : paint('█', outcomeTone);
  const row = (text: string, tone: UiTone = 'normal'): string =>
    `${side}${styleContent(fitContent(text), tone, false)}${side}`;
  const strongRow = (text: string): string => `${side}${styleContent(fitContent(text), 'normal', true)}${side}`;
  const strongToneRow = (text: string, tone: UiTone): string => {
    return `${side}${styleContent(fitContent(text), tone, true)}${side}`;
  };
  const frameLine = (left: string, right: string): string =>
    paint(`${left}${'─'.repeat(width)}${right}`, outcomeTone);
  const summaryTone: UiTone = uiState.connection === tr('已断开', 'Disconnected')
    || uiState.connection === tr('重连中', 'Reconnecting')
    || uiState.mode === tr('真实交易', 'LIVE TRADING') ? 'error'
      : uiState.connection === tr('已连接', 'Connected') ? 'success' : 'warning';
  const session = sessionIndicator();
  const spread = Number.isFinite(uiState.bestBid) && Number.isFinite(uiState.bestAsk)
    ? uiState.bestAsk - uiState.bestBid : NaN;
  const buyPrice = Number.isFinite(uiState.bestAsk) ? numberText(uiState.bestAsk) : tr('暂无报价', 'No quote');
  const sellPrice = Number.isFinite(uiState.bestBid) ? numberText(uiState.bestBid) : tr('暂无报价', 'No quote');
  const buySlip = uiState.buySlippageEnabled ? numberText(uiState.buySlippage) : tr('关闭', 'Off');
  const sellSlip = uiState.sellSlippageEnabled ? numberText(uiState.sellSlippage) : tr('关闭', 'Off');
  const outcomeBanner = uiState.outcome === 'UP' ? '+++ UP +++'
    : uiState.outcome === 'DOWN' ? '--- DOWN ---' : tr('品种 —', 'OUTCOME —');
  const lotLabel = uiState.buyLotCount === 1 ? 'lot' : 'lots';
  const eventSlots = Math.max(3, Math.min(10, (process.stdout.rows || 30) - 22));
  const visibleEvents = uiEvents.slice(-eventSlots).map(item =>
    paint(clip(`${item.at}  ${item.message}${item.count > 1 ? ` ×${item.count}` : ''}`, width).text, item.tone));
  const latency = uiState.latency;
  const latencyText = (value?: UiDuration): string => value ? `${value.ms.toFixed(3)} ms` : '—';
  const lines = [
    frameLine('┌', '┐'),
    row(`POLY ONECLICK  |  ${uiState.mode}  |  ${tr('行情', 'WS')} ${uiState.connection}  |  ${uiState.readiness}`, summaryTone),
    row(`${tr('市场：', 'Market: ')}${uiState.market}  |  ${uiState.outcome}  |  Token ${shortToken(uiState.tokenId)}`),
    row(`${tr('场次状态：', 'Session status: ')}${session.label}`, session.tone),
    row(`${tr('场次时间：', 'Session: ')}${uiState.session}`),
    frameLine('├', '┤'),
    strongToneRow(outcomeBanner, outcomeTone),
    strongRow(tr('当前可成交价格', 'CURRENT EXECUTABLE PRICES')),
    strongRow(`${tr('BUY  买入价', 'BUY   Price')}    ${buyPrice}    (Best Ask)`),
    strongRow(`${tr('SELL 卖出价', 'SELL  Price')}    ${sellPrice}    (Best Bid)`),
    row(`${tr('买卖价差：', 'Spread: ')}${numberText(spread)}`),
    frameLine('├', '┤'),
    row(tr(
      `每次 BUY：${numberText(uiState.orderSize)} USD  |  SELL：最近一笔 BUY 的剩余份额`,
      `Each BUY: ${numberText(uiState.orderSize)} USD  |  SELL: latest BUY lot balance`,
    )),
    row(tr(
      `本次记录：${numberText(uiState.positionShares)} 份（${uiState.buyLotCount} 笔）  |  Tick ${numberText(uiState.tick)}`,
      `Recorded: ${numberText(uiState.positionShares)} shares (${uiState.buyLotCount} ${lotLabel})  |  Tick ${numberText(uiState.tick)}`,
    )),
    row(tr(
      `下一次 SELL：${numberText(uiState.sellLotShares)} 份 @ 成本 ${numberText(uiState.entryPrice)}  |  目标 ${numberText(uiState.autoSellTarget)}`,
      `Next SELL: ${numberText(uiState.sellLotShares)} shares @ cost ${numberText(uiState.entryPrice)}  |  Target ${numberText(uiState.autoSellTarget)}`,
    )),
    row(tr(
      `自动卖出：${uiState.armed ? '已开启' : '关闭'} (+${numberText(uiState.autoSellProfitPercent, 2)}%)  |  滑点 买 ${buySlip} / 卖 ${sellSlip}`,
      `Auto sell: ${uiState.armed ? 'Armed' : 'Off'} (+${numberText(uiState.autoSellProfitPercent, 2)}%)  |  Slippage B ${buySlip} / S ${sellSlip}`,
    ),
      uiState.armed ? 'success' : 'normal'),
    frameLine('└', '┘'),
    clip(tr(
      '  B买  S卖  A自动  Tab切UP/DOWN  ←上期  →下期  Ctrl+C退出',
      '  B Buy  S Sell  A Auto  Tab UP/DOWN  ← Prev  → Next  Ctrl+C Exit',
    ), width).text,
    tr('最近事件', 'RECENT EVENTS'),
    ...(visibleEvents.length ? visibleEvents : [tr('暂无事件', 'No events')]),
    tr('最近延迟', 'LAST LATENCY'),
    `${latency?.firstLabel ?? 'Input → Post'}    ${latencyText(latency?.first)}`,
    `Post → Response    ${latencyText(latency?.response)}`,
    `Total              ${latencyText(latency?.total)}`,
  ];
  if (uiState.debug) {
    lines.push('', 'DEBUG', '─'.repeat(width), `Market ${uiState.marketSlug || '—'}`,
      `Token ${uiState.tokenId || '—'}`,
      ...(latency?.breakdown.map(item =>
        `${item.label.padEnd(18)} ${item.duration.us.toFixed(1)} µs / ${item.duration.ms.toFixed(3)} ms`) ?? []),
      ...uiEvents.slice(-3).flatMap(item => item.debug ? [`${item.at} ${item.debug}`] : []));
  }
  process.stdout.write(`\x1b[H\x1b[0J${lines.join('\n')}\n`);
}

function renderIfDirty(): void {
  if (!uiDirty || uiRenderBlocked) return;
  uiDirty = false;
  renderPanel();
}

function duration(a?: bigint, b?: bigint): UiDuration | undefined {
  if (a === undefined || b === undefined) return undefined;
  const us = Number(b - a) / 1e3;
  return { us, ms: us / 1e3 };
}

function pushUiEvent(message: string, tone: UiTone = 'normal', debug?: string): void {
  const atMs = Date.now();
  const previous = uiEvents.at(-1);
  if (previous && previous.message === message && previous.tone === tone && atMs - previous.atMs <= 2_000) {
    previous.at = new Date(atMs).toISOString().slice(11, 19);
    previous.atMs = atMs;
    previous.count++;
    previous.debug = debug;
    markUiDirty();
    return;
  }
  uiEvents.push({ at: new Date(atMs).toISOString().slice(11, 19), atMs,
    message, tone, count: 1, debug });
  if (uiEvents.length > 10) uiEvents.shift();
  markUiDirty();
}

// Formatting and console I/O happen on a later turn, never before order dispatch.
function report(event: string, trace?: Trace, detail?: object): void {
  setImmediate(() => {
    const data = (detail ?? {}) as Record<string, unknown>;
    const value = (name: string): string => data[name] === undefined || data[name] === null
      ? '-' : String(data[name]);
    const reasonText = (raw: unknown): string => {
      const reason = String(raw ?? '');
      const translations: Record<string, string> = {
        'The selected market has already ended': tr('该场次已结束', 'The selected session has ended'),
        'BTC five-minute market was not found': tr('该场次不存在或尚未生成', 'The session does not exist or is not ready'),
        'BTC five-minute market is not open for trading': tr('该场次尚未开放交易', 'The session is not open for trading'),
        'An order is currently being submitted': tr('上一笔订单还在提交', 'Another order is still being submitted'),
        'Another order is in flight': tr('上一笔订单还在提交', 'Another order is still being submitted'),
        'Market switch already in progress': tr('市场切换进行中', 'A market switch is already in progress'),
        'Only available in Bitcoin five-minute mode': tr('仅 Bitcoin 五分钟模式可用', 'Only available in Bitcoin five-minute mode'),
        'Only available for Bitcoin five-minute market': tr('仅 Bitcoin 五分钟模式可用', 'Only available in Bitcoin five-minute mode'),
        'Current market is not ready': tr('当前市场尚未准备完成', 'The current market is not ready'),
        'Token is not prepared': tr('Token 尚未准备完成', 'The token is not ready'),
        'No unsold BUY lot recorded for current token': tr('当前品种没有可卖的 BUY 批次', 'No unsold BUY lot for this outcome'),
        'No BUY entry recorded for current token in this run': tr('本次运行尚未买入当前品种', 'No BUY recorded for this outcome in this run'),
        'No fresh WebSocket quote': tr('没有新鲜的 WebSocket 行情', 'No fresh WebSocket quote'),
        'Requested book side is empty': tr('当前方向没有可成交报价', 'The requested side has no executable quote'),
        'Metadata expired; restart': tr('市场信息已过期，请重启', 'Market metadata expired; restart'),
        'Metadata lifetime exceeded; restart': tr('市场信息已过期，请重启', 'Market metadata expired; restart'),
        'Market resolved': tr('市场已经结算', 'Market resolved'),
        'Tick size changed; restart to refresh SDK metadata': tr('Tick 已变化，请重启', 'Tick size changed; restart'),
        'Trading state changed during signing': tr('签名期间市场状态发生变化，订单未发送', 'Trading state changed during signing; order not sent'),
        'Changing BTC 5-minute market': tr('正在切换 BTC 五分钟市场', 'Changing BTC five-minute market'),
        'SDK request/signing failed': tr('SDK 请求或签名失败', 'SDK request or signing failed'),
      };
      return translations[reason] ?? (reason || tr('未知原因', 'Unknown reason'));
    };
    const dryDispatchUs = Number(data.dry_input_to_dispatch_us ?? data.dry_ws_to_dispatch_us
      ?? data.dry_trigger_to_dispatch_us);
    if (trace) {
      const breakdown = [
        ['WS → Parse', duration(trace.ws, trace.parsed)],
        ['Parse → Trigger', duration(trace.parsed, trace.trigger)],
        ['Trigger → Post', duration(trace.trigger, trace.post)],
        ['Post → Response', duration(trace.post, trace.response)],
        ['WS → Post', duration(trace.ws, trace.post)],
        ['Input → Post', duration(trace.input, trace.post)],
      ].filter((item): item is [string, UiDuration] => item[1] !== undefined)
        .map(([label, value]) => ({ label, duration: value }));
      if (event.startsWith('DRY RUN')) {
        for (const [label, raw] of [
          ['Trigger → Dry', data.dry_trigger_to_dispatch_us],
          ['WS → Dry', data.dry_ws_to_dispatch_us],
          ['Input → Dry', data.dry_input_to_dispatch_us],
        ] as const) {
          if (raw === null || raw === undefined) continue;
          const us = Number(raw);
          if (Number.isFinite(us)) breakdown.push({ label, duration: { us, ms: us / 1e3 } });
        }
      }
      const first = Number.isFinite(dryDispatchUs) ? { us: dryDispatchUs, ms: dryDispatchUs / 1e3 }
        : duration(trace.input ?? trace.ws ?? trace.trigger, trace.post);
      const response = duration(trace.post, trace.response);
      const total = duration(trace.input ?? trace.ws ?? trace.trigger, trace.response) ?? first;
      if (first || response) {
        updateUiState({ latency: {
          firstLabel: event.startsWith('DRY RUN')
            ? `${trace.input === undefined ? 'WS' : 'Input'} → Dry`
            : `${trace.input === undefined ? 'WS' : 'Input'} → Post`,
          first, response, total, breakdown,
        } });
      }
    }
    const numericDetail = (name: string): number => {
      const raw = data[name];
      if (raw === null || raw === undefined || raw === '') return NaN;
      const result = Number(raw);
      return Number.isFinite(result) ? result : NaN;
    };
    updateUiState({
      ...(data.tokenId !== undefined && { tokenId: String(data.tokenId) }),
      ...(data.bestBid !== undefined && { bestBid: numericDetail('bestBid') }),
      ...(data.bestAsk !== undefined && { bestAsk: numericDetail('bestAsk') }),
      ...(data.minOrderSize !== undefined && { minOrderSize: numericDetail('minOrderSize') }),
      ...(data.entryPrice !== undefined && { entryPrice: numericDetail('entryPrice') }),
      ...(data.positionShares !== undefined && { positionShares: numericDetail('positionShares') }),
      ...(data.sellLotShares !== undefined && { sellLotShares: numericDetail('sellLotShares') }),
      ...(data.buyLotCount !== undefined && { buyLotCount: numericDetail('buyLotCount') }),
      ...(data.autoSellTarget !== undefined && { autoSellTarget: numericDetail('autoSellTarget') }),
    });
    let line: string;
    let tone: UiTone = 'normal';

    if (event === 'READY') {
      updateUiState({ mode: data.live ? tr('真实交易', 'LIVE TRADING') : tr('模拟模式', 'DRY RUN'),
        readiness: uiState.connection === tr('已连接', 'Connected') && Number.isFinite(uiState.bestBid)
          && Number.isFinite(uiState.bestAsk) ? tr('可以交易', 'Ready') : tr('等待行情', 'Waiting for quotes') });
      line = tr('准备完成', 'Ready');
      tone = data.live ? 'error' : 'warning';
    } else if (event === 'WS CONNECTED') {
      updateUiState({ connection: tr('已连接', 'Connected'), readiness: Number.isFinite(uiState.bestBid)
        && Number.isFinite(uiState.bestAsk) ? tr('可以交易', 'Ready') : tr('等待报价', 'Waiting for quotes') });
      line = tr('行情已连接', 'Market feed connected');
      tone = 'success';
    } else if (event === 'WS DISCONNECTED') {
      updateUiState({ connection: tr('重连中', 'Reconnecting'), readiness: tr('不可交易', 'Not ready'), armed: false,
        bestBid: NaN, bestAsk: NaN });
      line = tr('行情已断开，正在重连；自动卖出已关闭', 'Market feed disconnected; reconnecting; auto sell disarmed');
      tone = 'error';
    } else if (event === 'MARKET SELECTED' || event === 'MARKET SWITCHED') {
      updateUiState({ market: data.mode === 'AUTO' ? 'BTC 5M' : tr('其他市场', 'Other market'),
        marketSlug: value('market'), session: value('session'), sessionStart: Number(data.sessionStart) || 0,
        outcome: value('outcome'), connection: tr('连接中', 'Connecting'), readiness: tr('等待行情', 'Waiting for quotes'), armed: false });
      line = `${event === 'MARKET SWITCHED' ? tr('切换成功', 'Switch successful') : tr('市场已选择', 'Market selected')} → ${uiState.session} ${sessionStatus()} ${uiState.outcome}`;
      tone = 'success';
    } else if (event === 'MARKET SWITCHING') {
      updateUiState({ armed: false, readiness: tr('正在切换市场', 'Switching market') });
      line = `${data.direction === 'NEXT' ? tr('正在前往下一期', 'Moving to next session') : tr('正在返回上一期', 'Moving to previous session')}…`;
      tone = 'warning';
    } else if (event === 'MARKET SWITCH FAILED') {
      updateUiState({ readiness: uiState.connection === tr('已连接', 'Connected')
        ? tr('可以交易', 'Ready') : tr('等待行情', 'Waiting for quotes') });
      line = tr(
        `切换失败：${data.direction === 'NEXT' ? '无法前往下一期' : '无法返回上一期'}，${reasonText(data.reason)}；仍在 ${uiState.session}`,
        `Switch failed: cannot move ${data.direction === 'NEXT' ? 'to next' : 'to previous'} session; ${reasonText(data.reason)}; still on ${uiState.session}`,
      );
      tone = 'error';
    } else if (event === 'MARKET SEARCH RETRY') {
      line = tr(`下一期暂未就绪，正在重试｜${reasonText(data.reason)}`,
        `Next session is not ready; retrying | ${reasonText(data.reason)}`);
      tone = 'warning';
    } else if (event === 'CURRENT TOKEN') {
      updateUiState({ outcome: value('outcome'), armed: false,
        readiness: Number.isFinite(numericDetail('bestBid')) && Number.isFinite(numericDetail('bestAsk'))
          ? tr('可以交易', 'Ready') : tr('等待报价', 'Waiting for quotes') });
      line = tr(`品种切换成功 → ${uiState.outcome}`, `Outcome switched → ${uiState.outcome}`);
      tone = 'success';
    } else if (event === 'ARMED') {
      updateUiState({ armed: true });
      line = tr(`自动卖出已开启｜${value('outcome')}｜目标价 ${value('autoSellTarget')}`,
        `Auto sell armed | ${value('outcome')} | target ${value('autoSellTarget')}`);
      tone = 'success';
    } else if (event === 'DISARMED') {
      updateUiState({ armed: false });
      line = tr('自动卖出已关闭', 'Auto sell disarmed');
      tone = 'warning';
    } else if (event === 'ARM FAILED') {
      line = tr(`无法开启自动卖出｜${reasonText(data.reason)}`,
        `Cannot arm auto sell | ${reasonText(data.reason)}`);
      tone = 'error';
    } else if (event === 'TAB SWITCH UNAVAILABLE' || event === 'OUTCOME SWITCH FAILED') {
      line = tr(`无法切换品种｜${reasonText(data.reason)}`,
        `Cannot switch outcome | ${reasonText(data.reason)}`);
      tone = 'error';
    } else if (event === 'OUTCOME SWITCH QUEUED') {
      line = tr(`市场切换完成后将使用 ${value('outcome')}`,
        `Will use ${value('outcome')} after the market switch`);
      tone = 'warning';
    } else if (event === 'TRADING DISABLED') {
      updateUiState({ armed: false, readiness: tr('交易已暂停', 'Trading disabled') });
      line = tr(`交易已暂停｜${reasonText(data.reason)}`, `Trading disabled | ${reasonText(data.reason)}`);
      tone = 'error';
    } else if (event === 'AUTO SELL TRIGGER') {
      updateUiState({ armed: false });
      line = tr(`自动卖出触发｜买价 ${value('quotePrice')} ≥ 目标 ${value('autoSellTarget')}`,
        `Auto sell triggered | bid ${value('quotePrice')} ≥ target ${value('autoSellTarget')}`);
      tone = 'warning';
    } else if (event.startsWith('DRY RUN ')) {
      const side = event.endsWith('BUY') ? 'BUY' : 'SELL';
      const submitted = numericDetail('submittedAmount');
      const quote = numericDetail('quotePrice');
      line = side === 'BUY'
        ? tr(`模拟 BUY｜花 ${numberText(submitted)} USD → 约 ${numberText(numericDetail('estimatedSharesAtQuote'))} 份｜盘口 ${numberText(quote)}`,
          `DRY BUY | spend ${numberText(submitted)} USD → about ${numberText(numericDetail('estimatedSharesAtQuote'))} shares | quote ${numberText(quote)}`)
        : tr(`模拟 SELL｜卖 ${numberText(submitted)} 份 → 约 ${numberText(submitted * quote)} USD｜盘口 ${numberText(quote)}`,
          `DRY SELL | sell ${numberText(submitted)} shares → about ${numberText(submitted * quote)} USD | quote ${numberText(quote)}`);
      tone = 'warning';
    } else if (event === 'MANUAL BUY' || event === 'MANUAL SELL'
      || event === 'AUTO BUY' || event === 'AUTO SELL') {
      const side = event.endsWith('BUY') ? 'BUY' : 'SELL';
      const size = `${numberText(numericDetail('submittedAmount'))} ${side === 'BUY' ? 'USD' : tr('份', 'shares')}`;
      line = tr(
        `${event.startsWith('AUTO') ? '自动' : '手动'} ${side} 正在发送｜${size}｜盘口 ${value('quotePrice')} → 限价 ${value('limitPrice')}`,
        `${event.startsWith('AUTO') ? 'AUTO' : 'MANUAL'} ${side} sending | ${size} | quote ${value('quotePrice')} → limit ${value('limitPrice')}`,
      );
      tone = 'warning';
    } else if (event === 'ORDER SUCCESS') {
      const side = value('side');
      const making = numericDetail('makingAmount');
      const taking = numericDetail('takingAmount');
      line = side === 'BUY'
        ? tr(`订单成功｜BUY｜花 ${numberText(making)} USD → ${numberText(taking)} 份｜均价 ${value('averageFillPrice')}`,
          `Order success | BUY | spent ${numberText(making)} USD → ${numberText(taking)} shares | avg ${value('averageFillPrice')}`)
        : tr(`订单成功｜SELL｜卖 ${numberText(making)} 份 → ${numberText(taking)} USD｜均价 ${value('averageFillPrice')}`,
          `Order success | SELL | sold ${numberText(making)} shares → ${numberText(taking)} USD | avg ${value('averageFillPrice')}`);
      tone = 'success';
    } else if (event === 'ORDER FAILED') {
      line = tr(`下单失败｜${value('side')}｜${reasonText(data.reason ?? data.code ?? 'Polymarket rejected the order')}`,
        `Order failed | ${value('side')} | ${reasonText(data.reason ?? data.code ?? 'Polymarket rejected the order')}`);
      tone = 'error';
    } else {
      line = data.reason ? `${event}｜${value('reason')}` : event;
    }
    if (trace?.source === 'AUTO') updateUiState({ armed: false });
    pushUiEvent(line, tone, uiState.debug ? JSON.stringify(data) : undefined);
  });
}

async function main(): Promise<void> {
  const configuredLanguage = (process.env.LANGUAGE ?? 'zh').trim().toLowerCase();
  if (configuredLanguage !== 'zh' && configuredLanguage !== 'en') {
    throw fault('Invalid LANGUAGE; use zh or en');
  }
  language = configuredLanguage;
  const key = required('PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw fault('Invalid PRIVATE_KEY format');
  const configuredWallet = (process.env.POLYMARKET_WALLET ?? 'AUTO').trim();
  if (configuredWallet !== 'AUTO' && configuredWallet !== 'EOA'
    && !/^0x[0-9a-fA-F]{40}$/.test(configuredWallet)) {
    throw fault('Invalid POLYMARKET_WALLET; use AUTO, EOA, or a 0x wallet address');
  }
  const orderSize = numeric('ORDER_SIZE', 0.01, Number.MAX_SAFE_INTEGER);
  const legacyOrderSizeUnit = process.env.ORDER_SIZE_UNIT;
  if (legacyOrderSizeUnit !== undefined && legacyOrderSizeUnit !== 'USD') {
    throw fault('ORDER_SIZE_UNIT must be USD; SELL now closes the latest BUY lot');
  }
  const autoSellProfitPercent = numeric('AUTO_SELL_PROFIT_PERCENT', 0, 100_000);
  const buySlippageEnabled = boolean('BUY_SLIPPAGE_ENABLED', true);
  const sellSlippageEnabled = boolean('SELL_SLIPPAGE_ENABLED', true);
  const buySlippage = numeric('BUY_SLIPPAGE', 0, 0.9999, 0);
  const sellSlippage = numeric('SELL_SLIPPAGE', 0, 0.9999, 0);
  const live = boolean('LIVE_TRADING', false);
  const debugUi = boolean('DEBUG_UI', false);
  updateUiState({
    mode: live ? tr('真实交易', 'LIVE TRADING') : tr('模拟模式', 'DRY RUN'),
    connection: tr('连接中', 'Connecting'),
    readiness: tr('正在准备', 'Preparing'),
    orderSize, autoSellProfitPercent,
    buySlippageEnabled, sellSlippageEnabled, buySlippage, sellSlippage,
    debug: debugUi,
  });

  if (!process.stdin.isTTY || !process.stdout.isTTY) throw fault('Interactive terminal required; run start.cmd');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const marketChoice = await chooseOption(
    tr('选择市场', 'Select market'),
    [tr('Bitcoin 五分钟', 'Bitcoin five-minute'), tr('其他市场', 'Other market')],
  );
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
  process.stdout.write(`\x1b[2J\x1b[H${tr('正在连接 Polymarket...', 'Connecting to Polymarket...')}\n`);

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
    const maintenanceRead = method === 'GET' || (method === 'POST' && url === POLYGON_RPC_URL);
    if (maintenance && !maintenanceRead && !(credentialsReady === false && url.endsWith('/auth/api-key'))) {
      return Promise.reject(fault('Unexpected maintenance mutation blocked'));
    }
    return nativeFetch(input, init);
  };

  const signer = privateKey(key as `0x${string}`);
  const signerAddress = await signer.getAddress();
  // AUTO uses the SDK's deterministic Polymarket Deposit Wallet. EOA is available for standalone wallets.
  const client = configuredWallet === 'AUTO'
    ? await createSecureClient({ signer })
    : await createSecureClient({ signer, wallet: configuredWallet === 'EOA' ? signerAddress : configuredWallet });
  credentialsReady = true;

  let tokenId = configuredTokenId;
  let subscribedTokenIds = configuredTokenId ? [configuredTokenId] : [];
  let marketAssets: Partial<Record<MarketOutcome, string>> = {};
  let selectedMarketStart = 0;
  let selectedMarketSlug = '';
  const tokenTicks = new Map<string, number>();
  const tokenMinOrderSizes = new Map<string, number>();
  const quotes = new Map<string, Quote>();
  const buyLotsByToken = new Map<string, BuyLot[]>();
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
  let switchingMarket = false;
  let lastPong = 0;
  let lastQuote = 0n;

  function latestLotFor(assetId = tokenId): BuyLot | undefined {
    const lots = buyLotsByToken.get(assetId);
    if (!lots) return undefined;
    while (lots.length > 0 && lots[lots.length - 1].shares <= 1e-12) lots.pop();
    if (lots.length === 0) {
      buyLotsByToken.delete(assetId);
      return undefined;
    }
    return lots[lots.length - 1];
  }

  function positionFor(assetId = tokenId): { shares: number; cost: number; count: number } {
    const lots = buyLotsByToken.get(assetId) ?? [];
    let shares = 0;
    let cost = 0;
    for (const lot of lots) {
      shares += lot.shares;
      cost += lot.cost;
    }
    return { shares, cost, count: lots.length };
  }

  function entryPriceFor(assetId = tokenId): number | undefined {
    const lot = latestLotFor(assetId);
    if (!lot || lot.shares <= 0 || lot.cost <= 0) return undefined;
    return lot.cost / lot.shares;
  }

  function autoSellTargetFor(assetId = tokenId): number | undefined {
    const entryPrice = entryPriceFor(assetId);
    return entryPrice === undefined ? undefined : entryPrice * (1 + autoSellProfitPercent / 100);
  }

  function syncPositionUi(assetId: string): void {
    if (assetId !== tokenId) return;
    const position = positionFor(assetId);
    const lot = latestLotFor(assetId);
    const entryPrice = entryPriceFor(assetId);
    updateUiState({
      positionShares: position.shares,
      buyLotCount: position.count,
      sellLotShares: lot?.shares ?? 0,
      entryPrice: entryPrice ?? NaN,
      autoSellTarget: entryPrice === undefined
        ? NaN : entryPrice * (1 + autoSellProfitPercent / 100),
    });
  }

  function recordBuy(assetId: string, shares: number, cost: number): void {
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost <= 0) return;
    const lots = buyLotsByToken.get(assetId) ?? [];
    lots.push({ shares, cost });
    buyLotsByToken.set(assetId, lots);
    syncPositionUi(assetId);
  }

  function recordSell(assetId: string, shares: number): void {
    const lot = latestLotFor(assetId);
    if (!lot || !Number.isFinite(shares) || shares <= 0) return;
    const previousShares = lot.shares;
    const remainingShares = previousShares - Math.min(shares, previousShares);
    if (remainingShares <= 1e-12) {
      const lots = buyLotsByToken.get(assetId)!;
      lots.pop();
      if (lots.length === 0) buyLotsByToken.delete(assetId);
    } else {
      lot.shares = remainingShares;
      lot.cost *= remainingShares / previousShares;
    }
    syncPositionUi(assetId);
  }

  function tokenDetail(): object {
    const position = positionFor();
    const lot = latestLotFor();
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
      positionShares: position.shares,
      buyLotCount: position.count,
      sellLotShares: lot?.shares ?? 0,
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
      amount: orderSize,
      maxPrice: 0.5, orderType: OrderType.FAK });
    await client.createMarketOrder({ assetId, side: OrderSide.SELL,
      shares: 1,
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
    updateUiState({ tokenId: activeAssetId, tick, minOrderSize, bestBid: NaN, bestAsk: NaN,
      positionShares: 0, sellLotShares: 0, buyLotCount: 0,
      entryPrice: NaN, autoSellTarget: NaN,
      connection: tr('连接中', 'Connecting'), readiness: tr('等待行情', 'Waiting for quotes'), armed: false });
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
    if (switchingMarket) return;
    const previousBlocked = blocked;
    armed = false;
    blocked = 'Changing BTC 5-minute market';
    if (busy) {
      if (direction) {
        blocked = previousBlocked;
        report('MARKET SWITCH FAILED', undefined, { direction, reason: 'An order is currently being submitted' });
      } else {
        blocked = previousBlocked;
        rotation = setTimeout(() => { void selectAutomaticMarket(false); }, 50);
      }
      return;
    }
    switchingMarket = true;
    clearTimeout(rotation);
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
      buyLotsByToken.clear();
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
      report(initial ? 'MARKET SELECTED' : 'MARKET SWITCHED', undefined, { mode: 'AUTO', direction,
        outcome: marketOutcome,
        tokenId: selected.assets[marketOutcome], minOrderSize, market: selected.slug,
        session: formatSessionRange(selected.start),
        sessionStart: selected.start,
        endsAt: new Date((selected.start + MARKET_SECONDS) * 1000).toISOString() });
    } catch (error) {
      maintenance = false;
      const reason = error instanceof Error && error.name === 'ExecutorError'
        ? error.message : 'Automatic market search failed';
      if (direction) {
        blocked = previousBlocked;
        rotation = setTimeout(() => { void selectAutomaticMarket(false); },
          Math.max(100, (selectedMarketStart + MARKET_SECONDS) * 1000 - Date.now() + 100));
        report('MARKET SWITCH FAILED', undefined, { direction, reason,
          currentMarket: selectedMarketSlug });
        return;
      }
      if (initial && attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        switchingMarket = false;
        return await selectAutomaticMarket(true, attempt + 1);
      }
      if (initial) throw fault(reason);
      blocked = reason;
      report('MARKET SEARCH RETRY', undefined, { reason });
      rotation = setTimeout(() => { void selectAutomaticMarket(false); }, 1_000);
    } finally {
      switchingMarket = false;
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
    updateUiState({ bestBid: NaN, bestAsk: NaN, armed: false,
      readiness: tr('交易已暂停', 'Trading disabled') });
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
    let sellLotAtInvoke: BuyLot | undefined;
    let autoTargetAtInvoke: number | undefined;
    let autoTriggerReported = false;
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
      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > bestAsk) throw fault('Crossed quote');
      const selection = activeSelection;
      const assetId = tokenId;
      sellLotAtInvoke = side === OrderSide.SELL ? latestLotFor(assetId) : undefined;
      if (side === OrderSide.SELL && sellLotAtInvoke === undefined) {
        throw fault('No unsold BUY lot recorded for current token');
      }
      estimatedSharesAtQuote = side === OrderSide.BUY ? orderSize / quotePrice : sellLotAtInvoke!.shares;
      autoTargetAtInvoke = trace.source === 'AUTO' ? autoSellTargetFor(assetId) : undefined;
      busy = true;
      ownsLock = true;
      uiRenderBlocked = true;
      updateUiState({ readiness: tr('正在下单', 'Submitting order') });
      price = priceFor(side);
      let submittedAmount: number;
      let submittedUnit: 'USD' | 'SHARES';
      let order: Awaited<ReturnType<typeof client.createMarketOrder>>;
      if (side === OrderSide.BUY) {
        // Like Polymarket's market ticket, BUY input is the configured USD spend.
        submittedAmount = orderSize;
        submittedUnit = 'USD';
        order = await client.createMarketOrder({ assetId, side,
          amount: submittedAmount, maxPrice: price, orderType: OrderType.FAK });
      } else {
        // SELL closes the most recent unsold BUY lot; current price only determines proceeds.
        submittedAmount = sellLotAtInvoke!.shares;
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
          const simulatedShares = submittedAmount / quotePrice;
          recordBuy(assetId, simulatedShares, simulatedShares * quotePrice);
        } else {
          recordSell(assetId, submittedAmount);
        }
        uiRenderBlocked = false;
        if (trace.source === 'AUTO') {
          autoTriggerReported = true;
          report('AUTO SELL TRIGGER', undefined, { quotePrice, autoSellTarget: autoTargetAtInvoke });
        }
        report(`DRY RUN ${side}`, trace, { tokenId: assetId, quotePrice, limitPrice: price,
          ...tokenDetail(),
          estimatedSharesAtQuote, minOrderSize,
          orderType: 'FAK',
          buyAmountUsd: orderSize,
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
      uiRenderBlocked = false;
      if (trace.source === 'AUTO') {
        autoTriggerReported = true;
        report('AUTO SELL TRIGGER', undefined, { quotePrice, autoSellTarget: autoTargetAtInvoke });
      }
      report(`${trace.source} ${side}`, { ...trace }, { tokenId: assetId,
        quotePrice, limitPrice: price, estimatedSharesAtQuote, minOrderSize, orderType: 'FAK',
        buyAmountUsd: orderSize,
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
          ...tokenDetail(),
          estimatedSharesAtQuote, minOrderSize, averageFillPrice,
          orderId: response.orderId, status: response.status,
          makingAmount: response.makingAmount, takingAmount: response.takingAmount }
          : { side, tokenId: assetId, quotePrice, limitPrice: price, code: response.code });
    } catch (error) {
      if (trace.post !== undefined && trace.response === undefined) trace.response = now();
      if (trace.source === 'AUTO' && !autoTriggerReported) {
        report('AUTO SELL TRIGGER', undefined, { quotePrice, autoSellTarget: autoTargetAtInvoke });
      }
      // Never print SDK errors wholesale: they can contain requests/auth headers.
      const failure = safeOrderFailure(error);
      report('ORDER FAILED', trace, { side, tokenId, quotePrice, limitPrice: price,
        estimatedSharesAtQuote, minOrderSize,
        ...failure,
        outcome: trace.post === undefined ? 'not submitted' : 'check exchange; no automatic retry' });
    } finally {
      // A rejected overlapping keypress must not release the active order's lock.
      if (ownsLock) {
        uiRenderBlocked = false;
        busy = false;
        updateUiState({ readiness: blocked ? tr('不可交易', 'Not ready')
          : Number.isFinite(bestBid) && Number.isFinite(bestAsk)
            ? tr('可以交易', 'Ready') : tr('等待报价', 'Waiting for quotes') });
      }
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
    updateUiState({ bestBid: bid, bestAsk: ask,
      readiness: Number.isFinite(bid) && Number.isFinite(ask) && !blocked
        ? tr('可以交易', 'Ready') : tr('等待报价', 'Waiting for quotes') });
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
    updateUiState({ connection: tr('连接中', 'Connecting'),
      readiness: tr('等待行情', 'Waiting for quotes'), bestBid: NaN, bestAsk: NaN });
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
  let displayedSessionStatus = sessionStatus();
  const panelTimer = setInterval(() => {
    const status = sessionStatus();
    if (status !== displayedSessionStatus) {
      displayedSessionStatus = status;
      markUiDirty();
    }
    renderIfDirty();
  }, 100);
  panelTimer.unref();
  markUiDirty();
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
    clearInterval(panelTimer);
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
  report('READY', undefined, { live, tick, account: String(client.account.walletType),
    keys: 'b=BUY s=SELL a=arm/disarm Tab=UP/DOWN Left=previous Right=next',
    orderSize, orderSizeUnit: 'USD_BUY_THEN_SELL_LATEST_LOT', minOrderSize, autoFindMarket, marketOutcome,
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
