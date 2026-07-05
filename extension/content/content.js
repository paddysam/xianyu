/**
 * 内容脚本：注入闲鱼卖家工作台聊天页 (seller.goofish.com / www.goofish.com 的 #/im)
 *
 * 自动回复（DOM 驱动）：
 *   1. 定时扫描左侧会话列表，对比快照，发现"最后一条消息变化"或有未读角标的会话
 *   2. 点开会话，读取消息流；若最新一条是买家消息 → 知识库关键词 > AI 生成 > 默认回复
 *   3. 用原生 setter 往 textarea 写入 + input 事件 + 点击「发 送」
 *
 * 自动发货（接口驱动，权威判断，防止发错货）：
 *   1. 通过主世界桥 bridge.js 调 mtop.taobao.idle.trade.merchant.sold.get 拉订单
 *   2. 只挑 orderStatus === '待发货' 且未退款、标题匹配商品规则、orderId 未发过货的单
 *   3. 按买家昵称在会话列表定位并点开，发送发货内容；orderId 级别去重（持久化）
 *   4. 无库存 / 找不到会话 / 状态不符 → 跳过并记日志，等人工处理，绝不乱发
 *
 * 防呆：
 *   - 发货状态只认交易接口，不认页面标签
 *   - 启动时把当前会话记为"已读基线"，回复只处理启用后的新消息
 *   - 每会话每小时回复上限、随机延迟模拟人工
 */

