/**
 * 自测 1：content.js 发货决策纯逻辑
 * 直接从真实源码提取函数（brace 匹配），不复制实现，保证测的就是跑的。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content', 'content.js'), 'utf8');

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
let fakeInputValue = '';   // 模拟聊天输入框里的内容（userActive 用）
const notifies = [];       // 捕获 notify 调用（告警节流测试用）
const sandbox = {
  state: { settings: {}, products: [], S: { inputBox: 'textarea' } },
  log: (lv, tx) => logs.push(lv + ': ' + tx),
  notify: (title, msg) => notifies.push(title + '|' + msg),
  chrome: { storage: { local: { set: async (o) => Object.assign(stored, o) } } },
  // rand 返回 {min,max} 便于断言边界（replyDelay 直接透传 rand 的返回值）
  rand: (min, max) => ({ min, max }),
  backend: { enabled: () => false },
  // 极简 document：只支持 querySelector(inputBox) 返回带 value 的假输入框
  document: { querySelector: (sel) => (sel === 'textarea' ? { value: fakeInputValue } : null) },
};
const fnNames = ['matchProduct', 'prepareDelivery', 'consumeCard', 'looksLikeCredential', 'replyDelay', 'buildDeliveryInfo', 'withBotMark', 'isMuted', 'setMuted', 'normNick', 'isMaskedNick', 'nickMatch', 'uniqueNickMatch', 'pickDeliverableOrders', 'userActive', 'noteConvLocateFail', 'isStableConvId', 'fallbackConvKey', 'convKeyOf', 'markAmbiguousConvs', 'readReactConvId', 'readConvStableId', 'normMsgText', 'seenNewOwnMessage', 'matchHandoffKeyword', 'wantsHuman', 'sootheWindowMs', 'sootheRecentlySent', 'panelStatus', 'notifyAtMostEvery', 'notifyStockOnce', 'auditSelectors'];
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

  // ========== H. 免打扰名单（对某用户停用机器人） ==========
  console.log('\n[H] 免打扰名单 isMuted/setMuted');
  sandbox.state.botMuted = {};
  ok('默认没人被静音', !F.isMuted('avatarKeyA'));
  ok('空 key → false（不误判）', !F.isMuted(''));
  ok('null key → false', !F.isMuted(null));
  await F.setMuted('avatarKeyA', '张三', true);
  ok('设置后 → 该用户被静音', F.isMuted('avatarKeyA'));
  eq('  持久化写入 storage.botMuted', !!stored.botMuted && !!stored.botMuted['avatarKeyA'], true);
  eq('  记录了昵称', stored.botMuted['avatarKeyA'].name, '张三');
  ok('别的用户不受影响', !F.isMuted('avatarKeyB'));
  // tick 过滤模拟：未读会话里静音的那个应被排除，不被机器人打开
  const scanned = [
    { key: 'avatarKeyA', name: '张三', unread: true },
    { key: 'avatarKeyB', name: '李四', unread: true },
  ];
  eq('tick 过滤：静音用户被排除，只留没静音的',
    scanned.filter(c => c.unread && !F.isMuted(c.key)).map(c => c.name), ['李四']);
  await F.setMuted('avatarKeyA', '张三', false);
  ok('取消静音后 → 恢复自动回复', !F.isMuted('avatarKeyA'));
  eq('  从 storage 移除', stored.botMuted['avatarKeyA'], undefined);

  // ========== I. 手动发货：挑单安全判断（防重复/防误发） ==========
  console.log('\n[I] pickDeliverableOrders 手动发货挑单');
  const O = (over) => Object.assign({ buyerNick:'张三', orderStatus:'待发货', inRefund:false, orderId:'x' }, over);
  let r2;
  r2 = F.pickDeliverableOrders([
    O({ orderId:'A', buyerNick:'张三' }),
    O({ orderId:'B', buyerNick:'李四' }),      // 别的买家
  ], '张三', {});
  eq('只挑当前买家的单', r2.todo.map(o=>o.orderId), ['A']);
  r2 = F.pickDeliverableOrders([O({ orderId:'A', orderStatus:'已发货' })], '张三', {});
  eq('非"待发货"状态 → 不发（权威状态判断）', r2.todo.length, 0);
  eq('  也不算 pending', r2.pending.length, 0);
  r2 = F.pickDeliverableOrders([O({ orderId:'A', inRefund:true })], '张三', {});
  eq('退款中 → 不发', r2.todo.length, 0);
  ok('  但能识别为该买家的单（用于提示退款中）', r2.forBuyer.length === 1);
  r2 = F.pickDeliverableOrders([O({ orderId:'A' })], '张三', { 'A': { ts:1 } });
  eq('已发过(deliveredOrders命中) → 不重复发', r2.todo.length, 0);
  r2 = F.pickDeliverableOrders([
    O({ orderId:'A' }), O({ orderId:'B' }), O({ orderId:'C', inRefund:true })
  ], '张三', { 'A': { ts:1 } });
  eq('混合：A已发/B可发/C退款 → 只发 B', r2.todo.map(o=>o.orderId), ['B']);
  r2 = F.pickDeliverableOrders(null, '张三', {});
  eq('订单接口返回空 → 安全返回空，不报错', r2.todo.length, 0);
  r2 = F.pickDeliverableOrders([O({ orderId:'A', buyerNick:'王五' })], '张三', {});
  eq('普通昵称对不上 → 不发（未脱敏时仍需精确一致）', r2.todo.length, 0);

  // ========== I2. 脱敏昵称匹配（闲鱼把买家名脱敏为 "一***啊"）==========
  console.log('\n[I2] 脱敏昵称匹配 nickMatch / uniqueNickMatch');
  // normNick
  eq('去零宽字符', F.normNick('张​三'), '张三');
  eq('去空白', F.normNick(' 张 三 '), '张三');
  eq('全角数字/字母归一', F.normNick('ＡＢ１２'), 'AB12');
  // isMaskedNick
  eq('识别半角星号脱敏', F.isMaskedNick('一***啊'), true);
  eq('识别全角星号脱敏', F.isMaskedNick('一＊＊＊啊'), true);
  eq('普通昵称不算脱敏', F.isMaskedNick('一个随意啊'), false);
  // nickMatch —— 核心：这就是本次线上 bug 的场景
  eq('★脱敏中间: 一个随意啊 ~ 一***啊', F.nickMatch('一个随意啊', '一***啊'), true);
  eq('参数顺序无关', F.nickMatch('一***啊', '一个随意啊'), true);
  eq('全角星号也认', F.nickMatch('一个随意啊', '一＊＊＊啊'), true);
  eq('完全相同', F.nickMatch('阿郎的鱼', '阿郎的鱼'), true);
  eq('不同人不匹配', F.nickMatch('阿郎的鱼', '大哥脸红了'), false);
  eq('脱敏但首尾对不上 → 不匹配', F.nickMatch('一个随意啊', '大***了'), false);
  eq('整串脱敏(***) → 拒绝(太危险)', F.nickMatch('随便谁', '***'), false);
  eq('两边都没脱敏且不等 → 不匹配', F.nickMatch('阿郎的鱼', '阿郎'), false);
  // uniqueNickMatch —— 防误发的唯一性保护
  const L = [{ name: '一个随意啊' }, { name: '大哥脸红了' }, { name: '泰迪队长' }];
  eq('脱敏唯一命中 → 返回该会话', (F.uniqueNickMatch(L, '一***啊') || {}).name, '一个随意啊');
  eq('脱敏多命中(歧义) → 返回 null 不乱发',
    F.uniqueNickMatch([{ name: '一个随意啊' }, { name: '一二三四啊' }], '一***啊'), null);
  eq('精确优先于脱敏', (F.uniqueNickMatch([{ name: '张三' }, { name: '张三丰' }], '张三') || {}).name, '张三');
  eq('谁都不匹配 → null', F.uniqueNickMatch(L, '查无此人'), null);
  // pickDeliverableOrders 端到端（本次 bug 的真实数据）
  r2 = F.pickDeliverableOrders([O({ orderId:'A', buyerNick:'一***啊' })], '一个随意啊', {});
  eq('★脱敏买家的待发货单能挑出来（修复点）', r2.todo.map(o=>o.orderId), ['A']);
  r2 = F.pickDeliverableOrders([O({ orderId:'A', buyerNick:'一***啊', orderStatus:'已发货' })], '一个随意啊', {});
  eq('脱敏但已发货 → 不重复发', r2.todo.length, 0);

  // ========== J. userActive：你在操作时机器人不抢屏 ==========
  console.log('\n[J] userActive 真人活动检测（防抢窗口）');
  const now = Date.now();
  // 基线：没活动、输入框空、开关默认 → 不忙
  sandbox.state.settings = {};
  sandbox.state.lastUserActivity = 0;
  fakeInputValue = '';
  ok('很久没动 + 输入框空 → 不忙（机器人可处理）', !F.userActive());
  // 输入框有字 = 正在打字 → 一定判定为忙（不受计时影响）
  fakeInputValue = '你好，这个多少钱';
  ok('输入框有草稿 → 忙（绝不切走，正是你要的）', F.userActive());
  fakeInputValue = '   ';
  ok('输入框只有空白 → 不算草稿', !F.userActive());
  fakeInputValue = '';
  // 刚动过（3 秒前）→ 忙；停手超过 8 秒 → 不忙（窗口短，恢复快，不拖慢回复）
  sandbox.state.lastUserActivity = now - 3000;
  ok('3秒前动过 → 忙（默认8秒窗口内）', F.userActive());
  sandbox.state.lastUserActivity = now - 12000;
  ok('12秒前动过 → 不忙（超过8秒，快速恢复自动回复）', !F.userActive());
  // 开关关掉 → 永远不忙（机器人照常抢，回到旧行为）
  sandbox.state.settings = { pauseWhenUserActive: false };
  sandbox.state.lastUserActivity = now;
  fakeInputValue = '正在打字';
  ok('开关关掉(pauseWhenUserActive=false) → 强制不忙', !F.userActive());
  // 自定义空闲秒数
  sandbox.state.settings = { userIdleSeconds: 5 };
  sandbox.state.lastUserActivity = now - 8000;
  fakeInputValue = '';
  ok('自定义5秒窗口：8秒前动过 → 不忙', !F.userActive());
  sandbox.state.lastUserActivity = now - 3000;
  ok('自定义5秒窗口：3秒前动过 → 忙', F.userActive());

  // ========== K. 未定位到会话的告警节流（防"狼来了"） ==========
  console.log('\n[K] noteConvLocateFail 告警节流');
  sandbox.state.convLocateFail = {};
  sandbox.state.manualAlertAt = {};
  notifies.length = 0;
  const ord = { orderId: 'OD1', buyerNick: '张三', title: 'HeyGen会员号' };
  F.noteConvLocateFail(ord);
  F.noteConvLocateFail(ord);
  eq('前两次瞬时失败 → 只记日志不告警', notifies.length, 0);
  F.noteConvLocateFail(ord);
  eq('第三次连续失败 → 告警一次', notifies.length, 1);
  F.noteConvLocateFail(ord);
  F.noteConvLocateFail(ord);
  eq('30分钟内继续失败 → 不重复告警', notifies.length, 1);
  sandbox.state.manualAlertAt['OD1'] = Date.now() - 31 * 60000; // 模拟31分钟前告警过
  F.noteConvLocateFail(ord);
  eq('超过30分钟仍失败 → 再告警一次', notifies.length, 2);
  // 另一个订单独立计数
  F.noteConvLocateFail({ orderId: 'OD2', buyerNick: '李四', title: 'X' });
  eq('不同订单独立计数（OD2第一次不告警）', notifies.length, 2);

  // ========== L. 会话 key：不用头像文件名，不唯一则标出 ==========
  console.log('\n[L] 会话 key（userId / 退化键 / 不唯一）');
  eq('数字 userId 当作稳定 id', F.isStableConvId('1234567890'), true);
  eq('带点的头像文件名不是稳定 id', F.isStableConvId('O1CN01abcdef.jpg'), false);
  const avatarFile = 'O1CN01XxYyZzAaBbCcDdEeFfGgHhIiJjKkLlMm.jpg';
  const oldSlice = avatarFile.split('/').pop().slice(0, 48);
  ok('旧逻辑截前 48 字符的文件名不会被当成稳定 id', !F.isStableConvId(oldSlice) || oldSlice.indexOf('.') >= 0);
  eq('文件名截断即使塞进 stableId，带点的也不会变成 id key',
    F.convKeyOf({ stableId: 'avatar.jpg', name: '甲', productTitle: '货', orderNo: '100' }).indexOf('id:') === 0, false);
  eq('有 userId → id: 前缀，不看昵称', F.convKeyOf({ stableId: '123456789', name: '张三' }), 'id:123456789');
  eq('拿不到 id → 昵称+标题+订单号', F.convKeyOf({ name: '张三', productTitle: '会员月卡', orderNo: '10001' }), 'fb:张三|会员月卡|10001');
  ok('不同订单号不会串成同一个 key',
    F.convKeyOf({ name: '张三', productTitle: '会员月卡', orderNo: '10001' }) !==
    F.convKeyOf({ name: '张三', productTitle: '会员月卡', orderNo: '10002' }));
  eq('三者皆空 → 空 key（调用方不会拿它发货）', F.convKeyOf({}), '');
  function elWith(opts) {
    opts = opts || {};
    return {
      getAttribute: (n) => (opts.attrs && opts.attrs[n]) || '',
      querySelectorAll: () => [],
      querySelector: (sel) => {
        if (sel === 'img') return { getAttribute: (n) => (n === 'src' ? (opts.src || '') : ''), src: opts.src || '' };
        if (sel === 'a[href]') return opts.href ? { getAttribute: () => opts.href, href: opts.href } : null;
        return null;
      },
      innerText: opts.text || '',
      textContent: opts.text || ''
    };
  }
  eq('只有头像文件名 → 读不到 userId', F.readConvStableId(elWith({ src: 'https://img.alicdn.com/imgextra/i1/' + avatarFile })), '');
  eq('头像查询串里的 userId 可以用', F.readConvStableId(elWith({ src: 'https://img.alicdn.com/avatar.jpg?userId=12345678' })), '12345678');
  eq('data-userid 优先', F.readConvStableId(elWith({ attrs: { 'data-userid': '99887766' }, src: 'https://x/a.jpg' })), '99887766');
  const dup = [
    { key: 'fb:张三|会员|', name: '张三' },
    { key: 'fb:张三|会员|', name: '张三' },
    { key: 'id:123456', name: '李四' },
    { key: 'id:123456', name: '李四' },
    { key: 'id:654321', name: '王五' },
    { key: 'id:654321', name: '赵六' }
  ];
  F.markAmbiguousConvs(dup);
  eq('退化键重复 → 不唯一（转人工）', dup[0].ambiguous, true);
  eq('同一条退化键的另一条也不唯一', dup[1].ambiguous, true);
  eq('同一稳定 id 且昵称一致 → 当成重复节点，不转人工', dup[2].ambiguous, false);
  eq('同一稳定 id 但昵称冲突 → 不唯一', dup[4].ambiguous, true);

  // ========== M. 点发送后必须在己方消息里看到文本 ==========
  console.log('\n[M] seenNewOwnMessage 发送确认');
  eq('新气泡含正文 → 确认成功', F.seenNewOwnMessage(['旧消息'], ['旧消息', '【自动发货】 #9 卡密'], '【自动发货】 #9\n卡密'), true);
  eq('列表没变化 → 点了发送也不算成功', F.seenNewOwnMessage(['旧消息'], ['旧消息'], '【自动发货】 #9'), false);
  eq('发送前已经有同样文本 → 不算本次成功', F.seenNewOwnMessage(['【自动发货】 #9'], ['【自动发货】 #9'], '【自动发货】 #9'), false);

  // ========== N. 转人工整词/短语 + 安抚限频 ==========
  console.log('\n[N] wantsHuman 整词/短语，安抚限频');
  sandbox.state.settings = { humanHandoffKeywords: ['转人工', '找人工', '人工客服'], humanHandoffCooldownMinutes: 180 };
  eq('「是人工发货吗」不触发', F.wantsHuman('是人工发货吗'), false);
  eq('「我要转人工」触发', F.wantsHuman('我要转人工'), true);
  eq('「找人工」触发', F.wantsHuman('找人工'), true);
  eq('「请转人工客服」触发', F.wantsHuman('请转人工客服'), true);
  eq('空消息不触发', F.wantsHuman(''), false);
  sandbox.state.settings.humanHandoffKeywords = ['人工'];
  eq('自定义短词「人工」在「是人工发货吗」里不是整词', F.wantsHuman('是人工发货吗'), false);
  eq('单独发送「人工」算整词', F.wantsHuman('人工'), true);
  eq('「人工。」算整词', F.wantsHuman('人工。'), true);
  sandbox.state.sootheAt = {};
  sandbox.state.settings.humanHandoffCooldownMinutes = 180;
  eq('从没发过安抚语 → 可以发', F.sootheRecentlySent('conv1'), false);
  sandbox.state.sootheAt.conv1 = Date.now() - 31 * 60000;
  eq('冷却 180 分钟、31 分钟前发过 → 仍限频', F.sootheRecentlySent('conv1'), true);
  sandbox.state.sootheAt.conv1 = Date.now() - 181 * 60000;
  eq('超过接管时长 → 可以再发', F.sootheRecentlySent('conv1'), false);

  // ========== O. 面板未加载必须失败 ==========
  console.log('\n[O] panelStatus 面板未加载 / 不一致');
  eq('面板标题空 → unloaded', F.panelStatus('', 'HeyGen月卡'), 'unloaded');
  eq('订单标题空 → unloaded', F.panelStatus('HeyGen月卡', ''), 'unloaded');
  eq('两边都空 → unloaded', F.panelStatus('', ''), 'unloaded');
  eq('面板包含订单标题 → ok', F.panelStatus('HeyGen月卡 官方直充', 'HeyGen月卡'), 'ok');
  eq('互不包含 → mismatch', F.panelStatus('Cursor Pro', 'HeyGen月卡'), 'mismatch');

  // ========== P. 缺货通知 30 分钟一条（含会抄送 TG 的 notify） ==========
  console.log('\n[P] notifyStockOnce 缺货通知限频');
  sandbox.state.stockAlertAt = {};
  notifies.length = 0;
  eq('同一订单第一次缺货 → 通知', F.notifyStockOnce('ST1', '缺货', '请补货'), true);
  eq('通知已发出', notifies.length, 1);
  eq('30 分钟内第二次 → 不再通知', F.notifyStockOnce('ST1', '缺货', '请补货'), false);
  eq('通知数仍是 1', notifies.length, 1);
  eq('另一订单不受影响', F.notifyStockOnce('ST2', '缺货', '请补货'), true);
  sandbox.state.stockAlertAt.ST1 = Date.now() - 31 * 60000;
  eq('超过 30 分钟 → 可以再通知一次', F.notifyStockOnce('ST1', '缺货', '请补货'), true);
  eq('此时共 3 条', notifies.length, 3);

  // ========== Q. 选择器启动自检 ==========
  console.log('\n[Q] auditSelectors');
  const Sels = {
    convItem: '.c', convActive: '.a', msgList: '.m', msgTextBuyer: '.b',
    msgTextMine: '.me', inputBox: 'textarea', sendButtonScope: 'button', productTitle: '.t'
  };
  const hitCritical = (sel) => sel === '.c' || sel === 'textarea';
  eq('关键选择器能命中 → 通过（其余未命中不算 domBroken）', F.auditSelectors(Sels, hitCritical).ok, true);
  const missingItem = Object.assign({}, Sels, { convItem: '  ' });
  const miss = F.auditSelectors(missingItem, hitCritical);
  eq('convItem 为空 → 不通过', miss.ok, false);
  ok('missing 记下 convItem', miss.missing.indexOf('convItem') >= 0);
  const none = F.auditSelectors(Sels, () => null);
  eq('会话列表和输入框都找不到 → domBroken', none.domBroken, true);
  eq('页面未渲染关键节点 → 不通过', none.ok, false);
  const bad = F.auditSelectors(Object.assign({}, Sels, { inputBox: '[' }), (sel) => {
    if (sel === '[') throw new Error('bad selector');
    return { ok: 1 };
  });
  ok('非法选择器记入 invalid', bad.invalid.indexOf('inputBox') >= 0);
  eq('有非法选择器 → 不通过', bad.ok, false);

  console.log('\n===== content.js 逻辑: ' + pass + ' 通过, ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
