// 单测：Bing 搜索结果解析（纯函数，fixture 不联网）
'use strict';
const assert = require('assert');
const { parseSearchHtml } = require('../src/tools');

const html = `
<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.5258><link rel="stylesheet" href="/rp/x.css"/>
  <ul><li>嵌套的 li：sitelink</li></ul>
  <a href="https://example.com/snake" h="ID=SERP,5258.1"><h2>贪吃蛇游戏 <strong>教程</strong></h2></a>
  <div class="b_caption"><p>这是一个 &amp;nbsp; 贪吃蛇开发教程，包含 HTML 代码 &lt;示例&gt;。</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://example.org/js" h="ID=SERP,2">JavaScript 入门</a></h2>
  <p>零基础 JS 教程。</p>
</li>
<a aria-label="打开必应主页" href="/?FORM=Z9FD1" h="ID=SERP,5036.1"><svg></svg></a>
<li class="b_ans"><a href="https://example.com/ignored"><h2>不该出现</h2></a></li>
</ol></body></html>`;

const r = parseSearchHtml(html, 8);
assert.strictEqual(r.length, 2, '解析出 2 条');
assert.strictEqual(r[0].url, 'https://example.com/snake');
assert.strictEqual(r[0].title, '贪吃蛇游戏 教程', '标题去标签');
assert.ok(r[0].snippet.includes('贪吃蛇'), '摘要实体解码');
assert.ok(!r.some((x) => x.url.includes('ignored')), '非 b_algo 块被忽略');

const none = parseSearchHtml('<html></html>', 5);
assert.strictEqual(none.length, 0, '无结果返回空数组');

console.log('✓ Bing 解析：2 条正确解析、实体解码、异常块过滤、空页安全');
process.exit(0);
