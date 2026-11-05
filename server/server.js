/**
 * 闲鱼智能客服助手 本地后端（MySQL）
 *
 * 提供给浏览器插件的 HTTP 接口：
 *   - 商品规则 CRUD（含每规则库存/已发统计）
 *   - 卡密库存：查看 / 补货
 *   - 发货：原子事务（去重 + 匹配规则 + 锁卡扣减 + 记录），保证不重发、不发错、并发安全
 *   - 知识库：关键词条目 + 店铺知识文本
 *
 * 默认只监听 127.0.0.1。未设置 AUTH_TOKEN 时拒绝对外监听。启动：node server.js
 */
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');
const shop = require('./shop-client');   // 卡网自动进货（.env 配齐 SHOP_* 才启用）

const path = require('path');
const app = express();
app.use(express.json({ limit: '2mb' }));

const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const PORT = Number(process.env.PORT || 8788);

/** 本机回环地址。只有这些地址允许在不设 AUTH_TOKEN 时启动。 */
function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * 决定监听地址。默认 127.0.0.1。
 * 未设置 AUTH_TOKEN 且要绑非回环地址 → 拒绝启动。
 */
function decideBind(bindRaw, tokenRaw) {
  const bind = String(bindRaw == null ? '' : bindRaw).trim() || '127.0.0.1';
  const token = String(tokenRaw == null ? '' : tokenRaw).trim();
  if (!token && !isLoopbackHost(bind)) {
    return {
      ok: false, bind, token,
      error: '未设置 AUTH_TOKEN，拒绝对外监听（BIND_HOST=' + bind + '）'
    };
  }
  return { ok: true, bind, token };
}

/** CORS 只放行扩展页面和本机页面，绝不使用 *。 */
function isCorsOriginAllowed(origin) {
  if (!origin) return true;
  if (origin === '*') return false;
  try {
    const u = new URL(origin);
    if (u.protocol === 'chrome-extension:') return true;
    const host = u.hostname;
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
  } catch (_) { /* 非法 Origin 拒绝 */ }
  return false;
}

app.use(cors({
  origin(origin, callback) {
    // 回写具体 Origin 字符串。不要传 true / '*'，否则 cors 包可能写成 Access-Control-Allow-Origin: *
    if (!origin || !isCorsOriginAllowed(origin)) return callback(null, false);
    callback(null, origin);
  }
}));

function feedbackByteLength(body) {
  try { return Buffer.byteLength(JSON.stringify(body == null ? {} : body), 'utf8'); }
  catch (_) { return Infinity; }
}

function feedbackWithinLimit(body, max) {
  return feedbackByteLength(body) <= (max || 64 * 1024);
}

/** 纯函数限频：窗口内已达上限则拒绝，并返回更新后的时间戳列表。 */
function allowFeedbackRate(hits, now, windowMs, limit) {
  const list = (Array.isArray(hits) ? hits : []).filter(t => now - t < windowMs);
  if (list.length >= limit) return { ok: false, hits: list };
  list.push(now);
  return { ok: true, hits: list };
}

function redactFeedbackField(s, maxLen) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[secret]');
  out = out.replace(/(密码|卡密|token|api[_-]?key|secret|AUTH_TOKEN)\s*[:：=]\s*\S+/gi, '$1:[redacted]');
  if (maxLen && out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

const feedbackRateBuckets = new Map();
function takeFeedbackSlot(ip) {
  const now = Date.now();
  const prev = feedbackRateBuckets.get(ip) || [];
  const decision = allowFeedbackRate(prev, now, 10 * 60 * 1000, 5);
  feedbackRateBuckets.set(ip, decision.hits);
  if (feedbackRateBuckets.size > 2000) {
    const first = feedbackRateBuckets.keys().next().value;
    feedbackRateBuckets.delete(first);
  }
  return decision.ok;
}

// 公开页面（无需鉴权）——放在鉴权中间件之前
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));          // 产品介绍首页
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html'))); // 隐私政策（商店要求）

// 简单令牌校验。AUTH_TOKEN 为空时只可能发生在本机回环（对外监听已在启动时拒绝）。
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/api/health' || req.path === '/privacy') return next();
  if (!AUTH_TOKEN) return next();
  if (req.get('X-Auth-Token') === AUTH_TOKEN) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch(e => {
    console.error(req.method, req.path, '-', e.message);
    res.status(500).json({ ok: false, error: e.message });
  });

// ---------- 健康检查 ----------
app.get('/api/health', wrap(async (req, res) => {
  let db = 'ok';
  try { await pool.query('SELECT 1'); } catch (e) { db = 'down: ' + e.message; }
  res.json({ ok: true, service: 'xianyu-assistant-server', db });
}));

// ---------- 问题反馈（插件弹窗/设置页）----------
// 单条 ≤64KB；同一 IP 10 分钟最多 5 次。描述必填。入库前再脱敏一次。
app.post('/api/feedback', (req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(len) && len > 64 * 1024) {
    return res.status(413).json({ ok: false, error: '反馈内容超过 64KB' });
  }
  next();
}, wrap(async (req, res) => {
  const body = req.body || {};
  if (!feedbackWithinLimit(body, 64 * 1024)) {
    return res.status(413).json({ ok: false, error: '反馈内容超过 64KB' });
  }
  const description = redactFeedbackField(body.description, 4000).trim();
  if (!description) return res.status(400).json({ ok: false, error: '请填写问题描述' });
  const ip = String((req.socket && req.socket.remoteAddress) || req.ip || 'unknown');
  if (!takeFeedbackSlot(ip)) {
    return res.status(429).json({ ok: false, error: '反馈过于频繁，请 10 分钟后再试' });
  }
  const version = redactFeedbackField(body.version, 32);
  const ua = redactFeedbackField(body.ua, 400);
  const page = redactFeedbackField(body.page, 32);
  let audit = '';
  let logs = '';
  try { audit = redactFeedbackField(JSON.stringify(body.selectorAudit || null), 8000); } catch (_) { audit = ''; }
  try { logs = redactFeedbackField(JSON.stringify(body.logs || []), 50000); } catch (_) { logs = '[]'; }
  const [r] = await pool.query(
    `INSERT INTO feedback (version, ua, page, selector_audit, logs, description) VALUES (?,?,?,?,?,?)`,
    [version, ua, page, audit, logs, description]);
  res.json({ ok: true, id: r.insertId });
}));

