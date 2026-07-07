/** 设置页逻辑 */

const $ = (id) => document.getElementById(id);

const SETTING_FIELDS = [
  'apiBaseUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'systemPrompt',
  'defaultReply', 'replyDelayMinMs', 'replyDelayMaxMs', 'pollIntervalMs',
  'maxRepliesPerConvPerHour', 'styleSampleCount', 'deliveryDoneMark', 'deliveryTemplate',
  'botReplyMark', 'botReplyMarkPosition',
  'humanHandoffReply', 'humanHandoffCooldownMinutes', 'humanTakeoverMinutes',
  'backendUrl', 'backendToken', 'consignText', 'riskReply', 'tgBotToken', 'tgChatId'
];
const NUM_FIELDS = new Set([
  'temperature', 'maxTokens', 'replyDelayMinMs', 'replyDelayMaxMs',
  'pollIntervalMs', 'maxRepliesPerConvPerHour', 'humanHandoffCooldownMinutes',
  'humanTakeoverMinutes', 'styleSampleCount'
]);

let kbEntries = [];
let products = [];
let deliveredOrders = {};
const stockExpanded = new Set(); // 库存表里展开了详情的行索引

let backendMode = false;         // 是否用后端（MySQL）作为数据源
let deletedProductIds = [];      // 后端模式下待删除的规则 id（保存时提交）

// 后端客户端：读取当前表单里的地址/令牌
const backend = window.__XY_makeBackend(() => ({
  url: $('backendUrl') && $('backendUrl').value.trim(),
  token: $('backendToken') && $('backendToken').value.trim()
}));

// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('tab-' + t.dataset.tab).classList.add('active');
}));

// ---------- 载入 ----------
async function load() {
  const { settings = {}, kb = {}, products: prods = [], deliveredOrders: dOrders = {} } =
    await chrome.storage.local.get(['settings', 'kb', 'products', 'deliveredOrders']);

  for (const f of SETTING_FIELDS) {
    if ($(f) && settings[f] !== undefined) $(f).value = settings[f];
  }
  $('aiEnabled').checked = settings.aiEnabled !== false;
  $('learnHumanStyle').checked = settings.learnHumanStyle !== false;
  $('autoDeliver').checked = settings.autoDeliver !== false;
  $('autoConsign').checked = settings.autoConsign !== false;
  $('keepTabAlive').checked = settings.keepTabAlive !== false;
  $('riskKeywords').value = (settings.riskKeywords || []).join(',');
  $('humanHandoffKeywords').value = (settings.humanHandoffKeywords || []).join(',');
  $('selectorOverrides').value = settings.selectorOverrides &&
    Object.keys(settings.selectorOverrides).length
      ? JSON.stringify(settings.selectorOverrides, null, 2) : '';

  deliveredOrders = dOrders;
  backendMode = backend.enabled();

  if (backendMode) {
    // 后端模式：规则 + 知识库从数据库读
    try {
      const [pr, kbData] = await Promise.all([backend.listProducts(), backend.getKb()]);
      products = (pr.products || []).map(mapBackendProduct);
      kbEntries = kbData.entries || [];
      $('knowledgeText').value = kbData.knowledgeText || '';
      $('backendResult').className = '';
      $('backendResult').textContent = '✓ 已连接数据库，数据来自 MySQL';
    } catch (e) {
      backendMode = false; // 连接失败退回本地，避免误操作
      products = prods;
      kbEntries = kb.entries || [];
      $('knowledgeText').value = kb.knowledgeText || '';
      $('backendResult').className = 'err';
      $('backendResult').textContent = '✗ 后端连接失败，暂用本地存储：' + e.message;
    }
  } else {
    products = prods;
    kbEntries = kb.entries || [];
    $('knowledgeText').value = kb.knowledgeText || '';
  }
  deletedProductIds = [];
  renderKb();
  renderProds();
  renderStock();
}

