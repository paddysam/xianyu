/**
 * 弹窗 / 设置页共用：反馈问题。
 * 附带版本、UA、选择器自检、脱敏日志和用户描述，POST 到后端 /api/feedback。
 * 没配后端或提交失败时，降级为打开 GitHub issue（正文同样脱敏）。
 */
(function () {
  const GITHUB_NEW_ISSUE = 'https://github.com/paddysam/xianyu/issues/new';
  const MAX_BYTES = 60 * 1024;

  function redactFeedbackText(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[secret]');
    s = s.replace(/\b\d{6,}:[A-Za-z0-9_-]{10,}\b/g, '[tg-token]');
    s = s.replace(/(密码|卡密|token|api[_-]?key|secret|AUTH_TOKEN)\s*[:：=]\s*\S+/gi, '$1:[redacted]');
    s = s.split('\n').map(line => (/----|\|\|/.test(line) ? '[redacted-card]' : line)).join('\n');
    return s;
  }

  function byteLen(obj) {
    try { return new Blob([JSON.stringify(obj)]).size; }
    catch (_) { return JSON.stringify(obj).length; }
  }

  async function renderSelectorWarn() {
    const el = document.getElementById('selectorWarn');
    if (!el || !chrome.storage) return;
    const { selectorAudit } = await chrome.storage.local.get('selectorAudit');
    if (!selectorAudit || selectorAudit.ok !== false) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const parts = [];
    if (selectorAudit.missing && selectorAudit.missing.length) parts.push('缺少 ' + selectorAudit.missing.join('、'));
    if (selectorAudit.invalid && selectorAudit.invalid.length) parts.push('非法 ' + selectorAudit.invalid.join('、'));
    if (selectorAudit.domBroken) parts.push('页面上找不到会话列表或输入框');
    el.hidden = false;
    el.textContent = '选择器自检未通过：' + (parts.join('；') || '请检查高级设置里的选择器覆盖') + '。自动回复/发货可能失效。';
  }
  window.__XY_renderSelectorWarn = renderSelectorWarn;

  async function buildPayload(description, page) {
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    const { selectorAudit, logs } = await chrome.storage.local.get(['selectorAudit', 'logs']);
    const cleanLogs = (Array.isArray(logs) ? logs : []).slice(-30).map(l => ({
      t: l && l.ts ? new Date(l.ts).toLocaleString('zh-CN', { hour12: false }) : '',
      level: (l && l.level) || 'info',
      text: redactFeedbackText(l && l.text).slice(0, 500)
    }));
    const payload = {
      version: ver,
      ua: navigator.userAgent || '',
      page: page || '',
      selectorAudit: selectorAudit || null,
      logs: cleanLogs,
      description: redactFeedbackText(description).slice(0, 4000)
    };
    while (payload.logs.length && byteLen(payload) > MAX_BYTES) payload.logs.shift();
    if (byteLen(payload) > 64 * 1024) {
      payload.logs = [];
      payload.ua = String(payload.ua).slice(0, 180);
      payload.description = String(payload.description).slice(0, 1500);
    }
    return payload;
  }

  function githubIssueUrl(payload) {
    const title = '[反馈] 闲鱼助手 ' + (payload.version || '');
    const lines = (payload.logs || []).map(l => (l.t || '') + ' ' + (l.level || '') + ' ' + (l.text || ''));
    const body = [
      '## 描述',
      payload.description || '',
      '',
      '## 环境',
      '- 版本: ' + (payload.version || ''),
      '- 页面: ' + (payload.page || ''),
      '- UA: ' + (payload.ua || ''),
      '- 选择器自检: ' + JSON.stringify(payload.selectorAudit || null),
      '',
      '## 日志（已脱敏）',
      '```',
      lines.join('\n').slice(0, 2500),
      '```'
    ].join('\n');
    return GITHUB_NEW_ISSUE + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body.slice(0, 4500));
  }

  async function postFeedback(payload) {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const url = String(settings.backendUrl || '').trim();
    if (!url) return { ok: false, noBackend: true, error: '未配置后端地址' };
    const resp = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({
          type: 'BACKEND_FETCH',
          url: url,
          token: settings.backendToken || '',
          method: 'POST',
          path: '/api/feedback',
          body: payload
        }, r => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
    if (!resp || resp.ok === false) return { ok: false, error: (resp && resp.error) || '提交失败' };
    return { ok: true };
  }

  function showFallback(statusEl, payload, message) {
    statusEl.textContent = '';
    const span = document.createElement('span');
    span.textContent = message + ' ';
    const a = document.createElement('a');
    a.href = githubIssueUrl(payload);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '改到 GitHub 开 Issue';
    statusEl.appendChild(span);
    statusEl.appendChild(a);
  }

  function openDialog(page) {
    let mask = document.getElementById('xyFeedbackMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'xyFeedbackMask';
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:12px;';
      const form = document.createElement('form');
      form.id = 'xyFeedbackForm';
      form.style.cssText = 'width:100%;max-width:420px;background:#fff;color:#1e2430;border-radius:12px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:13px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;';
      const title = document.createElement('b');
      title.textContent = '反馈问题';
      title.style.cssText = 'display:block;font-size:14px;margin-bottom:6px;';
      const meta = document.createElement('p');
      meta.id = 'xyFeedbackMeta';
      meta.style.cssText = 'margin:0 0 8px;color:#64748b;font-size:12px;';
      const ta = document.createElement('textarea');
      ta.id = 'xyFeedbackDesc';
      ta.required = true;
      ta.maxLength = 4000;
      ta.placeholder = '发生了什么？你期望怎样？不要粘贴卡密、密码或令牌。';
      ta.style.cssText = 'width:100%;min-height:96px;box-sizing:border-box;border:1px solid #e4e8ee;border-radius:8px;padding:8px;font:inherit;resize:vertical;';
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = '提交';
      submit.style.cssText = 'padding:6px 14px;border:none;border-radius:8px;background:#ffe600;font-weight:700;cursor:pointer;';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.id = 'xyFeedbackCancel';
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:6px 14px;border:1px solid #e4e8ee;border-radius:8px;background:#fff;cursor:pointer;';
      const status = document.createElement('p');
      status.id = 'xyFeedbackStatus';
      status.style.cssText = 'margin:8px 0 0;font-size:12px;word-break:break-all;';
      actions.appendChild(submit);
      actions.appendChild(cancel);
      form.appendChild(title);
      form.appendChild(meta);
      form.appendChild(ta);
      form.appendChild(actions);
      form.appendChild(status);
      mask.appendChild(form);
      document.body.appendChild(mask);
      cancel.addEventListener('click', () => { mask.style.display = 'none'; });
      mask.addEventListener('click', (e) => { if (e.target === mask) mask.style.display = 'none'; });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const desc = ta.value.trim();
        if (!desc) { status.textContent = '请先写一下问题描述'; return; }
        submit.disabled = true;
        status.textContent = '正在提交…';
        let payload;
        try { payload = await buildPayload(desc, form.dataset.page || page); }
        catch (err) {
          submit.disabled = false;
          status.textContent = '收集环境信息失败：' + (err && err.message || err);
          return;
        }
        const result = await postFeedback(payload);
        submit.disabled = false;
        if (result.ok) {
          status.textContent = '已提交，感谢反馈。';
          ta.value = '';
          return;
        }
        const why = result.noBackend ? '当前没配置本地后端。' : ('提交失败：' + (result.error || '未知错误') + '。');
        showFallback(status, payload, why);
      });
    }
    const form = mask.querySelector('#xyFeedbackForm');
    form.dataset.page = page || 'popup';
    mask.style.display = 'flex';
    const meta = mask.querySelector('#xyFeedbackMeta');
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    chrome.storage.local.get(['selectorAudit', 'logs']).then(({ selectorAudit, logs }) => {
      const auditText = !selectorAudit ? '尚未自检' : (selectorAudit.ok === false ? '未通过' : '通过');
      const n = Math.min(30, (logs || []).length);
      meta.textContent = '将附带版本 ' + ver + '、浏览器 UA、选择器自检（' + auditText + '）、最近 ' + n + ' 条脱敏日志。';
    }).catch(() => { meta.textContent = '将附带版本 ' + ver + ' 和浏览器 UA。'; });
    const ta = mask.querySelector('#xyFeedbackDesc');
    if (ta) ta.focus();
  }

  function bind() {
    const btn = document.getElementById('openFeedback');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openDialog(btn.dataset.page || 'popup');
      });
    }
    renderSelectorWarn().catch(() => {});
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.selectorAudit) renderSelectorWarn().catch(() => {});
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
