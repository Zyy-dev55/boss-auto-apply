/* =========================================================================
 * 投递记录 · 表格视图
 * 数据来源：chrome.storage.local 中的 baa_store_v1.applied
 * ========================================================================= */
(function () {
  'use strict';

  const STORE_KEY = 'baa_store_v1';
  const FONT_MAP_KEY = 'baa_font_map_v1';

  /** @type {{applied: Object<string, {t:string,c:string,s:string,a:string,at:number}>, daily: Object<string, number>}} */
  let store = { applied: {}, daily: {} };
  /** BOSS 加密数字 → 0-9 的映射，由 content script 在搜索页探测后写入 */
  let fontMap = {};

  function isPuaChar(ch) {
    const cp = String(ch).codePointAt(0);
    return (
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0xf0000 && cp <= 0xffffd) ||
      (cp >= 0x100000 && cp <= 0x10fffd)
    );
  }

  /** BOSS 用自定义字体把薪资数字映射成私用区字符，离开页面就显示成缺字方框。
   *  有映射表就还原成真实数字，没有就统一显示 ?，绝不再出现方块。 */
  function cell(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s)) {
      if (fontMap && fontMap[ch]) out += fontMap[ch];
      else if (isPuaChar(ch) || ch === '\ufffd') out += '?';
      else out += ch;
    }
    return out;
  }

  /** 数字一个都没还原出来时，给一句人话，别让表格里挂一串问号 */
  function salaryCell(s) {
    const t = cell(s);
    if (!t) return '';
    return t.indexOf('?') >= 0 ? '薪资加密' : t;
  }

  /** 大模型语义判断结论（旧记录没有这个字段，留空） */
  function aiCell(v) {
    if (!v || typeof v !== 'object') return '';
    return (typeof v.s === 'number' ? v.s + '分 · ' : '') +
      (v.h ? '硬性不符' : v.f ? '建议投' : '不太匹配');
  }

  function aiDetail(v) {
    if (!v || typeof v !== 'object') return '';
    return [cell(v.m || ''), cell(v.r || '')].filter(Boolean).join('｜');
  }

  /** 当前视图状态 */
  const view = {
    q: '',
    range: 'all',
    sortDesc: true
  };

  const el = {
    tbody: document.getElementById('tbody'),
    empty: document.getElementById('empty'),
    q: document.getElementById('q'),
    range: document.getElementById('range'),
    exportBtn: document.getElementById('exportBtn'),
    clearBtn: document.getElementById('clearBtn'),
    kTotal: document.getElementById('kTotal'),
    kToday: document.getElementById('kToday'),
    kCompany: document.getElementById('kCompany'),
    countText: document.getElementById('countText'),
    sortTh: document.querySelector('th[data-sort="at"]')
  };

  /* ------------------------------------------------------------------ *
   * 数据
   * ------------------------------------------------------------------ */
  function load() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORE_KEY, FONT_MAP_KEY], (r) => {
        const s = r[STORE_KEY] || {};
        fontMap = r[FONT_MAP_KEY] || {};
        store = {
          applied: s.applied || {},
          daily: s.daily || {}
        };
        resolve();
      });
    });
  }

  function save() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORE_KEY]: store }, resolve);
    });
  }

  function toRows() {
    return Object.keys(store.applied).map((key, i) => {
      const v = store.applied[key] || {};
      return {
        key,
        title: cell(v.t) || '(未解析)',
        company: cell(v.c),
        salary: salaryCell(v.s),
        area: cell(v.a),
        fresh: cell(v.p),
        req: cell(v.r),                            // 岗位详情识别出的硬性要求
        aiRaw: v.ai || null,                      // 大模型语义判断结论
        api: !!v.api,                             // 是否来自接口明文数据
        score: typeof v.m === 'number' ? v.m : -1,
        at: Number(v.at) || 0,
        _i: i
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 筛选 / 排序
   * ------------------------------------------------------------------ */
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function inRange(at) {
    if (view.range === 'all') return true;
    if (view.range === 'today') return at >= startOfToday();
    const days = Number(view.range);
    if (!days) return true;
    return at >= Date.now() - days * 86400000;
  }

  function currentRows() {
    const q = view.q.trim().toLowerCase();
    let rows = toRows().filter((r) => {
      if (!inRange(r.at)) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.company.toLowerCase().includes(q) ||
        r.area.toLowerCase().includes(q)
      );
    });

    rows.sort((a, b) => (view.sortDesc ? b.at - a.at : a.at - b.at));
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      ' ' +
      p(d.getHours()) +
      ':' +
      p(d.getMinutes())
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderKpi() {
    const all = toRows();
    const todayCount = all.filter((r) => r.at >= startOfToday()).length;
    const companies = new Set(all.map((r) => r.company).filter(Boolean));

    el.kTotal.textContent = String(all.length);
    el.kToday.textContent = String(todayCount);
    el.kCompany.textContent = String(companies.size);
  }

  function render() {
    renderKpi();

    const rows = currentRows();

    if (!rows.length) {
      el.tbody.innerHTML = '';
      el.empty.classList.add('show');
      el.countText.textContent =
        toRows().length === 0 ? '共 0 条' : '当前筛选下 0 条 / 共 ' + toRows().length + ' 条';
      el.exportBtn.disabled = toRows().length === 0;
      el.clearBtn.disabled = toRows().length === 0;
      return;
    }

    el.empty.classList.remove('show');
    el.exportBtn.disabled = false;
    el.clearBtn.disabled = false;

    const start = view.sortDesc ? rows.length : 1;
    const step = view.sortDesc ? -1 : 1;

    el.tbody.innerHTML = rows
      .map((r, i) => {
        const idx = start + step * i;
        const scoreHtml =
          r.score < 0
            ? '<span class="score na">—</span>'
            : '<span class="score' + (r.score < 70 ? ' mid' : '') + '">' + r.score + '</span>';

        return (
          '<tr>' +
          '<td class="idx">' + idx + '</td>' +
          '<td class="title" title="' + escapeHtml(r.title) + '">' + escapeHtml(r.title) + '</td>' +
          '<td class="company" title="' + escapeHtml(
            r.company || '旧记录没有公司信息；新版会读 BOSS 接口明文自动补齐'
          ) + '">' + escapeHtml(r.company || '未识别') + '</td>' +
          '<td class="salary" title="' + escapeHtml(r.salary || '') + '">' + escapeHtml(r.salary || '—') + '</td>' +
          '<td>' + scoreHtml + '</td>' +
          '<td>' + escapeHtml(r.area || '—') + '</td>' +
          '<td class="fresh">' + escapeHtml(r.fresh || '—') + '</td>' +
          '<td class="req" title="' + escapeHtml(r.req || '') + '">' +
            escapeHtml(r.req || (r.api ? '无硬性要求' : '—')) + '</td>' +
          '<td class="req" title="' + escapeHtml(aiDetail(r.aiRaw)) + '">' +
            escapeHtml(aiCell(r.aiRaw) || '—') + '</td>' +
          '<td class="time">' + fmtTime(r.at) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    el.countText.textContent =
      '共 ' + toRows().length + ' 条' + (rows.length !== toRows().length ? ' · 当前显示 ' + rows.length + ' 条' : '');
  }

  /* ------------------------------------------------------------------ *
   * 导出 CSV（带 BOM，Excel / WPS 直接打开不乱码）
   * ------------------------------------------------------------------ */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const rows = currentRows();
    if (!rows.length) {
      toast('当前没有可导出的记录');
      return;
    }

    const header = ['序号', '职位', '公司', '薪资', '匹配分', '地区', '发布时间', '岗位要求', 'AI 判断', '投递时间'];
    const lines = [header.map(csvCell).join(',')];

    const start = view.sortDesc ? rows.length : 1;
    const step = view.sortDesc ? -1 : 1;

    rows.forEach((r, i) => {
      lines.push(
        [
          start + step * i,
          r.title,
          r.company,
          r.salary,
          r.score < 0 ? '' : r.score,
          r.area,
          r.fresh,
          r.req,
          aiCell(r.aiRaw) + (aiDetail(r.aiRaw) ? '｜' + aiDetail(r.aiRaw) : ''),
          fmtTime(r.at)
        ]
          .map(csvCell)
          .join(',')
      );
    });

    const csv = '\ufeff' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp =
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    const suffix =
      view.range === 'all' ? '全部' : view.range === 'today' ? '今日' : '近' + view.range + '天';
    const name = 'BOSS投递记录_' + suffix + '_' + stamp + '.csv';

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    toast('已导出 ' + rows.length + ' 条记录');
  }

  /* ------------------------------------------------------------------ *
   * 清空
   * ------------------------------------------------------------------ */
  async function clearRecords() {
    const total = toRows().length;
    if (!total) return;

    const ok = window.confirm(
      '确定要清空全部 ' + total + ' 条投递记录吗？\n\n清空后去重也一并失效，同一岗位可能会被重复投递。\n建议先「导出表格」备份。'
    );
    if (!ok) return;

    store.applied = {};
    store.daily = {};
    await save();
    render();
    toast('记录已清空');
  }

  /* ------------------------------------------------------------------ *
   * 轻提示
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(text) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  let qTimer = null;
  el.q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      view.q = el.q.value;
      render();
    }, 160);
  });

  el.range.addEventListener('change', () => {
    view.range = el.range.value;
    render();
  });

  el.sortTh.addEventListener('click', () => {
    view.sortDesc = !view.sortDesc;
    el.sortTh.querySelector('.arrow').textContent = view.sortDesc ? '↓' : '↑';
    render();
  });

  el.exportBtn.addEventListener('click', exportCsv);
  el.clearBtn.addEventListener('click', clearRecords);

  // 记录页打开时若有新投递（另开标签页在跑），自动刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORE_KEY]) {
      const s = changes[STORE_KEY].newValue || {};
      store = { applied: s.applied || {}, daily: s.daily || {} };
      render();
    }
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  load().then(() => {
    render();
    // 键盘：Ctrl/Cmd + E 导出
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportCsv();
      }
    });
  });
})();