/** 后端返回的规则行 → 前端统一结构 */
function mapBackendProduct(r) {
  return {
    id: r.id, match: r.match_title || '', spec: r.spec || '', price: r.price || '',
    mode: r.mode || 'pool', delivery: r.delivery || '', note: r.note || '',
    cards: [],                    // 后端模式卡密不内联，走库存页补货
    stock: Number(r.stock || 0), sold: Number(r.sold || 0)
  };
}

// 测试后端连接
$('testBackend').addEventListener('click', async () => {
  const res = $('backendResult');
  res.className = '';
  if (!$('backendUrl').value.trim()) { res.textContent = '未填地址 = 使用浏览器本地存储'; return; }
  res.textContent = '连接中…';
  try {
    const h = await backend.health();
    if (h.db && h.db !== 'ok') {
      res.className = 'err';
      res.textContent = '后端在线，但数据库异常：' + h.db + '（请检查 server 的 .env 与 init-db）';
    } else {
      res.className = '';
      res.textContent = '✓ 连接正常，数据库就绪。保存后即切换到数据库存储。';
    }
  } catch (e) {
    res.className = 'err';
    res.textContent = '✗ 连不上后端：' + e.message + '（确认已 node server.js 启动）';
  }
});

// 库存/发货由内容脚本实时写入 storage，这里同步刷新总览表
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // 后端模式下 products 来自数据库，不能被本地 storage 的旧 products 覆盖
    if (changes.products && !backendMode) { products = changes.products.newValue || []; renderProds(); renderStock(); }
    if (changes.deliveredOrders) { deliveredOrders = changes.deliveredOrders.newValue || {}; renderStock(); }
  });
}

// ---------- 知识库条目 ----------
function renderKb() {
  const box = $('kbList');
  box.innerHTML = '';
  kbEntries.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'kb-entry';
    div.innerHTML = `
      <button class="del" data-i="${i}">删除</button>
      <label>关键词（逗号分隔）<input class="kb-kw" data-i="${i}"></label>
      <label>回复内容<textarea class="kb-reply" data-i="${i}" rows="2"></textarea></label>`;
    div.querySelector('.kb-kw').value = (e.keywords || []).join(',');
    div.querySelector('.kb-reply').value = e.reply || '';
    box.appendChild(div);
  });
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    kbEntries.splice(Number(b.dataset.i), 1);
    renderKb();
  }));
  box.querySelectorAll('.kb-kw').forEach(inp => inp.addEventListener('input', () => {
    kbEntries[Number(inp.dataset.i)].keywords =
      inp.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  }));
  box.querySelectorAll('.kb-reply').forEach(inp => inp.addEventListener('input', () => {
    kbEntries[Number(inp.dataset.i)].reply = inp.value;
  }));
}
$('addKb').addEventListener('click', () => {
  kbEntries.push({ id: Date.now(), keywords: [], reply: '' });
  renderKb();
});

