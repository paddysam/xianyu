/**
 * 页面主世界桥接脚本（manifest 里以 world: "MAIN" 注入）。
 *
 * 内容脚本运行在隔离世界，拿不到页面的 window.lib.mtop（闲鱼带签名的请求库）。
 * 本脚本运行在页面主世界，复用页面已登录的 mtop 实例发权威请求，
 * 再通过 window.postMessage 把「脱敏后的最小字段」回传给内容脚本。
 *
 * 安全约束：
 *   - 只暴露白名单里的操作：只读查询（查订单/查规格），外加唯一一个写操作
 *     consignDummy（无需物流发货，仅推进订单状态，不涉及金额/改价/退款）。
 *     不暴露任意 API 调用。
 *   - 回传只包含判断发货所需字段，不外传买家隐私明细/token。
 */
(function () {
  'use strict';

  const TAG = 'XY_CS';   // 内容脚本 → 页面
  const RES = 'XY_PAGE'; // 页面 → 内容脚本

  function ready() {
    return window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function';
  }

  /** 从 itemVO.itemInfoLines 里抽出规格值（"规格"字段后面那个词） */
  function extractSpec(itemVO) {
    const lines = [];
    (function walk(x) {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (typeof x === 'object') {
        for (const k in x) {
          const v = x[k];
          if (typeof v === 'string' && v.trim()) lines.push(v.trim());
          else if (typeof v === 'object') walk(v);
        }
      }
    })(itemVO && itemVO.itemInfoLines);
    const gi = lines.indexOf('规格');
    return gi >= 0 && lines[gi + 1] ? lines[gi + 1] : '';
  }

  /** 把一个原始订单对象转成脱敏后的精简订单 */
  function toOrder(o) {
    const c = o.commonData || {};
    const item = o.itemVO || {};
    const price = o.priceVO || {};
    const buyer = o.buyerInfoVO || {};
    return {
      orderId: String(c.orderId || ''),
      itemId: String(c.itemId || ''),
      title: String(item.title || ''),
      spec: extractSpec(item),                       // 规格：新版 / 旧版 / 速刷号600积分 ...
      price: String(price.auctionPrice || price.totalPrice || ''), // 实付单价
      orderStatus: String(c.orderStatus || ''),      // 权威状态："待发货"/"已发货"/...
      inRefund: !!c.inRefund && c.inRefund !== 'false' && c.inRefund !== '0',
      buyerNick: String(buyer.userNick || '')
    };
  }

  async function fetchSoldList() {
    if (!ready()) throw new Error('页面 mtop 库未就绪');
    // 翻页拉取：积压超一页时，后面的单子也能轮到（上限 3 页防止极端情况拖垮轮询）
    const PAGE_SIZE = 50, MAX_PAGES = 3;
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await window.lib.mtop.request({
        api: 'mtop.taobao.idle.trade.merchant.sold.get',
        v: '1.0',
        data: { tabCode: 'waitSellerSend', pageNumber: page, pageSize: PAGE_SIZE }
      });
      const ok = res && res.ret && String(res.ret[0] || '').includes('SUCCESS');
      if (!ok) {
        if (page === 1) throw new Error('订单接口返回异常: ' + (res && res.ret));
        break; // 后续页失败不影响已拉到的
      }
      let arr = null;
      (function find(o, depth) {
        if (!o || typeof o !== 'object' || depth > 6 || arr) return;
        if (Array.isArray(o) && o.length && o[0] && o[0].commonData) { arr = o; return; }
        for (const k in o) if (o[k] && typeof o[k] === 'object') find(o[k], depth + 1);
      })(res.data, 0);
      out.push(...(arr || []).map(toOrder).filter(o => o.orderId));
      if (!arr || arr.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** 拉取"待发货"订单（发货流程用） */
  async function fetchWaitShipOrders() {
    return fetchSoldList();
  }

  /** 列出订单里出现过的所有「商品+规格+价格」组合（设置页选择用，避免手输出错） */
  async function listSkus() {
    const orders = await fetchSoldList();
    const seen = new Map();
    for (const o of orders) {
      const key = o.title + '|' + o.spec + '|' + o.price;
      if (o.title && !seen.has(key)) {
        seen.set(key, { title: o.title, spec: o.spec, price: o.price });
      }
    }
    return [...seen.values()];
  }

  /**
   * 无需物流发货（虚拟商品）：点亮订单的「发货」，把订单从"待发货"推进到"已发货"，
   * 之后买家系统自动确认收货完成交易，避免超时自动退款。
   * 契约取自闲鱼工作台自身代码（consign.dummy）。payload: { orderId, tradeText }
   * 成功返回 { orderId }；失败抛出错误信息。
   */
  async function consignDummy(payload) {
    if (!ready()) throw new Error('页面 mtop 库未就绪');
    const orderId = payload && payload.orderId;
    if (!orderId) throw new Error('缺少 orderId');
    const res = await window.lib.mtop.request({
      api: 'mtop.taobao.idle.logistics.merchant.consign.dummy',
      v: '1.0',
      data: {
        orderId: String(orderId),
        tradeText: (payload && payload.tradeText) || '',
        picList: '[]',
        newUnconsign: true
      }
    });
    const ok = res && ((res.data && res.data.orderId) ||
      (res.ret && String(res.ret[0] || '').includes('SUCCESS')));
    if (!ok) throw new Error('发货接口返回异常: ' + (res && res.ret));
    return { orderId: String(orderId) };
  }

  const handlers = {
    fetchWaitShipOrders,
    listSkus,
    consignDummy
  };

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== TAG || ev.source !== window) return;
    const { id, action } = msg;
    const fn = handlers[action];
    if (!fn) {
      window.postMessage({ source: RES, id, ok: false, error: '未知操作: ' + action }, '*');
      return;
    }
    try {
      const data = await fn(msg.payload);
      window.postMessage({ source: RES, id, ok: true, data }, '*');
    } catch (e) {
      window.postMessage({ source: RES, id, ok: false, error: String(e && e.message || e) }, '*');
    }
  });

  // 告知内容脚本桥已就绪
  window.postMessage({ source: RES, id: '__ready__', ok: true, data: 'bridge-ready' }, '*');
})();