// ---------- 商品规则 ----------

// 列表：带可用库存数、已发数
app.get('/api/products', wrap(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM cards c WHERE c.product_id=p.id AND c.status='available') AS stock,
      (SELECT COUNT(*) FROM deliveries d WHERE d.product_id=p.id) AS sold
    FROM products p ORDER BY p.id`);
  res.json({ ok: true, products: rows });
}));

// 货源字段清洗：source 只认 local/shop；shop 模式必须给卡网 SKU ID
function normalizeSourceFields(b) {
  const source = b.source === 'shop' ? 'shop' : 'local';
  const shopSkuId = Number(b.shop_sku_id) > 0 ? Number(b.shop_sku_id) : null;
  const maxCost = Number(b.max_cost) > 0 ? Number(b.max_cost) : null;
  if (source === 'shop' && !shopSkuId) {
    return { error: '卡网自动进货需要填写卡网 SKU ID' };
  }
  return { source, shopSkuId, maxCost };
}

app.post('/api/products', wrap(async (req, res) => {
  const b = req.body || {};
  // 空标题的规则永远匹配不到订单，只会变成"(未命名)"垃圾行，拒收
  if (!b.match || !String(b.match).trim()) {
    return res.status(400).json({ ok: false, error: '商品标题匹配不能为空' });
  }
  const sf = normalizeSourceFields(b);
  if (sf.error) return res.status(400).json({ ok: false, error: sf.error });
  const [r] = await pool.query(
    `INSERT INTO products (match_title, spec, price, mode, delivery, note, source, shop_sku_id, max_cost, auto_deliver)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.match || '', b.spec || '', b.price || '', b.mode || 'pool', b.delivery || '', b.note || '',
     sf.source, sf.shopSkuId, sf.maxCost, Number(b.auto_deliver) === 1 ? 1 : 0]);   // 默认关：新品必须显式开启才会自动发
  res.json({ ok: true, id: r.insertId });
}));

