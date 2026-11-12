/* =========================================================================
 * Service Worker
 * 职责：
 *   1. 图标角标显示今日投递数
 *   2. 打开「投递记录」表格页（复用已打开的标签）
 *   3. 代理大模型调用：content script 受页面 CSP 限制，跨域请求统一放这里，
 *      API Key 也只留在扩展进程里，不注入 BOSS 页面。
 * ========================================================================= */
'use strict';

/* ai-core.js 是纯函数模块：prompt 构造 / 响应解析 / 决策，方便单独测试 */
try { importScripts('ai-core.js'); } catch (e) {}
const AI = (typeof globalThis !== 'undefined' && globalThis.BaaAi) || null;

const STORE_KEY = 'baa_store_v1';
const RECORD_TAB_KEY = 'baa_records_tab';
const AI_CACHE_KEY = 'baa_ai_cache_v1';
const AI_CACHE_TTL = 7 * 24 * 3600 * 1000;
const AI_CACHE_MAX = 400;

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function updateBadge() {
  chrome.storage.local.get(STORE_KEY, (r) => {
    const s = r[STORE_KEY] || {};
    const n = (s.daily || {})[todayKey()] || 0;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#00969e' });
    chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ color: '#ffffff' });
  });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORE_KEY]) updateBadge();
});

function openRecordsTab() {
  const url = chrome.runtime.getURL('records/records.html');

  chrome.storage.local.get(RECORD_TAB_KEY, (r) => {
    const tabId = r[RECORD_TAB_KEY];

    const createNew = () => {
      chrome.tabs.create({ url }, (tab) => {
        if (tab && tab.id) chrome.storage.local.set({ [RECORD_TAB_KEY]: tab.id });
      });
    };

    if (!tabId) return createNew();

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return createNew();
      chrome.tabs.update(tabId, { active: true });
      if (tab.windowId) {
        try {
          chrome.windows.update(tab.windowId, { focused: true });
        } catch (e) {}
      }
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(RECORD_TAB_KEY, (r) => {
    if (r[RECORD_TAB_KEY] === tabId) chrome.storage.local.remove(RECORD_TAB_KEY);
  });
});

/* =========================================================================
 * AI 语义判断代理
 * ========================================================================= */
const aiStorageGet = (key) =>
  new Promise((res) => chrome.storage.local.get(key, (r) => res(r[key])));
const aiStorageSet = (key, val) =>
  new Promise((res) => chrome.storage.local.set({ [key]: val }, res));

async function readAiCache() {
  const c = await aiStorageGet(AI_CACHE_KEY);
  return c && typeof c === 'object' ? c : {};
}

async function aiCacheLookup(key) {
  const c = await readAiCache();
  const hit = c[key];
  if (!hit || !hit.v) return null;
  if (Date.now() - (hit.at || 0) > AI_CACHE_TTL) return null;
  return hit.v;
}

async function aiCacheWrite(key, val) {
  const c = await readAiCache();
  c[key] = { at: Date.now(), v: val };
  const keys = Object.keys(c);
  if (keys.length > AI_CACHE_MAX) {
    keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
    keys.slice(0, keys.length - AI_CACHE_MAX).forEach((k) => delete c[k]);
  }
  await aiStorageSet(AI_CACHE_KEY, c);
}

function originPattern(origin) {
  return String(origin).replace(/\/+$/, '') + '/*';
}

/** 内置服务商已写进 host_permissions，contains 直接为 true；
 *  自定义地址则尝试动态申请（不成功时给出可操作的提示，绝不静默失败）。 */
async function ensureOrigin(origin) {
  if (!chrome.permissions || !chrome.permissions.contains) return true;
  const pat = originPattern(origin);
  const has = await new Promise((res) =>
    chrome.permissions.contains({ origins: [pat] }, (v) => res(!!v))
  );
  if (has) return true;
  return new Promise((res) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      res(!!v);
    };
    setTimeout(() => finish(false), 1500);
    try {
      chrome.permissions.request({ origins: [pat] }, (v) => finish(v));
    } catch (e) {
      finish(false);
    }
  });
}

