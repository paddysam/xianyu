/**
 * 闲鱼智能客服助手 本地后端（MySQL）
 *
 * 提供给浏览器插件的 HTTP 接口：
 *   - 商品规则 CRUD（含每规则库存/已发统计）
 *   - 卡密库存：查看 / 补货
 *   - 发货：原子事务（去重 + 匹配规则 + 锁卡扣减 + 记录），保证不重发、不发错、并发安全
 *   - 知识库：关键词条目 + 店铺知识文本
 *
 * 只监听本机，供你自己的插件调用。启动：node server.js
 */
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');

const app = express();
app.use(cors());                       // 允许插件跨源调用
app.use(express.json({ limit: '2mb' }));

const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const PORT = Number(process.env.PORT || 8788);

// 简单令牌校验（AUTH_TOKEN 为空则跳过）
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
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

app.post('/api/products', wrap(async (req, res) => {
  const b = req.body || {};
  // 空标题的规则永远匹配不到订单，只会变成"(未命名)"垃圾行，拒收
  if (!b.match || !String(b.match).trim()) {
    return res.status(400).json({ ok: false, error: '商品标题匹配不能为空' });
  }
  const [r] = await pool.query(
    `INSERT INTO products (match_title, spec, price, mode, delivery, note)
     VALUES (?,?,?,?,?,?)`,
    [b.match || '', b.spec || '', b.price || '', b.mode || 'pool', b.delivery || '', b.note || '']);
  res.json({ ok: true, id: r.insertId });
}));

app.put('/api/products/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.match || !String(b.match).trim()) {
    return res.status(400).json({ ok: false, error: '商品标题匹配不能为空' });
  }
  await pool.query(
    `UPDATE products SET match_title=?, spec=?, price=?, mode=?, delivery=?, note=? WHERE id=?`,
    [b.match || '', b.spec || '', b.price || '', b.mode || 'pool', b.delivery || '', b.note || '', req.params.id]);
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
app.post('/api/deliver', wrap(async (req, res) => {
  const { orderId, title = '', spec = '', price = '', buyer = '', template = '' } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. 去重
    const [dup] = await conn.query('SELECT id FROM deliveries WHERE order_id=? FOR UPDATE', [orderId]);
    if (dup.length) {
      await conn.commit();
      return res.json({ ok: true, status: 'alreadyDelivered' });
    }

    // 2. 匹配规则
    const [prods] = await conn.query('SELECT * FROM products');
    const titleHits = prods.filter(p => p.match_title && title.includes(p.match_title));
    if (!titleHits.length) { await conn.commit(); return res.json({ ok: true, status: 'noRule' }); }
    const hits = titleHits.filter(p =>
      (!p.spec || p.spec === spec) && (!p.price || String(p.price) === String(price)));
    if (!hits.length) { await conn.commit(); return res.json({ ok: true, status: 'needManual' }); }
    // 优先最具体的规则（规格+价格都填 > 只填一个 > 全不限），
    // 避免"不限规格"兜底规则抢走本该走精确规格库存的订单
    hits.sort((a, b) =>
      ((b.spec ? 1 : 0) + (b.price ? 1 : 0)) - ((a.spec ? 1 : 0) + (a.price ? 1 : 0)));
    const rule = hits[0];

    // 3. 组装内容 + 扣卡
    let card = null, content, stockLeft = null;
    if ((rule.mode || 'pool') === 'pool') {
      const [cardRows] = await conn.query(
        `SELECT id, secret FROM cards WHERE product_id=? AND status='available'
         ORDER BY id LIMIT 1 FOR UPDATE`, [rule.id]);
      if (!cardRows.length) { await conn.commit(); return res.json({ ok: true, status: 'outOfStock' }); }
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
      if (!content) { await conn.commit(); return res.json({ ok: true, status: 'noContent' }); }
    }

    // 4. 记录发货
    await conn.query(
      `INSERT INTO deliveries (order_id, product_id, card_id, title, spec, price, buyer, content)
       VALUES (?,?,?,?,?,?,?,?)`,
      [orderId, rule.id, card ? card.id : null, title, spec, price, buyer, content]);

    await conn.commit();
    res.json({ ok: true, status: 'delivered', content, card: card ? card.secret : null, stockLeft });
  } catch (e) {
    await conn.rollback();
    // 唯一约束冲突（并发重发）→ 视为已发
    if (e.code === 'ER_DUP_ENTRY') return res.json({ ok: true, status: 'alreadyDelivered' });
    throw e;
  } finally {
    conn.release();
  }
}));

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

// 部署到远程服务器供本地浏览器插件访问时绑 0.0.0.0；只在本机用可设为 127.0.0.1
const BIND = process.env.BIND_HOST || '0.0.0.0';
app.listen(PORT, BIND, () => {
  console.log(`✓ 闲鱼助手后端已启动: http://${BIND}:${PORT}`);
  console.log(`  健康检查: /api/health`);
  if (BIND !== '127.0.0.1' && !AUTH_TOKEN) {
    console.log('  ⚠️ 已对外监听但未设置 AUTH_TOKEN，强烈建议在 .env 设置访问令牌！');
  }
});