app.put('/api/products/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.match || !String(b.match).trim()) {
    return res.status(400).json({ ok: false, error: '商品标题匹配不能为空' });
  }
  const sf = normalizeSourceFields(b);
  if (sf.error) return res.status(400).json({ ok: false, error: sf.error });
  await pool.query(
    `UPDATE products SET match_title=?, spec=?, price=?, mode=?, delivery=?, note=?,
       source=?, shop_sku_id=?, max_cost=?, auto_deliver=? WHERE id=?`,
    [b.match || '', b.spec || '', b.price || '', b.mode || 'pool', b.delivery || '', b.note || '',
     sf.source, sf.shopSkuId, sf.maxCost, Number(b.auto_deliver) === 1 ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/products/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- 卡密库存 ----------

// 查看某规则的卡密（默认只看在库）
app.get('/api/products/:id/cards', wrap(async (req, res) => {
  const status = req.query.status || 'available';
  const [rows] = await pool.query(
    'SELECT id, secret, status, used_order_id, used_at FROM cards WHERE product_id=? AND status=? ORDER BY id',
    [req.params.id, status]);
  res.json({ ok: true, cards: rows });
}));

// 补货：批量插入
app.post('/api/products/:id/cards', wrap(async (req, res) => {
  const list = (req.body && req.body.cards || [])
    .map(s => String(s).trim()).filter(Boolean);
  if (!list.length) return res.json({ ok: true, added: 0 });
  const values = list.map(s => [req.params.id, s]);
  await pool.query('INSERT INTO cards (product_id, secret) VALUES ?', [values]);
  res.json({ ok: true, added: list.length });
}));

/**
 * 标记某张卡"已手动发货"：你在别处手动发了这张卡时用。
 * 事务内把该卡置为 used（从可用库存移除，机器人不会再自动发它），
 * 并记一笔发货（order_id = MANUAL-card<卡id>，唯一，重复点幂等），让"累计已发"准确。
 * 返回 status: removed / alreadyUsed / notFound
 */
app.post('/api/products/:id/cards/:cardId/manual', wrap(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT c.id, c.secret, c.status, p.match_title, p.spec, p.price
       FROM cards c JOIN products p ON p.id = c.product_id
       WHERE c.id = ? AND c.product_id = ? FOR UPDATE`,
      [req.params.cardId, req.params.id]);
    if (!rows.length) { await conn.commit(); return res.json({ ok: true, status: 'notFound' }); }
    const card = rows[0];
    if (card.status !== 'available') { await conn.commit(); return res.json({ ok: true, status: 'alreadyUsed' }); }
    const manualOrder = 'MANUAL-card' + card.id;
    await conn.query(
      `UPDATE cards SET status='used', used_order_id=?, used_at=NOW() WHERE id=?`,
      [manualOrder, card.id]);
    // INSERT IGNORE：order_id 唯一，重复点同一张不会重复记
    await conn.query(
      `INSERT IGNORE INTO deliveries (order_id, product_id, card_id, title, spec, price, buyer, content)
       VALUES (?,?,?,?,?,?,?,?)`,
      [manualOrder, req.params.id, card.id, card.match_title || '', card.spec || '', card.price || '', '手动发货', card.secret]);
    await conn.commit();
    res.json({ ok: true, status: 'removed' });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// ---------- 发货（原子）----------
/**
 * body: { orderId, title, spec, price, buyer, template }
 * 事务内完成：
 *   1. orderId 已发过 → 幂等返回 alreadyDelivered
 *   2. 按 title 包含 + spec/price 精确 匹配规则；命中标题但规格对不上 → needManual（转人工）
 *   3. pool 模式：SELECT ... FOR UPDATE 锁一条在库卡密，置 used；无库存 → outOfStock
 *   4. 写 deliveries（order_id 唯一约束兜底防并发重发）
 * 返回 { ok, status, content, stockLeft }
 */
/**
 * 单次发货尝试（一个数据库事务）：去重 → 匹配规则 → 锁卡扣减 → 记录。
 * 返回 { status, ... , rule }；rule 只在 outOfStock 时给外层判断是否走卡网进货。
 * 注意：本函数内绝不做任何 HTTP 调用——事务里发 HTTP 会长时间持有行锁。
 */
async function tryDeliverOnce({ orderId, title, spec, price, buyer, template, force }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. 去重
    const [dup] = await conn.query('SELECT id FROM deliveries WHERE order_id=? FOR UPDATE', [orderId]);
    if (dup.length) {
      await conn.commit();
      return { ok: true, status: 'alreadyDelivered' };
    }

    // 2. 匹配规则
    const [prods] = await conn.query('SELECT * FROM products');
    const titleHits = prods.filter(p => p.match_title && title.includes(p.match_title));
    if (!titleHits.length) { await conn.commit(); return { ok: true, status: 'noRule' }; }
    const hits = titleHits.filter(p =>
      (!p.spec || p.spec === spec) && (!p.price || String(p.price) === String(price)));
    if (!hits.length) { await conn.commit(); return { ok: true, status: 'needManual' }; }
    // 优先最具体的规则（规格+价格都填 > 只填一个 > 全不限），
    // 避免"不限规格"兜底规则抢走本该走精确规格库存的订单
    hits.sort((a, b) =>
      ((b.spec ? 1 : 0) + (b.price ? 1 : 0)) - ((a.spec ? 1 : 0) + (a.price ? 1 : 0)));
    const rule = hits[0];

    // 2.5 自动发货开关：关了就只提醒不发（不扣卡不进货）。
    // force=true 是你在 TG 点「发货」按钮或人工触发的明确指令，放行。
    if (!force && Number(rule.auto_deliver) === 0) {
      await conn.commit();
      return { ok: true, status: 'autoOff' };
    }

    // 3. 组装内容 + 扣卡
    let card = null, content, stockLeft = null;
    if ((rule.mode || 'pool') === 'pool') {
      const [cardRows] = await conn.query(
        `SELECT id, secret FROM cards WHERE product_id=? AND status='available'
         ORDER BY id LIMIT 1 FOR UPDATE`, [rule.id]);
      if (!cardRows.length) { await conn.commit(); return { ok: true, status: 'outOfStock', rule }; }
      card = cardRows[0];
      await conn.query(
        `UPDATE cards SET status='used', used_order_id=?, used_at=NOW() WHERE id=?`,
        [orderId, card.id]);
      const tpl = rule.delivery || template || '';
      content = tpl.includes('{卡密}') ? tpl.split('{卡密}').join(card.secret)
              : (tpl ? tpl + '\n' + card.secret : card.secret);
      // 事务内计算剩余库存（left 是保留字，用 remaining 别名）
      const [[cnt]] = await conn.query(
        `SELECT COUNT(*) AS remaining FROM cards WHERE product_id=? AND status='available'`, [rule.id]);
      stockLeft = cnt.remaining;
    } else {
      content = rule.delivery || '';
      if (!content) { await conn.commit(); return { ok: true, status: 'noContent' }; }
    }

    // 4. 记录发货
    await conn.query(
      `INSERT INTO deliveries (order_id, product_id, card_id, title, spec, price, buyer, content)
       VALUES (?,?,?,?,?,?,?,?)`,
      [orderId, rule.id, card ? card.id : null, title, spec, price, buyer, content]);

    await conn.commit();
    return { ok: true, status: 'delivered', content, card: card ? card.secret : null, stockLeft };
  } catch (e) {
    await conn.rollback();
    // 唯一约束冲突（并发重发）→ 视为已发
    if (e.code === 'ER_DUP_ENTRY') return { ok: true, status: 'alreadyDelivered' };
    throw e;
  } finally {
    conn.release();
  }
}

app.post('/api/deliver', wrap(async (req, res) => {
  const { orderId, title = '', spec = '', price = '', buyer = '', template = '', force = false } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

  const args = { orderId, title, spec, price, buyer, template, force: !!force };
  let r = await tryDeliverOnce(args);

  // 本地无货且规则配了"卡网自动进货"→ 现场向卡网下单取货，取回入池后再发一次
  if (r.status === 'outOfStock' && r.rule &&
      r.rule.source === 'shop' && r.rule.shop_sku_id && shop.enabled()) {
    const p = await ensureShopPurchase(orderId, r.rule);
    if (p.imported) {
      r = await tryDeliverOnce(args);       // 卡已入池，正常发货流程再走一遍
    } else if (p.pending) {
      // 卡网正在向它的上游采购，几秒到一分钟；插件对未发货订单每轮都会重试，
      // 后台轮询器取到货入池后，下一轮自动发出
      return res.json({ ok: true, status: 'purchasing' });
    } else {
      return res.json({ ok: true, status: 'outOfStock', reason: p.error || 'shop purchase failed' });
    }
  }

  const { rule, ...resp } = r;   // rule 是内部信息，不回给插件
  res.json(resp);
}));

// ---------- 卡网自动进货 ----------
/**
 * 进货状态机（shop_purchases，闲鱼订单号唯一）：
 *   ordering → 已决定进货，正在/即将向卡网下单（downstream_no 已先落库，
 *              崩溃重启后用同一个号重放，卡网幂等不会重复扣款）
 *   ordered  → 卡网订单已建已扣款，等交付（卡网本地有货=秒到；要向上游买=几秒到一分钟）
 *   imported → 卡密已取回并放进本地 cards 池（后续走原有发货流程）
 *   failed   → 进货失败（余额不足/超价/商品下架等），冷却期后可自动重试
 */
const SHOP_WAIT_MS = Number(process.env.SHOP_DELIVER_WAIT_MS || 15000);  // 发货请求内最多等这么久
const SHOP_RETRY_COOLDOWN_MS = 10 * 60 * 1000;                           // failed 后冷却 10 分钟再试

/** 只发给店主的 TG 通知（未配置则静默） */
function notifyOwner(text) {
  try { if (TG_TOKEN && TG_CHAT) tgReply(text); } catch (_) { /* 通知失败不影响主流程 */ }
}

/** 把取回的卡密放进本地库存池。原子状态转移保证同一笔进货绝不入池两次。 */
async function importPurchaseToPool(purchase, payload) {
  const secret = String(payload || '').trim();
  if (!secret) return false;
  const [r] = await pool.query(
    `UPDATE shop_purchases SET status='imported' WHERE id=? AND status IN ('ordering','ordered')`,
    [purchase.id]);
  if (!r.affectedRows) return true;   // 别的调用方（轮询器/并发请求）已入池
  await pool.query('INSERT INTO cards (product_id, secret) VALUES (?,?)', [purchase.product_id, secret]);
  console.log(`[shop] 进货入池：闲鱼单 ${purchase.order_id} ← 卡网单 ${purchase.shop_order_no || purchase.shop_order_id}`);
  return true;
}

async function markPurchaseFailed(purchase, error) {
  await pool.query(
    `UPDATE shop_purchases SET status='failed', error=? WHERE id=? AND status IN ('ordering','ordered')`,
    [String(error).slice(0, 250), purchase.id]);
}

/**
 * 推进一笔进货直到入池 / 超时 / 失败。
 * 返回 { imported } | { pending } | { error }
 */
async function ensureShopPurchase(orderId, rule) {
  try {
    // 1. 取或建进货记录（order_id 唯一：并发请求只会有一条）
    let [[p]] = await pool.query('SELECT * FROM shop_purchases WHERE order_id=?', [orderId]);
    if (!p) {
      // 下单前核价：卡网价超过成本上限就不买（防上游涨价后每单倒贴）。
      // 核价失败不阻断——下单后还有 amount 兜底核对。
      if (rule.max_cost != null) {
        try {
          const snap = await findShopSku(Number(rule.shop_sku_id));
          if (snap && snap.price && snap.price > Number(rule.max_cost)) {
            const msg = `卡网价 ¥${snap.price} 已超过成本上限 ¥${rule.max_cost}`;
            notifyOwner(`⛔ 未自动进货：${rule.match_title} —— ${msg}\n闲鱼订单 ${orderId} 需人工处理`);
            return { error: msg };
          }
        } catch (e) { console.warn('[shop] 核价失败（继续下单，靠事后核对）:', e.message); }
      }
      // downstream_no 先落库再下单：崩溃后用同一个号重放，卡网幂等保证不重复扣款
      try {
        await pool.query(
          `INSERT INTO shop_purchases (order_id, product_id, shop_sku_id, downstream_no, attempt, status)
           VALUES (?,?,?,?,1,'ordering')`,
          [orderId, rule.id, rule.shop_sku_id, `XY-${orderId}-1`]);
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;   // 并发建了同一条 → 直接用现有的
      }
      [[p]] = await pool.query('SELECT * FROM shop_purchases WHERE order_id=?', [orderId]);
    }

    if (p.status === 'imported') return { imported: true };
    if (p.status === 'failed') {
      // 冷却期内不重试（避免每轮 tick 反复打卡网）；过了冷却换一个幂等号重来
      const age = Date.now() - new Date(p.updated_at).getTime();
      if (age < SHOP_RETRY_COOLDOWN_MS) return { error: p.error || 'purchase failed' };
      const attempt = (p.attempt || 1) + 1;
      await pool.query(
        `UPDATE shop_purchases SET status='ordering', attempt=?, downstream_no=?, shop_order_id=NULL, shop_order_no=NULL, error='' WHERE id=?`,
        [attempt, `XY-${orderId}-${attempt}`, p.id]);
      [[p]] = await pool.query('SELECT * FROM shop_purchases WHERE id=?', [p.id]);
    }

    const deadline = Date.now() + SHOP_WAIT_MS;

    // 2. 还没有卡网订单 → 下单（钱包扣款）
    if (!p.shop_order_id) {
      const r = await shop.createOrder({
        skuId: p.shop_sku_id, quantity: 1, downstreamOrderNo: p.downstream_no, traceId: p.downstream_no
      });
      if (!r || !r.ok) {
        const code = (r && r.error_code) || 'unknown';
        const msg = (r && r.error_message) || '卡网下单失败';
        await markPurchaseFailed(p, `${code}: ${msg}`);
        notifyOwner(code === 'payment_failed'
          ? `⛔ 卡网进货失败：钱包余额不足！\n商品：${rule.match_title}\n闲鱼订单 ${orderId} 待发货，请去卡网充值（充值后 10 分钟内自动重试）`
          : `⛔ 卡网进货失败：${msg}\n商品：${rule.match_title}，闲鱼订单 ${orderId}`);
        return { error: `${code}: ${msg}` };
      }
      await pool.query(
        `UPDATE shop_purchases SET status='ordered', shop_order_id=?, shop_order_no=?, amount=? WHERE id=?`,
        [r.order_id, r.order_no || '', r.amount || '', p.id]);
      p.shop_order_id = r.order_id; p.shop_order_no = r.order_no; p.amount = r.amount;
      // 事后核对实付：超上限也照取货（钱已扣），但要告警
      if (rule.max_cost != null && Number(r.amount) > Number(rule.max_cost)) {
        notifyOwner(`⚠️ 本单进货价 ¥${r.amount} 超过成本上限 ¥${rule.max_cost}（${rule.match_title}），货照发，请核查卡网价格`);
      }
    }

    // 3. 轮询取货直到拿到卡密或本次等待窗口用完
    for (;;) {
      const o = await shop.getOrder(p.shop_order_id);
      if (o && o.ok && o.fulfillment && o.fulfillment.payload) {
        await importPurchaseToPool(p, o.fulfillment.payload);
        return { imported: true };
      }
      // 卡网侧订单被取消/退款 → 失败（钱会退回钱包，不用担心）
      if (o && o.ok && ['canceled', 'refunded'].includes(String(o.status))) {
        await markPurchaseFailed(p, `卡网订单 ${o.status}`);
        notifyOwner(`⛔ 卡网进货订单被${o.status === 'canceled' ? '取消' : '退款'}：${rule.match_title}，闲鱼订单 ${orderId} 需人工处理`);
        return { error: `shop order ${o.status}` };
      }
      if (Date.now() + 2500 > deadline) return { pending: true };   // 交给后台轮询器继续
      await new Promise(r2 => setTimeout(r2, 2500));
    }
  } catch (e) {
    console.error('[shop] 进货异常:', e.message);
    return { error: e.message };   // 网络类异常不落 failed：下一轮重进这个函数会自动续跑
  }
}

// SKU 快照缓存：skuId -> { price, isActive, title, ts }。核价用，10 分钟有效
const shopSkuCache = new Map();
async function findShopSku(skuId) {
  const hit = shopSkuCache.get(skuId);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit;
  for (let page = 1; page <= 10; page++) {
    const r = await shop.listProducts(page, 50);
    if (!r || !r.ok || !Array.isArray(r.items)) break;
    for (const prod of r.items) {
      for (const sku of (prod.skus || [])) {
        if (Number(sku.id) === Number(skuId)) {
          const snap = {
            price: Number(sku.price_amount),
            isActive: !!sku.is_active && !!prod.is_active,
            title: (prod.title && (prod.title['zh-CN'] || Object.values(prod.title)[0])) || '',
            ts: Date.now()
          };
          shopSkuCache.set(Number(skuId), snap);
          return snap;
        }
      }
    }
    if (r.items.length < 50) break;   // 已到最后一页
  }
  return null;
}

// ---------- 后台轮询器：接手发货请求没等到的进货单 ----------
async function shopPurchasePoller() {
  try {
    const [rows] = await pool.query(
      `SELECT sp.*, p.match_title FROM shop_purchases sp
       LEFT JOIN products p ON p.id = sp.product_id
       WHERE sp.status IN ('ordering','ordered') LIMIT 20`);
    for (const p of rows) {
      try {
        if (!p.shop_order_id) {
          // ordering 且没有卡网单号：可能是崩溃残留 → 用原幂等号重放下单（不会重复扣款）
          if (Date.now() - new Date(p.updated_at).getTime() < 60 * 1000) continue; // 给在途请求让路
          const r = await shop.createOrder({
            skuId: p.shop_sku_id, quantity: 1, downstreamOrderNo: p.downstream_no, traceId: p.downstream_no
          });
          if (!r || !r.ok) {
            await markPurchaseFailed(p, `${(r && r.error_code) || 'unknown'}: ${(r && r.error_message) || 'createOrder failed'}`);
            continue;
          }
          await pool.query(
            `UPDATE shop_purchases SET status='ordered', shop_order_id=?, shop_order_no=?, amount=? WHERE id=?`,
            [r.order_id, r.order_no || '', r.amount || '', p.id]);
          p.shop_order_id = r.order_id;
        }
        const o = await shop.getOrder(p.shop_order_id);
        if (o && o.ok && o.fulfillment && o.fulfillment.payload) {
          if (await importPurchaseToPool(p, o.fulfillment.payload)) {
            notifyOwner(`📦 卡网进货到货：${p.match_title || ('#' + p.product_id)}\n闲鱼订单 ${p.order_id} 将在插件下一轮自动发货`);
          }
        } else if (o && o.ok && ['canceled', 'refunded'].includes(String(o.status))) {
          await markPurchaseFailed(p, `卡网订单 ${o.status}`);
          notifyOwner(`⛔ 卡网进货订单被${o.status === 'canceled' ? '取消' : '退款'}：闲鱼订单 ${p.order_id} 需人工处理`);
        }
      } catch (e) {
        console.warn('[shop] 轮询进货单失败:', p.order_id, e.message);
      }
    }
  } catch (e) {
    console.warn('[shop] 轮询器异常:', e.message);
  }
}

// 回滚一次发货：聊天消息发送失败时调用，恢复卡密、删除发货记录
app.post('/api/deliver/rollback', wrap(async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, card_id FROM deliveries WHERE order_id=? FOR UPDATE', [orderId]);
    if (rows.length) {
      if (rows[0].card_id) {
        await conn.query(
          `UPDATE cards SET status='available', used_order_id=NULL, used_at=NULL WHERE id=?`,
          [rows[0].card_id]);
      }
      await conn.query('DELETE FROM deliveries WHERE id=?', [rows[0].id]);
    }
    await conn.commit();
    res.json({ ok: true, rolledBack: rows.length > 0 });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// 查询某订单是否已发（插件预判用）
app.get('/api/delivered/:orderId', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id, created_at FROM deliveries WHERE order_id=?', [req.params.orderId]);
  res.json({ ok: true, delivered: rows.length > 0 });
}));

// 发货记录（对账）
app.get('/api/deliveries', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const [rows] = await pool.query(
    'SELECT order_id, title, spec, price, buyer, content, created_at FROM deliveries ORDER BY id DESC LIMIT ?',
    [limit]);
  res.json({ ok: true, deliveries: rows });
}));

// ---------- 知识库 ----------
app.get('/api/kb', wrap(async (req, res) => {
  const [entries] = await pool.query('SELECT id, keywords, reply FROM kb_entries ORDER BY sort_order, id');
  const [[kv]] = await pool.query("SELECT v FROM kv_store WHERE k='knowledgeText'");
  res.json({
    ok: true,
    entries: entries.map(e => ({ keywords: (e.keywords || '').split(',').filter(Boolean), reply: e.reply })),
    knowledgeText: kv ? kv.v : ''
  });
}));

app.put('/api/kb', wrap(async (req, res) => {
  const entries = req.body && req.body.entries || [];
  const text = (req.body && req.body.knowledgeText) || '';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM kb_entries');
    let i = 0;
    for (const e of entries) {
      await conn.query('INSERT INTO kb_entries (keywords, reply, sort_order) VALUES (?,?,?)',
        [(e.keywords || []).join(','), e.reply || '', i++]);
    }
    await conn.query(
      `INSERT INTO kv_store (k, v) VALUES ('knowledgeText', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)`, [text]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// ---------- 话术库（本人回复风格样本）----------
app.get('/api/style', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 600), 2000);
  const [rows] = await pool.query(
    'SELECT q, a FROM style_samples ORDER BY id DESC LIMIT ?', [limit]);
  res.json({ ok: true, samples: rows.reverse() }); // 时间正序返回
}));

// 批量追加样本（按回复内容去重，已存在的相同回复跳过）
app.post('/api/style', wrap(async (req, res) => {
  const list = (req.body && req.body.samples || [])
    .filter(s => s && s.a && String(s.a).trim().length >= 2)
    .map(s => ({ q: String(s.q || '').slice(0, 200), a: String(s.a).slice(0, 400) }));
  if (!list.length) return res.json({ ok: true, added: 0 });
  let added = 0;
  for (const s of list) {
    const [[dup]] = await pool.query('SELECT id FROM style_samples WHERE a=? LIMIT 1', [s.a]);
    if (dup) continue;
    await pool.query('INSERT INTO style_samples (q, a) VALUES (?, ?)', [s.q, s.a]);
    added++;
  }
  // 控制总量：只保留最近 800 条
  await pool.query(
    'DELETE FROM style_samples WHERE id <= (SELECT id FROM (SELECT id FROM style_samples ORDER BY id DESC LIMIT 1 OFFSET 800) t)');
  res.json({ ok: true, added });
}));

app.delete('/api/style', wrap(async (req, res) => {
  await pool.query('DELETE FROM style_samples');
  res.json({ ok: true });
}));

// ---------- 远程发货指令队列（飞机点「发货」→ 插件轮询执行）----------

// 插件取待执行指令。age_sec=指令排队秒数：双账号共用后端时，
// 插件靠它判断"本账号查无此单"该继续等（可能是另一账号的单）还是判失败
app.get('/api/deliver-commands', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT order_id, buyer, title, spec, price,
       TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec
     FROM deliver_commands WHERE status='pending' ORDER BY id LIMIT 20`);
  res.json({ ok: true, commands: rows });
}));

