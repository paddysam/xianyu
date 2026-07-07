/**
 * 后台 Service Worker
 * 职责：
 *  1. 调用 OpenAI 兼容接口生成 AI 回复（在后台调可绕开页面 CSP 限制）
 *  2. 维护运行日志 / 统计数据
 *  3. 首次安装时写入默认配置
 */

const DEFAULT_SETTINGS = {
  enabled: false,               // 总开关
  aiEnabled: true,              // 知识库未命中时是否调用 AI
  learnHumanStyle: true,        // 记录你的手动回复当范本，让 AI 学你的说话风格
  styleSampleCount: 30,         // 每次喂给 AI 的风格范本条数（20~40 较合适，太多费 token 也没必要）
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.5,
  maxTokens: 300,
  systemPrompt:
    '你是一名闲鱼卖家的客服助手，用简短、口语化、友好的中文回复买家。' +
    '只回答与商品和交易有关的问题；不确定的信息不要编造，可以说"稍等我确认一下"。' +
    '不要提及你是 AI。回复控制在 60 字以内。',
  defaultReply: '您好，在的~ 有什么可以帮您？',
  botReplyMark: '（机器人自动回复，稍后本人会跟进）', // 普通自动回复末尾追加的标识，留空则不加
  botReplyMarkPosition: 'suffix',                     // suffix=末尾 / prefix=开头

  // 引流/线下交易 敏感词：命中则 AI 绝不顺着聊，只回一句固定话术（防风控）
  riskKeywords: ['微信', 'vx', 'v信', '威信', 'wx', 'QQ', 'qq', '支付宝', '加我', '私聊', '线下', '直接转', '走咸鱼外', '绕过平台', '别走平台', '出闲鱼', '脱离平台'],
  riskReply: '不好意思哈，为了保障双方权益，我们只在闲鱼平台内交易和沟通哦，其他方式恕不支持~',

  // 转人工：买家消息命中关键词 → 回一句安抚语 + 暂停该会话自动回复，等人工
  humanHandoffKeywords: ['人工客服', '转人工', '人工', '真人', '客服在吗', '找客服'],
  humanHandoffReply: '好的，稍等一下哈~ 马上由本人为您处理，请耐心等待回复😊',
  humanHandoffCooldownMinutes: 180, // 接管后暂停自动回复的时长（分钟），到期自动恢复
  humanTakeoverMinutes: 10,     // 本人手动回复某会话后，这段时间内机器人不打扰（0=关闭该逻辑）
  replyDelayMinMs: 2000,        // 模拟人工：回复前随机延迟
  replyDelayMaxMs: 6000,
  pollIntervalMs: 5000,         // 扫描未读会话的间隔
  pauseWhenUserActive: true,    // 你正在操作工作台时，机器人不切走你正看的会话（输入框有草稿时绝不切）
  userIdleSeconds: 8,           // 停手几秒后判定"你已离手"，机器人恢复处理（越小恢复越快）
  maxRepliesPerConvPerHour: 10, // 防刷屏/防对轰
  keepTabAlive: true,           // 工作台标签被关时，后台自动重开一个（浏览器开着即可，无需一直守着页面）
  autoDeliver: true,            // 自动发货总开关（状态取自交易接口，非页面标签）
  autoConsign: true,            // 发完卡密后自动点订单「发货」（无需物流），推进交易避免超时退款
  consignText: '',              // 发货说明（可留空；随发货一起提交，留个记录）
  // 本地后端（MySQL）：填了就用数据库存卡密/发货记录/知识库，留空则用浏览器本地存储
  backendUrl: '',               // 如 http://127.0.0.1:8788
  backendToken: '',             // 与后端 .env 的 AUTH_TOKEN 一致（后端留空则此处也留空）
  // Telegram 推送：两项都填了才启用；只发给 tgChatId 这一个人（即你自己）
  tgBotToken: '',               // @BotFather 创建机器人给的 token
  tgChatId: '',                 // 你的账号 chat id（先给机器人发条消息才能拿到）
  tgPushEnabled: true,          // 飞机推送开关（独立于机器人回复总开关，聊天页有悬浮按钮可切）
  deliveryDoneMark: '【自动发货】',
  // 全局发货话术模板：商品规则里没单独填模板时使用，{卡密} 为占位符
  deliveryTemplate:
    '感谢购买~ 您的账号信息：\n{卡密}\n' +
    '登录后请及时改密码。有效期30天，7天内失效包补，有问题随时联系我。\n' +
    '确认没问题的话麻烦确认收货哦~',
  selectorOverrides: {}         // 页面改版时可在设置页覆盖选择器
};

