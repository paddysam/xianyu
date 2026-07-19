/**
 * 卡网（dujiao-next）下游 API 客户端。
 *
 * 插件后端作为卡网的"下游站点"，用卡网的上游 API 自动进货：
 *   - 签名：HMAC-SHA256("{METHOD}\n{path}\n{unix秒}\n{md5(body)}")，
 *     头：Dujiao-Next-Api-Key / Dujiao-Next-Timestamp / Dujiao-Next-Signature
 *   - 下单：POST /api/v1/upstream/orders（钱包自动扣款；downstream_order_no 幂等，
 *     同一个号重复下单只会返回原订单，绝不会重复扣款）
 *   - 取货：GET /api/v1/upstream/orders/:id（交付后 fulfillment.payload 是卡密）
 *
 * .env 配置：SHOP_BASE_URL / SHOP_API_KEY / SHOP_API_SECRET
 * 三者齐全才启用；缺任何一个则 enabled() = false，发货逻辑退回纯本地库存。
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const BASE = (process.env.SHOP_BASE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.SHOP_API_KEY || '').trim();
const API_SECRET = (process.env.SHOP_API_SECRET || '').trim();
const TIMEOUT_MS = Number(process.env.SHOP_HTTP_TIMEOUT_MS || 15000);

const enabled = () => !!(BASE && API_KEY && API_SECRET);

function sign(method, path, timestamp, bodyStr) {
  const bodyMD5 = crypto.createHash('md5').update(bodyStr || '', 'utf8').digest('hex');
  const signString = `${method}\n${path}\n${timestamp}\n${bodyMD5}`;
  return crypto.createHmac('sha256', API_SECRET).update(signString, 'utf8').digest('hex');
}

/** 发签名请求。约定：卡网业务失败返回 200 + ok:false，网络/5xx 才抛异常 */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!enabled()) return reject(new Error('卡网货源未配置（SHOP_BASE_URL/API_KEY/API_SECRET）'));
    const bodyStr = body ? JSON.stringify(body) : '';
    const signPath = path.split('?')[0];         // 签名不含 query string
    const timestamp = Math.floor(Date.now() / 1000);
    const url = new URL(BASE + path);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, {
      method,
      headers: {
        'Dujiao-Next-Api-Key': API_KEY,
        'Dujiao-Next-Timestamp': String(timestamp),
        'Dujiao-Next-Signature': sign(method, signPath, timestamp, bodyStr),
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { /* 非 JSON 按错误处理 */ }
        if (!parsed) return reject(new Error(`卡网响应异常 HTTP ${res.statusCode}: ${String(data).slice(0, 200)}`));
        resolve(parsed);
      });
    });
    req.on('error', (e) => reject(new Error('卡网请求失败: ' + e.message)));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('卡网请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = {
  enabled,
  /** 余额/连通性检查 */
  ping: () => request('POST', '/api/v1/upstream/ping', {}),
  /** 商品列表（下单前核价/找 SKU 用）：{ ok, items:[{id, title, skus:[{id, price_amount, stock_quantity, is_active}]}], total } */
  listProducts: (page, pageSize) =>
    request('GET', `/api/v1/upstream/products?page=${page || 1}&page_size=${pageSize || 50}`),
  /**
   * 下单并钱包扣款。downstreamOrderNo 是幂等键：网络超时后用同一个号重试，
   * 卡网只会返回已存在的订单，不会再扣一次钱。
   * 返回：{ ok:true, order_id, order_no, status, amount } 或 { ok:false, error_code, error_message }
   */
  createOrder: ({ skuId, quantity, downstreamOrderNo, traceId }) =>
    request('POST', '/api/v1/upstream/orders', {
      sku_id: Number(skuId),
      quantity: Number(quantity) || 1,
      downstream_order_no: String(downstreamOrderNo),
      trace_id: String(traceId || downstreamOrderNo)
    }),
  /** 查单取货：交付完成后返回 fulfillment.payload（每行一张卡密） */
  getOrder: (orderId) => request('GET', `/api/v1/upstream/orders/${orderId}`)
};