// 插件回写执行结果：status=done/failed，result 为说明
app.post('/api/deliver-commands/:orderId/resolve', wrap(async (req, res) => {
  const { status = 'done', result = '' } = req.body || {};
  const st = status === 'done' ? 'done' : 'failed';
  // 只处理确实存在、且还没结算过的指令——查无此单/已结算则静默，不误推飞机
  const [[cmd]] = await pool.query(
    'SELECT buyer, title, spec, status FROM deliver_commands WHERE order_id=?', [req.params.orderId]);
  if (!cmd) return res.json({ ok: true, ignored: 'no such command' });
  if (cmd.status !== 'pending') return res.json({ ok: true, ignored: 'already resolved' });
  await pool.query(
    'UPDATE deliver_commands SET status=?, result=? WHERE order_id=?',
    [st, String(result).slice(0, 250), req.params.orderId]);
  // 结果回推飞机（配了 TG 才发）
  if (TG_TOKEN && TG_CHAT) {
    const who = `${cmd.buyer || ''}「${cmd.title || ''}${cmd.spec ? '/' + cmd.spec : ''}」`;
    tgReply(st === 'done' ? `✅ 远程发货成功：${who}` : `⚠️ 远程发货未成功：${who}\n${result || ''}\n可回电脑手动发`);
  }
  res.json({ ok: true });
}));

