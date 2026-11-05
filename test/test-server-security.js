/**
 * 自测：server.js 的监听决策、CORS、反馈体积和限频。
 * 只从源码抽出纯函数，不启动 HTTP、不连数据库。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = SRC.match(re);
  if (!m) throw new Error('源码里找不到函数: ' + name);
  let i = m.index, depth = 0, start = -1;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') { if (start < 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) return SRC.slice(m.index, i + 1); }
  }
  throw new Error('brace 不闭合: ' + name);
}

const fnNames = ['isLoopbackHost', 'decideBind', 'isCorsOriginAllowed', 'feedbackByteLength', 'feedbackWithinLimit', 'allowFeedbackRate'];
const sandbox = { URL, Buffer, console };
vm.createContext(sandbox);
vm.runInContext(fnNames.map(extract).join('\n\n') + '\nthis.__fns = {' + fnNames.join(',') + '};', sandbox);
const F = sandbox.__fns;

let pass = 0, fail = 0;
function eq(desc, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + '\n      期望 ' + e + '\n      实际 ' + a); }
}
function ok(desc, v) { eq(desc, !!v, true); }

console.log('\n[S] decideBind 默认本机，无令牌拒绝对外');
eq('没写 BIND_HOST → 127.0.0.1', F.decideBind('', '').bind, '127.0.0.1');
eq('没写地址且无令牌 → 允许启动（只回环）', F.decideBind(undefined, '').ok, true);
eq('显式 127.0.0.1 无令牌 → 允许', F.decideBind('127.0.0.1', '').ok, true);
eq('localhost 无令牌 → 允许', F.decideBind('localhost', '  ').ok, true);
eq('::1 无令牌 → 允许', F.decideBind('::1', '').ok, true);
const denied = F.decideBind('0.0.0.0', '');
eq('0.0.0.0 且无令牌 → 拒绝启动', denied.ok, false);
ok('拒绝原因提到 AUTH_TOKEN', String(denied.error).includes('AUTH_TOKEN'));
eq('0.0.0.0 且有令牌 → 允许', F.decideBind('0.0.0.0', 'secret-token').ok, true);
eq('有令牌时沿用调用方地址', F.decideBind('0.0.0.0', 'secret-token').bind, '0.0.0.0');

console.log('\n[S2] CORS 不是 *');
eq('无 Origin（curl / 同源）放行', F.isCorsOriginAllowed(''), true);
eq('字面量 * 拒绝', F.isCorsOriginAllowed('*'), false);
eq('chrome-extension 放行', F.isCorsOriginAllowed('chrome-extension://ihmlaefggchpddfhnhnkjloifdicfcli'), true);
eq('本机 http 放行', F.isCorsOriginAllowed('http://127.0.0.1:8788'), true);
eq('localhost 放行', F.isCorsOriginAllowed('http://localhost:8788'), true);
eq('任意网站拒绝', F.isCorsOriginAllowed('https://evil.example'), false);
eq('非法 Origin 拒绝', F.isCorsOriginAllowed('::::'), false);

console.log('\n[S3] 反馈体积与限频');
eq('小正文在 64KB 内', F.feedbackWithinLimit({ description: '打不开会话' }, 64 * 1024), true);
const big = { description: 'x'.repeat(70 * 1024) };
eq('超过 64KB → 拒绝', F.feedbackWithinLimit(big, 64 * 1024), false);
ok('字节数确实超过 64KB', F.feedbackByteLength(big) > 64 * 1024);
const now = 1_000_000;
let slot = F.allowFeedbackRate([], now, 600000, 5);
eq('第 1 次允许', slot.ok, true);
for (let i = 0; i < 4; i++) slot = F.allowFeedbackRate(slot.hits, now + i + 1, 600000, 5);
eq('第 5 次仍允许', slot.ok, true);
slot = F.allowFeedbackRate(slot.hits, now + 10, 600000, 5);
eq('第 6 次限频', slot.ok, false);
slot = F.allowFeedbackRate(slot.hits, now + 600001, 600000, 5);
eq('窗口过去后恢复', slot.ok, true);

console.log('\n===== server.js 安全: ' + pass + ' 通过, ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