// ---------- 商品发货规则 ----------
function renderProds() {
  const box = $('prodList');
  box.innerHTML = '';
  products.forEach((p, i) => {
    const isPool = p.mode === 'pool';
    const stock = backendMode ? (p.stock || 0) : (p.cards || []).filter(c => c.trim()).length;
    const div = document.createElement('div');
    div.className = 'prod-entry';
    div.innerHTML = `
      <button class="del" data-i="${i}">删除</button>
      <label>商品标题匹配（包含即命中，如"HeyGen"）<input class="p-match" data-i="${i}"></label>
      <div class="row">
        <label>规格（精确匹配，如"新版"；留空=不限规格）<input class="p-spec" data-i="${i}"></label>
        <label>价格（精确匹配，如"169.00"；留空=不限价格）<input class="p-price" data-i="${i}"></label>
      </div>
      <label>发货方式
        <select class="p-mode" data-i="${i}">
          <option value="fixed">固定内容（每单发同样的文本，适合网盘链接/教程）</option>
          <option value="pool">卡密库存（每单发一条并扣库存，适合账号/兑换码）</option>
        </select>
      </label>
      <label class="p-delivery-label">${isPool
        ? '发货话术模板（用 {卡密} 占位；留空则用「行为设置」里的全局模板）'
        : '发货内容（链接/说明，付款后原样发送）'}
        <textarea class="p-delivery" data-i="${i}" rows="3"></textarea>
      </label>
      ${isPool ? `
      <div class="p-cards-hint">
        卡密库存：<b style="color:${stock <= 2 ? '#c00' : '#00a35c'}">${stock} 条</b>
        —— 卡密的查看和补货都在「库存总览」页
      </div>` : ''}
      <label>备注（仅自己看）<input class="p-note" data-i="${i}"></label>`;
    div.querySelector('.p-match').value = p.match || '';
    div.querySelector('.p-spec').value = p.spec || '';
    div.querySelector('.p-price').value = p.price || '';
    div.querySelector('.p-mode').value = p.mode || 'fixed';
    div.querySelector('.p-delivery').value = p.delivery || '';
    div.querySelector('.p-note').value = p.note || '';
    box.appendChild(div);
  });
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    const removed = products.splice(Number(b.dataset.i), 1)[0];
    if (removed && typeof removed.id === 'number') deletedProductIds.push(removed.id); // 后端已存在的，保存时删库
    renderProds();
    renderStock();
  }));
  const bind = (cls, key) => box.querySelectorAll(cls).forEach(inp =>
    inp.addEventListener('input', () => { products[Number(inp.dataset.i)][key] = inp.value; }));
  bind('.p-match', 'match');
  bind('.p-spec', 'spec');
  bind('.p-price', 'price');
  bind('.p-delivery', 'delivery');
  bind('.p-note', 'note');
  box.querySelectorAll('.p-mode').forEach(sel => sel.addEventListener('change', () => {
    products[Number(sel.dataset.i)].mode = sel.value;
    renderProds(); // 切换模式重绘，更新库存提示
  }));
}
$('addProd').addEventListener('click', () => {
  products.push({ id: 'new_' + Date.now(), match: '', spec: '', price: '', mode: 'fixed', delivery: '', cards: [], note: '' });
  renderProds();
  renderStock();
});

// ---------- 从接口识别商品规格 ----------
// 直接在工作台页面里执行（MAIN 世界），复用页面已登录的 mtop 库，
// 不依赖内容脚本是否注入，避免"Receiving end does not exist"。
$('loadSkus').addEventListener('click', async () => {
  const res = $('skuResult');
  res.className = '';
  res.textContent = '识别中…';
  try {
    const tabs = await chrome.tabs.query({ url: ['https://seller.goofish.com/*', 'https://www.goofish.com/*'] });
    if (!tabs.length) {
      res.className = 'err';
      res.textContent = '未找到闲鱼卖家工作台标签页，请先在浏览器打开并登录 seller.goofish.com';
      return;
    }
    let injResult;
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: 'MAIN',
        func: fetchSkusInPage
      });
      injResult = inj && inj.result;
    } catch (injErr) {
      res.className = 'err';
      res.textContent = '无法访问工作台页面：' + injErr.message + '（请点开工作台标签页确认已登录，再重试）';
      return;
    }
    if (!injResult || !injResult.ok) {
      res.className = 'err';
      res.textContent = '识别失败：' + (injResult && injResult.error || '页面未就绪') + '（请在工作台标签页确认已登录后重试）';
      return;
    }
    renderSkuPicker(injResult.skus || []);
    if (!injResult.skus.length) {
      res.textContent = '接口暂无可识别的规格（可能近期没有订单），可先手动添加规则';
    } else {
      res.textContent = `识别到 ${injResult.skus.length} 个商品规格，点「配置发货」即可添加`;
    }
  } catch (e) {
    res.className = 'err';
    res.textContent = '识别失败：' + e.message;
  }
});