// ---------- Telegram 机器人：远程查库存 / 补货（服务器 7x24 在线，无需浏览器） ----------
// .env 配置 TG_BOT_TOKEN + TG_CHAT_ID 后启用；只响应 TG_CHAT_ID（店主本人）的消息，
// 其他任何人发消息一律忽略。指令：
//   「库存」                 → 列出所有商品剩余卡密
//   「补货 新版」+每行一张卡密 → 按关键词补货（也支持「补货 #8」按编号）
const TG_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TG_CHAT_ID || '').trim();
const https = require('https');

function tgApi(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(
      `https://api.telegram.org/bot${TG_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(40000, () => { req.destroy(); resolve(null); }); // 长轮询 30s + 余量
    req.write(body); req.end();
  });
}
const tgReply = (text, keyboard) => tgApi('sendMessage', {
  chat_id: TG_CHAT, text: String(text).slice(0, 3800),
  ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
});

/** 发一条消息并把它的 message_id 记进当前补货会话（入库成功/取消时统一删除，保持对话干净、不留卡密明文） */
async function tgReplyTracked(text, keyboard) {
  const r = await tgReply(text, keyboard);
  const id = r && r.ok && r.result && r.result.message_id;
  if (id && tgPending && Array.isArray(tgPending.msgIds)) tgPending.msgIds.push(id);
  return r;
}
/** 批量删除消息（失败静默：太老的消息 TG 不允许删，忽略即可） */
async function tgDeleteMsgs(ids) {
  for (const id of (ids || [])) {
    if (id) await tgApi('deleteMessage', { chat_id: TG_CHAT, message_id: id });
  }
}

async function tgStockText() {
  const [rows] = await pool.query(`
    SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id=p.id AND c.status='available') AS stock
    FROM products p ORDER BY p.id`);
  if (!rows.length) return '还没有配置任何商品规则。';
  return rows.map(p =>
    `#${p.id} ${p.match_title}${p.spec ? ' / ' + p.spec : ''}${p.price ? ' ¥' + p.price : ''} — ` +
    (p.mode === 'pool' ? `在库 ${p.stock} 张${p.stock <= 2 ? ' ⚠️' : ''}` : '固定内容')).join('\n');
}

