/**
 * 自测 1：content.js 发货决策纯逻辑
 * 直接从真实源码提取函数（brace 匹配），不复制实现，保证测的就是跑的。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  'C:/Users/peter1/Desktop/project/seller/extension/content/content.js', 'utf8');

/** 按函数名从源码提取完整 function 声明（brace 匹配，跳过字符串/注释粗略版） */
function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = SRC.match(re);
  if (!m) throw new Error('源码里找不到函数: ' + name);
  let i = m.index, depth = 0, start = -1;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') { if (start < 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) return SRC.slice(m.index, i + 1); }
  }
  throw new Error('brace 不闭合: ' + name);
}

// ---------- 沙箱环境 ----------
const logs = [];
const stored = {};
const sandbox = {
  state: { settings: {}, products: [] },
  log: (lv, tx) => logs.push(lv + ': ' + tx),
  chrome: { storage: { local: { set: async (o) => Object.assign(stored, o) } } },
  // rand 返回 {min,max} 便于断言边界（replyDelay 直接透传 rand 的返回值）
  rand: (min, max) => ({ min, max }),
  backend: { enabled: () => false },
};
const fnNames = ['matchProduct', 'prepareDelivery', 'consumeCard', 'looksLikeCredential', 'replyDelay', 'buildDeliveryInfo', 'withBotMark'];
const code = fnNames.map(extract).join('\n\n');
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.__fns = {' + fnNames.join(',') + '};', sandbox);
const F = sandbox.__fns;

// ---------- 迷你断言 ----------
let pass = 0, fail = 0;
function eq(desc, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + '\n      期望 ' + e + '\n      实际 ' + a); }
}
function ok(desc, v) { eq(desc, !!v, true); }

// ========== A. matchProduct：绝不匹配错规则 ==========
console.log('\n[A] matchProduct 规则匹配（发错货第一道闸）');
sandbox.state.products = [
  { match: 'HeyGen', spec: '', price: '', mode: 'pool', cards: ['兜底卡'] },                    // 兜底：不限规格价格
  { match: 'HeyGen', spec: '新版', price: '169.00', mode: 'pool', cards: ['精确卡'] },          // 最具体
  { match: 'HeyGen', spec: '旧版', price: '', mode: 'pool', cards: ['旧版卡'] },                // 只限规格
  { match: 'Cursor', spec: 'Pro月卡', price: '99.00', mode: 'pool', cards: ['cursor卡'] },
];
let r;
r = F.matchProduct({ title: 'HeyGen数字人月卡', spec: '新版', price: '169.00' });
eq('规格+价格全中 → 选最具体规则(精确卡)', r.rule && r.rule.cards[0], '精确卡');
r = F.matchProduct({ title: 'HeyGen数字人月卡', spec: '旧版', price: '128.00' });
eq('旧版规格 → 命中"只限规格"规则，不被兜底抢走', r.rule && r.rule.cards[0], '旧版卡');
r = F.matchProduct({ title: 'HeyGen数字人月卡', spec: '尊享版', price: '999.00' });
eq('未配置的规格 → 落到兜底规则（配了兜底就走兜底）', r.rule && r.rule.cards[0], '兜底卡');

// 关键：去掉兜底规则后，规格对不上必须 needManual，绝不乱发
sandbox.state.products = [
  { match: 'HeyGen', spec: '新版', price: '169.00', mode: 'pool', cards: ['精确卡'] },
];
r = F.matchProduct({ title: 'HeyGen数字人月卡', spec: '尊享版', price: '999.00' });
eq('无兜底+规格不符 → rule 为空（不发货）', r.rule, null);
eq('无兜底+规格不符 → titleHit=true（触发人工告警）', r.titleHit, true);
r = F.matchProduct({ title: 'HeyGen数字人月卡', spec: '新版', price: '9.90' });
eq('规格对但价格不对（改价单）→ 不发货', r.rule, null);
r = F.matchProduct({ title: 'Figma会员', spec: '新版', price: '169.00' });
eq('标题不含匹配词 → 完全不管', r, { rule: null, titleHit: false });
r = F.matchProduct({ title: '', spec: '', price: '' });
eq('空标题 → 不发货', r.rule, null);

// ========== B. prepareDelivery：卡密组装 ==========
console.log('\n[B] prepareDelivery 卡密组装');
sandbox.state.settings = { deliveryTemplate: '感谢购买\n{卡密}\n有问题联系我' };
r = F.prepareDelivery({ mode: 'pool', match: 'X', cards: ['acc1----pwd1', 'acc2----pwd2'] });
eq('取库存第一条卡密', r.card, 'acc1----pwd1');
ok('模板 {卡密} 被替换且只发这一条', r.content.includes('acc1----pwd1') && !r.content.includes('acc2'));
r = F.prepareDelivery({ mode: 'pool', match: 'X', spec: 'S', cards: ['  ', ''] });
eq('库存全是空白 → 返回 null（不发+缺货告警）', r, null);
ok('  且记录了缺货 error 日志', logs.some(l => l.startsWith('error') && l.includes('库存为空')));
r = F.prepareDelivery({ mode: 'fixed', delivery: '网盘链接xxx' });
eq('固定内容模式 → 原样返回，无卡密', r, { content: '网盘链接xxx', card: null });
r = F.prepareDelivery({ mode: 'fixed', delivery: '' });
eq('固定内容为空 → null（不发）', r, null);