/** 注入到工作台页面主世界执行：调订单接口，返回去重后的「商品+规格+价格」 */
function fetchSkusInPage() {
  return (async () => {
    try {
      if (!(window.lib && window.lib.mtop && window.lib.mtop.request)) {
        return { ok: false, error: '页面未就绪或不是卖家工作台，请在 seller.goofish.com 已登录页面上操作' };
      }
      const res = await window.lib.mtop.request({
        api: 'mtop.taobao.idle.trade.merchant.sold.get',
        v: '1.0',
        data: { tabCode: 'waitSellerSend', pageNumber: 1, pageSize: 50 }
      });
      if (!(res && res.ret && String(res.ret[0] || '').includes('SUCCESS'))) {
        return { ok: false, error: '订单接口返回异常：' + (res && res.ret) };
      }
      let arr = null;
      (function f(o, d) {
        if (!o || typeof o !== 'object' || d > 6 || arr) return;
        if (Array.isArray(o) && o.length && o[0] && o[0].commonData) { arr = o; return; }
        for (const k in o) if (o[k] && typeof o[k] === 'object') f(o[k], d + 1);
      })(res.data, 0);
      const seen = new Map();
      for (const o of (arr || [])) {
        const iv = o.itemVO || {}, pv = o.priceVO || {};
        const lines = [];
        (function w(x) {
          if (!x) return;
          if (Array.isArray(x)) { x.forEach(w); return; }
          if (typeof x === 'object') for (const k in x) {
            const v = x[k];
            if (typeof v === 'string' && v.trim()) lines.push(v.trim());
            else if (typeof v === 'object') w(v);
          }
        })(iv.itemInfoLines);
        let spec = '';
        const gi = lines.indexOf('规格');
        if (gi >= 0 && lines[gi + 1]) spec = lines[gi + 1];
        const price = String(pv.auctionPrice || pv.totalPrice || '');
        const title = String(iv.title || '');
        const key = title + '|' + spec + '|' + price;
        if (title && !seen.has(key)) seen.set(key, { title, spec, price });
      }
      return { ok: true, skus: [...seen.values()] };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  })();
}

function renderSkuPicker(skus) {
  const box = $('skuPicker');
  if (!skus.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="sku-grid"></div>';
  const grid = box.querySelector('.sku-grid');
  skus.forEach(s => {
    const already = products.some(p =>
      p.match && s.title.includes(p.match) &&
      (!p.spec || p.spec === s.spec) && (!p.price || String(p.price) === String(s.price)));
    const chip = document.createElement('div');
    chip.className = 'sku-chip';
    chip.innerHTML = `
      <div class="sku-info">
        <b>${escapeHtml(s.title)}</b>
        <span>${s.spec ? escapeHtml(s.spec) : '默认规格'} · ¥${escapeHtml(s.price || '?')}</span>
      </div>
      <button class="btn secondary sku-add" ${already ? 'disabled' : ''}>${already ? '已配置' : '配置发货'}</button>`;
    chip.querySelector('.sku-add').addEventListener('click', () => {
      products.push({
        id: 'new_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        match: s.title, spec: s.spec || '', price: s.price || '',
        mode: 'pool', delivery: '', cards: [], note: ''
      });
      renderProds();
      renderStock();
      renderSkuPicker(skus); // 刷新"已配置"状态
      // 滚动到新加的规则
      $('prodList').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    grid.appendChild(chip);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 库存总览 ----------

/** 统计某规则累计已发货单数（从 deliveredOrders 里按 标题+规格+价格 匹配） */
function countSold(p) {
  let n = 0;
  for (const id in deliveredOrders) {
    const d = deliveredOrders[id] || {};
    if (!p.match || !(d.title || '').includes(p.match)) continue;
    if (p.spec && (d.spec || '') !== p.spec) continue;
    if (p.price && String(d.price || '') !== String(p.price)) continue;
    n++;
  }
  return n;
}

function stockLevelClass(n) {
  if (n <= 2) return 'lvl-low';
  if (n <= 5) return 'lvl-mid';
  return 'lvl-ok';
}

function renderStock() {
  const box = $('stockTable');
  const summary = $('stockSummary');
  if (!box) return;

  if (!products.length) {
    box.innerHTML = '<div class="stock-empty">还没有配置任何商品。点下方「添加新商品 / 规格」，或到「商品发货」页用「从接口识别我的商品规格」一键添加。</div>';
    if (summary) summary.textContent = '';
    return;
  }

  let totalStock = 0, totalSold = 0, poolCount = 0;
  const rows = products.map((p, i) => {
    const isPool = (p.mode || 'fixed') === 'pool';
    const stock = isPool
      ? (backendMode ? (p.stock || 0) : (p.cards || []).filter(c => c.trim()).length)
      : null;
    const sold = backendMode ? (p.sold || 0) : countSold(p);
    totalSold += sold;
    if (isPool) { totalStock += stock; poolCount++; }

    const name = escapeHtml(p.match || '(未命名)');
    const spec = p.spec ? escapeHtml(p.spec) : '<span class="muted">不限</span>';
    const price = p.price ? '¥' + escapeHtml(p.price) : '<span class="muted">不限</span>';
    const stockCell = isPool
      ? `<span class="stock-badge ${stockLevelClass(stock)}">${stock}</span>`
      : '<span class="muted">固定内容</span>';
    const expanded = stockExpanded.has(i);

    let detail = '';
    if (expanded) {
      // 卡密库存：每张一行，带「已手动发货·移除」按钮（你在别处手动发了某张卡时点它，扣掉库存防止重复自动发）
      let cardListHtml = '';
      if (isPool) {
        if (backendMode) {
          if (p._cardsErr) cardListHtml = `<div class="stock-empty">读取失败：${escapeHtml(p._cardsErr)}</div>`;
          else if (!p._cards) cardListHtml = '<div class="stock-empty">加载中…</div>';
          else if (!p._cards.length) cardListHtml = '<div class="stock-empty">（暂无在库卡密，去右侧补货）</div>';
          else cardListHtml = p._cards.map(c =>
            `<div class="sd-card-row">
               <span class="mono sd-card-text">${escapeHtml(c.secret)}</span>
               <button class="link-btn sd-del-card" data-i="${i}" data-cid="${c.id}" style="color:#c0392b">已手动发货·移除</button>
             </div>`).join('');
        } else {
          const cards = (p.cards || []).map((sec, ci) => ({ sec, ci })).filter(x => x.sec && x.sec.trim());
          if (!cards.length) cardListHtml = '<div class="stock-empty">（暂无在库卡密，去右侧补货）</div>';
          else cardListHtml = cards.map(x =>
            `<div class="sd-card-row">
               <span class="mono sd-card-text">${escapeHtml(x.sec)}</span>
               <button class="link-btn sd-del-card" data-i="${i}" data-ci="${x.ci}" style="color:#c0392b">已手动发货·移除</button>
             </div>`).join('');
        }
      }
      detail = `
        <tr class="stock-detail-row"><td colspan="6">
          <div class="stock-detail">
            <div class="sd-block">
              <label>${isPool ? '当前库存卡密（点「已手动发货·移除」扣掉你在别处手动发出的那张）' : '发货内容（只读）'}</label>
              ${isPool
                ? `<div class="sd-card-list">${cardListHtml}</div>`
                : `<textarea rows="4" readonly class="mono">${escapeHtml(p.delivery || '（发货内容在「商品发货」页配置）')}</textarea>`}
            </div>
            ${isPool ? `
            <div class="sd-block">
              <label>补货：粘贴新卡密，一行一条
                <textarea rows="4" class="mono sd-restock" data-i="${i}" placeholder="账号1----密码1&#10;账号2----密码2"></textarea>
              </label>
              <button class="btn primary sd-restock-btn" data-i="${i}">确认补货</button>
            </div>` : ''}
          </div>
        </td></tr>`;
    }

    return `
      <tr>
        <td>${name}</td>
        <td>${spec}</td>
        <td>${price}</td>
        <td class="ta-center">${stockCell}</td>
        <td class="ta-center">${sold}</td>
        <td class="ta-right">
          <button class="link-btn sd-toggle" data-i="${i}">${expanded ? '收起' : (isPool ? '查看 / 补货' : '查看')}</button>
        </td>
      </tr>${detail}`;
  }).join('');

  box.innerHTML = `
    <div class="stock-table-wrap">
      <table class="stock-table">
        <thead><tr>
          <th>商品</th><th>规格</th><th>价格</th>
          <th class="ta-center">剩余库存</th><th class="ta-center">累计已发</th><th class="ta-right">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  if (summary) {
    summary.innerHTML = `共 <b>${products.length}</b> 个规格 · 库存合计 <b>${totalStock}</b> 个（${poolCount} 个走库存）· 累计已发 <b>${totalSold}</b> 单`;
  }

  box.querySelectorAll('.sd-toggle').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i);
    const opening = !stockExpanded.has(i);
    opening ? stockExpanded.add(i) : stockExpanded.delete(i);
    renderStock();
    // 后端模式：展开时按需拉取该规则的在库卡密明细
    if (opening && backendMode && typeof products[i].id === 'number' && (products[i].mode || 'pool') === 'pool' && !products[i]._cards) {
      try {
        const r = await backend.listCards(products[i].id);
        // 保留卡 id（移除时按 id 精确删，避免删错同名/相似卡）
        products[i]._cards = (r.cards || []).map(c => ({ id: c.id, secret: c.secret }));
        products[i]._cardsErr = null;
      } catch (e) {
        products[i]._cardsErr = e.message;
      }
      if (stockExpanded.has(i)) renderStock();
    }
  }));

  // 「已手动发货·移除」：把某张卡从库存扣掉（后端置 used / 本地删数组），机器人不会再自动发它
  box.querySelectorAll('.sd-del-card').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i);
    const p = products[i];
    if (!confirm('确认这张卡已经手动发出、从库存移除？\n移除后机器人不会再把它自动发给别人（此操作不可撤销）。')) return;
    // 立刻禁用防连点：本地模式按索引删，连点两次第二下会删错另一张卡；
    // 后端模式连点会把 stock/sold 计数重复加减
    b.disabled = true;
    if (backendMode) {
      const cid = Number(b.dataset.cid);
      let r;
      try {
        r = await backend.manualDeliverCard(p.id, cid);
      } catch (e) { alert('移除失败：' + e.message); b.disabled = false; return; }
      p._cards = (p._cards || []).filter(c => c.id !== cid);
      if (r.status === 'removed') {
        p.stock = Math.max(0, (p.stock || 0) - 1);
        p.sold = (p.sold || 0) + 1;
      } else if (r.status === 'alreadyUsed') {
        // 可能刚被自动发货用掉：不再在库是事实，但发货记录已有，不重复计
        p.stock = Math.max(0, (p.stock || 0) - 1);
        alert('这张卡已是「已用」状态（可能刚被自动发货用掉），已从列表移除，未重复记账。');
      } else if (r.status === 'notFound') {
        alert('这张卡在数据库里已不存在，已从列表移除。');
      }
    } else {
      const ci = Number(b.dataset.ci);
      p.cards = (p.cards || []).filter((_, idx) => idx !== ci);
      await chrome.storage.local.set({ products });
    }
    renderStock();
    renderProds();
  }));
  box.querySelectorAll('.sd-restock-btn').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i);
    const ta = box.querySelector(`.sd-restock[data-i="${i}"]`);
    const added = (ta.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!added.length) return;
    if (backendMode) {
      const p = products[i];
      // 新加的规则 id 还是临时字符串（new_...），先建进数据库拿真实数字 id 再补货
      if (typeof p.id !== 'number') {
        if (!p.match || !p.match.trim()) {
          alert('请先在「商品发货」页填写该商品的标题，再补货');
          return;
        }
        try {
          const r = await backend.createProduct({
            match: p.match, spec: p.spec, price: p.price,
            mode: p.mode, delivery: p.delivery, note: p.note
          });
          p.id = r.id;
        } catch (e) { alert('建立商品失败：' + e.message); return; }
      }
      try {
        await backend.restock(p.id, added);
        p.stock = (p.stock || 0) + added.length;
        p._cards = [...(p._cards || []), ...added]; // 同步明细缓存
      } catch (e) { alert('补货失败：' + e.message); return; }
    } else {
      products[i].cards = [...(products[i].cards || []), ...added];
      await chrome.storage.local.set({ products }); // 本地即时生效
    }
    renderStock();
    renderProds();
  }));
}

$('addProdFromStock').addEventListener('click', () => {
  // 切到「商品发货」页并新增一条，方便填写完整规则
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  document.querySelector('[data-tab="products"]').classList.add('active');
  $('tab-products').classList.add('active');
  $('addProd').click();
  $('prodList').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ---------- 保存 ----------
$('save').addEventListener('click', async () => {
  const res = $('saveResult');
  try {
    // 清理空白商品规则（点了"添加"但啥都没填的行）——不清会以"(未命名)"垃圾行入库：
    //   · 全空 → 直接丢弃；已经在数据库里的（有数字id）加入待删除，顺带自愈历史脏数据
    //   · 填了内容但没填标题 → 拦下保存并提示，绝不静默丢用户填的东西
    const halfFilled = [];
    products = products.filter(p => {
      if (p.match && p.match.trim()) return true;
      const hasContent = (p.delivery && p.delivery.trim()) || (p.note && p.note.trim()) ||
        (p.spec && String(p.spec).trim()) || (p.price && String(p.price).trim()) ||
        (p.cards || []).some(c => c && c.trim());
      if (hasContent) { halfFilled.push(p); return true; }
      if (typeof p.id === 'number') deletedProductIds.push(p.id);
      return false;
    });
    if (halfFilled.length) {
      throw new Error(`有 ${halfFilled.length} 条商品规则填了内容但没填「商品标题匹配」，请到「商品发货」页补上标题（或清空该条）再保存`);
    }
    const { settings = {} } = await chrome.storage.local.get('settings');
    for (const f of SETTING_FIELDS) {
      if (!$(f)) continue;
      if (NUM_FIELDS.has(f)) {
        const raw = $(f).value.trim();
        if (raw === '') { delete settings[f]; continue; } // 留空 = 恢复该项默认值
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`「${f}」必须填数字（当前是：${raw}）`);
        settings[f] = n;
      } else {
        settings[f] = $(f).value;
      }
    }
    settings.aiEnabled = $('aiEnabled').checked;
    settings.learnHumanStyle = $('learnHumanStyle').checked;
    settings.autoDeliver = $('autoDeliver').checked;
    settings.autoConsign = $('autoConsign').checked;
    settings.keepTabAlive = $('keepTabAlive').checked;
    settings.riskKeywords =
      $('riskKeywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    settings.humanHandoffKeywords =
      $('humanHandoffKeywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const so = $('selectorOverrides').value.trim();
    settings.selectorOverrides = so ? JSON.parse(so) : {};

    // 设置永远存本地（后端地址本身也在这里）
    await chrome.storage.local.set({ settings });

    const useBackend = backend.enabled();
    if (useBackend) {
      // 规则/知识库写入数据库（本地已有规则会一并迁移进库）。
      // 设置在上面已落本地存储，这里失败时要如实告知"设置已保存但数据库没同步全"
      try {
        for (const id of deletedProductIds) {
          if (typeof id === 'number') await backend.deleteProduct(id);
        }
        deletedProductIds = [];
        for (const p of products) {
          const payload = { match: p.match, spec: p.spec, price: p.price, mode: p.mode, delivery: p.delivery, note: p.note };
          if (typeof p.id === 'number') await backend.updateProduct(p.id, payload);
          else { const r = await backend.createProduct(payload); p.id = r.id; }
        }
        await backend.saveKb({ entries: kbEntries, knowledgeText: $('knowledgeText').value });
      } catch (e) {
        res.className = 'err';
        res.textContent = '⚠️ 基础设置已保存，但规则/知识库同步到数据库失败：' + e.message + '（请检查后端后再点一次保存）';
        return;
      }
      backendMode = true;
      res.className = '';
      res.textContent = '✓ 已保存到数据库 ' + new Date().toLocaleTimeString();
    } else {
      await chrome.storage.local.set({
        kb: { knowledgeText: $('knowledgeText').value, entries: kbEntries },
        products
      });
      backendMode = false;
      res.className = '';
      res.textContent = '✓ 已保存 ' + new Date().toLocaleTimeString();
    }
    renderStock();
  } catch (e) {
    res.className = 'err';
    res.textContent = '保存失败: ' + e.message;
  }
});

// ---------- 测试 Telegram 推送 ----------
$('testTg').addEventListener('click', async () => {
  const res = $('tgResult');
  res.className = '';
  const token = $('tgBotToken').value.trim(), chatId = $('tgChatId').value.trim();
  if (!token || !chatId) { res.className = 'err'; res.textContent = '请先填 Bot Token 和 Chat ID'; return; }
  res.textContent = '发送中…';
  // 用当前表单值临时存一份调用，测完还原（测试不等于保存）
  const { settings = {} } = await chrome.storage.local.get('settings');
  const tmp = { ...settings, tgBotToken: token, tgChatId: chatId };
  await chrome.storage.local.set({ settings: tmp });
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TG_PUSH', text: '✅ 测试推送成功！\n闲鱼助手的订单提醒将发到这里。' });
    if (r && r.ok) { res.textContent = '✓ 已发送，去 Telegram 看一眼'; }
    else { res.className = 'err'; res.textContent = '✗ 发送失败：' + (r && r.error || '无响应') + '（检查 Token/Chat ID 是否正确、是否已给机器人发过消息）'; }
  } finally {
    await chrome.storage.local.set({ settings });
  }
});

// ---------- 测试 AI 接口 ----------
$('testApi').addEventListener('click', async () => {
  const res = $('testResult');
  res.className = '';
  res.textContent = '测试中…';
  // 用当前表单值临时存一份再调用，测完必须还原——测试不等于保存
  const { settings = {} } = await chrome.storage.local.get('settings');
  const tmp = { ...settings };
  for (const f of ['apiBaseUrl', 'apiKey', 'model']) tmp[f] = $(f).value;
  await chrome.storage.local.set({ settings: tmp });
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GEN_REPLY',
      context: { lastMessage: '在吗？', history: [{ role: 'buyer', text: '在吗？' }] }
    });
    if (resp && resp.ok) {
      res.textContent = '✓ 成功，AI 回复：' + resp.reply.slice(0, 60);
    } else {
      res.className = 'err';
      res.textContent = '✗ ' + (resp && resp.error || '无响应');
    }
  } finally {
    await chrome.storage.local.set({ settings }); // 还原，避免没点保存就悄悄生效
  }
});

// ---------- 导入导出 ----------
$('exportBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['settings', 'kb', 'products']);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'xianyu-assistant-config.json';
  a.click();
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await chrome.storage.local.set(data);
    await load();
    $('saveResult').textContent = '✓ 导入成功';
  } catch (err) {
    $('saveResult').className = 'err';
    $('saveResult').textContent = '导入失败: ' + err.message;
  }
});

load();
