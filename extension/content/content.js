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

  // 防重复注入：同一页面已加载过本脚本（如插件重载后又被注入）→ 直接退出，
  // 避免两份脚本各跑一套定时器抢同一个悬浮按钮（症状：开关来回闪）。
  if (window.__XY_CS_LOADED__) return;
  window.__XY_CS_LOADED__ = true;

  const state = {
    settings: null,
    kb: null,
    products: [],
    S: null,                    // 选择器
    running: false,
    busy: false,                // 正在处理某个会话
    baseline: new Map(),        // convKey -> lastMsg 快照
    deliveredOrders: {},         // orderId -> {ts, card, title, buyer} 已发货订单（持久化去重）
    tgNotified: {},              // orderId -> ts 已推送过 Telegram"新订单"的单（持久化去重，防重复推）
    convLocateFail: {},          // orderId -> 连续"未定位到会话"次数（瞬时失败不告警，连续≥3轮才喊人工）
    manualAlertAt: {},           // orderId -> 上次"需人工"告警时间（同一订单30分钟内不重复喊）
    stockAlertAt: {},            // orderId -> 上次缺货通知时间（桌面+Telegram，30 分钟一条）
    panelAlertAt: {},            // orderId -> 上次面板未加载/不一致通知时间
    deliverHold: {},             // orderId -> {ts, reason} 发送未确认，停止自动重试并转人工
    sootheAt: {},                // convKey -> ts 转人工安抚语上次发送时间（限频）
    remoteCmdTries: {},          // orderId -> 远程发货指令已尝试次数（瞬时失败重试几轮再判失败）
    humanHandoff: {},            // convKey -> ts 转人工接管中的会话（持久化）
    lastSendFail: null,          // 'unconfirmed' | 'rejected' | null 最近一次 sendReply 失败原因
    selectorAudit: null,         // 启动时选择器自检结果（给弹窗告警和反馈）
    replyTimestamps: new Map(), // convKey -> [ts, ...] 用于限频
    deliverBusy: false,          // 发货流程互斥
    activeSig: null,             // 当前激活会话已处理到的消息签名（兜底检查去重用）
    stockCache: null,            // 后端模式库存快照缓存 {ts, list}
    humanReplyAt: {},            // convKey -> ts 本人最后一次手动回复该会话的时间（持久化）
    botMuted: {},                // convKey -> {ts, name} 手动"免打扰"名单：机器人对这些用户永不自动回复（持久化）
    humanQA: [],                 // 本人真实问答样本 [{q,a,ts}]，喂给 AI 学你的风格（最多200，持久化）
    botSending: false,           // 机器人正在发送（让"本人回复"监听忽略这次）
    humanWatchBound: false,      // 手动回复监听是否已绑定
    lastUserActivity: 0,         // 最近一次"真人"在页面上操作的时间（只认 isTrusted 事件）
    lastDeferLogAt: 0,           // "暂缓自动回复"日志节流
    lastDeferNoticeAt: 0,        // "暂缓自动发货"通知节流
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

  // ---------- 会话身份（禁止用头像文件名当 key）----------

  /**
   * 稳定的买家 userId / 会话 id：6~64 位字母数字。
   * 带点的文件名（avatar.jpg）、过短的碎片一律拒绝。
   */
  function isStableConvId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(s)) return false;
    if (!/[A-Za-z0-9]/.test(s)) return false;
    return true;
  }

  /** 拿不到 userId 时的退化键：昵称 + 商品标题 + 订单号。三者皆空则返回空串。 */
  function fallbackConvKey(name, productTitle, orderNo) {
    const n = normNick(name);
    const t = normNick(productTitle);
    const o = normNick(orderNo);
    if (!n && !t && !o) return '';
    return 'fb:' + n + '|' + t + '|' + o;
  }

  /** 会话 key：优先 id:<userId/会话id>，否则 fb:昵称|标题|订单号。不接收头像文件名。 */
  function convKeyOf(parts) {
    const p = parts || {};
    const id = String(p.stableId || '').trim();
    if (isStableConvId(id)) return 'id:' + id;
    return fallbackConvKey(p.name, p.productTitle, p.orderNo);
  }

  /**
   * 同一 key 出现多次：退化键（或 id 对应了不同昵称）标为不唯一，调用方转人工。
   * 同一个稳定 id 且昵称不冲突，当成列表重复节点，不误伤。
   */
  function markAmbiguousConvs(list) {
    const groups = Object.create(null);
    const arr = Array.isArray(list) ? list : [];
    for (const c of arr) {
      if (!c) continue;
      c.ambiguous = false;
      if (!c.key) continue;
      if (!groups[c.key]) groups[c.key] = [];
      groups[c.key].push(c);
    }
    for (const key of Object.keys(groups)) {
      const group = groups[key];
      if (group.length < 2) continue;
      const names = Object.create(null);
      for (const c of group) {
        const n = normNick(c.name);
        if (n) names[n] = 1;
      }
      if (key.indexOf('id:') === 0 && Object.keys(names).length <= 1) continue;
      for (const c of group) c.ambiguous = true;
    }
    return arr;
  }

  /** 从 React 节点上浅层找 userId / sessionId / conversationId，步数有上限。 */
  function readReactConvId(el) {
    if (!el || typeof el !== 'object') return '';
    let seed = null;
    try {
      const rk = Object.keys(el).find(x =>
        x.indexOf('__reactProps$') === 0 ||
        x.indexOf('__reactFiber$') === 0 ||
        x.indexOf('__reactInternalInstance$') === 0);
      if (!rk) return '';
      seed = el[rk];
    } catch (_) { return ''; }
    const idKeys = {
      userid: 1, user_id: 1, buyerid: 1, buyeruserid: 1, peeruserid: 1,
      sessionid: 1, conversationid: 1, cid: 1, convid: 1
    };
    const seen = new Set();
    const stack = [{ node: seed, depth: 0 }];
    let steps = 0;
    while (stack.length && steps < 40) {
      const cur = stack.pop();
      steps++;
      const node = cur && cur.node;
      const depth = cur ? cur.depth : 0;
      if (!node || typeof node !== 'object' || seen.has(node) || depth > 6) continue;
      seen.add(node);
      let keys;
      try { keys = Object.keys(node); } catch (_) { continue; }
      for (const key of keys) {
        const v = node[key];
        if (idKeys[String(key).toLowerCase()] && isStableConvId(v)) return String(v).trim();
        if (depth < 5 && v && typeof v === 'object' &&
            (key === 'memoizedProps' || key === 'pendingProps' || key === 'props' ||
             key === 'session' || key === 'conversation' || key === 'user' ||
             key === 'buyer' || key === 'return' || key === 'child')) {
          stack.push({ node: v, depth: depth + 1 });
        }
      }
    }
    return '';
  }

  /**
   * 从会话节点读买家 userId / 会话 id。
   * 只认 data 属性、链接参数、头像 URL 查询串里的 userId、React props。
   * 不使用头像文件名（包括前 48 字符）——那是串号的来源。
   */
  function readConvStableId(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const attrNames = [
      'data-userid', 'data-user-id', 'data-uid', 'data-buyer-id', 'data-buyerid',
      'data-peer-id', 'data-peerid', 'data-session-id', 'data-sessionid',
      'data-conversation-id', 'data-conversationid', 'data-cid', 'data-conv-id'
    ];
    const nodes = [el];
    if (typeof el.querySelectorAll === 'function') {
      try {
        const extra = state && state.S && state.S.convUserId;
        const sel = extra || '[data-userid],[data-user-id],[data-uid],[data-buyer-id],[data-session-id],[data-conversation-id],[data-cid],[data-conv-id]';
        const found = el.querySelectorAll(sel);
        if (found && found.length) {
          for (let i = 0; i < found.length; i++) nodes.push(found[i]);
        }
      } catch (_) { /* 选择器异常时只看元素自身 */ }
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node.getAttribute !== 'function') continue;
      for (let j = 0; j < attrNames.length; j++) {
        const v = node.getAttribute(attrNames[j]);
        if (isStableConvId(v)) return String(v).trim();
      }
    }
    let href = '';
    try {
      const a = el.querySelector && el.querySelector('a[href]');
      href = a ? (a.getAttribute('href') || a.href || '') : '';
    } catch (_) {}
    const hm = String(href).match(/(?:userId|user_id|sessionId|conversationId)[=/]([A-Za-z0-9_-]{6,64})/i);
    if (hm && isStableConvId(hm[1])) return hm[1];
    try {
      const img = el.querySelector && el.querySelector('img');
      const src = img ? (img.getAttribute('src') || img.src || '') : '';
      const qm = String(src).match(/[?&](?:userId|user_id|uid)=([A-Za-z0-9_-]{6,64})/i);
      if (qm && isStableConvId(qm[1])) return qm[1];
    } catch (_) {}
    const rid = readReactConvId(el);
    if (isStableConvId(rid)) return String(rid).trim();
    return '';
  }

  function readConvProductTitle(el) {
    if (!el || typeof el.querySelector !== 'function') return '';
    const extra = state && state.S && state.S.convItemTitle;
    const sel = extra || '[class*="itemName--"], [class*="itemTitle--"], [class*="item-title--"]';
    try {
      const n = el.querySelector(sel);
      return n ? String(n.textContent || '').trim() : '';
    } catch (_) { return ''; }
  }

  function readConvOrderNo(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const attrNames = ['data-order-id', 'data-orderid', 'data-order-no'];
    const nodes = [el];
    try {
      const extraSel = state && state.S && state.S.convOrderId;
      if (extraSel && el.querySelector) {
        const n = el.querySelector(extraSel);
        if (n) nodes.push(n);
      }
    } catch (_) {}
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node.getAttribute !== 'function') continue;
      for (let j = 0; j < attrNames.length; j++) {
        const v = String(node.getAttribute(attrNames[j]) || '').trim();
        if (/^[0-9A-Za-z-]{8,32}$/.test(v)) return v;
      }
    }
    const text = String(el.innerText || el.textContent || '');
    const m = text.match(/(?:订单号|订单)[:：\s]*([0-9]{10,24})/);
    return m ? m[1] : '';
  }

  // ---------- 会话列表 ----------

  /** 解析一个会话项 → {el, name, lastMsg, time, orderTag, unread, key, ambiguous} */
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
    // 会话唯一键：买家 userId / 会话 id。拿不到再用「昵称+商品标题+订单号」。
    // 绝不用头像文件名前 48 字符——默认头像和 CDN 路径前缀会把不同买家串成同一个 key。
    let stableId = '', productTitle = '', orderNo = '';
    try {
      stableId = readConvStableId(el);
      productTitle = readConvProductTitle(el);
      orderNo = readConvOrderNo(el);
    } catch (_) { /* DOM 异常时退回昵称组合键 */ }
    const key = convKeyOf({ stableId, name, productTitle, orderNo });
    return {
      el, name, lastMsg, time, orderTag, unread,
      productTitle, orderNo, stableId,
      key, ambiguous: false
    };
  }

  // 官方/系统会话：不是买家，绝不自动处理（它们也会有未读角标）
  const SYSTEM_CONV_NAMES = ['通知消息', '系统消息', '闲鱼小蜜', '闲鱼客服', '互动消息', '官方客服'];

  function scanConvList() {
    const list = [...document.querySelectorAll(state.S.convItem)].map(parseConvItem)
      .filter(c => c.key && !SYSTEM_CONV_NAMES.includes(c.name));
    return markAmbiguousConvs(list);
  }

  // ---------- 昵称匹配（容忍闲鱼把买家昵称脱敏，如订单里的 "一***啊"）----------

  /** 归一化：去零宽字符/所有空白 + 全角半角统一，避免"看着一样却 !==" */
  function normNick(s) {
    return String(s == null ? '' : s)
      .replace(/[​‌‍﻿]/g, '')  // 零宽字符
      .replace(/\s+/g, '')                         // 所有空白
      .normalize('NFKC');                          // 全角/半角统一
  }

  /** 昵称是否被脱敏（含 * 掩码，半角/全角） */
  function isMaskedNick(s) { return /[*＊]/.test(String(s == null ? '' : s)); }

  /**
   * 两个昵称是否指同一人；容忍其中一方被脱敏。
   * 脱敏把中间几个字换成 *（如 "一***啊"）→ 转成通配符再和明文比。
   * 安全：整串都是 * 的（如 "***"）拒绝匹配；真正防误发靠调用方的"唯一命中"约束。
   */
  function nickMatch(a, b) {
    const na = normNick(a), nb = normNick(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const aM = isMaskedNick(na), bM = isMaskedNick(nb);
    if (aM === bM) return false;                 // 都没脱敏(且不等) 或 都脱敏 → 不模糊匹配
    const mask = aM ? na : nb;                    // 被脱敏的那个
    const full = aM ? nb : na;                    // 明文那个
    const parts = mask.split(/[*＊]+/);       // "一***啊" → ["一","啊"]
    if (!parts.some(Boolean)) return false;       // 全是 * → 太危险，不匹配
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + parts.map(esc).join('.+') + '$').test(full);
  }

  /** 在会话列表按昵称唯一定位（认脱敏）：精确优先；否则脱敏匹配且必须唯一，防发错人 */
  function uniqueNickMatch(list, nick) {
    const arr = Array.isArray(list) ? list : [];
    const key = normNick(nick);
    const exact = arr.filter(c => c && normNick(c.name) === key);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    const fuzzy = arr.filter(c => c && nickMatch(c.name, nick));
    return fuzzy.length === 1 ? fuzzy[0] : null;
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

  function normMsgText(s) {
    return String(s || '').replace(/\s+/g, '');
  }

  /**
   * 点击发送之后，是否真的多出一条「己方」气泡且包含本次正文。
   * 发送前已经在列表里的同一段文本不算本次成功（防止假成功）。
   */
  function seenNewOwnMessage(before, after, text) {
    const head = normMsgText(text).slice(0, 40);
    if (!head) return false;
    const prev = (Array.isArray(before) ? before : []).map(normMsgText);
    const next = (Array.isArray(after) ? after : []).map(normMsgText);
    return next.some(t => t && t.indexOf(head) >= 0 && prev.indexOf(t) < 0);
  }

  function currentSellerTexts() {
    return readMessages().filter(m => m && m.role === 'seller' && m.text).map(m => m.text);
  }

  /**
   * 往输入框写入并发送。点了发送按钮不算成功。
   * 5 秒内己方消息列表出现该文本才返回 true；否则 lastSendFail='unconfirmed'。
   * expectKey：目标会话的 key。发送前校验当前激活会话就是它——
   * 防止（比如你人工同时在操作工作台点开了别的会话时）消息发进别人的聊天窗。
   */
  async function sendReply(text, expectKey) {
    state.lastSendFail = 'rejected';
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
      const beforeTexts = currentSellerTexts();
      btn.click();
      // 点发送 ≠ 成功。5 秒内己方消息列表必须出现这段文本。
      const confirmed = await waitFor(() => {
        if (!checkTarget()) return false;
        return seenNewOwnMessage(beforeTexts, currentSellerTexts(), text);
      }, 5000, 200);
      if (!confirmed) {
        state.lastSendFail = 'unconfirmed';
        log('error', '点击发送后 5 秒内未在己方消息列表看到该文本，本次不算发送成功');
        return false;
      }
      state.lastSendFail = null;
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

  // ---------- 真人活动检测（你在操作工作台时，机器人不抢屏切会话）----------

  /**
   * 只认 isTrusted 的真实输入事件——机器人程序化 el.click() / dispatchEvent
   * 产生的事件 isTrusted=false，不会把机器人自己误判成"你在操作"。
   */
  function bindActivityWatch() {
    const mark = (e) => { if (e.isTrusted) state.lastUserActivity = Date.now(); };
    for (const t of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) {
      document.addEventListener(t, mark, { capture: true, passive: true });
    }
  }

  /**
   * 你此刻是否正在亲自操作工作台（机器人别切走你正看/正打字的会话）。
   * 两条判据：
   *   1. 输入框里有没发出去的字 = 你正在打字 → 绝不切走（最强，不受计时影响）
   *   2. 或最近很短时间内（默认 8 秒）动过鼠标/键盘 → 刚点进来读，先别马上被抢
   * 窗口特意设短：停手 8 秒就恢复自动回复，避免"你一直在工作台 → 回复一直被拖慢"。
   * settings.pauseWhenUserActive=false 可关闭；userIdleSeconds 可自定义秒数。
   */
  function userActive() {
    if (state.settings && state.settings.pauseWhenUserActive === false) return false;
    // 最强保护：输入框里有没发出去的字 = 你正在打字，绝不切走（不受计时影响）
    const ta = document.querySelector(state.S.inputBox);
    if (ta && ta.value && ta.value.trim()) return true;
    const idle = Number(state.settings && state.settings.userIdleSeconds);
    const win = (Number.isFinite(idle) && idle > 0 ? idle : 8) * 1000;
    return Date.now() - state.lastUserActivity < win;
  }

  /** 本人是否在接管窗口内手动回复过该会话（机器人应让位） */
  function humanTakingOver(key) {
    const mins = state.settings.humanTakeoverMinutes;
    const win = (mins === undefined ? 10 : Number(mins)) * 60000;
    if (win <= 0) return false;
    const at = state.humanReplyAt[key] || 0;
    return Date.now() - at < win;
  }

  // ---------- 手动免打扰名单（永久，直到你手动取消）----------

  /** 该用户是否被你手动设为"不用机器人" */
  function isMuted(key) {
    return !!(key && state.botMuted && state.botMuted[key]);
  }

  /** 设/取消某会话的免打扰，并持久化 */
  async function setMuted(key, name, on) {
    if (!key) return;
    if (on) state.botMuted[key] = { ts: Date.now(), name: name || '' };
    else delete state.botMuted[key];
    try { await chrome.storage.local.set({ botMuted: state.botMuted }); } catch (_) {}
  }

  // ---------- 回复决策 ----------

  /**
   * 转人工关键词按整词/短语匹配。
   * 两字及以内（如「人工」）两侧不能再粘着汉字/字母/数字，
   * 所以「是人工发货吗」不会命中「人工」；三字及以上短语（转人工/找人工/人工客服）允许出现在句子里。
   */
  function matchHandoffKeyword(text, kw) {
    const src = String(text || '');
    const word = String(kw || '').trim();
    if (!src || !word) return false;
    if (Array.from(word).length <= 2) {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^\\u4e00-\\u9fffA-Za-z0-9])' + esc + '($|[^\\u4e00-\\u9fffA-Za-z0-9])');
      return re.test(src);
    }
    return src.indexOf(word) >= 0;
  }

  /** 买家消息是否在要求转人工（整词/短语，不是随便包含「人工」两个字） */
  function wantsHuman(text) {
    const src = String(text || '');
    const kws = (state.settings.humanHandoffKeywords || [])
      .map(k => String(k || '').trim()).filter(Boolean);
    return kws.some(k => matchHandoffKeyword(src, k));
  }

  /** 安抚语限频窗口：接管时长，且至少 30 分钟 */
  function sootheWindowMs() {
    const mins = Number(state.settings && state.settings.humanHandoffCooldownMinutes);
    const win = (Number.isFinite(mins) && mins > 0 ? mins : 30) * 60000;
    return Math.max(win, 30 * 60000);
  }

  function sootheRecentlySent(key) {
    if (!key) return false;
    const last = (state.sootheAt && state.sootheAt[key]) || 0;
    return Date.now() - last < sootheWindowMs();
  }

  async function markSootheSent(key) {
    if (!key) return;
    if (!state.sootheAt) state.sootheAt = {};
    state.sootheAt[key] = Date.now();
    try { await chrome.storage.local.set({ sootheAt: state.sootheAt }); } catch (_) {}
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
   * 右侧商品面板与订单标题的关系：
   *   unloaded  面板还没加载（或订单标题为空）——必须失败停止，不能盲发
   *   mismatch  两边都有字且互不包含——疑似串会话
   *   ok        互相包含，可以继续
   */
  function panelStatus(panelTitle, orderTitle) {
    const p = String(panelTitle || '').trim();
    const o = String(orderTitle || '').trim();
    if (!p || !o) return 'unloaded';
    if (p.indexOf(o) >= 0 || o.indexOf(p) >= 0) return 'ok';
    return 'mismatch';
  }

  /** 打开会话后等面板标题出现，最多 4 秒，然后给出 panelStatus。 */
  async function resolvePanelStatus(orderTitle) {
    await waitFor(() => currentProductTitle(), 4000, 200);
    return panelStatus(currentProductTitle(), orderTitle);
  }

  /**
   * 同一订单的某类通知最多每 30 分钟 1 条（桌面通知会同时抄送 Telegram）。
   * mapName 是 state 上的持久化字典名，例如 stockAlertAt。
   */
  function notifyAtMostEvery(mapName, orderId, title, message, windowMs) {
    if (!state[mapName] || typeof state[mapName] !== 'object') state[mapName] = {};
    const id = String(orderId || '');
    const last = id ? (state[mapName][id] || 0) : 0;
    const win = windowMs || 30 * 60000;
    if (id && Date.now() - last < win) return false;
    if (id) state[mapName][id] = Date.now();
    notify(title, message);
    try {
      const patch = {};
      patch[mapName] = state[mapName];
      chrome.storage.local.set(patch);
    } catch (_) {}
    return true;
  }

  /** 缺货：同一订单 30 分钟内桌面通知和 Telegram 合计最多 1 条。 */
  function notifyStockOnce(orderId, title, message) {
    return notifyAtMostEvery('stockAlertAt', orderId, title, message, 30 * 60000);
  }

  /** 面板未加载或标题对不上：记日志、限频通知，并让调用方停止本次发货。 */
  function stopForPanel(order, skuLabel, status) {
    if (status === 'unloaded') {
      log('warn', `订单 ${order.orderId}「${skuLabel}」右侧商品面板未加载，本次发货失败并停止（不扣卡密、不标发货）`);
      notifyAtMostEvery('panelAlertAt', order.orderId,
        '⚠️ 发货已停止',
        `订单 ${order.orderId} 右侧商品面板没加载出来，已停止发货。请打开该会话确认商品后再发。`);
      return true;
    }
    if (status === 'mismatch') {
      log('warn', `订单 ${order.orderId}「${skuLabel}」：会话「${order.buyerNick}」右侧商品与订单不一致，疑似同昵称撞车，请人工发货`);
      notifyAtMostEvery('panelAlertAt', order.orderId,
        '⚠️ 有单需人工发货',
        `买家「${order.buyerNick}」会话与订单商品不一致，「${skuLabel}」请手动核对发货`);
      return true;
    }
    return false;
  }

  /**
   * 点击发送后 5 秒没看到己方消息：不标发货、转人工、通知，并停掉这单的自动重试。
   * rolledBack：后端模式回滚是否成功。false 表示卡可能还扣着，通知里改口让人核对库存。
   * 本地模式在确认成功前不会扣卡，不传这个参数。
   */
  async function onSendUnconfirmed(order, conv, rolledBack) {
    if (!state.deliverHold) state.deliverHold = {};
    state.deliverHold[order.orderId] = { ts: Date.now(), reason: 'send-unconfirmed' };
    try { await chrome.storage.local.set({ deliverHold: state.deliverHold }); } catch (_) {}
    if (conv && conv.key) {
      try { await setHandoff(conv.key); } catch (_) {}
    }
    const stockLine = rolledBack === false
      ? '库存回滚失败，请立刻核对这张卡还在不在、买家有没有已经收到。'
      : '未扣卡密、未标发货。';
    log('error', `订单 ${order.orderId} 发送未确认，${stockLine}已转人工`);
    notify('⚠️ 发货未确认，已转人工',
      `订单 ${order.orderId} 点击发送后 5 秒内未看到己方消息，${stockLine}请核对与「${order.buyerNick}」的会话；若消息其实已发出，请把该卡标为已用，避免重复发卡。`);
  }

  /** 会话 key 不唯一：停止自动发货并转人工，同一订单 30 分钟内只通知一次。 */
  async function noteAmbiguousConv(order, conv) {
    log('warn', `订单 ${order.orderId} 买家「${order.buyerNick}」会话标识不唯一，停止自动发货并转人工`);
    if (conv && conv.key) {
      try { await setHandoff(conv.key); } catch (_) {}
    }
    notifyAtMostEvery('panelAlertAt', 'amb:' + order.orderId,
      '⚠️ 会话无法唯一识别，已转人工',
      `买家「${order.buyerNick}」有会话对不上唯一身份（缺少 userId，昵称/商品/订单号也不唯一）。订单 ${order.orderId} 已停止自动发货，请人工核对。`);
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

  /** Telegram 是否已配置（token+chatId 都填了） */
  function tgConfigured() {
    const s = state.settings || {};
    return !!((s.tgBotToken || '').trim() && String(s.tgChatId || '').trim());
  }

  /** 飞机推送当前是否开启（已配置 + 开关没关；开关独立于机器人回复总开关） */
  function tgPushOn() {
    return tgConfigured() && (state.settings || {}).tgPushEnabled !== false;
  }

  /** 推送一条 Telegram（后台代发；推送开关关闭或未配置时不发）。
   *  deliverOrderId 传了 → 消息带「发货」按钮（飞机上点即远程发货）。 */
  function tgPush(text, deliverOrderId) {
    if (!tgPushOn()) return;
    try { chrome.runtime.sendMessage({ type: 'TG_PUSH', text, deliverOrderId }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }

  /** 查某订单对应商品的当前库存（后端模式查数据库快照，本地模式查内存规则）。
   *  返回 {label, canDeliver}：label 用于推送展示，canDeliver=是否有货可发。 */
  async function stockLineForOrder(order) {
    const list = await getStockProducts();
    const hits = (list || []).filter(p =>
      p.match && order.title.includes(p.match) &&
      (!p.spec || p.spec === order.spec) &&
      (!p.price || String(p.price) === String(order.price)));
    if (!hits.length) return { label: '库存：⚠️ 未配置发货规则，需人工', canDeliver: false };
    const p = hits.sort((a, b) => ((b.spec ? 1 : 0) + (b.price ? 1 : 0)) - ((a.spec ? 1 : 0) + (a.price ? 1 : 0)))[0];
    if (p.stock === null) return { label: '库存：固定内容（随时可发）', canDeliver: true };
    if (p.stock > 0) return { label: `库存：${p.stock} 张 ✅`, canDeliver: true };
    return { label: '库存：❌ 无货，需补货', canDeliver: false };
  }

  /** 对刚发现的"新付款订单"推送 Telegram 提醒（每单只推一次，持久化去重，带库存+发货按钮） */
  async function tgNotifyNewOrders(orders) {
    const fresh = (Array.isArray(orders) ? orders : []).filter(o =>
      o.orderStatus === '待发货' && !o.inRefund &&
      !state.deliveredOrders[o.orderId] && !state.tgNotified[o.orderId]);
    for (const o of fresh) {
      state.tgNotified[o.orderId] = Date.now();
      let stock = { label: '', canDeliver: true };
      try { stock = await stockLineForOrder(o); } catch (_) {}
      const tail = stock.canDeliver
        ? '点下方「📦 发货」即可远程发货（电脑上的插件执行，约1分钟内）。'
        : '⚠️ 当前发不了（缺货/需人工），请先补货或回电脑处理。';
      tgPush(
        `🛒 新订单已付款\n买家：${o.buyerNick}\n商品：${o.title}${o.spec ? ' / ' + o.spec : ''}  ¥${o.price}\n${stock.label}\n订单号：${o.orderId}\n\n${tail}`,
        stock.canDeliver ? o.orderId : undefined);   // 有货才给发货按钮
    }
    if (fresh.length) {
      try { await chrome.storage.local.set({ tgNotified: state.tgNotified }); } catch (_) {}
    }
  }

  /**
   * 记一次"未定位到买家会话"。刚刷新页面/骨架屏/搜索渲染慢时瞬时失败很常见、
   * 下轮自动重试即可——连续失败 ≥3 轮才值得喊人工，且同一订单 30 分钟内不重复喊，
   * 避免"狼来了"式告警把真正需要处理的单淹没。
   */
  function noteConvLocateFail(order) {
    const n = (state.convLocateFail[order.orderId] || 0) + 1;
    state.convLocateFail[order.orderId] = n;
    if (n < 3) {
      log('info', `订单 ${order.orderId} 暂未定位到买家「${order.buyerNick}」的会话（第${n}次，列表可能还没加载完，下轮自动重试）`);
      return;
    }
    log('warn', `订单 ${order.orderId}「${order.title}」待发货，连续${n}轮未找到买家「${order.buyerNick}」的会话，请人工发货`);
    const last = state.manualAlertAt[order.orderId] || 0;
    if (Date.now() - last > 30 * 60000) {
      state.manualAlertAt[order.orderId] = Date.now();
      notify('⚠️ 有单需人工发货', `未定位到买家 ${order.buyerNick} 的会话，「${order.title}」请手动发货`);
    }
  }

  /**
   * 处理"飞机远程发货指令"：你在 Telegram 点了「📦 发货」→ 服务器排了指令 →
   * 这里取回来、走与本地发货完全相同的安全路径执行、把结果回写服务器（服务器再推飞机）。
   * 独立于自动发货开关（这是你明确的远程指令）。瞬时失败(会话没定位到等)重试几轮再判失败。
   */
  async function processRemoteDeliverCommands() {
    if (!backend.enabled()) return;
    if (state.deliverBusy) return;
    let cmds;
    try { cmds = (await backend.listDeliverCommands()).commands || []; }
    catch (_) { return; }              // 后端不可达，下轮再来
    if (!cmds.length) return;
    let orders;
    try { orders = await bridge.call('fetchWaitShipOrders', { maxPages: 2 }, 15000); }
    catch (_) { log('warn', '远程发货：拉订单失败，下轮重试'); return; }
    const byId = {};
    for (const o of (orders || [])) byId[o.orderId] = o;

    for (const c of cmds) {
      const oid = c.order_id;
      if (state.deliveredOrders[oid]) {
        delete state.remoteCmdTries[oid];
        await backend.resolveDeliverCommand(oid, 'done', '（已发过，未重复）').catch(() => {});
        continue;
      }
      if (state.deliverHold && state.deliverHold[oid]) {
        delete state.remoteCmdTries[oid];
        await backend.resolveDeliverCommand(oid, 'failed', '发送未确认，已转人工，请核对聊天后手动发').catch(() => {});
        continue;
      }
      const order = byId[oid];
      if (!order) {
        // 本账号查无此单 ≠ 失败：两个号共用后端时，这可能是另一个号的单，
        // 留 pending 让对方插件执行。排队超 10 分钟仍没人发成，才判失败通知飞机。
        // （老版服务器不返回 age_sec → 按超时处理，即回到旧的立即判失败行为）
        const age = Number(c.age_sec);
        if (Number.isFinite(age) && age < 600) continue;
        delete state.remoteCmdTries[oid];
        await backend.resolveDeliverCommand(oid, 'failed', '待发货列表里找不到这单（已发/退款/超时？），请上工作台核对').catch(() => {});
        continue;
      }
      if (order.orderStatus !== '待发货' || order.inRefund) {
        delete state.remoteCmdTries[oid];
        await backend.resolveDeliverCommand(oid, 'failed', '订单已不在待发货（已发/退款/超时？）').catch(() => {});
        continue;
      }
      // 真正发卡：抢锁，只在发送期间互斥。
      // 注意只查 deliverBusy——本函数就跑在 tick 里，state.busy 此刻必然为 true，
      // 拿它当条件等于永远不执行（之前的 bug：远程指令只会被标记、从不真发货）
      if (state.deliverBusy) return;                 // 发货通道被占（如手动发货中）→ 下轮继续
      state.deliverBusy = true;
      // force=true：远程指令是你的明确命令，商品即使关了自动发货也要发
      try { await deliverOrder(order, true); }
      finally { state.deliverBusy = false; }

      if (state.deliveredOrders[oid]) {
        delete state.remoteCmdTries[oid];
        await backend.resolveDeliverCommand(oid, 'done', '').catch(() => {});
      } else {
        // 没成功（会话没定位到/草稿占用/缺货）：重试几轮再判失败，避免一次瞬时抖动就放弃
        const n = (state.remoteCmdTries[oid] || 0) + 1;
        state.remoteCmdTries[oid] = n;
        if (n >= 3) {
          delete state.remoteCmdTries[oid];
          await backend.resolveDeliverCommand(oid, 'failed', '多次尝试未成功（缺货/会话定位失败/输入框有草稿），请回电脑手动发').catch(() => {});
        }
        // n<3：不 resolve，保持 pending，下轮自动重试
      }
    }
  }

  // ---------- 接口驱动的自动发货 ----------

  /**
   * 一轮订单监控：拉「待发货」订单 → 推送新单到 Telegram → 逐单自动发货。
   * 独立于"机器人回复"总开关：关了回复，发货/推送照常。
   *   - 推送（tgPushOn）：不碰页面，你在操作时也照推；
   *   - 自动发货（settings.autoDeliver）：要切会话，你在操作时暂缓。
   * 状态判断全部来自交易接口，不依赖页面标签。任何不确定都跳过等人工。
   */
  async function deliveryPass() {
    if (state.deliverBusy) return;
    const wantPush = tgPushOn();
    const wantDeliver = state.settings.autoDeliver !== false;
    if (!wantPush && !wantDeliver) return;
    // 关键：拉订单是只读的，不占发货锁——订单接口偶尔慢到几秒，占着锁会把手动发货也拖死。
    // 只有真要"自动发卡"时（wantDeliver）才在发送前抢锁。纯推送不碰锁。
    let orders;
    try {
      orders = await bridge.call('fetchWaitShipOrders', { maxPages: wantDeliver ? 2 : 1 }, 15000);
    } catch (e) {
      log('warn', '拉取待发货订单失败（稍后重试）: ' + (e && e.message));
      return;
    }
    if (!Array.isArray(orders) || !orders.length) return;
    if (wantPush) await tgNotifyNewOrders(orders);   // 新付款订单先推 Telegram（每单一次，不碰界面）
    if (!wantDeliver) return;                          // 只要推送不要自动发货（全手动模式）：到此为止

    // —— 到这里才真正要自动发卡：抢锁，只在发送期间互斥 ——
    if (state.deliverBusy) return;                     // 手动发货正占着 → 本轮让它先
    state.deliverBusy = true;
    try {
      // 自动发货要点开买家会话（会切走你正看的窗口）→ 你在操作时暂缓并提醒
      if (userActive()) {
        if (Date.now() - state.lastDeferNoticeAt > 120000) {
          const waiting = orders.filter(o =>
            o.orderStatus === '待发货' && !o.inRefund && !state.deliveredOrders[o.orderId]);
          if (waiting.length) {
            state.lastDeferNoticeAt = Date.now();
            notify('📦 有待发货订单（已暂缓）', `你正在操作工作台，${waiting.length} 个已付款订单暂缓自动发货。可点绿色「发货」按钮手动发，或停手几秒后自动发。`);
            log('warn', `你在操作中，${waiting.length} 个待发货订单暂缓自动发货（停手后自动继续）`);
          }
        }
        return;
      }

      for (const order of orders) {
        // —— 逐层硬校验，任一不满足就跳过 ——
        if (order.orderStatus !== '待发货') continue;          // 权威状态：必须是待发货
        if (order.inRefund) {                                  // 退款中：绝不发货
          log('warn', `订单 ${order.orderId}（${order.buyerNick}）退款中，跳过发货`);
          continue;
        }
        if (state.deliveredOrders[order.orderId]) continue;    // 已发过（本地缓存）：快速跳过
        // 发多单要几十秒，你中途回来操作 → 立刻收手不抢屏；
        // 没发的单还是"待发货"，停手后下一轮自动补发，不会漏
        if (userActive()) {
          log('info', '检测到你开始操作，剩余待发货订单暂缓（停手几秒后自动继续发）');
          break;
        }
        await deliverOrder(order);
        await sleep(rand(1500, 3000));
      }
    } catch (e) {
      log('error', 'deliveryPass 异常: ' + (e && e.message));
    } finally {
      state.deliverBusy = false;
    }
  }

  /**
   * 发一个订单（自动轮询与手动按钮共用同一条路径，确保去重/校验完全一致）。
   * 调用前应已确认：状态待发货、未退款、未在 deliveredOrders 里。
   */
  async function deliverOrder(order, force = false) {
    if (order && state.deliverHold && state.deliverHold[order.orderId]) {
      log('info', `订单 ${order.orderId} 此前发送未确认，已转人工，不再自动重试`);
      return;
    }
    const skuLabel = order.title + (order.spec ? ' / ' + order.spec : '') +
      (order.price ? ' ¥' + order.price : '');
    const doneMark = state.settings.deliveryDoneMark || '【自动发货】';
    if (backend.enabled()) {
      await deliverViaBackend(order, skuLabel, doneMark, force);
    } else {
      await deliverLocal(order, skuLabel, doneMark);
    }
  }

  /** 后端（MySQL）模式：取卡+扣库存+去重在数据库事务里完成，最安全 */
  async function deliverViaBackend(order, skuLabel, doneMark, force = false) {
    // 先定位会话；找不到就不占用库存（瞬时失败下轮重试，连续失败才告警）
    const conv = await openConversationByNick(order.buyerNick);
    if (!conv || conv.ambiguous) {
      if (conv && conv.ambiguous) await noteAmbiguousConv(order, conv);
      else noteConvLocateFail(order);
      return;
    }
    delete state.convLocateFail[order.orderId];   // 定位成功，清失败计数
    try {
      // 注意：这里不再用"聊天里出现过发货标记"做去重——回头客的聊天里必然留着
      // 上一单的标记，会把新订单误判成已发货。去重完全交给后端（orderId 唯一约束，
      // 重复调用幂等返回 alreadyDelivered，不会重复扣卡）。
      // 面板没加载 / 标题对不上：失败停止，此时还没向后端扣卡密。
      const panel = await resolvePanelStatus(order.title);
      if (stopForPanel(order, skuLabel, panel)) return;

      let r;
      try {
        r = await backend.deliver({
          orderId: order.orderId, title: order.title, spec: order.spec,
          price: order.price, buyer: order.buyerNick,
          template: state.settings.deliveryTemplate || '',
          force   // TG「发货」按钮/人工指令 = 明确要发，绕过该商品的自动发货开关
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
            tgPush(`✅ 已自动发货\n买家：${order.buyerNick}\n商品：${skuLabel}\n剩余库存：${r.stockLeft}` +
              (r.stockLeft <= 2 ? '（⚠️ 该补货了）\n\n💡 直接回复本机器人即可远程补货：\n补货 新版\n卡密1\n卡密2' : ''));
            await autoConsign(order, skuLabel); // 点亮订单发货，闭环
          } else {
            // 聊天发送未确认 → 回滚数据库，恢复卡密。未确认则转人工并不再自动重试。
            let rolled = false;
            try {
              await backend.rollbackDeliver(order.orderId);
              rolled = true;
            } catch (e) {
              log('error', `订单 ${order.orderId} 发送失败且回滚失败，请手动核对该单是否已发！${e.message}`);
              notify('⚠️ 发货异常需核对', `订单 ${order.orderId} 发送失败且回滚失败，请手动检查库存与该订单`);
            }
            if (state.lastSendFail === 'unconfirmed') {
              // 回滚失败也要停住，避免下一轮再发一张
              await onSendUnconfirmed(order, conv, rolled);
            } else if (rolled) {
              log('warn', `订单 ${order.orderId} 聊天发送失败，已回滚库存，下轮重试`);
            }
          }
          break;
        }
        case 'alreadyDelivered':
          await rememberDelivered(order);
          break;
        case 'autoOff':
          // 该商品关了自动发货：不发不扣，只留一条日志（新订单的 TG 提醒
          // 由 tgNotifyNewOrders 负责推送，带「发货」按钮可远程触发）
          if (!state.autoOffLogged) state.autoOffLogged = {};
          if (!state.autoOffLogged[order.orderId]) {
            state.autoOffLogged[order.orderId] = 1;
            log('info', `订单 ${order.orderId}「${skuLabel}」该商品自动发货已关闭，等待 TG 按钮或人工发货`);
          }
          break;
        case 'purchasing':
          // 后端正在向卡网自动进货（卡网可能还要向它的上游买），几秒到一分钟；
          // 本函数对未发货订单每轮都会重试，货到自动发出，这里只记日志不打扰
          log('info', `订单 ${order.orderId}「${skuLabel}」本地无货，正在从卡网自动进货，到货后自动发出`);
          break;
        case 'outOfStock': {
          const sent = notifyStockOnce(order.orderId, '⚠️ 有单待发货但缺货',
            `「${skuLabel}」库存不足，买家 ${order.buyerNick} 已付款，请补货或手动发货`);
          log(sent ? 'warn' : 'info', sent
            ? `订单 ${order.orderId}「${skuLabel}」待发货，但数据库无可用库存，等待人工发货`
            : `订单 ${order.orderId} 仍缺货，30 分钟内已通知过（含 Telegram），本次不再推送`);
          break;
        }
        case 'needManual':
          log('warn', `订单 ${order.orderId}「${skuLabel}」待发货，但没有匹配该规格/价格的规则，请人工发货`);
          notify('⚠️ 有单需人工发货', `「${skuLabel}」未配置对应规格的发货规则，请手动发货`);
          break;
        case 'noRule':
          // 不弹通知（没配规则的商品可能是故意不管的），但必须留日志——
          // 手动点发货失败时全靠运行日志定位原因，静默会让人完全没法排查
          log('warn', `订单 ${order.orderId}「${skuLabel}」没有标题能匹配的发货规则（检查规则的"商品标题匹配"是否包含在宝贝标题里）`);
          break;
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
      const sent = notifyStockOnce(order.orderId, '⚠️ 有单待发货但缺货',
        `「${skuLabel}」库存不足，买家 ${order.buyerNick} 已付款，请尽快补货或手动发货`);
      log(sent ? 'warn' : 'info', sent
        ? `订单 ${order.orderId}「${skuLabel}」待发货，但无可用库存，等待人工发货`
        : `订单 ${order.orderId} 仍缺货，30 分钟内已通知过（含 Telegram），本次不再推送`);
      return;
    }
    const conv = await openConversationByNick(order.buyerNick);
    if (!conv || conv.ambiguous) {
      if (conv && conv.ambiguous) await noteAmbiguousConv(order, conv);
      else noteConvLocateFail(order);
      return;
    }
    delete state.convLocateFail[order.orderId];   // 定位成功，清失败计数
    try {
      // 缓存丢失（重装插件等）后的兜底去重：只认"发货标记 + 本订单号"同时出现。
      // 只认裸标记会把回头客的新订单误判成已发货（聊天里留着上一单的标记）
      if (readMessages().some(m => m.role === 'seller' &&
          m.text.includes(doneMark) && m.text.includes('#' + order.orderId))) {
        await markOrderDelivered(order, null);
        return;
      }
      // 面板没加载 / 标题对不上：失败停止。本地模式此时还没扣卡密。
      const panel = await resolvePanelStatus(order.title);
      if (stopForPanel(order, skuLabel, panel)) return;
      await sleep(replyDelay());
      if (await sendReply(doneMark + ' #' + order.orderId + '\n' + prepared.content, conv.key)) {
        if (prepared.card) await consumeCard(rule, prepared.card);
        await markOrderDelivered(order, prepared.card);
        bumpStat('deliveriesSent');
        log('info', `已发货：订单 ${order.orderId}「${skuLabel}」→ ${order.buyerNick}` +
          (prepared.card ? `，剩余库存 ${rule.cards.length}` : ''));
        tgPush(`✅ 已自动发货\n买家：${order.buyerNick}\n商品：${skuLabel}` +
          (prepared.card ? `\n剩余库存：${rule.cards.length}${rule.cards.length <= 2 ? '（⚠️ 该补货了）' : ''}` : ''));
        await autoConsign(order, skuLabel); // 点亮订单发货，闭环
      } else if (state.lastSendFail === 'unconfirmed') {
        // 未扣库存（consumeCard 在发送确认之后）。转人工，不再自动重试。
        await onSendUnconfirmed(order, conv);
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
    let conv = uniqueNickMatch(scanConvList(), nick);
    if (!conv) {
      // 昵称可能没在当前虚拟列表可视区，用搜索框过滤。
      // 但脱敏昵称（含 *）没法当搜索词，搜也搜不到 → 跳过搜索，交人工。
      const search = convSearchBox();
      if (search && !isMaskedNick(nick)) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(search, nick);
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1200);
        // 精确优先；脱敏仅在唯一命中时采用，绝不退化取第一个（防发错人）
        conv = uniqueNickMatch(scanConvList(), nick);
      }
    }
    if (!conv) { await clearConvSearch(); return null; }  // 失败：清搜索恢复列表
    // 退化键不唯一（或同一个 id 对上了不同昵称）→ 不点开、不发货，交给人工
    if (conv.ambiguous || !conv.key) {
      log('warn', `买家「${nick}」命中的会话标识不唯一，停止自动处理并转人工`);
      await clearConvSearch();
      return { ambiguous: true, key: conv.key || '', name: conv.name || nick };
    }
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
      chrome.runtime.sendMessage({ type: 'GEN_REPLY', context }, (r) => {
        void chrome.runtime.lastError; // 签收传输层错误（SW 重启/通道关闭），避免记 Unchecked
        resolve(r);                    // 失败时 r 为 undefined，下面按"无响应"处理
      }));
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
    // ---- 免打扰名单最高优先：你手动设了"此用户不用机器人" → 连会话都不点开，一句不回 ----
    if (isMuted(conv.key)) {
      state.baseline.set(conv.key, conv.lastMsg);
      return;
    }
    // 标识不唯一：不点开、不自动回复，转人工（30 分钟内不重复通知）
    if (conv.ambiguous) {
      state.baseline.set(conv.key, conv.lastMsg);
      log('warn', `会话「${conv.name || conv.key}」标识不唯一，已停止自动回复并转人工`);
      notifyAtMostEvery('panelAlertAt', 'ambconv:' + conv.key,
        '🙋 会话无法唯一识别，已转人工',
        `「${conv.name || '未知买家'}」与其他会话撞了同一个标识，已停止自动回复和发货，请人工处理`);
      try { await setHandoff(conv.key); } catch (_) {}
      return;
    }
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

    // ---- 转人工：买家要求人工客服 → 安抚一句（限频）+ 暂停该会话自动回复 ----
    if (wantsHuman(lastChat.text)) {
      if (!handoffActive(conv.key)) {
        const soothe = (state.settings.humanHandoffReply || '').trim();
        const limited = sootheRecentlySent(conv.key);
        if (!limited) {
          // 安抚语不加机器人标识，避免和「转人工」矛盾；同一窗口内只发一次
          if (soothe) {
            await sleep(replyDelay());
            await sendReply(soothe, conv.key);
          }
          await markSootheSent(conv.key);
          notify('🙋 有买家要人工客服', `「${conv.name}」请求人工，已暂停自动回复，请尽快处理`);
          log('info', `「${conv.name}」触发转人工，已暂停自动回复，等待人工处理`);
        } else {
          log('info', `「${conv.name}」转人工安抚语还在限频窗口内，本次不再发送`);
        }
        await setHandoff(conv.key);
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
      // 日志带上商品上下文：AI 答串商品时，一眼能看出是不是右侧面板挂错了商品
      log('info', `[${source}] 回复「${conv.name}」(商品:${productTitle || '无'}): ${reply.slice(0, 50)}`);
    }
    // 把自己刚发的话记入基线，避免下一轮误判为新消息
    await sleep(800);
    const fresh = scanConvList().find(c => c.key === conv.key);
    state.baseline.set(conv.key, fresh ? fresh.lastMsg : reply);
    syncActiveSig(conv.key);
  }

  // ---------- 主循环 ----------

  /** 单个节点解析不出「是否撞车」，对照整表补上 ambiguous。 */
  function flagIfAmbiguous(conv) {
    if (!conv || !conv.key) return conv;
    try {
      const same = scanConvList().filter(c => c.key === conv.key);
      if (same.some(c => c.ambiguous)) conv.ambiguous = true;
    } catch (_) {}
    return conv;
  }

  /** 当前激活会话的消息签名（会话key + 消息数 + 最后一条内容） */
  function activeConvSig() {
    const act = document.querySelector(state.S.convActive);
    if (!act) return null;
    const conv = flagIfAmbiguous(parseConvItem(act));
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
    if (isMuted(cur.conv.key)) return;               // 免打扰名单里的用户：兜底也不回
    if (!cur.last || cur.last.role !== 'buyer' || !cur.last.text) return; // 最新不是买家文本，不动作
    await handleConversation(cur.conv);
  }

  async function tick() {
    // deliverBusy 也要挡：手动发货按钮点击后会在当前会话里 sleep 几秒再发送，
    // 这几秒内若买家追加消息，tick() 的自动回复不能跟手动发货抢同一个输入框
    // （两边都没有对方感知的锁，同时 sendReply 会互相覆盖写入内容）。
    // 注意：tick 本身常驻运行——"机器人回复"由 state.running 在下面分段控制，
    // 订单监控（自动发货+飞机推送）独立于回复开关。
    // 但插件弹窗里的"总开关"关闭时一切暂停（回复/发货/推送全停，彻底安静）。
    if (!state.settings || state.settings.enabled !== true) return;
    if (state.busy || state.deliverBusy) return;
    state.busy = true;
    try {
      if (state.running) {
      // 1) 自动回复：只处理"有未读红点"的会话。
      // 未读红点 = 买家发来我还没看的新消息，这是唯一可靠信号：
      // 系统消息（确认收货）、评价卡、自己发的消息都不会产生未读 → 不会被点开，
      // 从根本上消除"逐个点开会话"的扰民行为。
      // 再叠加基线比对：启动时已挂着未读、且最后一条消息至今没变的会话跳过，
      // 保证"只回复启用之后的新消息"，不翻旧账（买家再发新消息后 lastMsg 变化即恢复处理）
      const convs = scanConvList().filter(c =>
        c.unread && !isMuted(c.key) && state.baseline.get(c.key) !== c.lastMsg);
      if (convs.length && userActive()) {
        // 你正在亲自操作工作台：处理这些会话要点开它们、会抢走你正看的聊天框。
        // 暂缓，等你停手几秒后自动继续（未读红点还在，不会漏）
        if (Date.now() - state.lastDeferLogAt > 30000) {
          state.lastDeferLogAt = Date.now();
          log('info', `你正在操作工作台，${convs.length} 个未读会话暂缓自动回复（停手几秒后自动继续）`);
        }
      } else {
        for (const conv of convs) {
          // 每处理一个前再查一次：跑批要几十秒，你可能中途回来操作了 → 立刻收手，
          // 剩余的未读红点还在，停手几秒后下一轮自动继续，不会漏
          if (userActive()) {
            log('info', '检测到你开始操作，剩余未读会话暂缓（停手几秒后自动继续）');
            break;
          }
          await handleConversation(conv);
          await sleep(rand(1000, 2000));
        }
      }
      // 1b) 兜底：当前"打开着"的会话里买家发新消息不会产生未读（开着=自动已读），
      // 直接读当前聊天窗判断，无需点击。签名去重防止重复回复。
      // 这条不切换窗口（就在你当前会话里回），不需要为"防抢屏"暂缓；
      // 你正在打字时 sendReply 的草稿保护会拦住，不会覆盖你的输入。
      await checkActiveConversation();
      } // ← 以上"机器人回复"部分受总开关(state.running)控制

      // 2) 订单监控：自动发货 + 飞机推送，独立于回复开关（内部各有自己的开关与
      // "你在操作时暂缓"逻辑，见 deliveryPass 注释）
      await deliveryPass();
      // 3) 远程发货：飞机上点了「发货」按钮排下的指令，取回来执行（独立于自动发货开关）
      await processRemoteDeliverCommands();
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

  /**
   * 本页脚本是否还连着扩展本体。扩展被重载后，旧页面脚本的 chrome.runtime.id
   * 会变 undefined——此时拉订单仍是好的（走页面自己的接口通道），但调后端、
   * 存配置全会失败，症状极具迷惑性。手动按钮点击前必须先自检。
   */
  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
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
    const data = await chrome.storage.local.get([
      'settings', 'kb', 'products', 'deliveredOrders', 'humanHandoff',
      'humanReplyAt', 'botMuted', 'humanQA', 'tgNotified',
      'deliverHold', 'sootheAt', 'stockAlertAt', 'panelAlertAt'
    ]);
    state.settings = data.settings || {};
    state.kb = data.kb || { entries: [], knowledgeText: '' };
    state.products = data.products || [];
    state.deliveredOrders = data.deliveredOrders || {};
    state.humanHandoff = data.humanHandoff || {};
    state.humanReplyAt = data.humanReplyAt || {};
    state.botMuted = data.botMuted || {};
    state.tgNotified = data.tgNotified || {};
    state.deliverHold = data.deliverHold || {};
    state.sootheAt = data.sootheAt || {};
    state.stockAlertAt = data.stockAlertAt || {};
    state.panelAlertAt = data.panelAlertAt || {};
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

  /**
   * 启动自检：必填选择器缺失/写错，或页面上会话列表和输入框都找不到。
   * 结果写入 storage，弹窗据此告警，反馈问题时一并带上。
   */
  function auditSelectors(S, query) {
    const required = ['convItem', 'convActive', 'msgList', 'msgTextBuyer', 'msgTextMine', 'inputBox', 'sendButtonScope', 'productTitle'];
    const missing = [];
    const invalid = [];
    const unmatched = [];
    const q = typeof query === 'function' ? query : function () { return true; };
    for (let i = 0; i < required.length; i++) {
      const k = required[i];
      const sel = S && S[k];
      if (typeof sel !== 'string' || !String(sel).trim()) { missing.push(k); continue; }
      try {
        if (!q(sel)) unmatched.push(k);
      } catch (_) {
        invalid.push(k);
      }
    }
    const domBroken = ['convItem', 'inputBox'].every(function (k) {
      return missing.indexOf(k) >= 0 || invalid.indexOf(k) >= 0 || unmatched.indexOf(k) >= 0;
    });
    return {
      ok: missing.length === 0 && invalid.length === 0 && !domBroken,
      missing: missing,
      invalid: invalid,
      unmatched: unmatched,
      domBroken: domBroken
    };
  }

  async function runSelectorAudit() {
    const S = state.S;
    if (!S) return;
    const ask = function (sel) { return document.querySelector(sel); };
    let report = null;
    // 骨架屏时会话列表和输入框可能都还没有。配置错误立刻报；只是页面没画出来就再等几轮。
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 1200 : 3000);
      report = auditSelectors(S, ask);
      if (!report) break;
      if (report.ok || report.missing.length || report.invalid.length) break;
    }
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch (_) {}
    report.version = version;
    report.ts = Date.now();
    state.selectorAudit = report;
    try { await chrome.storage.local.set({ selectorAudit: report }); } catch (_) {}
    if (!report.ok) {
      const why = report.missing.length ? ('缺少选择器 ' + report.missing.join('、'))
        : report.invalid.length ? ('选择器写错了 ' + report.invalid.join('、'))
        : '页面上找不到会话列表或输入框，选择器可能已失效';
      log('error', '选择器自检未通过：' + why);
      notify('⚠️ 选择器自检未通过', why + '。自动回复/发货可能失效，请打开插件弹窗查看或点「反馈问题」。');
    } else {
      log('info', '选择器自检通过');
    }
  }

  /** 开启"机器人回复"（订单监控/发货/推送由常驻 tick 独立负责，不在这里管） */
  async function start() {
    await loadConfig();
    if (state.settings.enabled !== true) return;          // 总开关（插件弹窗）没开
    if (state.settings.replyEnabled === false) return;    // 机器人回复单项关着
    if (state.running) return;
    // 建立基线：当前已存在的消息一律不处理，只管之后新来的
    for (const c of scanConvList()) state.baseline.set(c.key, c.lastMsg);
    // 当前打开的会话同理：启动前的消息记入签名，不回旧账
    const cur = activeConvSig();
    state.activeSig = cur ? cur.sig : null;
    state.running = true;
    log('info', `机器人回复已开启，监控 ${state.baseline.size} 个会话（自动发货/飞机推送独立运行）`);
    mountBadge();
  }

  /** 关闭"机器人回复"。注意：不停 tick 定时器——自动发货和飞机推送继续工作 */
  function stop() {
    state.running = false;
    log('info', '机器人回复已关闭（自动发货/飞机推送不受影响，仍在运行）');
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
    // 后台定时"戳"：标签在后台被浏览器节流时，靠后台 SW 驱动强制跑一轮。
    // 不看 running——回复关着时订单监控（发货/推送）也要被戳活
    if (msg && msg.type === 'TICK_NOW') {
      // 关键：顺手发一次心跳。后台标签被浏览器冻结后，页面自己的 setInterval(heartbeat)
      // 会停摆，光靠它会被误判"掉线"；而 SW 每分钟戳一次能唤醒本标签，借这次戳补心跳，
      // 只要标签还活着就不会误报掉线（真关了/僵尸了才收不到戳，才会真掉线）
      heartbeat();
      if (!state.busy) tick();
      sendResponse({ ok: true });
      return;
    }
  });

  /** 建一条到后台的常连接，降低本标签被浏览器"冻结/丢弃"的概率 */
  function keepAlivePort() {
    try {
      const port = chrome.runtime.connect({ name: 'xy-keepalive' });
      // 断开后（SW 回收/5分钟上限/页面进往返缓存）稍后重连，尽量保持"有扩展活动"。
      // 读一下 lastError 表示"已签收"，否则 Chrome 会记 Unchecked runtime.lastError
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        setTimeout(keepAlivePort, 2000);
      });
    } catch (_) { /* 扩展上下文失效时忽略 */ }
  }

  // 配置变化实时生效
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      await loadConfig();
      const s = state.settings || {};
      // 回复引擎 = 总开关(弹窗) && 回复单项(角标) 都开
      const replyOn = s.enabled === true && s.replyEnabled !== false;
      if (replyOn && !state.running) start();
      if (!replyOn && state.running) stop();
      mountBadge(); // 总开关状态变化要立刻反映到角标
    }
    if (changes.kb) state.kb = changes.kb.newValue;
    if (changes.products) state.products = changes.products.newValue;
    // 免打扰名单在别的工作台标签被改动 → 本标签同步，并刷新按钮显示
    if (changes.botMuted) { state.botMuted = changes.botMuted.newValue || {}; updateMuteButton(); }
  });

  // ---------- 页面右下角状态角标 ----------

  /** 点角标 = 开/关"机器人回复"单项（总开关在插件弹窗里，关了这里点不动） */
  async function toggleFromBadge() {
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (settings.enabled !== true) {
        alert('总开关是关闭状态（在插件弹窗里：点浏览器右上角的插件图标开启）。\n总开关关闭时，回复/自动发货/飞机推送全部暂停，这个角标只管"机器人回复"单项。');
        return;
      }
      const wantOn = !state.running;
      settings.replyEnabled = wantOn;
      await chrome.storage.local.set({ settings }); // 持久化
      state.settings.replyEnabled = wantOn;
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
    b.title = '点击开启/关闭机器人自动回复（不影响自动发货和飞机推送；总开关在插件弹窗）';
    if (state.settings && state.settings.enabled !== true) {
      // 总开关（插件弹窗）关闭：一切暂停，角标明示
      b.style.background = '#f3f4f6';
      b.style.color = '#6b7280';
      dot.style.background = '#9ca3af';
      dot.style.boxShadow = 'none';
      txt.textContent = '已全部停用（总开关在插件弹窗）';
    } else if (state.running) {
      b.style.background = '#f0fdf4';
      b.style.color = '#15803d';
      dot.style.background = '#16a34a';
      dot.style.boxShadow = '0 0 0 3px rgba(22,163,74,.2)';
      txt.textContent = '机器人回复：开（点此关闭）';
    } else {
      b.style.background = '#fff';
      b.style.color = '#6b7280';
      dot.style.background = '#9ca3af';
      dot.style.boxShadow = 'none';
      txt.textContent = '机器人回复：关 · 点此开启';
    }
  }

  // ---------- 右下角"对该用户停用机器人"按钮（作用于当前打开的会话）----------

  /** 点按钮：把当前打开的会话加入/移出免打扰名单 */
  async function onMuteClick() {
    // 断线自检：僵尸脚本存不了名单（chrome.storage 已失效），明说而不是静默失败
    if (!extAlive()) {
      markZombie();
      alert('插件刚更新过，本页面的脚本已断线，设置无法保存。\n请按 F5 刷新工作台页面后再操作。');
      return;
    }
    const act = document.querySelector(state.S.convActive);
    if (!act) return;
    const conv = parseConvItem(act);
    if (!conv.key || SYSTEM_CONV_NAMES.includes(conv.name)) return;
    const turnOn = !isMuted(conv.key);               // 当前没静音 → 这次点是开启静音
    await setMuted(conv.key, conv.name, turnOn);
    updateMuteButton();
    const who = conv.name || conv.key.slice(0, 12) + '…';
    log(turnOn ? 'warn' : 'info', turnOn
      ? `已对「${who}」停用机器人，之后不再自动回复该用户（发货不受影响）`
      : `已恢复「${who}」的机器人自动回复`);
  }

  /**
   * 刷新按钮：反映"当前打开的会话"的静音状态。
   * 机器人跑批期间（state.busy）会程序化切换会话，此时不改按钮指向，
   * 避免你看到/点到的是机器人临时打开的别人会话。
   */
  function updateMuteButton() {
    if (state.busy || !state.S) return;  // 配置未加载完(state.S 空)时触发会抛错，直接跳过
    let b = document.getElementById('__xy_mute_btn');
    const act = document.querySelector(state.S && state.S.convActive || '[class*="conversation-item-active--"]');
    const conv = act ? parseConvItem(act) : null;
    const show = conv && conv.key && !SYSTEM_CONV_NAMES.includes(conv.name) &&
                 !!document.querySelector(state.S.msgList);
    if (!show) { if (b) b.style.display = 'none'; return; }
    if (!b) {
      b = document.createElement('div');
      b.id = '__xy_mute_btn';
      b.style.cssText =
        'position:fixed;right:16px;bottom:56px;z-index:99999;padding:7px 14px;' +
        'border-radius:18px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;' +
        'font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.06);';
      b.addEventListener('click', onMuteClick);
      document.body.appendChild(b);
    }
    b.style.display = 'block';
    const muted = isMuted(conv.key);
    const who = conv.name || '该用户';
    b.title = muted ? '当前对此用户已停用机器人，点击恢复自动回复'
                    : '点击后机器人不再自动回复此用户（仅影响聊天回复，不影响自动发货）';
    if (muted) {
      b.style.background = '#fff7ed'; b.style.color = '#b45309';
      b.textContent = `🔔 「${who}」已停用机器人 · 点击恢复`;
    } else {
      b.style.background = '#fff'; b.style.color = '#374151';
      b.textContent = `🔕 对「${who}」停用机器人`;
    }
  }

  // ---------- 飞机推送独立开关（与机器人回复完全无关）----------

  async function onTgToggleClick() {
    if (!extAlive()) {
      markZombie();
      alert('插件刚更新过，本页面脚本已断线，请按 F5 刷新后再操作。');
      return;
    }
    if (!tgConfigured()) {
      alert('还没配置 Telegram：\n插件设置页 → 高级 → 「Telegram 推送」里填 Bot Token 和 Chat ID，保存后这里就能一键开关。');
      return;
    }
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      settings.tgPushEnabled = settings.tgPushEnabled === false; // 取反：关→开 / 开→关
      await chrome.storage.local.set({ settings });
      state.settings.tgPushEnabled = settings.tgPushEnabled;
      updateTgButton();
      log('info', settings.tgPushEnabled ? '飞机推送已开启（有单/发货/告警都会推送）' : '飞机推送已关闭');
    } catch (e) {
      alert('保存失败：' + (e && e.message));
    }
  }

  function updateTgButton() {
    if (!state.S) return;
    let b = document.getElementById('__xy_tg_btn');
    if (!b) {
      b = document.createElement('div');
      b.id = '__xy_tg_btn';
      b.style.cssText =
        'position:fixed;right:16px;bottom:96px;z-index:99999;padding:7px 14px;' +
        'border-radius:18px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;' +
        'font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.06);';
      b.addEventListener('click', onTgToggleClick);
      document.body.appendChild(b);
    }
    if (!tgConfigured()) {
      b.style.background = '#fff'; b.style.color = '#9ca3af';
      b.textContent = '📣 飞机推送：未配置';
      b.title = '在插件设置页 → 高级 填 Bot Token / Chat ID 后即可使用';
    } else if (tgPushOn()) {
      b.style.background = '#eff6ff'; b.style.color = '#1d4ed8';
      b.textContent = '📣 飞机推送：开';
      b.title = '有单/发货/告警会推到你的 Telegram。点击关闭（与机器人回复开关互不影响）';
    } else {
      b.style.background = '#fff'; b.style.color = '#6b7280';
      b.textContent = '📣 飞机推送：关 · 点此开启';
      b.title = '点击开启 Telegram 推送（与机器人回复开关互不影响）';
    }
  }

  // ---------- 自动发货独立开关（与"机器人回复"、"飞机推送"互不影响）----------

  async function onAutoDeliverToggle() {
    if (!extAlive()) {
      markZombie();
      alert('插件刚更新过，本页面脚本已断线，请按 F5 刷新后再操作。');
      return;
    }
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      settings.autoDeliver = settings.autoDeliver === false; // 取反
      await chrome.storage.local.set({ settings });
      state.settings.autoDeliver = settings.autoDeliver;
      updateAutoDeliverButton();
      log('warn', settings.autoDeliver
        ? '自动发货已开启：付款订单将自动发卡'
        : '自动发货已关闭：来单只推送提醒，需你点绿色「发货」按钮手动发（注意别超时）');
    } catch (e) {
      alert('保存失败：' + (e && e.message));
    }
  }

  function updateAutoDeliverButton() {
    if (!state.S) return;
    let b = document.getElementById('__xy_autodeliver_btn');
    if (!b) {
      b = document.createElement('div');
      b.id = '__xy_autodeliver_btn';
      b.style.cssText =
        'position:fixed;right:16px;bottom:136px;z-index:99999;padding:7px 14px;' +
        'border-radius:18px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;' +
        'font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.06);';
      b.addEventListener('click', onAutoDeliverToggle);
      document.body.appendChild(b);
    }
    if (state.settings.autoDeliver !== false) {
      b.style.background = '#f0fdf4'; b.style.color = '#15803d';
      b.textContent = '🚚 自动发货：开';
      b.title = '付款订单自动发卡。点击关闭（改为手动点📦发货，飞机推送不受影响）';
    } else {
      b.style.background = '#fff7ed'; b.style.color = '#b45309';
      b.textContent = '🚚 自动发货：关 · 点此开启';
      b.title = '当前只推送提醒不自动发卡，需手动点📦发货（注意发货时效，超时会被退款）';
    }
  }

  // ---------- 手动发货按钮（给当前打开会话的买家发货）----------

  /**
   * 从订单列表挑出该买家"能安全发货"的订单（纯函数，便于自测）：
   *   forBuyer - 这个买家的所有订单
   *   pending  - 其中"待发货 + 未退款"的（权威状态，不认页面标签）
   *   todo     - pending 里"还没发过货"的（去掉 deliveredMap 命中的），真正要发的
   */
  function pickDeliverableOrders(orders, nick, deliveredMap) {
    const all = Array.isArray(orders) ? orders : [];
    const forBuyer = all.filter(o => o && nickMatch(o.buyerNick, nick)); // 认脱敏
    const pending = forBuyer.filter(o => o.orderStatus === '待发货' && !o.inRefund);
    const todo = pending.filter(o => !(deliveredMap && deliveredMap[o.orderId]));
    return { forBuyer, pending, todo };
  }

  /**
   * 手动发货：给当前打开会话的买家发货。
   * 安全要点（正是你担心的重复发货）：
   *   1. 用交易接口权威判断"有没有待发货订单"，没有就不发（不认页面标签）；
   *   2. 复用与自动发货同一条 deliverOrder 路径 → 共享 orderId 幂等去重、
   *      本地 deliveredOrders 缓存、DOM 发货标记三重去重；
   *   3. deliverBusy 互斥锁：机器人正在自动发 / 你连点两次 → 第二个直接挡下；
   *   4. 后端 /api/deliver 的 orderId 唯一约束是最后兜底，绝不会扣两张卡。
   */
  async function deliverToActiveConversation() {
    // 断线自检：插件重载后旧脚本"拉订单正常、发卡必挂"，症状迷惑性极强，
    // 必须在动手前就拦下并明说，而不是跑到后端调用失败才报含糊错误
    if (!extAlive()) {
      markZombie();
      alert('插件刚更新过，本页面的脚本已断线（拉订单正常但发不了货）。\n请按 F5 刷新工作台页面后，再点「发货」。');
      return;
    }
    const act = document.querySelector(state.S.convActive);
    if (!act) { alert('请先打开一个买家的会话，再点发货'); return; }
    const conv = parseConvItem(act);
    const nick = conv.name;
    if (!nick || SYSTEM_CONV_NAMES.includes(nick)) { alert('请打开一个买家会话再发货'); return; }
    // 前置检查草稿：发卡要往输入框写内容，草稿保护会拒绝覆盖你打的字——
    // 与其跑到最后一步被拦、回滚库存、报一个含糊的"未完成"，不如现在就说清楚
    const ta0 = document.querySelector(state.S.inputBox);
    if (ta0 && ta0.value && ta0.value.trim()) {
      alert('聊天输入框里有一段还没发送的草稿。\n为了不覆盖你打的字，请先把它发出去（或清空），再点「发货」。');
      return;
    }
    const btn = document.getElementById('__xy_deliver_btn');
    const oldText = btn ? btn.textContent : '';
    const restoreBtn = () => { if (btn) { btn.textContent = oldText; btn.style.pointerEvents = ''; btn.style.opacity = ''; } };
    if (btn) { btn.textContent = '⏳ 正在核对订单…'; btn.style.pointerEvents = 'none'; btn.style.opacity = '.7'; }
    try {
      // 关键：查订单是只读的，不占发货锁（订单接口偶尔慢到几秒，占锁会把自己和轮询都拖死）。
      // 只查第一页（当前买家的待发货单必在最前），发卡那一步才需要互斥锁。
      let orders;
      try {
        orders = await bridge.call('fetchWaitShipOrders', { maxPages: 1 }, 15000);
      } catch (e) {
        restoreBtn();
        alert('拉取订单失败：' + (e && e.message) + '\n（订单接口偶尔较慢，请再点一次；确认工作台已登录）');
        return;
      }
      const { forBuyer, pending, todo } = pickDeliverableOrders(orders, nick, state.deliveredOrders);
      // 权威判断：这个买家有没有"待发货且未退款"的订单
      if (!pending.length) {
        restoreBtn();
        if (forBuyer.some(o => o.inRefund))
          alert(`买家「${nick}」的订单正在退款中，未发货。`);
        else
          alert(`买家「${nick}」当前没有「待发货」订单。\n可能是：还没拍下 / 未付款 / 或已经发过货了。`);
        return;
      }
      // 已发过的（缓存里有）过滤掉，避免重复
      if (!todo.length) {
        restoreBtn();
        alert(`买家「${nick}」这些订单都已经发过货了，未重复发送。`); return;
      }
      // 到这里才真正要发卡——现在才抢锁，只在"发送"期间互斥，等待很短（查询已在锁外做完）
      if (btn) btn.textContent = '⏳ 等待发货通道…';
      if (!(await waitFor(() => !state.deliverBusy && !state.busy, 20000))) {
        restoreBtn();
        alert('发货通道一直忙（订单接口较慢），请过几秒再点一次');
        return;
      }
      state.deliverBusy = true;
      if (btn) btn.textContent = '⏳ 正在发货…';
      try {
      // 手动点「发货」本身就是你的确认；脱敏买家不再弹框打扰。
      // 真正的安全网仍在：你已打开该买家会话、pickDeliverableOrders 认脱敏但
      // 多单会走下面的确认、deliverOrder 再按 orderId 幂等去重。
      if (todo.length > 1 &&
          !confirm(`买家「${nick}」有 ${todo.length} 个待发货订单，确认全部发货？`)) return;

        let ok = 0, fail = 0;
        for (const order of todo) {
          await deliverOrder(order, true);               // 与自动发货同一条安全路径；手动点击=明确指令，绕过商品的自动发货开关
          if (state.deliveredOrders[order.orderId]) ok++; else fail++;
          await sleep(rand(600, 1200));
        }
        if (ok && !fail) alert(`✓ 已给「${nick}」发货成功（${ok} 单）`);
        else if (ok && fail) alert(`部分完成：成功 ${ok} 单，${fail} 单未完成（原因见插件弹窗「运行日志」）`);
        else alert(
          '发货未完成，可能原因：\n' +
          '· 输入框有草稿 / 会话被切走 → 发送被安全拦截，库存已自动回滚，处理后再点一次即可\n' +
          '· 点击发送后 5 秒内没在聊天里看到己方消息 → 不算发货成功，未扣卡密，已转人工\n' +
          '· 右侧商品面板没加载出来 → 本次发货已停止，确认面板商品后再发\n' +
          '· 库存缺货 / 没匹配的发货规则 → 需补货或人工发\n' +
          '具体哪一种，点插件图标看「运行日志」最后几条。');
      } finally {
        state.deliverBusy = false;   // 只释放"发送期"的锁（查询本就没占锁）
      }
    } catch (e) {
      log('error', '手动发货异常: ' + (e && e.message));
      alert('发货出错：' + (e && e.message));
    } finally {
      restoreBtn();
    }
  }

  /** 刷新手动发货按钮：打开非系统会话时显示（点击时才做权威订单核对） */
  function updateDeliverButton() {
    // 机器人跑批 / 手动发货正在处理中：都不改按钮文字，
    // 否则每秒一次的刷新会把 deliverToActiveConversation 设置的"⏳ 正在核对订单…"立刻覆盖掉。
    // state.S 未加载完时也跳过（选择器还没就绪）
    if (state.busy || state.deliverBusy || !state.S) return;
    let b = document.getElementById('__xy_deliver_btn');
    const act = document.querySelector(state.S && state.S.convActive || '[class*="conversation-item-active--"]');
    const conv = act ? parseConvItem(act) : null;
    const show = conv && conv.key && !SYSTEM_CONV_NAMES.includes(conv.name) &&
                 !!document.querySelector(state.S.msgList);
    if (!show) { if (b) b.style.display = 'none'; return; }
    if (!b) {
      b = document.createElement('div');
      b.id = '__xy_deliver_btn';
      b.style.cssText =
        'position:fixed;right:16px;bottom:176px;z-index:99999;padding:8px 16px;' +
        'border-radius:18px;font-size:12px;font-weight:700;cursor:pointer;user-select:none;' +
        'font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#16a34a;color:#fff;' +
        'box-shadow:0 2px 10px rgba(22,163,74,.35);';
      b.title = '给当前会话买家发货：会先用交易接口核对确有待发货订单，且不会重复发';
      b.addEventListener('click', deliverToActiveConversation);
      document.body.appendChild(b);
    }
    b.style.display = 'block';
    b.textContent = `📦 给「${conv.name || '该买家'}」发货`;
  }

  // ---------- 入口 ----------

  (async () => {
    bridge.init(); // 建立与主世界桥的通信
    // 等聊天页主体渲染出来（SPA，hash 路由）
    await waitFor(() => document.querySelector(window.__XY_SELECTORS_DEFAULT.convItem) ||
                        location.hash.includes('im'), 30000, 500);
    await loadConfig();
    mountBadge();
    runSelectorAudit(); // 不阻塞主循环；缺选择器会记到 storage，弹窗告警
    // 聊天页两个按钮随你切换会话实时刷新（都独立于助手开关）：
    //   · 免打扰按钮：反映当前会话是否已停用机器人
    //   · 手动发货按钮：给当前会话买家发货（点击时才做权威订单核对+去重）
    const uiTimer = setInterval(() => {
      // 本页脚本一旦成僵尸（插件被重载）就停掉，否则它会用旧状态继续改按钮，
      // 和刷新后的新脚本抢同一个按钮 → 开关来回闪。
      if (!extAlive()) { clearInterval(uiTimer); markZombie(); return; }
      updateMuteButton(); updateDeliverButton(); updateTgButton(); updateAutoDeliverButton();
    }, 1000);
    bindHumanReplyWatch(); // 监听你的手动发送，机器人据此让位
    bindActivityWatch();   // 监听你的鼠标/键盘，你在操作时机器人不抢屏切会话
    keepAlivePort();       // 常连接，降低后台被冻结的概率
    // 掉线守护心跳：只要工作台页面开着就持续上报，页面关闭/登出后心跳自然停止
    heartbeat();
    setInterval(heartbeat, 30000);
    // 主循环常驻：订单监控（自动发货+飞机推送）只要页面开着就一直跑；
    // "机器人回复"是否工作由 state.running（总开关）在 tick 内部分段控制
    state.timer = setInterval(tick, Number(state.settings.pollIntervalMs) || 5000);
    if (state.settings.enabled === true && state.settings.replyEnabled !== false) start();
  })();
})();
