'use strict';
/**
 * 给 7 个页面注入：购物车按钮（顶栏）+ 抽屉 + 结算脚本
 * 幂等：已含 #cartDrawer 就跳过。
 */
const fs = require('fs');

const PAGES = ['hakuho.html', 'koyudo.html', 'takeda.html', 'n8.html', 'eihodo.html', 'chikuhodo.html', 'beautylish.html'];

const DRAWER = `
<div class="cart-overlay" id="cartOverlay" hidden></div>
<aside class="cart-drawer" id="cartDrawer" hidden aria-label="购物车" aria-live="polite">
  <header class="cart-head">
    <h2>购物车 <span class="cart-head-count" id="cartDrawerCount">0</span></h2>
    <button type="button" class="cart-close" id="cartClose" aria-label="关闭购物车">&times;</button>
  </header>
  <div class="cart-body" id="cartBody"></div>
  <footer class="cart-foot" id="cartFoot"></footer>
</aside>`;

for (const f of PAGES) {
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('id="cartDrawer"')) { console.log('  = 已有购物车 ' + f); continue; }

  // ① 顶栏加购物车按钮（放在 nav 后面）
  const navEnd = t.indexOf('</nav>');
  if (navEnd < 0) { console.log('  ✗ 找不到 nav ' + f); continue; }
  const cartBtn = '\n      <button type="button" class="js-cart-open cart-entry" aria-label="打开购物车">'
    + '购物车<span class="cart-badge" id="cartBadge" hidden>0</span></button>';
  t = t.slice(0, navEnd + '</nav>'.length) + cartBtn + t.slice(navEnd + '</nav>'.length);

  // ② 抽屉放在 </body> 前
  const bodyEnd = t.lastIndexOf('</body>');
  t = t.slice(0, bodyEnd) + DRAWER + '\n' + t.slice(bodyEnd);

  // ③ 脚本：site-config → cart → catalog（顺序重要，catalog 要用 window.Cart）
  t = t.replace(
    /(<script src="\.\/catalog\.js\?v=)(\d+)("><\/script>)/,
    '<script src="./site-config.js?v=$2"></script>\n  <script src="./cart.js?v=$2"></script>\n  $1$2$3'
  );

  fs.writeFileSync(f, t, 'utf8');
  console.log('  ✅ ' + f);
}
console.log('\n完成。');
