// 生成静态预览页，用来在真实浏览器里核对弹层样式。
// 弹层 HTML 直接从 timezone.js 的 createRoot() 模板里抽出来，避免手抄走样。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'timezone.js'), 'utf8');
const match = code.match(/root\.innerHTML = `([\s\S]*?)`;/);
if (!match) throw new Error('createRoot template not found');
if (match[1].includes('${')) throw new Error('template unexpectedly interpolated');
// 不用 eval：先断言模板里没有 ${} 插值，再把 \uXXXX / \xXX 这类转义手动解回字符。
// 这样即使这段模板以后被改了，也只会得到一个明显的报错，而不是执行任意代码。
const decodeEscapes = value => value.replace(
  /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
  (whole, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') {
      const hex = esc[0] === 'u' && esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return { n: '\n', t: '\t', r: '\r' }[esc] ?? esc;
  }
);
const popover = decodeEscapes(match[1]);
if (popover.includes('\\u') || popover.includes('\\x')) {
  throw new Error('createRoot 模板里还有没解开的转义，检查上面的 decodeEscapes');
}
const css = fs.readFileSync(path.join(root, 'timezone.css'), 'utf8');

const stateScript = (opts) => `
  const root = document.getElementById('wat-region-time-root');
  root.querySelector('.wat-region').textContent = '乌克兰';
  root.querySelector('.wat-time').textContent = '${opts.time}';
  const presence = root.querySelector('.wat-presence');
  presence.hidden = ${opts.presenceHidden};
  presence.dataset.state = '${opts.presence}';
  presence.title = '客户${opts.presence === 'online' ? '在线' : '离线'}：${opts.presenceText}';
  root.querySelector('.wat-work').hidden = ${opts.workHidden};
  root.querySelector('.wat-phone').textContent = '+380676503011';
  root.querySelector('.wat-detail-region').textContent = '乌克兰';
  const ph = root.querySelector('.wat-presence-hint');
  ph.textContent = '${opts.presenceText}';
  ph.dataset.state = '${opts.presence}';
  const wh = root.querySelector('.wat-work-hint');
  wh.textContent = '${opts.workText}';
  wh.dataset.state = '${opts.workState}';
  root.querySelector('.wat-presence-toggle').checked = ${opts.presenceOn};
  root.querySelector('.wat-work-toggle').checked = ${opts.workOn};
  root.querySelector('.wat-language').innerHTML = '<option>自动：俄语（自动识别 99%）</option>';
  root.querySelector('.wat-profile').innerHTML = '<option>仓储设备</option>';
  root.querySelector('.wat-profile-hint').textContent = '优化货架、托盘、叉车、承载和安装术语';
  root.querySelector('.wat-timezone').innerHTML = '<option>Europe/Kyiv</option>';
  root.querySelector('.wat-manual-phone').value = '+380676503011';
  root.querySelector('.wat-popover-contact').textContent = 'Ihor Petrenko';
`;

const render = (opts) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>TransMate 弹层预览</title>
<style>
  body { margin: 0; padding: 28px; background: #eff2f5; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .mock-header { position: relative; display: flex; align-items: center; gap: 12px; width: 560px;
    padding: 10px 14px; border-radius: 10px; background: #f0f2f5; box-shadow: 0 1px 3px rgba(11,20,26,.14); }
  .mock-avatar { width: 38px; height: 38px; border-radius: 50%; background: #b9c6c2; }
  .mock-name { font-size: 15px; font-weight: 600; color: #111b21; }
  .mock-sub { font-size: 12.5px; color: #667781; }
  .mock-actions { margin-left: auto; color: #54656f; letter-spacing: 2px; }
  h1 { margin: 0 0 14px; font-size: 15px; color: #54656f; font-weight: 600; }
  .wrap { margin-bottom: 340px; }
  ${css}
  /* 预览里让弹层直接展开，不依赖点击。必须放在 timezone.css 之后，
     否则会被里面的 [hidden] { display: none !important } 盖掉。 */
  #wat-region-time-root .wat-popover[hidden] { display: block !important; }
</style></head>
<body>
<h1>${opts.title}</h1>
<div class="wrap">
  <div class="mock-header">
    <span class="mock-avatar"></span>
    <div>
      <div class="mock-name">Ihor Petrenko</div>
      <div class="mock-sub">${opts.subtitle}</div>
    </div>
    <span class="mock-actions">•••</span>
    <div id="wat-region-time-root" class="wat-root" data-position="status-line" data-state="known"
         style="position:absolute; left:300px; top:9px;">
      ${popover}
    </div>
  </div>
</div>
<script>${stateScript(opts)}</script>
</body></html>`;

const variants = {
  'preview-ui.html': {
    title: '状态 A：在线 + 非工作时段（默认态）',
    subtitle: '在线', time: '17:26',
    presence: 'online', presenceText: '在线', presenceHidden: false,
    presenceOn: true, workOn: true, workHidden: false, workState: 'out',
    workText: '客户当地时间 17:26，不在工作时段（09:00–18:00），距客户上班还有约 15 小时 34 分。'
  },
  'preview-ui-b.html': {
    title: '状态 B：离线 + 工作时段内 + 两个开关都关掉',
    subtitle: '最后上线时间 昨天 21:10', time: '11:05',
    presence: 'offline', presenceText: '最后上线时间 昨天 21:10', presenceHidden: false,
    presenceOn: false, workOn: false, workHidden: true, workState: 'in',
    workText: '客户当地时间 11:05，处于工作时段（09:00–18:00），可以直接发送。'
  },
  'preview-ui-c.html': {
    title: '状态 C：WhatsApp 不公开状态（指示灯自动收起）',
    subtitle: '在线', time: '11:05',
    presence: 'offline', presenceText: '—', presenceHidden: true,
    presenceOn: true, workOn: true, workHidden: true, workState: 'in',
    workText: '客户当地时间 11:05，处于工作时段（09:00–18:00），可以直接发送。'
  }
};

for (const [name, opts] of Object.entries(variants)) {
  fs.writeFileSync(path.join(__dirname, name), render(opts), 'utf8');
}
console.log('wrote', Object.keys(variants).join(', '));
