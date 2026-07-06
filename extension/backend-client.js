/**
 * 后端 API 客户端（content script 与设置页共用）。
 *
 * 所有请求都通过后台 Service Worker 转发（BACKEND_FETCH 消息）：
 *   - content script 跑在 https 页面里，直接 fetch http 后端会被"混合内容"拦截；
 *   - 后台 SW 是扩展源、非文档上下文，带 host 权限即可请求 http 后端，不受限制。
 *
 * 用 window.__XY_makeBackend(getConf) 创建实例，
 * getConf() 返回 { url, token }（url 为空表示未启用后端）。
 */
(function () {
  function makeBackend(getConf) {
    async function req(method, path, body) {
      const conf = getConf() || {};
      if (!conf.url) throw new Error('未配置后端地址');
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'BACKEND_FETCH', url: conf.url, token: conf.token, method, path, body },
          (r) => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(r);
          });
      });
      if (!resp) throw new Error('后台无响应');
      if (!resp.ok) throw new Error(resp.error || '请求失败');
      return resp.data;
    }

    return {
      enabled: () => !!(getConf() || {}).url,
      health: () => req('GET', '/api/health'),
      listProducts: () => req('GET', '/api/products'),
      createProduct: (p) => req('POST', '/api/products', p),
      updateProduct: (id, p) => req('PUT', '/api/products/' + id, p),
      deleteProduct: (id) => req('DELETE', '/api/products/' + id),
      listCards: (id) => req('GET', '/api/products/' + id + '/cards'),
      restock: (id, cards) => req('POST', '/api/products/' + id + '/cards', { cards }),
      // 标记某张卡已手动发货：从库存移除（置 used），机器人不会再自动发它
      manualDeliverCard: (id, cardId) => req('POST', '/api/products/' + id + '/cards/' + cardId + '/manual'),
      deliver: (order) => req('POST', '/api/deliver', order),
      rollbackDeliver: (orderId) => req('POST', '/api/deliver/rollback', { orderId }),
      listDeliveries: (limit) => req('GET', '/api/deliveries?limit=' + (limit || 200)),
      getKb: () => req('GET', '/api/kb'),
      saveKb: (kb) => req('PUT', '/api/kb', kb),
      getStyle: () => req('GET', '/api/style?limit=800'),
      addStyle: (samples) => req('POST', '/api/style', { samples })
    };
  }
  window.__XY_makeBackend = makeBackend;
})();