(() => {
  'use strict';

  const state = {
    settings: null,
    kb: null,
    products: [],
    S: null,                    // 选择器
    running: false,
    busy: false,                // 正在处理某个会话
    baseline: new Map(),        // convKey -> lastMsg 快照
    deliveredOrders: {},         // orderId -> {ts, card, title, buyer} 已发货订单（持久化去重）
    humanHandoff: {},            // convKey -> ts 转人工接管中的会话（持久化）
    replyTimestamps: new Map(), // convKey -> [ts, ...] 用于限频
    deliverBusy: false,          // 发货流程互斥
    activeSig: null,             // 当前激活会话已处理到的消息签名（兜底检查去重用）
    stockCache: null,            // 后端模式库存快照缓存 {ts, list}
    humanReplyAt: {},            // convKey -> ts 本人最后一次手动回复该会话的时间（持久化）
    humanQA: [],                 // 本人真实问答样本 [{q,a,ts}]，喂给 AI 学你的风格（最多200，持久化）
    botSending: false,           // 机器人正在发送（让"本人回复"监听忽略这次）
    humanWatchBound: false,      // 手动回复监听是否已绑定
    timer: null
  };

  // 后端客户端（读取当前 settings 的后端配置）
  const backend = window.__XY_makeBackend(() => ({
    url: state.settings && state.settings.backendUrl,
    token: state.settings && state.settings.backendToken
  }));

  // ---------- 主世界桥（接口调用）----------

  const bridge = {
    _seq: 0,
    _pending: new Map(),
    _ready: false,
    init() {
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.source !== 'XY_PAGE' || ev.source !== window) return;
        if (m.id === '__ready__') { bridge._ready = true; return; }
        const p = bridge._pending.get(m.id);
        if (!p) return;
        bridge._pending.delete(m.id);
        m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || '桥接调用失败'));
      });
    },
    call(action, payload, timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        const id = 'xy_' + (++bridge._seq) + '_' + Date.now();
        bridge._pending.set(id, { resolve, reject });
        window.postMessage({ source: 'XY_CS', id, action, payload }, '*');
        setTimeout(() => {
          if (bridge._pending.has(id)) {
            bridge._pending.delete(id);
            reject(new Error('接口调用超时: ' + action));
          }
        }, timeoutMs);
      });
    }
  };

  // ---------- 工具 ----------

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  /** 回复/发货前的拟人随机延迟；设置缺失或非法（NaN）时退回默认 2~6 秒 */
  function replyDelay() {
    let min = Number(state.settings && state.settings.replyDelayMinMs);
    let max = Number(state.settings && state.settings.replyDelayMaxMs);
    if (!Number.isFinite(min) || min < 0) min = 2000;
    if (!Number.isFinite(max) || max < min) max = Math.max(min, 6000);
    return rand(min, max + 1);
  }

  function log(level, text) {
    try {
      chrome.runtime.sendMessage({ type: 'LOG', entry: { level, text } });
    } catch (_) { /* 扩展被重载时忽略 */ }
    console.log('[闲鱼助手]', level, text);
  }

  function bumpStat(key) {
    try { chrome.runtime.sendMessage({ type: 'BUMP_STAT', key }); } catch (_) {}
  }

  function notify(title, message) {
    try { chrome.runtime.sendMessage({ type: 'NOTIFY', title, message }); } catch (_) {}
  }

  /** 心跳：告诉后台"工作台页面还活着且登录着"，掉线守护据此判断 */
  function heartbeat() {
    // 页面还在聊天/工作台且会话列表可读 = 视为在线；被登出会跳转别的域名，内容脚本自然不再发心跳
    try { chrome.runtime.sendMessage({ type: 'HEARTBEAT' }); } catch (_) {}
  }

  /** 等待条件成立 */
  async function waitFor(fn, timeoutMs = 8000, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  // ---------- 会话列表 ----------

  /** 解析一个会话项 → {el, name, lastMsg, time, orderTag, unread, key} */
  function parseConvItem(el) {
    const S = state.S;
    const orderTagEl = el.querySelector(S.convOrderTag);
    const orderTag = orderTagEl ? orderTagEl.textContent.trim() : '';
    // 会话项内的纯文本叶子节点。完整状态是 [昵称, 最后消息, 时间]；
    // 新消息刚到时昵称可能还是骨架屏，只剩 [最后消息, 时间]
    const leaves = [...el.querySelectorAll('div')]
      .filter(d => d.children.length === 0 && d.textContent.trim())
      .map(d => d.textContent.trim());
    const texts = leaves.filter(t => t !== orderTag);
    let name = '', lastMsg = '', time = '';
    if (texts.length >= 3) {
      name = texts[0];
      lastMsg = texts[texts.length - 2];
      time = texts[texts.length - 1];
    } else if (texts.length === 2) {
      lastMsg = texts[0];
      time = texts[1];
    } else if (texts.length === 1) {
      time = texts[0];
    }
    const unread = !!el.querySelector(S.convUnread);
    // 会话唯一键：优先用头像 URL（昵称可能未加载），退化到昵称
    const img = el.querySelector('img');
    const key = (img && img.src) ? img.src.split('/').pop().slice(0, 48) : name;
    return { el, name, lastMsg, time, orderTag, unread, key: key || name || lastMsg };
  }

  // 官方/系统会话：不是买家，绝不自动处理（它们也会有未读角标）
  const SYSTEM_CONV_NAMES = ['通知消息', '系统消息', '闲鱼小蜜', '闲鱼客服', '互动消息', '官方客服'];

  function scanConvList() {
    return [...document.querySelectorAll(state.S.convItem)].map(parseConvItem)
      .filter(c => c.key && !SYSTEM_CONV_NAMES.includes(c.name));
  }

  // ---------- 聊天窗口 ----------

  /** 读取当前打开会话的消息流（按 DOM 顺序，最后一条在底部） */
  function readMessages() {
    const S = state.S;
    const list = document.querySelector(S.msgList);
    if (!list) return [];
    const out = [];
    for (const row of list.querySelectorAll(S.msgRow + ', ' + S.msgTips)) {
      if (row.matches(S.msgTips)) {
        out.push({ role: 'system', text: row.textContent.trim() });
        continue;
      }
      const buyer = row.querySelector(S.msgTextBuyer);
      const mine = row.querySelector(S.msgTextMine);
      const el = buyer || mine;
      if (!el) {
        // 图片/商品卡片/评价卡等非文本消息：记为 other 占位，
        // 保证"最新一条是不是买家文本"的判断不会越过它们找到旧消息
        out.push({ role: 'other', text: '' });
        continue;
      }
      out.push({ role: buyer ? 'buyer' : 'seller', text: el.textContent.trim() });
    }
    return out;
  }

  /** 当前会话关联的商品标题（右侧面板） */
  function currentProductTitle() {
    const el = document.querySelector(state.S.productTitle);
    return el ? el.textContent.trim() : '';
  }

  /**
   * 往输入框写入并发送。
   * expectKey：目标会话的 key。发送前校验当前激活会话就是它——
   * 防止（比如你人工同时在操作工作台点开了别的会话时）消息发进别人的聊天窗。
   */
  async function sendReply(text, expectKey) {
    const S = state.S;
    const checkTarget = () => {
      if (!expectKey) return true;
      const act = document.querySelector(S.convActive);
      return !!act && parseConvItem(act).key === expectKey;
    };
    if (!checkTarget()) { log('warn', '当前打开的不是目标会话，取消本次发送'); return false; }
    const ta = document.querySelector(S.inputBox);
    if (!ta) { log('error', '找不到输入框'); return false; }
    // 输入框里有你正在打的草稿 → 绝不覆盖，本次自动发送让位（下轮再试）
    if (ta.value && ta.value.trim()) {
      log('warn', '输入框里有未发送的草稿，为避免覆盖你的输入，已取消本次自动发送');
      return false;
    }
    // 标记"这是机器人在发"，让"本人手动回复"监听器忽略这次发送，不误判成人工
    state.botSending = true;
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(rand(300, 800));
      // 写入到点击之间有延迟，点击前再校验一次
      if (!checkTarget()) {
        setter.call(ta, '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        log('warn', '会话在发送前被切走，已清空草稿并取消发送');
        return false;
      }
      const btn = [...document.querySelectorAll(S.sendButtonScope)]
        .find(b => b.textContent.replace(/\s/g, '') === '发送');
      if (!btn || btn.disabled) { log('error', '找不到可用的发送按钮'); return false; }
      btn.click();
      await sleep(500);
      return true;
    } finally {
      // 延后一点再复位，确保由这次点击引发的事件都已被监听器忽略
      setTimeout(() => { state.botSending = false; }, 300);
    }
  }

  // ---------- 本人手动回复检测（机器人让位）----------

  /** 当前激活会话的 key */
  function activeConvKey() {
    const sel = (state.S && state.S.convActive) || '[class*="conversation-item-active--"]';
    const act = document.querySelector(sel);
    return act ? parseConvItem(act).key : null;
  }

  /** 记一次"本人在当前会话手动发了消息" */
  function markHumanReply() {
    if (state.botSending) return;              // 机器人自己发的，不算
    const key = activeConvKey();
    if (!key) return;
    state.humanReplyAt[key] = Date.now();
    try { chrome.storage.local.set({ humanReplyAt: state.humanReplyAt }); } catch (_) {}
    captureHumanQA();                          // 顺便记录你的问答样本，供 AI 学风格
    log('info', `检测到你手动回复了「${key.slice(0, 12)}…」，接下来一段时间机器人不打扰这个会话`);
  }

  /**
   * 是否像"账号密码/卡密/邮箱/激活码"这类敏感发货内容 —— 命中一律不记录，
   * 绝不能进话术库（既泄露买家凭据，也防止 AI 在回复里吐出别人的账号密码）。
   */
  function looksLikeCredential(text) {
    if (!text) return false;
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return true;        // 邮箱
    if (/密码|帐号|账号|帐户|账户|account|passw|pwd|卡密|激活码|兑换码|序列号|授权码|登录名|验证码/i.test(text)) return true; // 凭据关键词
    if (/----|::|\|\||\t/.test(text)) return true;                                       // 常见卡密分隔符
    const dm = (state.settings.deliveryDoneMark || '【自动发货】');
    if (dm && text.includes(dm)) return true;                                             // 发货标记
    // 逐个"词"按特征识别账号/密码/激活码（英文数字特殊符号混合、非自然语言）
    for (const w of text.split(/\s+/)) {
      if (w.length < 6) continue;
      const hasLetter = /[A-Za-z]/.test(w);
      const hasDigit = /[0-9]/.test(w);
      const hasSymbol = /[!@#$%^&*()_+\-=\[\]{};:'",.<>?/\\|~`]/.test(w);
      const kinds = (hasLetter ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSymbol ? 1 : 0);
      // 含≥2类字符(字母/数字/符号)且长度≥6 → 疑似密码/账号（如 Ab1@xyz9、P@ss1234、abc12345）
      if (kinds >= 2 && (hasLetter || hasDigit)) return true;
      // 纯字母/纯数字但很长(≥10) → 疑似账号/长串
      if (w.length >= 10 && (/^[A-Za-z]+$/.test(w) || /^[0-9]+$/.test(w))) return true;
    }
    return false;
  }

  /** 记录一条"买家问 + 本人答"样本（发送前从输入框读你正在发的内容） */
  function captureHumanQA() {
    if (state.settings.learnHumanStyle === false) return;
    try {
      const ta = document.querySelector(state.S.inputBox);
      const a = ta && ta.value ? ta.value.trim() : '';
      if (a.length < 2) return;                          // 太短（如"嗯""好"）不作范本
      const mark = (state.settings.botReplyMark || '').trim();
      if (mark && a.includes(mark)) return;              // 机器人的话，不是你的
      if (looksLikeCredential(a)) return;                // 含账号密码/卡密/邮箱等 → 绝不记录
      const msgs = readMessages();
      let q = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'buyer' && msgs[i].text) { q = msgs[i].text; break; }
      }
      if (looksLikeCredential(q)) q = '';                // 问句里若含敏感也不留
      // 样本池 = 目标条数的4倍（去重后仍够挑），最多存 600 条
      const cap = Math.min(Math.max(Number(state.settings.styleSampleCount) || 30, 30) * 4, 600);
      const item = { q: q.slice(0, 120), a: a.slice(0, 240), ts: Date.now() };
      state.humanQA.push(item);
      while (state.humanQA.length > cap) state.humanQA.shift();
      if (backend.enabled()) {
        // 后端模式：话术库入数据库（去重由后端处理），换设备也不丢
        backend.addStyle([{ q: item.q, a: item.a }]).catch(() => {});
      } else {
        chrome.storage.local.set({ humanQA: state.humanQA });
      }
    } catch (_) {}
  }

  /**
   * 取最近若干条问答对当范本，并按"回复内容"去重——
   * 相同的回复只占一条，避免"在的~"这种重复雷同的答案挤占名额、白费 token。
   */
  function humanStyleSamples() {
    if (state.settings.learnHumanStyle === false) return '';   // 开关关了：既不记也不喂
    let n = state.settings.styleSampleCount;
    n = (n === undefined || n === null || n === '') ? 30 : Number(n);
    if (!(n > 0)) return '';                                    // 填 0 = 不喂
    const qa = state.humanQA || [];
    const seen = new Set();
    const out = [];
    for (let i = qa.length - 1; i >= 0 && out.length < n; i--) {
      const x = qa[i];
      if (!x || !x.a) continue;
      const key = x.a.trim();
      if (seen.has(key)) continue;   // 相同回复不重复占坑
      seen.add(key);
      out.push(x);
    }
    out.reverse();                   // 恢复时间先后顺序
    if (!out.length) return '';
    return out.map(x => (x.q ? '买家：' + x.q + '\n' : '') + '我：' + x.a).join('\n———\n');
  }

  /** 监听输入框回车 / 点发送按钮 —— 捕获"本人手动发送"（不读任何聊天记录） */
  function bindHumanReplyWatch() {
    if (state.humanWatchBound) return;
    state.humanWatchBound = true;
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('textarea') && e.key === 'Enter' && !e.shiftKey) markHumanReply();
    }, true);
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button');
      if (btn && btn.textContent.replace(/\s/g, '') === '发送') markHumanReply();
    }, true);
  }

  /** 本人是否在接管窗口内手动回复过该会话（机器人应让位） */
  function humanTakingOver(key) {
    const mins = state.settings.humanTakeoverMinutes;
    const win = (mins === undefined ? 10 : Number(mins)) * 60000;
    if (win <= 0) return false;
    const at = state.humanReplyAt[key] || 0;
    return Date.now() - at < win;
  }

  // ---------- 回复决策 ----------

  /** 买家消息是否在要求转人工 */
  function wantsHuman(text) {
    const kws = (state.settings.humanHandoffKeywords || []).filter(Boolean);
    return kws.some(k => text.includes(k));
  }

  /** 买家是否在试图引流/线下交易（加微信、支付宝直转等），命中要防风控 */
  function isRiskMessage(text) {
    const kws = (state.settings.riskKeywords || []).filter(Boolean);
    // 大小写不敏感匹配（vx/VX、qq/QQ 等）
    const low = text.toLowerCase();
    return kws.some(k => low.includes(String(k).toLowerCase()));
  }

  /** 该会话是否处于人工接管冷却期内（期内不自动回复） */
  function handoffActive(key) {
    const ts = state.humanHandoff[key];
    if (!ts) return false;
    const cool = (state.settings.humanHandoffCooldownMinutes || 180) * 60000;
    if (Date.now() - ts < cool) return true;
    delete state.humanHandoff[key]; // 冷却结束，自动恢复
    chrome.storage.local.set({ humanHandoff: state.humanHandoff });
    return false;
  }

  async function setHandoff(key) {
    state.humanHandoff[key] = Date.now();
    await chrome.storage.local.set({ humanHandoff: state.humanHandoff });
  }

  /** 给普通自动回复追加"机器人回复"标识，让买家知道是自动回复 */
  function withBotMark(text) {
    const mark = (state.settings.botReplyMark || '').trim();
    if (!mark) return text;
    if (text.includes(mark)) return text; // 避免重复
    return state.settings.botReplyMarkPosition === 'prefix'
      ? mark + '\n' + text
      : text + '\n' + mark;
  }

  function matchKb(text) {
    for (const e of (state.kb.entries || [])) {
      const kws = (e.keywords || []).filter(Boolean);
      if (kws.length && kws.some(k => text.includes(k))) return e.reply;
    }
    return null;
  }

  /**
   * 取当前库存快照（统一成 [{match, spec, price, stock}]）。
   * 后端模式从数据库拉（带 30 秒缓存，避免每条回复都打接口）；本地模式用内存规则。
   */
  async function getStockProducts() {
    if (!backend.enabled()) {
      return (state.products || []).map(p => ({
        match: p.match, spec: p.spec, price: p.price,
        stock: (p.mode || 'fixed') === 'pool' ? (p.cards || []).filter(c => c.trim()).length : null
      }));
    }
    const now = Date.now();
    if (state.stockCache && now - state.stockCache.ts < 30000) return state.stockCache.list;
    try {
      const r = await backend.listProducts();
      const list = (r.products || []).map(p => ({
        match: p.match_title, spec: p.spec, price: p.price,
        stock: (p.mode || 'pool') === 'pool' ? Number(p.stock || 0) : null
      }));
      state.stockCache = { ts: now, list };
      return list;
    } catch (e) {
      return (state.stockCache && state.stockCache.list) || [];
    }
  }

  /** 为"当前宝贝标题"拼一段实时库存说明，喂给 AI 用于如实回答"有没有货/能否发货" */
  function buildDeliveryInfo(itemTitle, products) {
    if (!itemTitle) return '';
    const hits = (products || []).filter(p => p.match && itemTitle.includes(p.match));
    // 当前商品完全没配发货规则 → 人工发货
    if (!hits.length) return '当前咨询的商品未配置自动发货，属于人工发货，需本人处理。';
    const lines = hits.map(p => {
      const label = (p.spec ? p.spec : '默认规格') + (p.price ? '(¥' + p.price + ')' : '');
      if (p.stock === null) return `${label}：支持自动发货（固定内容），拍下即时发`;
      if (p.stock > 0) return `${label}：支持自动发货，有货，拍下可秒发`;
      return `${label}：本可自动发货，但暂时缺货，需补货或人工处理`;
    });
    return '【已配置自动发货的规格】\n' + lines.join('\n') + '\n未在上面列出的规格为人工发货。';
  }

  /**
   * 按订单匹配发货规则：标题包含 + 规格精确 + 价格精确（后两者留空表示不限）。
   * 返回 { rule, titleHit }：
   *   rule     - 完全匹配到的规则（可直接发货）
   *   titleHit - 是否有规则标题命中但规格/价格对不上（说明是同款不同规格，
   *              不能乱发，需人工——用于安全告警）
   */
  function matchProduct(order) {
    const title = order && order.title;
    if (!title) return { rule: null, titleHit: false };
    const rules = (state.products || []).filter(p => p.match && title.includes(p.match));
    if (!rules.length) return { rule: null, titleHit: false };
    const hits = rules.filter(p =>
      (!p.spec || p.spec === order.spec) &&
      (!p.price || String(p.price) === String(order.price))
    );
    // 同时命中多条时优先最具体的：规格+价格都填的 > 只填一个的 > 全不限的，
    // 避免"不限规格"的兜底规则抢走了本该走精确规格库存的订单
    hits.sort((a, b) =>
      ((b.spec ? 1 : 0) + (b.price ? 1 : 0)) - ((a.spec ? 1 : 0) + (a.price ? 1 : 0)));
    return { rule: hits[0] || null, titleHit: !hits.length };
  }

  /**
   * 组装发货内容。
   * 固定内容模式：直接返回 delivery 文本。
   * 卡密库存模式：取库存第一条卡密；delivery 里写 {卡密} 占位符则替换，
   *               否则拼在末尾。此处只"预取"，发送成功后才真正扣库存。
   */
  function prepareDelivery(rule) {
    if ((rule.mode || 'fixed') !== 'pool') {
      return rule.delivery ? { content: rule.delivery, card: null } : null;
    }
    const cards = (rule.cards || []).map(c => c.trim()).filter(Boolean);
    if (!cards.length) {
      const label = rule.match + (rule.spec ? ' / ' + rule.spec : '');
      log('error', `⚠️ 商品「${label}」卡密库存为空，无法自动发货，请尽快补货并手动发货！`);
      return null;
    }
    const card = cards[0];
    // 商品没单独填模板时，退回全局默认模板（行为设置里配置）
    const tpl = rule.delivery || state.settings.deliveryTemplate || '';
    const content = tpl.includes('{卡密}')
      ? tpl.replaceAll('{卡密}', card)
      : (tpl ? tpl + '\n' + card : card);
    return { content, card };
  }

  /** 发送成功后扣掉已用卡密并持久化（只删第一条命中的，防止重复卡密被一次全删） */
  async function consumeCard(rule, card) {
    const cards = (rule.cards || []).filter(c => c.trim());
    const idx = cards.findIndex(c => c.trim() === card);
    if (idx >= 0) cards.splice(idx, 1);
    rule.cards = cards;
    await chrome.storage.local.set({ products: state.products });
    if (cards.length <= 2) log('warn', `⚠️ 商品「${rule.match}」卡密仅剩 ${cards.length} 条，请及时补货`);
  }

  /**
   * 发货前交叉校验：右侧面板显示的商品标题应与订单商品一致。
   * 防止两个买家昵称显示相同（如都叫 x***5）时定位到错误会话。
   * 只有两者都非空且互不包含才判定不一致（面板没加载出来不拦截）。
   */
  function panelTitleMismatch(orderTitle) {
    const panelTitle = currentProductTitle();
    if (!panelTitle || !orderTitle) return false;
    return !panelTitle.includes(orderTitle) && !orderTitle.includes(panelTitle);
  }

  /** 后端模式的去重缓存也持久化，避免插件重载后重复打开已发货会话做无用功 */
  async function rememberDelivered(order) {
    state.deliveredOrders[order.orderId] = { ts: Date.now(), title: order.title };
    try { await chrome.storage.local.set({ deliveredOrders: state.deliveredOrders }); } catch (_) {}
  }

  /** 标记某订单已发货并持久化（orderId 级别去重，重载/重开都不会重发） */
  async function markOrderDelivered(order, card) {
    state.deliveredOrders[order.orderId] = {
      ts: Date.now(), card: card || null,
      title: order.title, spec: order.spec || '', price: order.price || '',
      buyer: order.buyerNick
    };
    await chrome.storage.local.set({ deliveredOrders: state.deliveredOrders });
  }

  /**
   * 卡密发出后，自动点订单「发货」（无需物流），把订单推进到已发货。
   * 关键闭环：不点发货订单一直是"待发货"，超时会被系统自动退款。
   * 失败不影响已发的卡密，但必须响亮告警让人工补点，避免漏发。
   */
  async function autoConsign(order, skuLabel) {
    if (state.settings.autoConsign === false) return;
    try {
      await bridge.call('consignDummy', {
        orderId: order.orderId,
        tradeText: state.settings.consignText || ''
      });
      log('info', `已自动点发货：订单 ${order.orderId}「${skuLabel}」`);
    } catch (e) {
      log('error', `订单 ${order.orderId}「${skuLabel}」卡密已发，但自动点发货失败，请立即手动点发货（否则会超时退款）！${e.message}`);
      notify('⚠️ 请手动点发货', `订单 ${order.orderId} 卡密已发出，但自动发货失败，请尽快去订单管理手动点「发货」`);
    }
  }

  // ---------- 接口驱动的自动发货 ----------

  /**
   * 一轮发货：拉「待发货」订单 → 逐单校验 → 定位会话 → 发货。
   * 状态判断全部来自交易接口，不依赖页面标签。任何不确定都跳过等人工。
   */
  async function deliveryPass() {
    if (state.deliverBusy) return;
    state.deliverBusy = true;
    try {
      let orders;
      try {
        orders = await bridge.call('fetchWaitShipOrders');
      } catch (e) {
        log('warn', '拉取待发货订单失败（稍后重试）: ' + (e && e.message));
        return;
      }
      if (!Array.isArray(orders) || !orders.length) return;

      for (const order of orders) {
        // —— 逐层硬校验，任一不满足就跳过 ——
        if (order.orderStatus !== '待发货') continue;          // 权威状态：必须是待发货
        if (order.inRefund) {                                  // 退款中：绝不发货
          log('warn', `订单 ${order.orderId}（${order.buyerNick}）退款中，跳过发货`);
          continue;
        }
        if (state.deliveredOrders[order.orderId]) continue;    // 已发过（本地缓存）：快速跳过

        const skuLabel = order.title + (order.spec ? ' / ' + order.spec : '') +
          (order.price ? ' ¥' + order.price : '');
        const doneMark = state.settings.deliveryDoneMark || '【自动发货】';

        if (backend.enabled()) {
          await deliverViaBackend(order, skuLabel, doneMark);
        } else {
          await deliverLocal(order, skuLabel, doneMark);
        }
        await sleep(rand(1500, 3000));
      }
    } catch (e) {
      log('error', 'deliveryPass 异常: ' + (e && e.message));
    } finally {
      state.deliverBusy = false;
    }
  }

  /** 后端（MySQL）模式：取卡+扣库存+去重在数据库事务里完成，最安全 */
  async function deliverViaBackend(order, skuLabel, doneMark) {
    // 先定位会话；找不到就不占用库存
    const conv = await openConversationByNick(order.buyerNick);
    if (!conv) {
      log('warn', `订单 ${order.orderId}「${order.title}」待发货，但未找到买家「${order.buyerNick}」的会话，请人工发货`);
      notify('⚠️ 有单需人工发货', `未定位到买家 ${order.buyerNick} 的会话，「${order.title}」请手动发货`);
      return;
    }
    try {
      // 注意：这里不再用"聊天里出现过发货标记"做去重——回头客的聊天里必然留着
      // 上一单的标记，会把新订单误判成已发货。去重完全交给后端（orderId 唯一约束，
      // 重复调用幂等返回 alreadyDelivered，不会重复扣卡）。
      // 交叉校验：会话右侧的商品和订单商品明显不一致 → 可能是同昵称撞车，转人工
      if (panelTitleMismatch(order.title)) {
        log('warn', `订单 ${order.orderId}「${skuLabel}」：会话「${order.buyerNick}」右侧商品与订单不一致，疑似同昵称撞车，请人工发货`);
        notify('⚠️ 有单需人工发货', `买家「${order.buyerNick}」会话与订单商品不一致，「${skuLabel}」请手动核对发货`);
        return;
      }

      let r;
      try {
        r = await backend.deliver({
          orderId: order.orderId, title: order.title, spec: order.spec,
          price: order.price, buyer: order.buyerNick,
          template: state.settings.deliveryTemplate || ''
        });
      } catch (e) {
        log('error', `订单 ${order.orderId} 调后端发货失败（下轮重试）: ${e.message}`);
        return;
      }

      switch (r.status) {
        case 'delivered': {
          await sleep(replyDelay());
          // 标记后带订单号：一眼能对上是哪一单，也让"按标记去重"能精确到订单
          if (await sendReply(doneMark + ' #' + order.orderId + '\n' + r.content, conv.key)) {
            await rememberDelivered(order);
            bumpStat('deliveriesSent');
            log('info', `已发货：订单 ${order.orderId}「${skuLabel}」→ ${order.buyerNick}，剩余库存 ${r.stockLeft}`);
            await autoConsign(order, skuLabel); // 点亮订单发货，闭环
          } else {
            // 聊天发送失败 → 回滚数据库，恢复卡密，下轮重试
            try {
              await backend.rollbackDeliver(order.orderId);
              log('warn', `订单 ${order.orderId} 聊天发送失败，已回滚库存，下轮重试`);
            } catch (e) {
              log('error', `订单 ${order.orderId} 发送失败且回滚失败，请手动核对该单是否已发！${e.message}`);
              notify('⚠️ 发货异常需核对', `订单 ${order.orderId} 发送失败且回滚失败，请手动检查库存与该订单`);
            }
          }
          break;
        }
        case 'alreadyDelivered':
          await rememberDelivered(order);
          break;
        case 'outOfStock':
          log('warn', `订单 ${order.orderId}「${skuLabel}」待发货，但数据库无可用库存，等待人工发货`);
          notify('⚠️ 有单待发货但缺货', `「${skuLabel}」库存不足，买家 ${order.buyerNick} 已付款，请补货或手动发货`);
          break;
        case 'needManual':
          log('warn', `订单 ${order.orderId}「${skuLabel}」待发货，但没有匹配该规格/价格的规则，请人工发货`);
          notify('⚠️ 有单需人工发货', `「${skuLabel}」未配置对应规格的发货规则，请手动发货`);
          break;
        case 'noRule': break;                                    // 没配规则的商品：不管
        case 'noContent':
          log('warn', `订单 ${order.orderId}「${skuLabel}」规则未填发货内容，跳过`);
          break;
        default:
          log('warn', `订单 ${order.orderId} 后端返回未知状态: ${r.status}`);
      }
    } finally {
      await clearConvSearch(); // 动作结束才恢复会话列表，全程保持目标会话稳定激活
    }
  }

  /** 本地存储模式：规则/库存来自 chrome.storage */
  async function deliverLocal(order, skuLabel, doneMark) {
    const { rule, titleHit } = matchProduct(order);
    if (!rule) {
      if (titleHit) {
        log('warn', `订单 ${order.orderId}「${skuLabel}」待发货，但没有匹配该规格/价格的发货规则，请人工发货`);
        notify('⚠️ 有单需人工发货', `「${skuLabel}」未配置对应规格的发货规则，买家 ${order.buyerNick} 已付款，请手动发货`);
      }
      return;
    }
    const prepared = prepareDelivery(rule);
    if (!prepared) {
      log('warn', `订单 ${order.orderId}「${skuLabel}」待发货，但无可用库存，等待人工发货`);
      notify('⚠️ 有单待发货但缺货', `「${skuLabel}」库存不足，买家 ${order.buyerNick} 已付款，请尽快补货或手动发货`);
      return;
    }
    const conv = await openConversationByNick(order.buyerNick);
    if (!conv) {
      log('warn', `订单 ${order.orderId}「${order.title}」待发货，但未找到买家「${order.buyerNick}」的会话，请人工发货`);
      notify('⚠️ 有单需人工发货', `未定位到买家 ${order.buyerNick} 的会话，「${order.title}」请手动发货`);
      return;
    }
    try {
      // 缓存丢失（重装插件等）后的兜底去重：只认"发货标记 + 本订单号"同时出现。
      // 只认裸标记会把回头客的新订单误判成已发货（聊天里留着上一单的标记）
      if (readMessages().some(m => m.role === 'seller' &&
          m.text.includes(doneMark) && m.text.includes('#' + order.orderId))) {
        await markOrderDelivered(order, null);
        return;
      }
      // 交叉校验：会话右侧的商品和订单商品明显不一致 → 可能是同昵称撞车，转人工
      if (panelTitleMismatch(order.title)) {
        log('warn', `订单 ${order.orderId}「${skuLabel}」：会话「${order.buyerNick}」右侧商品与订单不一致，疑似同昵称撞车，请人工发货`);
        notify('⚠️ 有单需人工发货', `买家「${order.buyerNick}」会话与订单商品不一致，「${skuLabel}」请手动核对发货`);
        return;
      }
      await sleep(replyDelay());
      if (await sendReply(doneMark + ' #' + order.orderId + '\n' + prepared.content, conv.key)) {
        if (prepared.card) await consumeCard(rule, prepared.card);
        await markOrderDelivered(order, prepared.card);
        bumpStat('deliveriesSent');
        log('info', `已发货：订单 ${order.orderId}「${skuLabel}」→ ${order.buyerNick}` +
          (prepared.card ? `，剩余库存 ${rule.cards.length}` : ''));
        await autoConsign(order, skuLabel); // 点亮订单发货，闭环
      } else {
        log('error', `订单 ${order.orderId} 发送失败，未扣库存，下轮重试`);
      }
    } finally {
      await clearConvSearch(); // 动作结束才恢复会话列表
    }
  }

  /** 会话搜索框（只认带"昵称"占位符的那个，避免误碰其它输入框） */
  function convSearchBox() {
    return document.querySelector('input[placeholder*="昵称"]');
  }

  /** 清空会话搜索框，恢复完整会话列表（定位买家后必须调用，否则列表一直被过滤） */
  async function clearConvSearch() {
    const search = convSearchBox();
    if (!search || !search.value) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, '');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(800);
  }

  /**
   * 按买家昵称在会话列表定位并点开，返回该会话（找不到返回 null）。
   * 只接受昵称精确匹配——发卡密的场景宁可找不到转人工，绝不发给"差不多的人"。
   */
  async function openConversationByNick(nick) {
    if (!nick) return null;
    const S = state.S;
    let conv = scanConvList().find(c => c.name === nick);
    if (!conv) {
      // 昵称可能没在当前虚拟列表可视区，用搜索框过滤
      const search = convSearchBox();
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(search, nick);
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1200);
        // 只认精确匹配，绝不退化取第一个
        conv = scanConvList().find(c => c.name === nick) || null;
      }
    }
    if (!conv) { await clearConvSearch(); return null; }  // 失败：清搜索恢复列表
    conv.el.click();
    // 必须等到"激活的正是目标会话"，防止点击失效时消息发进别人的聊天窗
    const ok = await waitFor(() => {
      const act = document.querySelector(S.convActive);
      return act && parseConvItem(act).key === conv.key &&
             document.querySelector(S.msgList);
    });
    if (!ok) { await clearConvSearch(); return null; }    // 失败：清搜索恢复列表
    await sleep(rand(600, 1200));
    // 成功：故意保持搜索过滤态（目标会话稳定激活），由调用方在动作完成后清搜索
    return conv;
  }

  async function askAI(context) {
    const resp = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'GEN_REPLY', context }, resolve));
    if (resp && resp.ok) return resp.reply;
    log('error', 'AI 调用失败: ' + (resp && resp.error || '无响应'));
    return null;
  }

  function underRateLimit(key) {
    const now = Date.now();
    const arr = (state.replyTimestamps.get(key) || []).filter(t => now - t < 3600e3);
    state.replyTimestamps.set(key, arr);
    return arr.length < (state.settings.maxRepliesPerConvPerHour || 10);
  }

  function recordReply(key) {
    const arr = state.replyTimestamps.get(key) || [];
    arr.push(Date.now());
    state.replyTimestamps.set(key, arr);
  }

  // ---------- 单个会话处理 ----------

  async function handleConversation(conv) {
    const S = state.S;
    conv.el.click();
    // 等聊天窗口切到该会话：激活项 key 匹配，且消息列表已渲染
    // （虚拟列表可能重建节点，不能依赖 conv.el 引用本身）
    const ok = await waitFor(() => {
      const act = document.querySelector(S.convActive);
      return act && parseConvItem(act).key === conv.key &&
             document.querySelector(S.msgList);
    });
    if (!ok) { log('warn', `打开会话「${conv.name || conv.key}」超时`); return; }
    await sleep(rand(800, 1500));
    // 昵称此前可能是骨架屏，激活后从顶栏补全（仅用于日志展示）
    if (!conv.name) {
      const bar = document.querySelector(S.chatTopbar);
      conv.name = bar ? bar.textContent.trim().split('(')[0] : conv.key;
    }

    const msgs = readMessages();
    const productTitle = currentProductTitle();

    // 普通回复：会话里最新的一条必须就是买家的文本消息。
    // 最新一条是系统消息（确认收货/评价提醒等）、卡片或自己的消息 → 一律不回，
    // 防止越过它们找到买家几小时前的旧消息、对旧话瞎回一句
    const lastChat = msgs[msgs.length - 1];
    if (!lastChat || lastChat.role !== 'buyer' || !lastChat.text) {
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }

    // ---- 本人接管优先：你手动回复过且还在窗口期内 → 机器人完全让位，一句都不回 ----
    if (humanTakingOver(conv.key)) {
      log('info', `「${conv.name}」你在处理中（手动回复过），机器人让位不打扰`);
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }

    // ---- 引流/线下交易 防风控：只回固定平台话术，AI 绝不顺着聊 ----
    if (isRiskMessage(lastChat.text)) {
      const riskReply = state.settings.riskReply;
      if (riskReply && underRateLimit(conv.key)) {
        await sleep(replyDelay());
        if (await sendReply(riskReply, conv.key)) {
          recordReply(conv.key);
          bumpStat('repliesSent');
          log('warn', `「${conv.name}」疑似引流/线下交易，已回固定平台话术（未走 AI）`);
        }
      }
      await sleep(800);
      const fresh0 = scanConvList().find(c => c.key === conv.key);
      state.baseline.set(conv.key, fresh0 ? fresh0.lastMsg : conv.lastMsg);
      syncActiveSig(conv.key);
      return;
    }

    // ---- 转人工：买家要求人工客服 → 安抚一句 + 暂停该会话自动回复 ----
    if (wantsHuman(lastChat.text)) {
      if (!handoffActive(conv.key)) {
        // 首次命中：发安抚语（转人工语不加机器人标识，避免矛盾）
        const soothe = state.settings.humanHandoffReply;
        await sleep(replyDelay());
        if (soothe) await sendReply(soothe, conv.key);
        await setHandoff(conv.key);
        notify('🙋 有买家要人工客服', `「${conv.name}」请求人工，已让其稍候，请尽快回复`);
        log('info', `「${conv.name}」触发转人工，已暂停自动回复，等待人工处理`);
      }
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }
    // 会话处于人工接管冷却期：不自动回复，交给人工
    if (handoffActive(conv.key)) {
      log('info', `「${conv.name}」人工接管中，跳过自动回复`);
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }

    if (!underRateLimit(conv.key)) {
      log('warn', `「${conv.name}」达到每小时回复上限，跳过`);
      state.baseline.set(conv.key, conv.lastMsg); // 记基线，避免每轮重复打开刷日志
      return;
    }

    let reply = matchKb(lastChat.text);
    let source = '知识库';
    if (!reply && state.settings.aiEnabled) {
      // 把当前宝贝的发货方式(自动/人工)+库存喂给 AI，让它如实回答"能不能自动发货/有没有货"
      const deliveryInfo = buildDeliveryInfo(productTitle, await getStockProducts());
      reply = await askAI({
        buyerName: conv.name,
        productTitle,
        deliveryInfo,
        knowledgeText: state.kb.knowledgeText || '',
        humanStyle: humanStyleSamples(), // 你最近的真实回复范本，让 AI 学你的风格
        lastMessage: lastChat.text,
        // 传更长的上下文（最近 24 条对话），长谈判也能接上前因后果
        history: msgs.filter(m => (m.role === 'buyer' || m.role === 'seller') && m.text)
          .slice(-24).map(m => ({ role: m.role, text: m.text }))
      });
      source = 'AI';
    }
    if (!reply && state.settings.defaultReply) {
      reply = state.settings.defaultReply;
      source = '默认回复';
    }
    if (!reply) { state.baseline.set(conv.key, conv.lastMsg); return; }

    reply = withBotMark(reply);

    await sleep(replyDelay());
    // 关键：延迟/AI 生成期间你可能刚手动回复了 → 发送前再查一次，你在处理就闭嘴
    if (humanTakingOver(conv.key)) {
      log('info', `「${conv.name}」发送前发现你已手动回复，机器人取消这条`);
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }
    // 发送前再确认没有新变化导致重复回复
    if (await sendReply(reply, conv.key)) {
      recordReply(conv.key);
      bumpStat('repliesSent');
      log('info', `[${source}] 回复「${conv.name}」: ${reply.slice(0, 50)}`);
    }
    // 把自己刚发的话记入基线，避免下一轮误判为新消息
    await sleep(800);
    const fresh = scanConvList().find(c => c.key === conv.key);
    state.baseline.set(conv.key, fresh ? fresh.lastMsg : reply);
    syncActiveSig(conv.key);
  }

  // ---------- 主循环 ----------

  /** 当前激活会话的消息签名（会话key + 消息数 + 最后一条内容） */
  function activeConvSig() {
    const act = document.querySelector(state.S.convActive);
    if (!act) return null;
    const conv = parseConvItem(act);
    if (!conv.key || SYSTEM_CONV_NAMES.includes(conv.name)) return null;
    const msgs = readMessages();
    const last = msgs[msgs.length - 1];
    return {
      conv, last,
      sig: conv.key + '|' + msgs.length + '|' + (last ? last.role + ':' + last.text : '')
    };
  }

  /**
   * 刚处理完某会话后，把它当前的签名记为"已处理"。
   * 不这么做的话：机器人刚发的回复若渲染慢，checkActiveConversation 看到的
   * 最后一条还是买家消息、签名又没记录过 → 会对同一条消息再回一遍。
   */
  function syncActiveSig(key) {
    const cur = activeConvSig();
    if (cur && cur.conv.key === key) state.activeSig = cur.sig;
  }

  /**
   * 兜底检查当前打开的会话：买家在开着的会话里发消息不产生未读红点，
   * 这里直接读聊天窗，最新一条是买家文本且签名没处理过 → 走回复流程。
   */
  async function checkActiveConversation() {
    const cur = activeConvSig();
    if (!cur) return;
    if (cur.sig === state.activeSig) return;         // 没有新变化
    state.activeSig = cur.sig;                        // 先记签名，防止失败重试刷屏
    if (!cur.last || cur.last.role !== 'buyer' || !cur.last.text) return; // 最新不是买家文本，不动作
    await handleConversation(cur.conv);
  }

  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    try {
      // 1) 自动回复：只处理"有未读红点"的会话。
      // 未读红点 = 买家发来我还没看的新消息，这是唯一可靠信号：
      // 系统消息（确认收货）、评价卡、自己发的消息都不会产生未读 → 不会被点开，
      // 从根本上消除"逐个点开会话"的扰民行为。
      // 再叠加基线比对：启动时已挂着未读、且最后一条消息至今没变的会话跳过，
      // 保证"只回复启用之后的新消息"，不翻旧账（买家再发新消息后 lastMsg 变化即恢复处理）
      const convs = scanConvList().filter(c =>
        c.unread && state.baseline.get(c.key) !== c.lastMsg);
      for (const conv of convs) {
        await handleConversation(conv);
        await sleep(rand(1000, 2000));
      }
      // 1b) 兜底：当前"打开着"的会话里买家发新消息不会产生未读（开着=自动已读），
      // 直接读当前聊天窗判断，无需点击。签名去重防止重复回复。
      await checkActiveConversation();
      // 2) 自动发货：接口驱动，独立于会话扫描（默认开启，可在设置关闭）
      if (state.settings.autoDeliver !== false) {
        await deliveryPass();
      }
    } catch (e) {
      const m = String(e && e.message || e);
      // 扩展被重载后本页老脚本已失效：chrome API 全部抛此错，tick 永远跑不完，
      // 但角标还绿着 → 看起来在运行实际一条不回。必须停摆并显眼提示刷新
      if (m.includes('Extension context invalidated')) { markZombie(); return; }
      log('error', 'tick 异常: ' + m);
    } finally {
      state.busy = false;
    }
  }

  /** 扩展已重载、本页脚本成僵尸：停止轮询，角标变红提示按 F5 刷新 */
  function markZombie() {
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    log('error', '扩展已更新，本页脚本失效，自动客服已停止 —— 请按 F5 刷新工作台页面恢复！');
    const b = document.getElementById('__xy_assistant_badge');
    const dot = document.getElementById('__xy_assistant_dot');
    const txt = document.getElementById('__xy_assistant_txt');
    if (b && dot && txt) {
      b.style.background = '#fef2f2';
      b.style.color = '#b91c1c';
      dot.style.background = '#dc2626';
      dot.style.boxShadow = '0 0 0 3px rgba(220,38,38,.25)';
      txt.textContent = '插件已更新，请按 F5 刷新本页面';
    }
  }

  // ---------- 启动 / 停止 ----------

  async function loadConfig() {
    const data = await chrome.storage.local.get(['settings', 'kb', 'products', 'deliveredOrders', 'humanHandoff', 'humanReplyAt', 'humanQA']);
    state.settings = data.settings || {};
    state.kb = data.kb || { entries: [], knowledgeText: '' };
    state.products = data.products || [];
    state.deliveredOrders = data.deliveredOrders || {};
    state.humanHandoff = data.humanHandoff || {};
    state.humanReplyAt = data.humanReplyAt || {};
    state.humanQA = data.humanQA || [];
    state.S = window.__XY_MERGE_SELECTORS(state.settings.selectorOverrides);

    // 后端模式：知识库 + 话术库改从数据库读（发货规则/库存由后端在发货时直接处理）
    if (backend.enabled()) {
      try {
        const kb = await backend.getKb();
        state.kb = { entries: kb.entries || [], knowledgeText: kb.knowledgeText || '' };
      } catch (e) {
        log('warn', '从后端读知识库失败，暂用本地缓存: ' + (e && e.message));
      }
      try {
        const st = await backend.getStyle();
        state.humanQA = (st.samples || []).map(s => ({ q: s.q || '', a: s.a || '', ts: 0 }));
      } catch (e) {
        log('warn', '从后端读话术库失败，暂用本地缓存: ' + (e && e.message));
      }
    }
  }

  async function start() {
    await loadConfig();
    if (!state.settings.enabled) return;
    if (state.running) return;
    // 建立基线：当前已存在的消息一律不处理，只管之后新来的
    for (const c of scanConvList()) state.baseline.set(c.key, c.lastMsg);
    // 当前打开的会话同理：启动前的消息记入签名，不回旧账
    const cur = activeConvSig();
    state.activeSig = cur ? cur.sig : null;
    state.running = true;
    state.timer = setInterval(tick, state.settings.pollIntervalMs || 5000);
    log('info', `助手已启动，监控 ${state.baseline.size} 个会话`);
    mountBadge();
  }

  function stop() {
    state.running = false;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    log('info', '助手已停止');
    mountBadge();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 设置页请求：从当前登录页面的接口识别商品规格
    if (msg && msg.type === 'LIST_SKUS') {
      bridge.call('listSkus')
        .then(skus => sendResponse({ ok: true, skus }))
        .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true; // 异步
    }
    // 后台定时"戳"：标签在后台被浏览器节流时，靠后台 SW 驱动强制跑一轮
    if (msg && msg.type === 'TICK_NOW') {
      if (state.running && !state.busy) tick();
      sendResponse({ ok: true });
      return;
    }
  });

  /** 建一条到后台的常连接，降低本标签被浏览器"冻结/丢弃"的概率 */
  function keepAlivePort() {
    try {
      const port = chrome.runtime.connect({ name: 'xy-keepalive' });
      // 断开后（SW 回收/5分钟上限）稍后重连，尽量保持"有扩展活动"
      port.onDisconnect.addListener(() => { setTimeout(keepAlivePort, 2000); });
    } catch (_) { /* 扩展上下文失效时忽略 */ }
  }

  // 配置变化实时生效
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const on = changes.settings.newValue && changes.settings.newValue.enabled;
      await loadConfig();
      if (on && !state.running) start();
      if (!on && state.running) stop();
    }
    if (changes.kb) state.kb = changes.kb.newValue;
    if (changes.products) state.products = changes.products.newValue;
  });

  // ---------- 页面右下角状态角标 ----------

  /** 点角标 = 开/关自动客服（直接在活脚本里执行，绕开弹窗/僵尸脚本问题） */
  async function toggleFromBadge() {
    const wantOn = !state.running;
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      settings.enabled = wantOn;
      await chrome.storage.local.set({ settings }); // 持久化，弹窗开关同步
      state.settings.enabled = wantOn;
      if (wantOn) await start(); else stop();
    } catch (e) {
      // 扩展被重载后当前脚本会失效，chrome API 抛错 → 提示刷新
      alert('插件刚更新过，本页面的脚本已失效。请按 F5 刷新本页面后，再点这个角标开启。');
    }
  }

  function mountBadge() {
    let b = document.getElementById('__xy_assistant_badge');
    if (!b) {
      b = document.createElement('div');
      b.id = '__xy_assistant_badge';
      b.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:99999;padding:7px 14px 7px 10px;' +
        'border-radius:18px;font-size:12px;font-weight:600;cursor:pointer;' +
        'display:flex;align-items:center;gap:7px;user-select:none;' +
        'font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.06);';
      b.title = '点击开启 / 关闭自动客服';
      b.addEventListener('click', toggleFromBadge);
      const dot = document.createElement('span');
      dot.id = '__xy_assistant_dot';
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;';
      const txt = document.createElement('span');
      txt.id = '__xy_assistant_txt';
      b.appendChild(dot);
      b.appendChild(txt);
      document.body.appendChild(b);
    }
    const dot = document.getElementById('__xy_assistant_dot');
    const txt = document.getElementById('__xy_assistant_txt');
    if (state.running) {
      b.style.background = '#f0fdf4';
      b.style.color = '#15803d';
      dot.style.background = '#16a34a';
      dot.style.boxShadow = '0 0 0 3px rgba(22,163,74,.2)';
      txt.textContent = '自动客服运行中（点此关闭）';
    } else {
      b.style.background = '#fff';
      b.style.color = '#6b7280';
      dot.style.background = '#9ca3af';
      dot.style.boxShadow = 'none';
      txt.textContent = '已停止 · 点此开启';
    }
  }

  // ---------- 入口 ----------

  (async () => {
    bridge.init(); // 建立与主世界桥的通信
    // 等聊天页主体渲染出来（SPA，hash 路由）
    await waitFor(() => document.querySelector(window.__XY_SELECTORS_DEFAULT.convItem) ||
                        location.hash.includes('im'), 30000, 500);
    await loadConfig();
    mountBadge();
    bindHumanReplyWatch(); // 监听你的手动发送，机器人据此让位
    keepAlivePort();       // 常连接，降低后台被冻结的概率
    // 掉线守护心跳：只要工作台页面开着就持续上报，页面关闭/登出后心跳自然停止
    heartbeat();
    setInterval(heartbeat, 30000);
    if (state.settings.enabled) start();
  })();
})();