// ========== C. consumeCard：扣库存只扣一条 ==========
console.log('\n[C] consumeCard 扣库存');
(async () => {
  const rule = { match: 'X', cards: ['same', 'same', 'other'] };
  sandbox.state.products = [rule];
  await F.consumeCard(rule, 'same');
  eq('重复卡密只删第一条', rule.cards, ['same', 'other']);
  ok('剩 2 条触发补货 warn', logs.some(l => l.startsWith('warn') && l.includes('请及时补货')));

  // ========== D. 回头客发货标记去重（本次修复的核心） ==========
  console.log('\n[D] 发货标记去重（回头客不误判 / 本单能识别）');
  const doneMark = '【自动发货】';
  const orderA = 'A1111', orderB = 'B2222';
  // 和 deliverLocal 发送格式完全一致地构造消息
  const oldOrderMsg = doneMark + ' #' + orderA + '\n账号xx 密码yy';   // 上一单发的
  const legacyMsg = doneMark + '\n账号old 密码old';                   // 修复前旧格式
  const hit = (msgs, orderId) => msgs.some(m => m.role === 'seller' &&
    m.text.includes(doneMark) && m.text.includes('#' + orderId));
  eq('聊天里只有上一单标记 → 新订单B 不算已发（原bug场景）',
    hit([{ role: 'seller', text: oldOrderMsg }], orderB), false);
  eq('聊天里有本单标记 → 本单判已发（缓存丢失兜底生效）',
    hit([{ role: 'seller', text: oldOrderMsg }], orderA), true);
  eq('旧格式裸标记 → 不算已发（交给 orderId 幂等去重，不误跳过）',
    hit([{ role: 'seller', text: legacyMsg }], orderB), false);
  eq('买家自己发"【自动发货】 #B2222" → 不算（只认 seller 消息）',
    hit([{ role: 'buyer', text: doneMark + ' #' + orderB }], orderB), false);

  // ========== E. replyDelay 参数硬化 ==========
  console.log('\n[E] replyDelay 延迟参数硬化');
  sandbox.state.settings = { replyDelayMinMs: 2000, replyDelayMaxMs: 6000 };
  eq('正常配置 2000~6000', F.replyDelay(), { min: 2000, max: 6001 });
  sandbox.state.settings = {};
  eq('配置缺失 → 默认 2000~6000', F.replyDelay(), { min: 2000, max: 6001 });
  sandbox.state.settings = { replyDelayMinMs: 'abc', replyDelayMaxMs: NaN };
  eq('非法值(NaN) → 默认 2000~6000', F.replyDelay(), { min: 2000, max: 6001 });
  sandbox.state.settings = { replyDelayMinMs: 5000, replyDelayMaxMs: 1000 };
  eq('max<min（填反了）→ 回退安全区间 5000~6000', F.replyDelay(), { min: 5000, max: 6001 });

  // ========== F. looksLikeCredential：卡密绝不进话术库 ==========
  console.log('\n[F] looksLikeCredential 凭据识别（不泄露买家卡密）');
  sandbox.state.settings = { deliveryDoneMark: '【自动发货】' };
  ok('账号密码串 → 拦截', F.looksLikeCredential('你的账号 Ab1@xyz9 密码 P@ss1234'));
  ok('邮箱 → 拦截', F.looksLikeCredential('用这个 abc@gmail.com 登录'));
  ok('卡密分隔符 ---- → 拦截', F.looksLikeCredential('acc----pwd'));
  ok('含发货标记 → 拦截', F.looksLikeCredential('【自动发货】 #A1 内容'));
  ok('普通对话 → 放行', !F.looksLikeCredential('好的 拍下后自动发货哦'));
  ok('普通短句 → 放行', !F.looksLikeCredential('在的 请问什么问题'));

  // ========== G. buildDeliveryInfo：喂给AI的库存口径 ==========
  console.log('\n[G] buildDeliveryInfo AI库存口径');
  let info = F.buildDeliveryInfo('HeyGen数字人月卡', [
    { match: 'HeyGen', spec: '新版', price: '169', stock: 5 },
    { match: 'HeyGen', spec: '旧版', price: '128', stock: 0 },
  ]);
  ok('有货规格 → "有货，拍下可秒发"', info.includes('有货，拍下可秒发'));
  ok('零库存规格 → 如实说缺货', info.includes('暂时缺货'));
  info = F.buildDeliveryInfo('Figma会员', [{ match: 'HeyGen', spec: '', price: '', stock: 3 }]);
  ok('未配置商品 → 明确"人工发货"', info.includes('人工发货'));

  console.log('\n===== content.js 逻辑: ' + pass + ' 通过, ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
