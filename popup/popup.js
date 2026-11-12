/* =========================================================================
 * 弹窗逻辑
 * ========================================================================= */
(function () {
  'use strict';

  const CFG_KEY = 'baa_cfg_v1';
  const STORE_KEY = 'baa_store_v1';

  const el = {
    pageState: document.getElementById('pageState'),
    today: document.getElementById('today'),
    limit: document.getElementById('limit'),
    state: document.getElementById('state'),
    tip: document.getElementById('tip'),
    mainBtn: document.getElementById('mainBtn'),
    openBtn: document.getElementById('openBtn'),
    recordsBtn: document.getElementById('recordsBtn'),
    aiState: document.getElementById('aiState'),
    permBtn: document.getElementById('permBtn')
  };

  let activeTab = null;
  let contentReady = false;
  let status = null;

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve((tabs && tabs[0]) || null);
      });
    });
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (!activeTab || !activeTab.id) return resolve(null);
      try {
        chrome.tabs.sendMessage(activeTab.id, msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function isZhipin(url) {
    return /^https:\/\/www\.zhipin\.com\//.test(url || '');
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function setTip(text, kind) {
    el.tip.textContent = text;
    el.tip.className = 'tip' + (kind ? ' ' + kind : '');
  }

  function render() {
    const onZhipin = activeTab && isZhipin(activeTab.url);

    if (!onZhipin) {
      el.pageState.textContent = '当前不在 BOSS 直聘';
      el.state.textContent = '—';
      el.mainBtn.disabled = true;
      el.mainBtn.textContent = '开始';
      el.openBtn.disabled = true;
      setTip('请先在 BOSS 直聘打开职位列表页，面板会出现在页面右下角。');
      return;
    }

    el.pageState.textContent = '已连接当前页面';
    el.openBtn.disabled = !contentReady;

    if (!contentReady) {
      el.state.textContent = '—';
      el.mainBtn.disabled = true;
      setTip('页面刚加载完，请刷新一次 BOSS 直聘页面以启用助手。');
      return;
    }

    el.mainBtn.disabled = false;

    if (status) {
      el.today.textContent = String(status.today || 0);
      el.limit.textContent = String(status.dailyLimit || 150);
      el.state.textContent = status.running ? '运行中' : '待机';

      if (status.running) {
        el.mainBtn.textContent = '停止';
        el.mainBtn.className = 'btn primary stop';
        setTip(
          '正在投递中，本次已扫描 ' + status.scanned + ' 个、跳过 ' + status.skipped + ' 个。',
          'ok'
        );
      } else {
        el.mainBtn.textContent = status.dryRun ? '试运行' : '开始';
        el.mainBtn.className = 'btn primary';
        setTip(
          status.dryRun
            ? '当前为演练模式：只会列出将要投递的岗位，不会真的点击。'
            : '准备好后点「开始」，助手会按设定间隔逐个投递。',
          status.dryRun ? 'warn' : 'ok'
        );
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */
  async function init() {
    activeTab = await queryActiveTab();

    // 读本地计数与配置（即使不在 zhipin 也能看到历史数据）
    chrome.storage.local.get([STORE_KEY, CFG_KEY], (r) => {
      const s = r[STORE_KEY] || {};
      const c = r[CFG_KEY] || {};
      el.today.textContent = String((s.daily || {})[todayKey()] || 0);
      el.limit.textContent = String(c.dailyLimit || 150);
      if (el.aiState) {
        el.aiState.textContent = c.aiEnabled ? 'AI 语义判断：已开启' : 'AI 语义判断：未启用';
      }
    });

    if (activeTab && isZhipin(activeTab.url)) {
      status = await sendToTab({ type: 'baa_status' });
      contentReady = !!status;
    }

    render();

    // 状态监听
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORE_KEY]) {
        const s = changes[STORE_KEY].newValue || {};
        el.today.textContent = String((s.daily || {})[todayKey()] || 0);
      }
      if (changes[CFG_KEY]) {
        const c = changes[CFG_KEY].newValue || {};
        if (c.dailyLimit) el.limit.textContent = String(c.dailyLimit);
        if (el.aiState) {
          el.aiState.textContent = c.aiEnabled ? 'AI 语义判断：已开启' : 'AI 语义判断：未启用';
        }
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */
  el.mainBtn.addEventListener('click', async () => {
    if (!contentReady) return;
    el.mainBtn.disabled = true;
    await sendToTab({ type: 'baa_toggle' });
    status = await sendToTab({ type: 'baa_status' });
    el.mainBtn.disabled = false;
    render();
    // 让用户看到面板状态
    setTimeout(() => window.close(), 260);
  });

  el.openBtn.addEventListener('click', async () => {
    if (!contentReady) return;
    await sendToTab({ type: 'baa_open' });
    window.close();
  });

  el.recordsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'baa_open_records' });
    window.close();
  });

  // 内置服务商已在 host_permissions 里；只有「自定义接口地址」需要在这里授权一次。
  // permissions.request 必须在用户点击的调用栈里执行，所以放在弹窗而不是后台。
  el.permBtn.addEventListener('click', () => {
    chrome.storage.local.get(CFG_KEY, (r) => {
      const c = r[CFG_KEY] || {};
      const base = String(c.aiBaseUrl || '').trim();
      if (!base) {
        setTip('请先到右下角面板里填好 AI 接口地址。', 'warn');
        return;
      }
      let origin;
      try {
        origin = new URL(base).origin;
      } catch (e) {
        setTip('接口地址不合法，应该是 https://… 开头。', 'warn');
        return;
      }
      const pat = origin + '/*';
      chrome.permissions.contains({ origins: [pat] }, (has) => {
        if (has) {
          setTip('这个接口域名已经授权过了，回面板点「测试连接」即可。', 'ok');
          return;
        }
        chrome.permissions.request({ origins: [pat] }, (granted) => {
          setTip(
            granted
              ? '已授权 ' + origin + '，回面板点「测试连接」。'
              : '授权未完成：也可以改用面板里的内置服务商（无需授权）。',
            granted ? 'ok' : 'warn'
          );
        });
      });
    });
  });

  init();
})();
