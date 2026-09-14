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
  mode: '准备中' | '模拟模式' | '真实交易';
  connection: '连接中' | '已连接' | '重连中' | '已断开';
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
  autoSellTarget: number;
  autoSellProfitPercent: number;
  orderSize: number;
  orderSizeUnit: string;
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
  autoSellTarget: NaN, autoSellProfitPercent: 0, orderSize: NaN, orderSizeUnit: 'USD',
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
  return uiState.sessionStart === current ? '【当期】' : uiState.sessionStart < current ? '【已结束】'
    : uiState.sessionStart === current + MARKET_SECONDS ? '【下一期】' : '【未来场次】';
}

function sessionIndicator(): { label: string; tone: UiTone } {
  if (!uiState.sessionStart) return { label: '未知', tone: 'warning' };
  const current = Math.floor(Date.now() / 1000 / MARKET_SECONDS) * MARKET_SECONDS;
  if (uiState.sessionStart === current) return { label: '当期进行中', tone: 'success' };
  if (uiState.sessionStart < current) return { label: '已过期', tone: 'error' };
  if (uiState.sessionStart === current + MARKET_SECONDS) return { label: '下一期（未开始）', tone: 'warning' };
  return { label: '未来场次（未开始）', tone: 'warning' };
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
  const fit = (text: string): string => {
    const clipped = clip(text, width - 2);
    return `│ ${clipped.text}${' '.repeat(width - clipped.width - 1)}│`;
  };
  const row = (text: string, tone: UiTone = 'normal'): string => paint(fit(text), tone);
  const strongRow = (text: string): string => emphasize(fit(text));
  const summaryTone: UiTone = uiState.connection === '已断开' || uiState.connection === '重连中'
    || uiState.mode === '真实交易' ? 'error'
      : uiState.connection === '已连接' ? 'success' : 'warning';
  const session = sessionIndicator();
  const spread = Number.isFinite(uiState.bestBid) && Number.isFinite(uiState.bestAsk)
    ? uiState.bestAsk - uiState.bestBid : NaN;
  const buyPrice = Number.isFinite(uiState.bestAsk) ? numberText(uiState.bestAsk) : '暂无报价';
  const sellPrice = Number.isFinite(uiState.bestBid) ? numberText(uiState.bestBid) : '暂无报价';
  const buySlip = uiState.buySlippageEnabled ? numberText(uiState.buySlippage) : '关闭';
  const sellSlip = uiState.sellSlippageEnabled ? numberText(uiState.sellSlippage) : '关闭';
  const eventSlots = Math.max(3, Math.min(10, (process.stdout.rows || 30) - 21));
  const visibleEvents = uiEvents.slice(-eventSlots).map(item =>
    paint(clip(`${item.at}  ${item.message}${item.count > 1 ? ` ×${item.count}` : ''}`, width).text, item.tone));
  const latency = uiState.latency;
  const latencyText = (value?: UiDuration): string => value ? `${value.ms.toFixed(3)} ms` : '—';
  const lines = [
    `┌${'─'.repeat(width)}┐`,
    row(`POLY ONECLICK  |  ${uiState.mode}  |  行情 ${uiState.connection}  |  ${uiState.readiness}`, summaryTone),
    row(`市场：${uiState.market}  |  ${uiState.outcome}  |  Token ${shortToken(uiState.tokenId)}`),
    row(`场次状态：${session.label}`, session.tone),
    row(`场次时间：${uiState.session}`),
    `├${'─'.repeat(width)}┤`,
    strongRow('当前可成交价格'),
    strongRow(`BUY  买入价    ${buyPrice}    (Best Ask)`),
    strongRow(`SELL 卖出价    ${sellPrice}    (Best Bid)`),
    row(`买卖价差：${numberText(spread)}`),
    `├${'─'.repeat(width)}┤`,
    row(`订单：${numberText(uiState.orderSize)} ${uiState.orderSizeUnit}  |  Tick ${numberText(uiState.tick)}  |  最低 ${numberText(uiState.minOrderSize)} 份`),
    row(`本次持仓：${numberText(uiState.positionShares)} 份 @ ${numberText(uiState.entryPrice)}  |  目标 ${numberText(uiState.autoSellTarget)}`),
    row(`自动卖出：${uiState.armed ? '已开启' : '关闭'} (+${numberText(uiState.autoSellProfitPercent, 2)}%)  |  滑点 买 ${buySlip} / 卖 ${sellSlip}`,
      uiState.armed ? 'success' : 'normal'),
    `└${'─'.repeat(width)}┘`,
    clip('  B买  S卖  A自动  Tab切UP/DOWN  ←上期  →下期  Ctrl+C退出', width).text,
    '最近事件',
    ...(visibleEvents.length ? visibleEvents : ['暂无事件']),
    '最近延迟',
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
      if (reason === 'The selected market has already ended') return '该场次已结束';
      if (reason === 'BTC five-minute market was not found') return '该场次不存在或尚未生成';
      if (reason === 'BTC five-minute market is not open for trading') return '该场次尚未开放交易';
      if (reason === 'An order is currently being submitted') return '上一笔订单还在提交';
      if (reason === 'Market switch already in progress') return '市场切换进行中';
      if (reason === 'Only available in Bitcoin five-minute mode') return '仅 Bitcoin 五分钟模式可用';
      const minimum = /^Order is about ([\d.]+) shares; market minimum is ([\d.]+) shares$/.exec(reason);
      if (minimum) return `约 ${minimum[1]} 份，低于市场最低 ${minimum[2]} 份`;
      return reason || '未知原因';
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
      ...(data.autoSellTarget !== undefined && { autoSellTarget: numericDetail('autoSellTarget') }),
    });
    let line: string;
    let tone: UiTone = 'normal';

    if (event === 'READY') {
      updateUiState({ mode: data.live ? '真实交易' : '模拟模式',
        readiness: uiState.connection === '已连接' && Number.isFinite(uiState.bestBid)
          && Number.isFinite(uiState.bestAsk) ? '可以交易' : '等待行情' });
      line = '准备完成';
      tone = data.live ? 'error' : 'warning';
    } else if (event === 'WS CONNECTED') {
      updateUiState({ connection: '已连接', readiness: Number.isFinite(uiState.bestBid)
        && Number.isFinite(uiState.bestAsk) ? '可以交易' : '等待报价' });
      line = '行情已连接';
      tone = 'success';
    } else if (event === 'WS DISCONNECTED') {
      updateUiState({ connection: '重连中', readiness: '不可交易', armed: false,
        bestBid: NaN, bestAsk: NaN });
      line = '行情已断开，正在重连；自动卖出已关闭';
      tone = 'error';
    } else if (event === 'MARKET SELECTED' || event === 'MARKET SWITCHED') {
      updateUiState({ market: data.mode === 'AUTO' ? 'BTC 5M' : '其他市场',
        marketSlug: value('market'), session: value('session'), sessionStart: Number(data.sessionStart) || 0,
        outcome: value('outcome'), connection: '连接中', readiness: '等待行情', armed: false });
      line = `${event === 'MARKET SWITCHED' ? '切换成功' : '市场已选择'} → ${uiState.session} ${sessionStatus()} ${uiState.outcome}`;
      tone = 'success';
    } else if (event === 'MARKET SWITCHING') {
      updateUiState({ armed: false, readiness: '正在切换市场' });
      line = `${data.direction === 'NEXT' ? '正在前往下一期' : '正在返回上一期'}…`;
      tone = 'warning';
    } else if (event === 'MARKET SWITCH FAILED') {
      updateUiState({ readiness: uiState.connection === '已连接' ? '可以交易' : '等待行情' });
      line = `切换失败：${data.direction === 'NEXT' ? '无法前往下一期' : '无法返回上一期'}，${reasonText(data.reason)}；仍在 ${uiState.session}`;
      tone = 'error';
    } else if (event === 'MARKET SEARCH RETRY') {
      line = `下一期暂未就绪，正在重试｜${reasonText(data.reason)}`;
      tone = 'warning';
    } else if (event === 'CURRENT TOKEN') {
      updateUiState({ outcome: value('outcome'), armed: false,
        readiness: Number.isFinite(numericDetail('bestBid')) && Number.isFinite(numericDetail('bestAsk'))
          ? '可以交易' : '等待报价' });
      line = `品种切换成功 → ${uiState.outcome}`;
      tone = 'success';
    } else if (event === 'ARMED') {
      updateUiState({ armed: true });
      line = `自动卖出已开启｜${value('outcome')}｜目标价 ${value('autoSellTarget')}`;
      tone = 'success';
    } else if (event === 'DISARMED') {
      updateUiState({ armed: false });
      line = '自动卖出已关闭';
      tone = 'warning';
    } else if (event === 'ARM FAILED') {
      line = `无法开启自动卖出｜${reasonText(data.reason)}`;
      tone = 'error';
    } else if (event === 'TAB SWITCH UNAVAILABLE' || event === 'OUTCOME SWITCH FAILED') {
      line = `无法切换品种｜${value('reason')}`;
      tone = 'error';
    } else if (event === 'OUTCOME SWITCH QUEUED') {
      line = `市场切换完成后将使用 ${value('outcome')}`;
      tone = 'warning';
    } else if (event === 'TRADING DISABLED') {
      updateUiState({ armed: false, readiness: '交易已暂停' });
      line = `交易已暂停｜${value('reason')}`;
      tone = 'error';
    } else if (event === 'AUTO SELL TRIGGER') {
      updateUiState({ armed: false });
      line = `自动卖出触发｜买价 ${value('quotePrice')} ≥ 目标 ${value('autoSellTarget')}`;
      tone = 'warning';
    } else if (event.startsWith('DRY RUN ')) {
      const side = event.endsWith('BUY') ? 'BUY' : 'SELL';
      line = `模拟 ${side}｜盘口 ${value('quotePrice')} → 限价 ${value('limitPrice')}`;
      tone = 'warning';
    } else if (event === 'MANUAL BUY' || event === 'MANUAL SELL'
      || event === 'AUTO BUY' || event === 'AUTO SELL') {
      line = `${event.startsWith('AUTO') ? '自动' : '手动'} ${event.endsWith('BUY') ? 'BUY' : 'SELL'} 已提交｜盘口 ${value('quotePrice')} → 限价 ${value('limitPrice')}`;
      tone = 'warning';
    } else if (event === 'ORDER SUCCESS') {
      line = `订单成功｜${value('side')}｜均价 ${value('averageFillPrice')}`;
      tone = 'success';
    } else if (event === 'ORDER FAILED') {
      line = `下单失败｜${value('side')}｜${reasonText(data.reason ?? data.code ?? 'Polymarket rejected the order')}`;
      tone = 'error';
    } else {
      line = data.reason ? `${event}｜${value('reason')}` : event;
    }
    if (trace?.source === 'AUTO') updateUiState({ armed: false });
    pushUiEvent(line, tone, uiState.debug ? JSON.stringify(data) : undefined);
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
  const debugUi = boolean('DEBUG_UI', false);
  updateUiState({
    mode: live ? '真实交易' : '模拟模式',
    orderSize, orderSizeUnit, autoSellProfitPercent,
    buySlippageEnabled, sellSlippageEnabled, buySlippage, sellSlippage,
    debug: debugUi,
  });

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
  let switchingMarket = false;
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
    if (assetId === tokenId) {
      const basis = costBasisByToken.get(assetId)!;
      updateUiState({ positionShares: basis.shares, entryPrice: basis.cost / basis.shares,
        autoSellTarget: basis.cost / basis.shares * (1 + autoSellProfitPercent / 100) });
    }
  }

  function recordSell(assetId: string, shares: number): void {
    const previous = costBasisByToken.get(assetId);
    if (!previous || !Number.isFinite(shares) || shares <= 0) return;
    const remainingShares = previous.shares - shares;
    if (remainingShares <= 1e-12) {
      costBasisByToken.delete(assetId);
      if (assetId === tokenId) updateUiState({ positionShares: 0, entryPrice: NaN, autoSellTarget: NaN });
      return;
    }
    costBasisByToken.set(assetId, {
      shares: remainingShares,
      cost: previous.cost * remainingShares / previous.shares,
    });
    if (assetId === tokenId) updateUiState({ positionShares: remainingShares,
      entryPrice: previous.cost / previous.shares,
      autoSellTarget: previous.cost / previous.shares * (1 + autoSellProfitPercent / 100) });
  }

  function tokenDetail(): object {
    const basis = costBasisByToken.get(tokenId);
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
      positionShares: basis?.shares ?? 0,
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
    updateUiState({ tokenId: activeAssetId, tick, minOrderSize, bestBid: NaN, bestAsk: NaN,
      positionShares: 0, entryPrice: NaN, autoSellTarget: NaN,
      connection: '连接中', readiness: '等待行情', armed: false });
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
    updateUiState({ bestBid: NaN, bestAsk: NaN, armed: false, readiness: '交易已暂停' });
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
      estimatedSharesAtQuote = orderSizeUnit === 'SHARES' ? orderSize : orderSize / quotePrice;
      if (estimatedSharesAtQuote + 1e-9 < minOrderSize) {
        throw fault(`Order is about ${estimatedSharesAtQuote.toFixed(4)} shares; market minimum is ${minOrderSize} shares`);
      }
      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > bestAsk) throw fault('Crossed quote');
      const selection = activeSelection;
      const assetId = tokenId;
      const bidAtInvoke = bestBid;
      autoTargetAtInvoke = trace.source === 'AUTO' ? autoSellTargetFor(assetId) : undefined;
      busy = true;
      ownsLock = true;
      uiRenderBlocked = true;
      updateUiState({ readiness: '正在下单' });
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
        uiRenderBlocked = false;
        if (trace.source === 'AUTO') {
          autoTriggerReported = true;
          report('AUTO SELL TRIGGER', undefined, { quotePrice, autoSellTarget: autoTargetAtInvoke });
        }
        report(`DRY RUN ${side}`, trace, { tokenId: assetId, quotePrice, limitPrice: price,
          ...tokenDetail(),
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
      uiRenderBlocked = false;
      if (trace.source === 'AUTO') {
        autoTriggerReported = true;
        report('AUTO SELL TRIGGER', undefined, { quotePrice, autoSellTarget: autoTargetAtInvoke });
      }
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
      report('ORDER FAILED', trace, { side, tokenId, quotePrice, limitPrice: price,
        estimatedSharesAtQuote, minOrderSize,
        reason: error instanceof Error && error.name === 'ExecutorError' ? error.message : 'SDK request/signing failed',
        outcome: trace.post === undefined ? 'not submitted' : 'check exchange; no automatic retry' });
    } finally {
      // A rejected overlapping keypress must not release the active order's lock.
      if (ownsLock) {
        uiRenderBlocked = false;
        busy = false;
        updateUiState({ readiness: blocked ? '不可交易'
          : Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? '可以交易' : '等待报价' });
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
      readiness: Number.isFinite(bid) && Number.isFinite(ask) && !blocked ? '可以交易' : '等待报价' });
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
    updateUiState({ connection: '连接中', readiness: '等待行情', bestBid: NaN, bestAsk: NaN });
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
