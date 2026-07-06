/**
 * 自测 3：background.js 整文件在沙箱里跑（mock chrome + fetch），
 * 验证 GEN_REPLY 请求组装：temperature=0 不被吃掉、历史合并、角色交替。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(
  'C:/Users/peter1/Desktop/project/seller/extension/background.js', 'utf8');

// ---------- mock chrome ----------
const store = {
  settings: {
    apiKey: 'sk-test', apiBaseUrl: 'https://api.example.com/v1/', model: 'gpt-4o-mini',
    temperature: 0, maxTokens: 300, systemPrompt: '你是客服',
  },
  kb: { knowledgeText: '本店只卖正规卡密', entries: [] },
  stats: {},
};
const msgListeners = [];
let lastFetch = null;
const noop = () => {};
const evt = { addListener: noop };
const sandbox = {
  console,
  chrome: {
    runtime: {
      onInstalled: evt, onStartup: evt, onConnect: evt,
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      getURL: (p) => p,
    },
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (store[k] !== undefined) out[k] = store[k];
          return out;
        },
        set: async (obj) => Object.assign(store, obj),
      },
    },
    alarms: { create: noop, onAlarm: evt },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => {}, onRemoved: evt, create: async () => {} },
    notifications: { create: noop },
  },
  fetch: async (url, opts) => {
    lastFetch = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  好的，在的~  ' } }] }) };
  },
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

let pass = 0, fail = 0;
const eq = (d, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log('  ✓ ' + d); }
  else { fail++; console.log('  ✗ ' + d + '\n      期望 ' + JSON.stringify(e) + '\n      实际 ' + JSON.stringify(a)); }
};
const ok = (d, v) => eq(d, !!v, true);

function genReply(context) {
  return new Promise((resolve) => {
    msgListeners[0]({ type: 'GEN_REPLY', context }, null, resolve);
  });
}

(async () => {
  console.log('\n[K] GEN_REPLY 请求组装');
  const resp = await genReply({
    productTitle: 'HeyGen月卡',
    knowledgeText: '拍下自动发货',
    deliveryInfo: '【已配置自动发货的规格】\n新版(¥169)：有货',
    humanStyle: '买家：在吗\n我：在的哈',
    lastMessage: '有货吗',
    history: [
      { role: 'seller', text: '（上一轮结尾我说的话）' },   // 开头的 assistant 应被裁掉
      { role: 'buyer', text: '在吗' },
      { role: 'buyer', text: '有货吗' },                     // 连续 buyer 应合并
      { role: 'seller', text: '在的' },
      { role: 'buyer', text: '现在拍能秒发吗' },
    ],
  });
  ok('调用成功且回复已 trim', resp.ok && resp.reply === '好的，在的~');
  const body = lastFetch.body;
  eq('temperature=0 原样传（修复前会变 0.5）', body.temperature, 0);
  eq('模型/上限透传', [body.model, body.max_tokens], ['gpt-4o-mini', 300]);
  ok('baseUrl 末尾斜杠被清理', lastFetch.url === 'https://api.example.com/v1/chat/completions');
  ok('Authorization 带 key', lastFetch.headers.Authorization === 'Bearer sk-test');

  const msgs = body.messages;
  eq('第一条是 system', msgs[0].role, 'system');
  ok('system 含店铺知识库', msgs[0].content.includes('拍下自动发货'));
  ok('system 含实时库存口径', msgs[0].content.includes('新版(¥169)：有货'));
  ok('system 含本人风格范本', msgs[0].content.includes('在的哈'));
  ok('system 声明多商品知识互相独立', msgs[0].content.includes('相互独立'));
  ok('system 含跨商品提问规则（问A商品不能拿当前B商品否定）',
    msgs[0].content.includes('买家问的不一定是这个商品') && msgs[0].content.includes('绝不能拿当前商品'));
  ok('system 要求知识库没写的不猜、先确认', msgs[0].content.includes('稍等我确认一下'));
  const convo = msgs.slice(1);
  eq('对话以 user 开头（开头的 assistant 已裁掉）', convo[0].role, 'user');
  eq('连续买家消息合并为一条', convo[0].content, '在吗\n有货吗');
  eq('角色严格交替 user/assistant/user',
    convo.map(m => m.role), ['user', 'assistant', 'user']);

  console.log('\n[L] 边界');
  const r2 = await genReply({ lastMessage: '在吗？', history: [] });
  ok('空历史也能调用（用 lastMessage 兜底）', r2.ok);
  eq('  兜底消息进了 user', lastFetch.body.messages.some(m => m.role === 'user' && m.content === '在吗？'), true);

  store.settings.temperature = undefined;
  await genReply({ lastMessage: 'x', history: [] });
  eq('temperature 未配置 → 默认 0.5', lastFetch.body.temperature, 0.5);

  store.settings.apiKey = '';
  const r3 = await genReply({ lastMessage: 'x', history: [] });
  eq('无 API Key → 明确报错不发请求', r3.ok, false);

  console.log('\n===== background.js: ' + pass + ' 通过, ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