const DEFAULT_KB = {
  knowledgeText: '',            // 自由文本知识库，整体拼进 AI 系统提示词
  entries: []                   // [{id, keywords: ['发货','多久'], reply: '拍下后自动发货哦'}]
};

const LOG_LIMIT = 200;

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['settings', 'kb', 'products', 'stats']);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(cur.settings || {}) },
    kb: { ...DEFAULT_KB, ...(cur.kb || {}) },
    products: cur.products || [],   // [{id, match, delivery, note}]
    stats: cur.stats || { repliesSent: 0, deliveriesSent: 0, aiCalls: 0 }
  });
  ensureWatchdog();
});
chrome.runtime.onStartup.addListener(ensureWatchdog);

// ---------- 掉线守护 ----------
// 内容脚本每 30s 发心跳；后台每分钟检查，心跳超时（页面被关/登出/踢下线）→ 桌面通知
const OFFLINE_THRESHOLD_MS = 3 * 60 * 1000;
function ensureWatchdog() {
  try { chrome.alarms.create('xy_watchdog', { periodInMinutes: 1 }); } catch (_) {}
}
ensureWatchdog(); // SW 冷启动也确保存在

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xy_watchdog') { ensureWorkbenchTab().then(checkOffline); pokeTabs(); }
});

// 接受内容脚本的常连接（用于降低标签被浏览器冻结的概率）
chrome.runtime.onConnect.addListener((port) => {
  // 断开回调里必须"读一下" lastError（页面进往返缓存时通道会被 Chrome 掐断），
  // 否则会在扩展错误列表里记一条 Unchecked runtime.lastError
  if (port.name === 'xy-keepalive') port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

/**
 * 后台"戳一戳"：主动让每个工作台标签跑一轮 tick。
 * 后台标签的页面定时器会被浏览器节流甚至冻结，靠后台 SW 的定时闹钟驱动更可靠，
 * 保证标签挂在后台/收起时也能自动回复（受闹钟最小 1 分钟限制）。
 */
async function pokeTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://seller.goofish.com/*', 'https://www.goofish.com/im*']
    });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'TICK_NOW' }); } catch (_) {}
    }
  } catch (_) {}
}

// 标签一被关就立刻补（不用等下一次定时检查），把空窗从最多1分钟缩到几秒
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info && info.isWindowClosing) return; // 你在关整个窗口/浏览器，不打扰
  setTimeout(ensureWorkbenchTab, 2500);     // 稍等一下再查，避开切换时的瞬时空窗
});

// 浏览器启动时，若开着自动客服却没有工作台标签，也自动挂一个
chrome.runtime.onStartup.addListener(() => setTimeout(ensureWorkbenchTab, 4000));

/**
 * 保活：自动客服开着、且没有任何闲鱼工作台标签时，后台静默开一个（不抢焦点）。
 * 这样标签被关了也能在 1 分钟内自动挂回来，浏览器开着即可。
 */
let ensuringTab = false; // 互斥：防止多个触发并发各开一个标签
/** 回复/发货/推送任一在用，就值得保活与掉线守护（回复关了发货推送还要跑） */
function anythingOn(settings) {
  return !!(settings.enabled ||
    settings.autoDeliver !== false ||
    (settings.tgBotToken && settings.tgChatId && settings.tgPushEnabled !== false));
}

async function ensureWorkbenchTab() {
  if (ensuringTab) return;
  ensuringTab = true;
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!anythingOn(settings) || settings.keepTabAlive === false) return;
    const tabs = await chrome.tabs.query({
      url: ['https://seller.goofish.com/*', 'https://www.goofish.com/im*']
    });
    if (tabs.length > 0) return; // 已有工作台标签
    await chrome.tabs.create({
      url: 'https://seller.goofish.com/?site=COMMONPRO#/im',
      active: false, // 不抢焦点、不切过去
      pinned: true   // 固定标签：标签栏最左一个窄图标，省地方、不易误关，且回复及时
    });
    notify('🔄 已自动挂起工作台', '闲鱼工作台标签被关了，已在标签栏最左固定一个（小图标）继续自动回复/发货。如需停止请关闭插件总开关。');
  } catch (_) { /* 无 tabs 权限或异常时忽略 */ } finally {
    ensuringTab = false;
  }
}

