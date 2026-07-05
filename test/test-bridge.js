/**
 * 自测 2：bridge.js 整文件在沙箱里跑（mock window + lib.mtop），
 * 走真实的 postMessage 协议测：翻页拉单、脱敏字段、规格提取、consignDummy 防呆。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(
  'C:/Users/peter1/Desktop/project/seller/extension/content/bridge.js', 'utf8');

// ---------- mock 页面环境 ----------
const listeners = {};
const outbox = [];   // 桥回给内容脚本的消息
let mtopCalls = [];  // 记录每次 mtop 请求参数
let mtopImpl = async () => { throw new Error('未设置 mtopImpl'); };

const window = {
  addEventListener: (type, fn) => { listeners[type] = fn; },
  postMessage: (msg) => outbox.push(msg),
  lib: { mtop: { request: (opts) => { mtopCalls.push(opts); return mtopImpl(opts); } } },
};
// vm contextify 会代理宿主对象，外部的 window 引用和沙箱内看到的 window 身份不同，
// 会让桥的 ev.source !== window 来源校验拒收。ev.source 必须用沙箱内部的 window 引用。
window.window = window;
vm.createContext(window);
vm.runInContext(SRC, window);
const innerWindow = vm.runInContext('window', window); // 沙箱视角的 window（校验用这个）

function makeOrder(i, over = {}) {
  return {
    commonData: { orderId: 'OD' + i, itemId: 'IT' + i, orderStatus: over.status || '待发货', inRefund: over.inRefund || false },
    itemVO: { title: over.title || 'HeyGen数字人月卡', itemInfoLines: [{ a: '规格' }, { b: over.spec || '新版' }] },
    priceVO: { auctionPrice: over.price || '169.00' },
    buyerInfoVO: { userNick: over.nick || '买家' + i },
  };
}
const okRes = (orders) => ({ ret: ['SUCCESS::调用成功'], data: { module: { orderList: orders } } });

/** 通过真实 message 协议调桥并等待回包 */
let seq = 0;
async function call(action, payload) {
  const id = 't' + (++seq);
  outbox.length = 0;
  await listeners.message({ data: { source: 'XY_CS', id, action, payload }, source: innerWindow });
  await new Promise(r => setImmediate(r));
  return outbox.find(m => m.id === id);
}

let pass = 0, fail = 0;
const eq = (d, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log('  ✓ ' + d); }
  else { fail++; console.log('  ✗ ' + d + '\n      期望 ' + JSON.stringify(e) + '\n      实际 ' + JSON.stringify(a)); }
};
const ok = (d, v) => eq(d, !!v, true);

(async () => {
  console.log('\n[H] fetchWaitShipOrders 翻页与脱敏');
  // 第1页满50条 + 第2页5条 → 应拉全 55 条并停止
  mtopCalls = [];
  mtopImpl = async (opts) => {
    const page = opts.data.pageNumber;
    if (page === 1) return okRes(Array.from({ length: 50 }, (_, i) => makeOrder(i)));
    if (page === 2) return okRes(Array.from({ length: 5 }, (_, i) => makeOrder(100 + i)));
    return okRes([]);
  };
  let resp = await call('fetchWaitShipOrders');
  ok('调用成功', resp && resp.ok);
  eq('55 条全部拉到（翻页生效，修复前只有 50）', resp.data.length, 55);
  eq('只请求了 2 页（拿满即停）', mtopCalls.length, 2);
  const o = resp.data[0];
  eq('订单字段脱敏后只含判定所需字段',
    Object.keys(o).sort(),
    ['buyerNick', 'inRefund', 'itemId', 'orderId', 'orderStatus', 'price', 'spec', 'title']);
  eq('规格从 itemInfoLines 正确提取', o.spec, '新版');
  eq('订单状态透传', o.orderStatus, '待发货');

  // 不足一页 → 只请求 1 次
  mtopCalls = [];
  mtopImpl = async () => okRes([makeOrder(1), makeOrder(2, { inRefund: 'false' }), makeOrder(3, { inRefund: true })]);
  resp = await call('fetchWaitShipOrders');
  eq('不足一页只请求 1 次', mtopCalls.length, 1);
  eq('inRefund 字符串 "false" → false（不误拦）', resp.data[1].inRefund, false);
  eq('inRefund true → true（拦下退款单）', resp.data[2].inRefund, true);

  // 第 2 页失败 → 保留第 1 页结果，不整体报错
  mtopCalls = [];
  mtopImpl = async (opts) => opts.data.pageNumber === 1
    ? okRes(Array.from({ length: 50 }, (_, i) => makeOrder(i)))
    : { ret: ['FAIL_SYS_TOKEN::令牌过期'] };
  resp = await call('fetchWaitShipOrders');
  ok('第2页失败仍返回成功', resp.ok);
  eq('保留第1页 50 条', resp.data.length, 50);

  // 第 1 页就失败 → 必须报错（不能当成"没有待发货订单"静默吞掉）
  mtopImpl = async () => ({ ret: ['FAIL_SYS_SESSION_EXPIRED::请登录'] });
  resp = await call('fetchWaitShipOrders');
  eq('第1页失败 → ok:false 抛给上层重试', resp.ok, false);
  ok('错误信息带上 ret', resp.error.includes('FAIL_SYS_SESSION_EXPIRED'));

  console.log('\n[I] consignDummy 自动点发货防呆');
  resp = await call('consignDummy', { tradeText: '' });
  eq('缺 orderId → 拒绝执行', resp.ok, false);
  ok('  错误说明缺参数', resp.error.includes('缺少 orderId'));
  mtopImpl = async () => ({ ret: ['SUCCESS::ok'], data: { orderId: 'OD9' } });
  resp = await call('consignDummy', { orderId: 'OD9' });
  eq('正常发货返回 orderId', resp.data, { orderId: 'OD9' });
  mtopImpl = async () => ({ ret: ['FAIL_BIZ_ORDER_STATUS::订单状态不对'] });
  resp = await call('consignDummy', { orderId: 'OD9' });
  eq('接口失败 → ok:false（上层会响亮告警+人工兜底）', resp.ok, false);

  console.log('\n[J] 协议安全');
  outbox.length = 0;
  await listeners.message({ data: { source: 'XY_CS', id: 'x1', action: 'evilArbitraryCall' }, source: innerWindow });
  await new Promise(r => setImmediate(r));
  eq('白名单外操作被拒绝', outbox[0] && outbox[0].ok, false);
  outbox.length = 0;
  await listeners.message({ data: { source: 'XY_CS', id: 'x2', action: 'fetchWaitShipOrders' }, source: { other: true } });
  await new Promise(r => setImmediate(r));
  eq('非本窗口来源的消息被忽略（防第三方 iframe 调桥）', outbox.length, 0);

  console.log('\n===== bridge.js: ' + pass + ' 通过, ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