/** 主菜单（任何看不懂的消息都回这个，点按钮操作，不用打字） */
const tgMenu = () => tgReply('你好，要做什么？点下面的按钮：', [
  [{ text: '📦 查库存', callback_data: 'stock' }],
  [{ text: '➕ 补货', callback_data: 'restock' }]
]);

/** 补货第一步：列出所有卡密类商品当按钮，点哪个补哪个（选不错） */
async function tgRestockPicker() {
  const [rows] = await pool.query(`
    SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id=p.id AND c.status='available') AS stock
    FROM products p WHERE p.mode='pool' ORDER BY p.id`);
  if (!rows.length) return tgReply('没有卡密类商品可补货（固定内容商品不需要库存）。');
  return tgReply('给哪个商品补货？点按钮选择：', [
    ...rows.map(p => ([{
      text: `#${p.id} ${p.match_title}${p.spec ? '/' + p.spec : ''} ¥${p.price || '?'} · 在库${p.stock}`,
      callback_data: 'pick:' + p.id
    }])),
    [{ text: '❌ 取消', callback_data: 'cancel' }]
  ]);
}

// 补货会话状态（单店主，一个状态足够；15 分钟不动作自动过期）
let tgPending = null; // { stage:'await_cards'|'await_confirm', productId, label, cards, ts }
const tgPendingFresh = () => tgPending && Date.now() - tgPending.ts < 15 * 60000;