/** OpenAI 兼容的 chat/completions。不发 response_format，兼容性最好。 */
async function callChat(ep, messages, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ep.key
      },
      body: JSON.stringify({
        model: ep.model,
        messages: [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user }
        ],
        temperature: 0.1,
        max_tokens: 600,
        stream: false
      }),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 180) };
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '响应不是 JSON：' + text.slice(0, 120) };
    }
    let content = '';
    if (data.choices && data.choices[0]) {
      content = (data.choices[0].message && data.choices[0].message.content) || data.choices[0].text || '';
    }
    if (!content && data.output && data.output.text) content = data.output.text;
    if (!content) return { ok: false, error: '模型没有返回内容' };
    return { ok: true, content, usage: data.usage || null };
  } catch (e) {
    return {
      ok: false,
      error: e && e.name === 'AbortError'
        ? '请求超时'
        : '网络错误：' + (e && e.message ? e.message : String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

function aiConfigError(cfg) {
  if (!AI) return { ok: false, code: 'no_core', error: 'AI 模块未加载，请重新加载扩展' };
  if (!cfg.aiEnabled || cfg.aiProvider === 'off') return { ok: false, code: 'disabled' };
  return null;
}

async function handleAiJudge(payload) {
  payload = payload || {};
  const cfg = payload.cfg || {};
  const bad = aiConfigError(cfg);
  if (bad) return bad;

  const info = payload.info || {};
  const jd = String(info.jd || '').trim();
  // 没有 JD 全文就不花钱调模型，由调用方按「失败放行」走原规则
  if (jd.length < 40) return { ok: false, code: 'no_jd', error: 'JD 不足 40 字' };

  const ep = AI.resolveEndpoint(cfg);
  if (!ep.ok) return { ok: false, code: 'config', error: ep.error };

  const key = AI.aiCacheKey(payload);
  const cached = await aiCacheLookup(key);
  if (cached) {
    return {
      ok: true,
      cached: true,
      elapsed: 0,
      verdict: cached,
      decision: AI.aiDecision(cached, cfg)
    };
  }

  if (!(await ensureOrigin(ep.origin))) {
    return {
      ok: false,
      code: 'permission',
      error: '浏览器未授权访问 ' + ep.origin + '，请用内置服务商，或在扩展弹窗点「授权 API 域名」'
    };
  }

  const messages = AI.buildAiMessages(payload);
  const secs = Math.min(120, Math.max(3, Number(cfg.aiTimeout) || 20));
  const started = Date.now();
  const r = await callChat(ep, messages, Math.floor(secs * 1000));
  const elapsed = Date.now() - started;
  if (!r.ok) {
    return { ok: false, code: 'request', error: r.error, elapsed, jdChars: messages.jdChars };
  }
  const raw = AI.parseAiResponse(r.content);
  const verdict = AI.normalizeAiVerdict(raw);
  if (!verdict) {
    return {
      ok: false,
      code: 'parse',
      error: '模型输出不是可解析的 JSON',
      raw: String(r.content).slice(0, 200),
      elapsed,
      jdChars: messages.jdChars
    };
  }
  await aiCacheWrite(key, verdict);
  return {
    ok: true,
    cached: false,
    elapsed,
    verdict,
    decision: AI.aiDecision(verdict, cfg),
    jdChars: messages.jdChars,
    usage: r.usage
  };
}

async function handleAiTest(cfg) {
  if (!AI) return { ok: false, error: 'AI 模块未加载，请重新加载扩展' };
  const ep = AI.resolveEndpoint(cfg || {});
  if (!ep.ok) return { ok: false, error: ep.error };
  if (!(await ensureOrigin(ep.origin))) {
    return { ok: false, error: '未授权访问 ' + ep.origin + '，请用内置服务商或在扩展弹窗点「授权 API 域名」' };
  }
  const started = Date.now();
  const r = await callChat(
    ep,
    { system: '你只输出 JSON，不输出其它文字。', user: '请只输出 JSON：{"ok":true}' },
    15000
  );
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    model: ep.model,
    elapsed: Date.now() - started,
    reply: String(r.content).slice(0, 120)
  };
}

/** 串行执行，避免「测试连接」和自动投递同时打接口 */
let aiQueue = Promise.resolve();
function enqueueAi(fn) {
  const p = aiQueue.then(fn, fn);
  aiQueue = p.catch(() => {});
  return p;
}

/** fn 是「返回 Promise 的函数」：先执行再挂 then，同步抛错也能接住。 */
const aiReply = (fn) => (sendResponse) =>
  Promise.resolve()
    .then(fn)
    .then(
      (r) => sendResponse(r),
      (e) => sendResponse({ ok: false, code: 'exception', error: String((e && e.message) || e) })
    );

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'baa_open_records') {
    openRecordsTab();
    sendResponse({ ok: true });
  } else if (msg.type === 'baa_badge_refresh') {
    updateBadge();
    sendResponse({ ok: true });
  } else if (msg.type === 'baa_ai_judge') {
    aiReply(() => enqueueAi(() => handleAiJudge(msg.payload)))(sendResponse);
  } else if (msg.type === 'baa_ai_test') {
    aiReply(() => handleAiTest(msg.cfg || {}))(sendResponse);
  } else if (msg.type === 'baa_ai_clear_cache') {
    chrome.storage.local.remove(AI_CACHE_KEY, () => sendResponse({ ok: true }));
  } else if (msg.type === 'baa_ai_status') {
    chrome.storage.local.get(AI_CACHE_KEY, (r) => {
      const c = r[AI_CACHE_KEY] || {};
      sendResponse({ ok: true, cache: Object.keys(c).length, core: !!AI });
    });
  }

  return true;
});
