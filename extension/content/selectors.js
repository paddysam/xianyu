/**
 * 闲鱼卖家工作台 (seller.goofish.com #/im) DOM 选择器集中配置。
 *
 * 页面使用 CSS Modules，类名形如 "conversation-item--JReyg97P"，
 * 哈希后缀会随前端发版变化，所以全部用 [class*="前缀--"] 模糊匹配。
 * 以下选择器于 2026-07 在真实页面上验证通过。
 *
 * 页面改版导致失效时：
 *   1. F12 检查对应元素，找到新的类名前缀
 *   2. 在插件设置页「高级 → 选择器覆盖」里填 JSON 覆盖，无需改代码
 */
window.__XY_SELECTORS_DEFAULT = {
  // ===== 左侧会话列表 =====
  convItem: '[class*="conversation-item--"]',
  convActive: '[class*="conversation-item-active--"]',
  // 会话项内的订单状态标签（交易成功 / 等待卖家发货 / 等待买家收货）
  convOrderTag: '[class*="order-"]',
  // 未读角标（antd Badge 数字）
  convUnread: '.ant-badge sup, [class*="unread"]',

  // ===== 右侧聊天窗口 =====
  chatMain: '[class*="chat-main--"]',
  chatTopbar: '[class*="message-topbar--"]',
  msgList: '[class*="message-list-reverse--"]',
  msgRow: '[class*="message-row--"]',
  msgTextBuyer: '[class*="message-text-left--"]',
  msgTextMine: '[class*="message-text-right--"]',
  msgTips: '[class*="msg-tips--"]',

  // 右侧面板商品标题（当前宝贝 / 订单卡片）。发货前必须能读到，读不到就停止发货。
  productTitle: '[class*="itemName--"]',

  // ===== 可选：会话身份（拿不到时自动退化，不必覆盖）=====
  // 买家 userId / 会话 id。不要把选择器指到头像 img 上——文件名会串号。
  convUserId: '[data-userid], [data-user-id], [data-uid], [data-conversation-id], [data-session-id]',
  // 会话项里的商品标题、订单号，仅在没有 userId 时参与「昵称+标题+订单号」退化键
  convItemTitle: '[class*="itemName--"], [class*="itemTitle--"], [class*="item-title--"]',
  convOrderId: '[data-order-id], [data-orderid]',

  // ===== 输入区 =====
  inputBox: 'textarea.ant-input',
  // 发送按钮通过文本匹配（"发 送"中间有空格），此处是候选范围
  sendButtonScope: 'button'
};

/** 合并用户在设置页填写的覆盖项 */
window.__XY_MERGE_SELECTORS = function (overrides) {
  const base = { ...window.__XY_SELECTORS_DEFAULT };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(overrides)) {
      if (overrides[k] && typeof overrides[k] === 'string') base[k] = overrides[k];
    }
  }
  return base;
};