async function tgHandleCallback(cb) {
  const data = String(cb.data || '');
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id }); // 让按钮停止转圈
  if (data === 'stock') {
    return tgReply('📦 当前库存：\n' + await tgStockText());
  }
  if (data === 'restock') {
    return tgRestockPicker();
  }
  if (data.startsWith('pick:')) {
    const id = Number(data.slice(5));
    const [rows] = await pool.query(`SELECT * FROM products WHERE id=? AND mode='pool'`, [id]);
    if (!rows.length) return tgReply('这个商品不存在了，重新点「➕ 补货」选一次。');
    const p = rows[0];
    const label = `#${p.id} ${p.match_title}${p.spec ? ' / ' + p.spec : ''} ¥${p.price || '?'}`;
    // msgIds 从选商品那条消息开始记（cb.message 就是它），入库/取消时一起删干净
    const pickerMsgId = cb.message && cb.message.message_id;
    tgPending = { stage: 'await_cards', productId: p.id, label, cards: [], ts: Date.now(), msgIds: pickerMsgId ? [pickerMsgId] : [] };
    return tgReplyTracked(`好，给「${label}」补货。\n\n现在把卡密发给我：一条消息里每行一张。`,
      [[{ text: '❌ 取消补货', callback_data: 'cancel' }]]);
  }
  if (data === 'confirm') {
    if (!tgPendingFresh() || tgPending.stage !== 'await_confirm') { tgPending = null; return tgReply('这次补货已过期或已处理，重新点「➕ 补货」来一次。'); }
    const { productId, label, cards, msgIds } = tgPending;
    tgPending = null;
    await pool.query('INSERT INTO cards (product_id, secret) VALUES ?', [cards.map(s => [productId, s])]);
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) AS n FROM cards WHERE product_id=? AND status='available'`, [productId]);
    // 删掉补货过程的中间消息（含明文卡密的核对预览、你粘贴的卡密），只留这条成功回执
    await tgDeleteMsgs(msgIds);
    return tgReply(`✅ 入库成功：${cards.length} 张 → ${label}\n现在库存：${cnt.n} 张`);
  }
  if (data === 'cancel') {
    const ids = tgPending && tgPending.msgIds;
    tgPending = null;
    await tgDeleteMsgs(ids);   // 取消也清掉中间消息（尤其是含卡密的那些）
    return tgReply('已取消，没有入库任何卡密。');
  }
  // 飞机点「发货」→ 排一条远程发货指令，插件轮询取走执行（订单号唯一，重复点不会重排）
  if (data.startsWith('dlv:')) {
    const orderId = data.slice(4);
    if (!orderId) return tgReply('发货指令缺少订单号。');
    // 已发过的不再排（查发货记录）
    const [[done]] = await pool.query('SELECT id FROM deliveries WHERE order_id=?', [orderId]);
    if (done) return tgReply(`这单（尾号 …${orderId.slice(-4)}）已经发过货了，未重复发。`);
    // 重排同一单时把 created_at 一起重置：age_sec 从 0 重新计，
    // 给持有该订单的账号留足执行窗口（另一账号靠 age_sec 决定等多久才判失败）
    await pool.query(
      "INSERT INTO deliver_commands (order_id) VALUES (?) ON DUPLICATE KEY UPDATE status='pending', result='', created_at=NOW()",
      [orderId]);
    return tgReply(`✅ 已排单，电脑上的插件将尽快发货（订单尾号 …${orderId.slice(-4)}）。\n发完会回你结果。`);
  }
}

async function tgHandleText(text, msgId) {
  const raw = String(text || '').trim();
  if (/^取消$/.test(raw)) {
    const ids = tgPending && tgPending.msgIds;
    tgPending = null;
    await tgDeleteMsgs(ids);
    return tgReply('已取消。');
  }

  // 补货第二步：正在等卡密 → 这条消息的每一行都是一张卡，回显预览等确认
  if (tgPendingFresh() && tgPending.stage === 'await_cards') {
    // 你粘贴的卡密消息含明文密码 → 记下 id，入库/取消时删除，不留在对话里
    if (msgId) tgPending.msgIds.push(msgId);
    const cards = raw.split('\n').map(s => s.trim()).filter(Boolean);
    if (!cards.length) return tgReplyTracked('没读到内容，每行一张卡密再发一次。',
      [[{ text: '❌ 取消补货', callback_data: 'cancel' }]]);
    // 查重：同商品库里已有完全相同的卡密 → 提醒（防手滑重复粘贴）
    const [dups] = await pool.query(
      `SELECT secret FROM cards WHERE product_id=? AND secret IN (?)`,
      [tgPending.productId, cards]);
    tgPending.cards = cards;
    tgPending.stage = 'await_confirm';
    tgPending.ts = Date.now();
    const preview = cards.length <= 5 ? cards.join('\n')
      : cards.slice(0, 3).join('\n') + `\n…（共 ${cards.length} 张）…\n` + cards[cards.length - 1];
    return tgReplyTracked(
      `请核对后确认入库：\n商品：${tgPending.label}\n数量：${cards.length} 张\n` +
      (dups.length ? `\n⚠️ 注意：有 ${dups.length} 张和库里已有卡密完全相同（可能重复粘贴了）\n` : '') +
      `\n${preview}`,
      [[{ text: `✅ 确认入库 ${cards.length} 张`, callback_data: 'confirm' }, { text: '❌ 取消', callback_data: 'cancel' }]]);
  }

  if (/^(库存|查库存|\/stock)$/i.test(raw)) {
    return tgReply('📦 当前库存：\n' + await tgStockText());
  }
  if (/^(补货|\/restock)/.test(raw)) {
    return tgRestockPicker();
  }
  // 其他任何消息（包括 /start）→ 菜单按钮
  return tgMenu();
}

let tgOffset = 0;
async function tgPollLoop() {
  for (;;) {
    try {
      const r = await tgApi('getUpdates', { offset: tgOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (r && r.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          tgOffset = u.update_id + 1;
          // 只认店主本人：消息看 chat.id，按钮回调看 from.id，其他人一律忽略
          if (u.message && u.message.text && String(u.message.chat && u.message.chat.id) === TG_CHAT) {
            try { await tgHandleText(u.message.text, u.message.message_id); }
            catch (e) { tgReply('处理出错：' + e.message); }
          } else if (u.callback_query && String(u.callback_query.from && u.callback_query.from.id) === TG_CHAT) {
            try { await tgHandleCallback(u.callback_query); }
            catch (e) { tgReply('处理出错：' + e.message); }
          }
        }
      } else {
        await new Promise(r2 => setTimeout(r2, 5000)); // 接口异常退避
      }
    } catch (_) {
      await new Promise(r2 => setTimeout(r2, 5000));
    }
  }
}

// 启动时自愈"卡网自动进货"所需的表结构（老库无需手动跑 SQL）
async function ensureShopSourceSchema() {
  const addColumn = async (sql) => {
    try { await pool.query(sql); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }   // 列已存在 → 幂等跳过
  };
  await addColumn(`ALTER TABLE products ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'local' COMMENT '货源：local=本地库存 / shop=卡网自动进货'`);
  await addColumn(`ALTER TABLE products ADD COLUMN shop_sku_id BIGINT NULL COMMENT '卡网 SKU ID（source=shop 时必填）'`);
  await addColumn(`ALTER TABLE products ADD COLUMN max_cost DECIMAL(10,2) NULL COMMENT '单件成本上限（卡网价超过则不自动进货）'`);
  await addColumn(`ALTER TABLE products ADD COLUMN auto_deliver TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=付款后自动发货 / 0=只提醒不自动发（TG 按钮或人工触发）'`);
  // 默认改为关：新品必须显式开启（幂等，重复执行无副作用）
  await pool.query(`ALTER TABLE products ALTER COLUMN auto_deliver SET DEFAULT 0`);
  await pool.query(`CREATE TABLE IF NOT EXISTS shop_purchases (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id VARCHAR(64) NOT NULL UNIQUE COMMENT '闲鱼订单号（一单最多一笔进货）',
    product_id BIGINT NOT NULL,
    shop_sku_id BIGINT NOT NULL,
    downstream_no VARCHAR(80) NOT NULL COMMENT '发给卡网的幂等单号（先落库再下单，崩溃重放不重复扣款）',
    attempt INT NOT NULL DEFAULT 1,
    shop_order_id BIGINT NULL,
    shop_order_no VARCHAR(64) NULL,
    amount VARCHAR(32) NULL COMMENT '实际扣款金额（对账用）',
    status VARCHAR(16) NOT NULL DEFAULT 'ordering' COMMENT 'ordering/ordered/imported/failed',
    error VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='卡网自动进货记录'`);
}

