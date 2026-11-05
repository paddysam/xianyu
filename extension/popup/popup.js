const $ = (id) => document.getElementById(id);

async function render() {
  const { settings = {}, stats = {}, logs = [] } =
    await chrome.storage.local.get(['settings', 'stats', 'logs']);
  $('enabled').checked = !!settings.enabled;
  if (window.__XY_renderSelectorWarn) await window.__XY_renderSelectorWarn();
  $('stReplies').textContent = stats.repliesSent || 0;
  $('stDeliveries').textContent = stats.deliveriesSent || 0;
  $('stAi').textContent = stats.aiCalls || 0;

  const box = $('logs');
  if (!logs.length) {
    box.innerHTML = '<div class="empty">暂无日志</div>';
  } else {
    box.innerHTML = '';
    for (const l of [...logs].reverse().slice(0, 50)) {
      const d = document.createElement('div');
      d.className = 'log ' + (l.level || 'info');
      const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false });
      d.innerHTML = `<span class="t">${t}</span>`;
      d.appendChild(document.createTextNode(l.text || ''));
      box.appendChild(d);
    }
  }
}

$('enabled').addEventListener('change', async (e) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.enabled = e.target.checked;
  await chrome.storage.local.set({ settings });
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('clearLogs').addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
  render();
});

chrome.storage.onChanged.addListener(render);
render();