async function onHeartbeat() {
  const { watchdog = {} } = await chrome.storage.local.get('watchdog');
  await chrome.storage.local.set({ heartbeat: { ts: Date.now() } });
  // 页面恢复：清除告警标记，并提示恢复
  if (watchdog.warned) {
    await chrome.storage.local.set({ watchdog: { warned: false } });
    notify('✓ 工作台已恢复', '检测到卖家工作台重新在线，自动客服可继续工作');
  }
}

async function checkOffline() {
  const { settings = {}, heartbeat, watchdog = {} } =
    await chrome.storage.local.get(['settings', 'heartbeat', 'watchdog']);
  if (!anythingOn(settings)) return; // 回复/发货/推送全关着才不管
  const last = (heartbeat && heartbeat.ts) || 0;
  const stale = Date.now() - last > OFFLINE_THRESHOLD_MS;
  if (stale && !watchdog.warned) {
    notify('⚠️ 工作台掉线', '闲鱼卖家工作台页面已关闭或掉线，自动客服已停止！买家付款可能无人发货，请尽快重新打开并登录。');
    await chrome.storage.local.set({ watchdog: { warned: true } });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GEN_REPLY':
          sendResponse(await genReply(msg));
          break;
        case 'LOG':
          await appendLog(msg.entry);
          sendResponse({ ok: true });
          break;
        case 'BUMP_STAT':
          await bumpStat(msg.key);
          sendResponse({ ok: true });
          break;
        case 'NOTIFY':
          notify(msg.title, msg.message);
          sendResponse({ ok: true });
          break;
        case 'TG_PUSH':
          sendResponse(await pushTelegram(msg.text));
          break;
        case 'BACKEND_FETCH':
          sendResponse(await backendFetch(msg));
          break;
        case 'HEARTBEAT':
          await onHeartbeat();
          sendResponse({ ok: true });
          break;
        case 'GET_DEFAULTS':
          sendResponse({ settings: DEFAULT_SETTINGS, kb: DEFAULT_KB });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});

/**
 * 生成回复：调用 OpenAI 兼容 /chat/completions
 * msg: { context: {buyerName, productTitle, history: [{role,text}], lastMessage} }
 */