// 启动时自建"远程发货指令队列"表（新表，老库自愈，无需手动跑 SQL）
async function ensureDeliverCommandsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS deliver_commands (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id VARCHAR(64) NOT NULL UNIQUE,
    buyer VARCHAR(255) NOT NULL DEFAULT '',
    title VARCHAR(255) NOT NULL DEFAULT '',
    spec VARCHAR(255) NOT NULL DEFAULT '',
    price VARCHAR(32) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    result VARCHAR(255) NOT NULL DEFAULT '',
    source VARCHAR(16) NOT NULL DEFAULT 'tg',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function ensureFeedbackTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    version VARCHAR(32) NOT NULL DEFAULT '',
    ua VARCHAR(400) NOT NULL DEFAULT '',
    page VARCHAR(32) NOT NULL DEFAULT '',
    selector_audit TEXT,
    logs MEDIUMTEXT,
    description VARCHAR(4000) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='插件问题反馈'`);
}

// 默认只听 127.0.0.1。未设 AUTH_TOKEN 时禁止对外监听，直接拒绝启动。
const bindDecision = decideBind(process.env.BIND_HOST, AUTH_TOKEN);
if (!bindDecision.ok) {
  console.error('拒绝启动：' + bindDecision.error);
  console.error('请在 .env 设置 AUTH_TOKEN，或把 BIND_HOST 留空 / 设为 127.0.0.1。');
  process.exit(1);
}
const BIND = bindDecision.bind;
app.listen(PORT, BIND, async () => {
  console.log(`✓ 闲鱼助手后端已启动: http://${BIND}:${PORT}`);
  console.log(`  健康检查: /api/health`);
  try { await ensureDeliverCommandsTable(); } catch (e) { console.error('建表 deliver_commands 失败:', e.message); }
  try { await ensureShopSourceSchema(); } catch (e) { console.error('卡网进货表结构自愈失败:', e.message); }
  try { await ensureFeedbackTable(); } catch (e) { console.error('建表 feedback 失败:', e.message); }
  if (!AUTH_TOKEN) {
    console.log('  ⚠️ 未设置 AUTH_TOKEN，当前仅本机回环可访问。对外发布前务必设置令牌。');
  }
  if (shop.enabled()) {
    setInterval(shopPurchasePoller, 20 * 1000);   // 兜底轮询：发货请求没等到的进货单由它接手
    try {
      const pong = await shop.ping();
      console.log(pong && pong.ok
        ? `✓ 卡网自动进货已启用（余额 ${pong.balance || '?'} ${pong.currency || ''}）`
        : `⚠️ 卡网连接异常：${(pong && pong.error_message) || '未知错误'}`);
    } catch (e) { console.log('⚠️ 卡网连接失败:', e.message); }
  }
  if (TG_TOKEN && TG_CHAT) {
    tgPollLoop();
    console.log(`✓ Telegram 机器人已启动（远程查库存/补货/发货，只服务 chat ${TG_CHAT}）`);
  }
});
