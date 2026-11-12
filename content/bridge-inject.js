/* =========================================================================
 * document_start 阶段把页面桥接脚本注入页面自身的 JS 世界。
 * content script 运行在 isolated world，碰不到页面的 fetch / XHR，
 * 只有页面世界的脚本才能拦到 BOSS 自己发出的接口请求。
 * ========================================================================= */
(function () {
  'use strict';
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/page-bridge.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { try { s.remove(); } catch (e) {} };
  } catch (e) {}
})();