async function genReply(msg) {
  const { settings, kb } = await chrome.storage.local.get(['settings', 'kb']);
  if (!settings.apiKey) {
    return { ok: false, error: '未配置 API Key，请在设置页填写' };
  }

  const ctx = msg.context || {};
  const messages = [];

  let sys = settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;
  // 优先用内容脚本传来的知识库文本（后端模式下知识库在数据库里），否则用本地存储的
  const knowledgeText = (ctx.knowledgeText !== undefined && ctx.knowledgeText !== null)
    ? ctx.knowledgeText : (kb && kb.knowledgeText);
  if (knowledgeText) {
    sys += '\n\n【店铺知识库 · 最高事实依据】店里同时在售多个互不相关的商品' +
      '（如 HeyGen、Figma、Cursor 等），知识库里各商品的信息相互独立、不可混用：\n' + knowledgeText;
  }
  if (ctx.productTitle) {
    sys += '\n\n当前聊天窗关联的商品：' + ctx.productTitle +
      '\n注意：买家问的不一定是这个商品。若买家在问题里明确提到了店里另一个商品或其功能' +
      '（以买家用词为准，如问"figma 支持 make 吗"就是在问 Figma），' +
      '必须按知识库中【那个商品】的条目如实回答，绝不能拿当前商品的情况去回答或否定另一个商品。' +
      '知识库里没写的功能细节不要猜、不要否定，回复"稍等我确认一下哈"。';
  }
  if (ctx.humanStyle) {
    sys += '\n\n【模仿本人风格】以下是卖家本人过去真实回复的例子。请学习这种语气、用词、称呼、口头禅和答法，' +
      '回复要像本人平时那样自然、简洁，不要更啰嗦或更客套。仅学"怎么说话"，具体内容仍以知识库和实际情况为准：\n' + ctx.humanStyle;
  }
  if (ctx.deliveryInfo) {
    sys += '\n\n【发货方式与库存】买家若问“能不能自动发货/是不是秒发/发货快不快/有没有货/现在拍能不能发”，' +
      '必须严格依据下面的信息回答：\n' +
      '· 支持自动发货且有货的规格 → 明确说“这个可以自动发货，拍下秒到”；\n' +
      '· 暂时缺货、或标注为人工发货的规格 → 如实说“这个需要人工发，稍后本人尽快处理”，不要催他拍；\n' +
      '· 买家问的规格如果不在下面列表里 → 说明该规格是人工发货；\n' +
      '· 不要报出具体剩余数字，不要承诺缺货或没配置自动发货的规格。\n' + ctx.deliveryInfo;
  }
  messages.push({ role: 'system', content: sys });

  // 最近对话作为上下文（买家=user，卖家=assistant）。取最近 20 条，接得住长对话。
  // 合并连续同角色的消息（闲鱼常连发多条），避免部分中转接口拒绝"非交替角色"。
  const convo = [];
  for (const h of (ctx.history || []).slice(-20)) {
    const role = h.role === 'seller' ? 'assistant' : 'user';
    const prev = convo[convo.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + h.text;
    else convo.push({ role, content: h.text });
  }
  // 去掉开头多余的 assistant（对话应以买家 user 开头）
  while (convo.length && convo[0].role === 'assistant') convo.shift();
  for (const m of convo) messages.push(m);
  if (!messages.some(m => m.role === 'user')) {
    messages.push({ role: 'user', content: ctx.lastMessage || '你好' });
  }

  const base = (settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/+$/, '');
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.apiKey
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_SETTINGS.model,
      // 不能用 ||：temperature 填 0 是合法值，会被 || 顶成 0.5
      temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.5,
      max_tokens: Number(settings.maxTokens) || 300,
      messages
    })
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `AI 接口 ${resp.status}: ${body.slice(0, 200)}` };
  }
  const data = await resp.json();
  const text = data && data.choices && data.choices[0] &&
               data.choices[0].message && data.choices[0].message.content;
  if (!text) return { ok: false, error: 'AI 返回为空' };

  await bumpStat('aiCalls');
  return { ok: true, reply: text.trim() };
}

async function appendLog(entry) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push({ ts: Date.now(), ...entry });
  while (logs.length > LOG_LIMIT) logs.shift();
  await chrome.storage.local.set({ logs });
}

async function bumpStat(key) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  stats[key] = (stats[key] || 0) + 1;
  await chrome.storage.local.set({ stats });
}

/**
 * 代前端向本地/远程后端发请求（后台 SW 不受页面混合内容限制）。
 * 返回 { ok:true, data } 或 { ok:false, error }。
 */
async function backendFetch(msg) {
  try {
    const base = String(msg.url || '').replace(/\/+$/, '');
    if (!base) return { ok: false, error: '未配置后端地址' };
    const headers = { 'Content-Type': 'application/json' };
    if (msg.token) headers['X-Auth-Token'] = msg.token;
    const resp = await fetch(base + msg.path, {
      method: msg.method || 'GET',
      headers,
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined
    });
    let data;
    try { data = await resp.json(); } catch (_) { data = { ok: false, error: '后端返回非 JSON' }; }
    if (!resp.ok || (data && data.ok === false)) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + resp.status) };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title || '闲鱼智能客服',
      message: message || '',
      priority: 2
    });
  } catch (_) { /* 通知权限被拒时忽略 */ }
  // 桌面通知同时抄送 Telegram（配置了才发）——离开电脑也能收到"需人工/掉线"提醒
  pushTelegram((title || '闲鱼智能客服') + '\n' + (message || '')).catch(() => {});
}

/**
 * 推送到 Telegram（只发给 settings.tgChatId 这一个账号）。
 * 纯文本，不带任何按钮（手机上没有插件环境，工作台链接没用）。
 * 未配置 token/chatId 时静默跳过。返回 { ok, error? }
 */
async function pushTelegram(text) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const token = (settings.tgBotToken || '').trim();
  const chatId = String(settings.tgChatId || '').trim();
  if (!token || !chatId) return { ok: false, error: '未配置 Telegram' };
  if (settings.tgPushEnabled === false) return { ok: false, error: '飞机推送已关闭' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || '').slice(0, 3800)
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      return { ok: false, error: (data && data.description) || ('HTTP ' + resp.status) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
