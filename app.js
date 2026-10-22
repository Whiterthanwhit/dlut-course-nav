/* 大工选课与培养方案导航 · 前端逻辑（交互与呈现层）
 * 数据：window.DLUT_DATA（programs + catalog，由 tools/build_data.py 生成）
 * 原则：数字一律来自数据表；LLM 只负责「归纳措辞」；未接入的数据明确显示为「待接入」。
 */
(function () {
  'use strict';

  var DATA = window.DLUT_DATA;
  var resultEl = document.getElementById('result');

  if (!DATA || !DATA.programs) {
    resultEl.innerHTML = '<div class="empty"><p class="empty-title">数据未加载</p>' +
      '<p class="empty-sub">请确认 web/data.js 存在，或先运行 tools/build_data.py。</p></div>';
    return;
  }

  var CAMPUS = {};
  DATA.campuses.forEach(function (c) { CAMPUS[c.id] = c; });

  var CATALOG = (DATA.catalog && DATA.catalog.majors) || [];
  var PROGRAM_BY_ID = {};
  DATA.programs.forEach(function (p) { PROGRAM_BY_ID[p.id] = p; });

  var CATALOG_URL = (DATA.catalog && DATA.catalog.meta && DATA.catalog.meta.source) ||
    'https://teach.dlut.edu.cn/info/1031/16418.htm';

  var state = {
    campus: '',
    grade: '',
    current: null,
    glm: loadGlm(),
    apiMode: 'local',   // local | remote（/api/ask 可用时自动切换）
    retryRemoteAt: 0,   // 远程网络失败后的自动重试冷却时间戳（0 = 不自动重试）
    busyQuery: null,    // 在途远程请求的查询词（防重复点击并发）
    inFlight: null,     // 在途请求的 promise（重复点击时复用）
    askCtrl: null       // 在途请求的 AbortController（新查询时取消旧请求）
  };

  var CHIPS = ['计算机', '软工', '盘锦化工', '集成电路', '海洋技术', '土木', '临床医学', '建筑学'];

  /* ---------------- 工具 ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u3000（）()【】\[\]·、，,。.／/\-—_~“”"'':：;；]/g, '');
  }

  // v2：旧版本把接口地址存在 dlut.glm，可能残留失效的 Worker/根地址，直接弃用
  var GLM_STORE = 'dlut.glm.v2';

  function loadGlm() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(GLM_STORE) || '{}') || {}; }
    catch (e) { saved = {}; }
    var ep = String(saved.endpoint || 'https://submissions-lucia-chips-volumes.trycloudflare.com/api/glm').trim();
    ep = ep.replace(/\/+$/, '');
    if (!/\/api\/glm$/.test(ep)) ep += '/api/glm';   // 允许只填域名/根地址
    return {
      endpoint: ep,
      model: saved.model || 'glm-4-flash',
      apiKey: saved.apiKey || ''
    };
  }

  function saveGlm(v) {
    try { localStorage.setItem(GLM_STORE, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function programFor(major) {
    if (!major) return null;
    if (major.programId && PROGRAM_BY_ID[major.programId]) return PROGRAM_BY_ID[major.programId];
    for (var i = 0; i < DATA.programs.length; i++) {
      var p = DATA.programs[i];
      if (p.major === major.name && p.campus === major.campus) return p;
    }
    return null;
  }

  /* ---------------- 检索服务（/api/ask）与回退 ---------------- */

  function setApiMode(mode, label) {
    state.apiMode = mode;
    var el = document.getElementById('apiPill');
    if (el) {
      el.textContent = '检索：' + label;
      el.title = mode === 'remote' ? '/api/ask 已连接' : '未连接检索服务，使用本地匹配';
    }
  }

  function showNotice(text, ms) {
    var el = document.getElementById('notice');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(function () { el.hidden = true; }, ms || 4500);
  }

  function setBusy(busy) {
    var go = document.getElementById('go');
    if (!go) return;
    go.disabled = !!busy;
    go.textContent = busy ? '查询中…' : '查询';
  }

  // 检索服务地址：默认同源；分离部署时在 index.html 的 <meta name="dlut-api"> 填 API 域名
  var API_BASE = (function () {
    var meta = document.querySelector('meta[name="dlut-api"]');
    var base = (meta && meta.getAttribute('content')) || window.DLUT_API_BASE || '';
    return String(base).replace(/\/+$/, '');
  })();

  function detectApi() {
    if (location.protocol === 'file:') { setApiMode('local', '本地'); return Promise.resolve(); }
    // 健康探测加 1.5s 超时：连接挂起时不能让 ?q= 直达查询无限期停在空状态
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 1500) : null;
    function settle() { if (timer) clearTimeout(timer); }
    return fetch(API_BASE + '/api/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        settle();
        if (h && h.ask_ready) setApiMode('remote', '服务');
        else setApiMode('local', '本地');
      }).catch(function () {
        settle();
        setApiMode('local', '本地');
      });
  }

  function askRemote(q) {
    return new Promise(function (resolve, reject) {
      // 新查询取消旧请求（与 search 的序号丢弃配合，旧响应/旧失败都不会上屏）
      if (state.askCtrl) { try { state.askCtrl.abort(); } catch (e) { /* 已结束 */ } }
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      state.askCtrl = ctrl;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) ctrl.abort();
        reject(new Error('超时'));
      }, 8000);  // 服务端 /api/ask 含 GLM 润色时典型耗时 1-5s，2.5s 会必然超时

      fetch(API_BASE + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          campus: state.campus || undefined,
          grade: state.grade || undefined
        }),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(data);
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function campusId(v) {
    if (!v) return '';
    if (CAMPUS[v]) return v;
    for (var k in CAMPUS) { if (CAMPUS[k].name === v) return k; }
    return '';
  }

  function findMajor(name, campus) {
    var cid = campusId(campus);
    for (var i = 0; i < CATALOG.length; i++) {
      var m = CATALOG[i];
      if (m.name === name && (!cid || m.campus === cid)) return m;
    }
    return null;
  }

  function applyRemoteSummary(summary, p) {
    var box = document.getElementById('summary');
    var tag = document.getElementById('sumTag');
    if (!box || !tag || !summary || !summary.text) return;
    // 数字一致性护栏：GLM 摘要必须包含本地数据的总学分，否则视为不可信，保留本地模板
    if (summary.mode === 'glm' && p && summary.text.indexOf(String(p.totalCredits)) === -1) {
      tag.textContent = '数字校验未过 · 本地';
      tag.className = 'tag warn';
      return;
    }
    box.textContent = summary.text;
    box.classList.remove('loading');
    tag.textContent = summary.mode === 'glm' ? '服务 · GLM' : '服务 · 模板';
    tag.className = summary.mode === 'glm' ? 'tag glm' : 'tag';
  }

  function renderRemote(ans, q) {
    var kind = ans && ans.kind;

    if (kind === 'program' && ans.program) {
      var major = findMajor(ans.program.major, ans.program.campus);
      var prog = major ? programFor(major) : null;
      if (!prog) throw new Error('服务返回的专业不在本地目录');
      renderProgram(prog, ans.note || '', '检索服务', major, ans.citations);
      applyRemoteSummary(ans.summary, prog);
      return;
    }

    if (kind === 'pending') {
      var m = findMajor(ans.major && ans.major.name, ans.major && ans.major.campus);
      if (!m) throw new Error('服务返回的专业不在本地目录');
      renderPending(m, ans.note || '');
      return;
    }

    if (kind === 'candidates') {
      // 优先渲染服务端返回的候选（映射到本地目录，状态与数字仍以本地数据为准），
      // 服务候选无法映射时退回本地匹配，最终为空则明确提示未命中
      var seen = {};
      var mapped = [];
      (ans.candidates || []).forEach(function (c) {
        var cm = c && c.major && findMajor(c.major.name, c.major.campus);
        if (cm && !seen[cm.id]) { seen[cm.id] = 1; mapped.push(cm); }
      });
      var items = mapped.map(function (cm) { return { major: cm, program: programFor(cm) }; });
      if (!items.length) items = resolve(q).list;
      if (!items.length) { renderNotFound(q); return; }
      renderCandidates(items, q, ans.note || '');
      return;
    }

    if (kind === 'none') { renderNotFound(q); return; }
    if (kind === 'catalog') { renderCatalog(); return; }

    throw new Error('返回格式无法识别');
  }

  /* ---------------- 匹配 ---------------- */

  function similarity(n, nq) {
    if (!n || !nq) return 0;
    if (n === nq) return 100;
    if (n.indexOf(nq) === 0 || nq.indexOf(n) === 0) return 85;
    if (n.indexOf(nq) !== -1 || nq.indexOf(n) !== -1) return 70;
    return 0;
  }

  function overlap(name, nq) {
    var target = {};
    norm(name).split('').forEach(function (c) { target[c] = 1; });
    var chars = {};
    nq.split('').forEach(function (c) { chars[c] = 1; });
    var keys = Object.keys(target);
    if (!keys.length) return 0;
    var hit = keys.filter(function (c) { return chars[c]; }).length;
    return hit / keys.length;
  }

  function resolve(query) {
    var nq = norm(query);
    var list = [];

    CATALOG.forEach(function (m) {
      if (state.campus && m.campus !== state.campus) return;
      var prog = programFor(m);
      var names = [m.name].concat(prog ? (prog.aliases || []) : []);
      var best = 0;
      var via = '';

      for (var i = 0; i < names.length; i++) {
        var s = similarity(norm(names[i]), nq);
        if (s > best) { best = s; via = names[i]; }
      }
      if (!best && nq.length >= 2) {
        var ratio = overlap(m.name, nq);
        if (ratio >= 0.6) { best = 40 + Math.round(ratio * 20); via = '字面相近'; }
      }
      if (best) list.push({ major: m, program: prog, score: best, via: via });
    });

    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (!!b.program !== !!a.program) return b.program ? 1 : -1;
      return a.major.seq - b.major.seq;
    });

    var note = '';
    if (state.grade && list.length) {
      var withProg = list.filter(function (x) { return x.program; });
      var exact = withProg.filter(function (x) { return String(x.program.grade) === String(state.grade); });
      if (exact.length) {
        list = exact;
      } else if (withProg.length) {
        note = state.grade + ' 级方案尚未接入，以下为最近可用的 ' + withProg[0].program.grade + ' 级方案。';
      }
    }
    return { list: list, note: note };
  }

  /* ---------------- 摘要 ---------------- */

  function localSummary(p) {
    var camp = CAMPUS[p.campus] ? CAMPUS[p.campus].short : p.campus;
    var mods = p.modules.map(function (m) { return m.name + ' ' + m.credits; }).join('、');
    var sorted = p.semesters.slice().sort(function (a, b) { return b.credits - a.credits; });
    var heavy = sorted[0];
    var light = sorted[sorted.length - 1];
    return p.major + '（' + camp + '，' + p.grade + ' 级）共 ' + p.totalCredits +
      ' 学分，分 ' + p.modules.length + ' 个模块：' + mods + '。课程负担最重的是' + heavy.name +
      '（' + heavy.credits + ' 学分），相对轻的是' + light.name + '（' + light.credits + ' 学分）。';
  }

  function publicView(p) {
    return {
      major: p.major,
      campus: CAMPUS[p.campus] ? CAMPUS[p.campus].name : p.campus,
      college: p.college,
      grade: p.grade,
      degree: p.degree,
      duration: p.duration,
      totalCredits: p.totalCredits,
      modules: p.modules.map(function (m) { return { name: m.name, credits: m.credits }; }),
      semesters: p.semesters.map(function (s) { return { name: s.name, credits: s.credits }; }),
      notes: p.notes
    };
  }

  async function callGLM(p) {
    var s = state.glm;
    if (!s.endpoint) throw new Error('未配置接口地址');

    var payload = {
      model: s.model || 'glm-4-flash',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是大连理工大学教务信息助手。只依据用户给出的培养方案数据作答，禁止编造数字、课程名与政策；' +
            '输出 120 字以内的一段中文归纳，覆盖总学分、模块构成、课程节奏和一条选课提醒；不要使用列表，不要罗列字段名。'
        },
        { role: 'user', content: '请归纳以下培养方案：\n' + JSON.stringify(publicView(p)) }
      ]
    };

    var headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;

    var res = await fetch(s.endpoint, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    var text = '';
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      text = data.choices[0].message.content || '';
    } else if (data && data.data && data.data.choices && data.data.choices[0]) {
      text = data.data.choices[0].message.content || '';
    }
    if (!text) throw new Error('返回格式无法识别');
    return text;
  }

  function renderSummary(p, useGLM) {
    var box = document.getElementById('summary');
    var tag = document.getElementById('sumTag');
    if (!box || !tag) return;

    if (!useGLM) {
      box.textContent = localSummary(p);
      box.classList.remove('loading');
      tag.textContent = '本地模板';
      tag.className = 'tag';
      return;
    }

    if (!state.glm.endpoint) {
      box.textContent = '尚未配置 GLM 接口。点击右上角「⚙ 模型接入」填写接口地址与模型名；不配置时使用本地模板摘要。';
      box.classList.remove('loading');
      tag.textContent = '未接入';
      tag.className = 'tag warn';
      return;
    }

    box.textContent = 'GLM 正在归纳…';
    box.classList.add('loading');
    tag.textContent = 'GLM';
    tag.className = 'tag glm';

    callGLM(p).then(function (text) {
      box.textContent = text.trim();
      box.classList.remove('loading');
      tag.textContent = 'GLM 归纳';
      tag.className = 'tag glm';
    }).catch(function (err) {
      box.textContent = localSummary(p) + '（GLM 调用失败：' + err.message + '，已回退本地模板）';
      box.classList.remove('loading');
      tag.textContent = '回退模板';
      tag.className = 'tag warn';
    });
  }

  /* ---------------- 渲染：已接入 ---------------- */

  function programsOf(major) {
    if (!major) return [];
    var ids = major.variantIds || (major.programId ? [major.programId] : []);
    return ids.map(function (id) { return PROGRAM_BY_ID[id]; }).filter(Boolean);
  }

  function renderProgram(p, note, via, major, citations) {
    state.current = p;
    var camp = CAMPUS[p.campus] || { name: p.campus };
    var maxCred = Math.max.apply(null, p.semesters.map(function (s) { return s.credits; }));

    var modHtml = p.modules.map(function (m) {
      var w = Math.round(m.credits / p.totalCredits * 100);
      return '<li class="mod">' +
        '<span class="mod-name">' + esc(m.name) + '</span>' +
        '<span class="mod-track"><span class="mod-fill" style="width:' + w + '%"></span></span>' +
        '<span class="mod-val">' + m.credits + '</span>' +
        '</li>';
    }).join('');

    var semHtml = p.semesters.map(function (s) {
      var h = Math.max(6, Math.round(s.credits / maxCred * 84));
      return '<div class="sem" title="' + esc(s.name + '：' + s.credits + ' 学分') + '">' +
        '<span class="sem-val">' + s.credits + '</span>' +
        '<div class="sem-bar" style="height:' + h + 'px"></div>' +
        '<span class="sem-name">' + esc(s.name) + '</span>' +
        '</div>';
    }).join('');

    var courses = [];
    p.semesters.forEach(function (s) {
      (s.core || []).forEach(function (c) { if (courses.indexOf(c) === -1) courses.push(c); });
    });

    var code = major && major.code ? ' · 专业代码 ' + major.code : '';

    // 字段缺失兜底：不给 "undefined"，明确显示「暂无/待补充」而不是编造内容
    var notesList = (p.notes && p.notes.length) ? p.notes : ['该方案暂无选课提醒记录。'];
    var doc = p.doc || {};
    var validCites = (citations || []).filter(function (c) {
      return c && typeof c.page === 'number' && isFinite(c.page);
    }).slice(0, 4);

    var variants = programsOf(major);
    var tabs = variants.length > 1 ? '<div class="variant-tabs">' + variants.map(function (v) {
      return '<button class="variant' + (v.id === p.id ? ' active' : '') + '" type="button" data-variant="' +
        esc(v.id) + '">' + esc(v.direction || ('v' + v.grade)) + '</button>';
    }).join('') + '</div>' : '';

    var semSum = p.semesters.reduce(function (a, s) { return a + Number(s.credits || 0); }, 0);
    var unassigned = Number(p.unassignedCredits || 0);
    var unassignedNote = unassigned
      ? '<p class="note">学期表合计 ' + semSum + ' 学分；另有 ' + unassigned + ' 学分选修按方向模块跨学期修读，未分摊到学期。</p>'
      : '';

    resultEl.innerHTML =
      '<div class="head">' +
        '<h2>' + esc(p.major) + (p.direction ? ' <span class="tag">' + esc(p.direction) + '</span>' : '') + '</h2>' +
        '<p class="meta">' + esc(camp.name) + ' · ' + esc(p.college) + ' · ' + p.grade + ' 级 · ' +
          esc(p.degree) + ' · ' + esc(p.duration) + esc(code) + '</p>' +
      '</div>' +
      tabs +
      '<p class="focus">' + esc(p.focus || '培养定位待补充。') + '</p>' +
      unassignedNote +
      (isVerified(p) ? '' : (isRecorded(p)
        ? '<p class="note">数据组已录入，待人工抽检原文后确认。</p>'
        : '<p class="note">示例数据：该专业培养方案尚未接入官网原文，仅用于演示链路。</p>')) +
      (note ? '<p class="note">' + esc(note) + '</p>' : '') +
      '<div class="grid">' +
        '<article class="card c12">' +
          '<h3>一句话摘要 <span class="tag" id="sumTag">本地模板</span>' +
            '<span class="muted" style="margin-left:auto">' +
              (via ? (via === '检索服务' ? '来源 · ' : '命中 ') + esc(via) : '') +
            '</span>' +
          '</h3>' +
          '<p class="summary" id="summary"></p>' +
          '<div style="margin-top:12px"><button class="ghost small" id="regen" type="button">用 GLM 重新归纳</button></div>' +
        '</article>' +

        '<article class="card c6">' +
          '<h3>学分结构 <span class="muted">共 ' + p.totalCredits + ' 学分</span></h3>' +
          '<ul class="mods">' + modHtml + '</ul>' +
        '</article>' +

        '<article class="card c6">' +
          '<h3>学期强度 <span class="muted">每学期学分</span></h3>' +
          '<div class="sems">' + semHtml + '</div>' +
        '</article>' +

        '<article class="card c4">' +
          '<h3>核心课程</h3>' +
          (courses.length
            ? '<div class="courses">' + courses.map(function (c) {
                return '<span class="course">' + esc(c) + '</span>';
              }).join('') + '</div>'
            : '<p class="doc-note">课程清单见原文（本方案按方向模块选课，未逐门录入）。</p>') +
        '</article>' +

        '<article class="card c4">' +
          '<h3>选课提醒</h3>' +
          '<ol class="tips">' + notesList.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ol>' +
        '</article>' +

        '<article class="card c4">' +
          '<h3>方案原文</h3>' +
          '<p class="doc-title">' + esc(doc.title || '原文文档待补充') + '</p>' +
          '<p class="doc-state">状态：' + esc(doc.status || '待接入') +
            (doc.url ? ' · <a href="' + esc(doc.url) + '" target="_blank" rel="noopener">打开原文</a>' : '') +
          '</p>' +
          (validCites.length ?
            '<p class="doc-cites">引用：' + validCites.map(function (c) {
              return '<span class="cite">p.' + esc(c.page) + '</span>';
            }).join('') + '</p>' : '') +
          '<p class="doc-note">正式版由采集管线写入官网链接与页码，可直接跳到原文对应位置。</p>' +
        '</article>' +
      '</div>';

    renderSummary(p, false);
  }

  /* ---------------- 渲染：待接入 ---------------- */

  function renderPending(m, note) {
    state.current = null;
    var camp = CAMPUS[m.campus] || { name: m.campus };
    var siblings = DATA.programs.filter(function (p) { return p.college === m.college; });

    resultEl.innerHTML =
      '<div class="head">' +
        '<h2>' + esc(m.name) + '</h2>' +
        '<p class="meta">' + esc(camp.name) + ' · ' + esc(m.college) + ' · 专业代码 ' + esc(m.code) + '</p>' +
      '</div>' +
      '<p class="focus">该专业已在教务处专业目录中登记（2025 年招生专业一览表），培养方案文件尚未结构化入库。</p>' +
      (note ? '<p class="note">' + esc(note) + '</p>' : '') +
      '<div class="grid">' +
        '<article class="card c8">' +
          '<h3>培养方案 <span class="tag warn">待接入</span></h3>' +
          '<p class="pending-lead">接入后这里会自动出现：总学分、模块学分结构、学期强度、核心课程与选课提醒。</p>' +
          '<ul class="pending-list">' +
            '<li>培养方案文件链接（直达 PDF）与发布年份</li>' +
            '<li>学分结构表：模块名称 + 学分 + 合计</li>' +
            '<li>教学计划：课程名、学分、开课学期、必修/选修</li>' +
            '<li>关键结论所在页码（用于引用）</li>' +
          '</ul>' +
          '<p class="pending-foot">数据组按《专业采集台账》填写后重新编译，前端无需改动。</p>' +
        '</article>' +
        '<article class="card c4">' +
          '<h3>当前状态</h3>' +
          '<p class="doc-title">目录已收录 · 方案待采集</p>' +
          '<p class="doc-state">专业代码 ' + esc(m.code) + ' · 序号 ' + m.seq + '</p>' +
          '<p class="doc-note"><a href="' + esc(CATALOG_URL) + '" target="_blank" rel="noopener">查看教务处专业目录原文</a></p>' +
        '</article>' +
        (siblings.length ?
          '<article class="card c12">' +
            '<h3>同学院已接入</h3>' +
            '<div class="courses">' + siblings.map(function (p) {
              return '<button class="course course-btn" type="button" data-q="' + esc(p.major) + '">' +
                esc(p.major) + ' · ' + p.grade + '级</button>';
            }).join('') + '</div>' +
          '</article>' : '') +
      '</div>';
  }

  /* ---------------- 渲染：候选 / 未命中 / 目录 ---------------- */

  function renderCandidates(list, query, note) {
    var items = list.slice(0, 10).map(function (x) {
      var c = CAMPUS[x.major.campus] || { name: x.major.campus };
      var status = x.program
        ? (isVerified(x.program) ? '<span class="dot ready"></span>已核对'
          : (isRecorded(x.program) ? '<span class="dot recorded"></span>已录入'
            : '<span class="dot sample"></span>示例'))
        : '<span class="dot pending"></span>待接入';
      return '<button class="cand" type="button" data-cid="' + esc(x.major.id) + '">' +
        '<span><span class="cand-main">' + esc(x.major.name) + '</span>' +
          '<span class="cand-sub">' + esc(c.name) + ' · ' + esc(x.major.college) + '</span></span>' +
        '<span class="cand-side">' + status + '</span>' +
        '</button>';
    }).join('');

    resultEl.innerHTML =
      '<div class="empty" style="text-align:left">' +
        '<p class="empty-title">「' + esc(query) + '」匹配到多个专业</p>' +
        '<p class="empty-sub">选一个继续（已接入的直接出方案，未接入的显示采集清单）。</p>' +
        (note ? '<p class="note">' + esc(note) + '</p>' : '') +
        '<div class="cands">' + items + '</div>' +
      '</div>';
  }

  function renderNotFound(query) {
    var picks = CHIPS;
    resultEl.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">没有找到「' + esc(query) + '」</p>' +
        '<p class="empty-sub">当前专业目录含 ' + CATALOG.length + ' 个专业，试试下面的说法：</p>' +
        '<div class="chips" style="justify-content:center;margin-top:16px">' +
          picks.map(function (n) { return '<button class="chip" type="button" data-q="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') +
        '</div>' +
      '</div>';
  }

  function isVerified(p) {
    return !!(p && p.doc && p.doc.status === '已核对');
  }

  function isRecorded(p) {
    return !!(p && p.doc && String(p.doc.status || '').indexOf('已录入') === 0);
  }

  function renderCatalog() {
    var majorState = {};
    DATA.programs.forEach(function (p) {
      var k = p.campus + '|' + p.major;
      majorState[k] = isVerified(p) ? 'ready' : (isRecorded(p) ? 'recorded' : 'sample');
    });
    var covered = Object.keys(majorState).length;
    var verified = 0, recorded = 0;
    Object.keys(majorState).forEach(function (k) {
      if (majorState[k] === 'ready') verified++;
      else if (majorState[k] === 'recorded') recorded++;
    });
    var entered = verified + recorded;
    var pct = CATALOG.length ? Math.round(covered / CATALOG.length * 1000) / 10 : 0;

    var groups = DATA.campuses.map(function (c) {
      var items = CATALOG.filter(function (m) { return m.campus === c.id; });
      if (!items.length) return '';
      var ready = items.filter(function (m) {
        var p = programFor(m);
        return p && (isVerified(p) || isRecorded(p));
      }).length;

      return '<div class="catalog-group">' +
        '<div class="catalog-head">' +
          '<h4>' + esc(c.name) + '</h4>' +
          '<span class="catalog-count">' + items.length + ' 个专业 · 已录入 ' + ready + '</span>' +
        '</div>' +
        '<div class="chips">' + items.map(function (m) {
          var p = programFor(m);
          var cls = p ? (isVerified(p) ? 'ready' : (isRecorded(p) ? 'recorded' : 'sample')) : 'pending';
          return '<button class="chip chip-major" type="button" data-q="' + esc(m.name) + '" ' +
            'title="' + esc(m.college + ' · ' + m.code) + '">' +
            '<span class="dot ' + cls + '"></span>' + esc(m.name) +
            '</button>';
        }).join('') + '</div></div>';
    }).join('');

    resultEl.innerHTML =
      '<div class="catalog">' +
        '<div class="catalog-top">' +
          '<div>' +
            '<p class="empty-title">专业目录 · ' + CATALOG.length + ' 个专业</p>' +
            '<p class="empty-sub">来源：' + esc(DATA.catalog.meta.title) + '（教务处）· 已录入 ' +
              entered + ' 个，示例 ' + (covered - entered) + ' 个</p>' +
          '</div>' +
          '<div class="legend">' +
            (verified ? '<span><span class="dot ready"></span>已核对</span>' : '') +
            '<span><span class="dot recorded"></span>已录入</span>' +
            '<span><span class="dot sample"></span>示例</span>' +
            '<span><span class="dot pending"></span>待接入</span>' +
          '</div>' +
        '</div>' +
        '<div class="coverage">' +
          '<div class="coverage-head"><span>培养方案已结构化 <b>' + covered + '</b> / ' + CATALOG.length +
            ' 个专业（已录入 ' + entered + '）</span><span>' + pct + '%</span></div>' +
          '<div class="coverage-track"><span class="coverage-fill" style="width:' + Math.max(pct, 1) + '%"></span></div>' +
        '</div>' +
        groups +
      '</div>';
  }

  /* ---------------- 检索入口 ---------------- */

  function searchLocal(q) {
    var r = resolve(q);
    if (!r.list.length) { renderNotFound(q); return; }

    var top = r.list[0];
    var second = r.list[1];

    if (second && second.score === top.score) { renderCandidates(r.list, q); return; }

    if (top.program) renderProgram(top.program, r.note, top.via, top.major);
    else renderPending(top.major, r.note);
  }

  var askSeq = 0;   // 查询序号：后发覆盖先发，过期响应一律丢弃

  function search(queryOverride) {
    var q = (typeof queryOverride === 'string' ? queryOverride : document.getElementById('q').value).trim();
    if (typeof queryOverride === 'string') document.getElementById('q').value = q;

    state.campus = document.getElementById('campus').value;
    state.grade = document.getElementById('grade').value;

    if (!q) { renderCatalog(); return Promise.resolve(); }

    // 断网恢复：网络类失败的冷却到期后，下一次搜索自动重试远程
    if (state.apiMode !== 'remote' && state.retryRemoteAt && Date.now() >= state.retryRemoteAt) {
      state.retryRemoteAt = 0;
      setApiMode('remote', '服务');
    }

    if (state.apiMode !== 'remote') {
      state.busyQuery = null;
      state.inFlight = null;
      setBusy(false);
      searchLocal(q);
      return Promise.resolve();
    }

    // 防重复点击：同一查询在途时复用在途请求，不发第二个
    if (state.busyQuery === q && state.inFlight) return state.inFlight;

    var seq = ++askSeq;
    setBusy(true);
    state.busyQuery = q;

    state.inFlight = askRemote(q).then(function (ans) {
      if (seq !== askSeq) return;   // 过期响应：已被更新的查询取代，直接丢弃
      state.busyQuery = null;
      state.inFlight = null;
      state.retryRemoteAt = 0;
      setBusy(false);
      renderRemote(ans, q);
    }).catch(function (err) {
      if (seq !== askSeq) return;   // 过期失败：不降级、不弹提示
      state.busyQuery = null;
      state.inFlight = null;
      setBusy(false);
      setApiMode('local', '本地');
      var msg = (err && err.message) ? err.message : String(err);
      // 网络类故障 15s 后自动重试远程；501（未实现）与数据不一致属配置问题，不自动重试
      var retryable = msg.indexOf('超时') !== -1 || msg.indexOf('Failed to fetch') !== -1 ||
        msg.indexOf('Network') !== -1 ||
        (/^HTTP 5\d\d$/.test(msg) && msg !== 'HTTP 501');
      state.retryRemoteAt = retryable ? Date.now() + 15000 : 0;
      var text;
      if (msg.indexOf('不在本地目录') !== -1) {
        text = '服务数据与前端数据包不一致（可能需重新编译 data.js），本次使用本地匹配';
      } else if (msg.indexOf('HTTP 501') !== -1) {
        text = '检索服务尚未就绪（501），已回退本地匹配';
      } else {
        text = '检索服务不可用（' + msg + '），已回退本地匹配';
      }
      showNotice(text);
      searchLocal(q);
    });
    return state.inFlight;
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    var campusSel = document.getElementById('campus');
    DATA.campuses.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      campusSel.appendChild(o);
    });

    var gradeSel = document.getElementById('grade');
    (DATA.grades || []).forEach(function (g) {
      var o = document.createElement('option');
      o.value = String(g); o.textContent = g + ' 级';
      gradeSel.appendChild(o);
    });

    var list = document.getElementById('majorList');
    CATALOG.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.name;
      list.appendChild(o);
    });

    var chips = document.getElementById('chips');
    chips.innerHTML = CHIPS.map(function (c) {
      return '<button class="chip" type="button" data-q="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');

    document.getElementById('go').addEventListener('click', function () { search(); });
    document.getElementById('q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') search();
    });
    campusSel.addEventListener('change', function () {
      if (document.getElementById('q').value.trim()) search();
    });

    document.getElementById('openSettings').addEventListener('click', function () {
      document.getElementById('endpoint').value = state.glm.endpoint || '';
      document.getElementById('model').value = state.glm.model || 'glm-4-flash';
      document.getElementById('apiKey').value = state.glm.apiKey || '';
      document.getElementById('settings').showModal();
      document.getElementById('endpoint').focus();   // 弹窗内键盘落点（Esc 关闭/焦点圈定为原生 dialog 行为）
    });

    document.getElementById('settings').addEventListener('close', function (e) {
      if (e.target.returnValue !== 'save') return;
      state.glm = {
        endpoint: document.getElementById('endpoint').value.trim(),
        model: document.getElementById('model').value.trim() || 'glm-4-flash',
        apiKey: document.getElementById('apiKey').value.trim()
      };
      saveGlm(state.glm);
      if (state.current) renderSummary(state.current, true);
    });

    document.addEventListener('click', function (e) {
      var vBtn = e.target.closest('[data-variant]');
      if (vBtn) {
        var vp = PROGRAM_BY_ID[vBtn.getAttribute('data-variant')];
        if (vp) renderProgram(vp, '', '方向切换', findMajor(vp.major, vp.campus));
        return;
      }

      var qBtn = e.target.closest('[data-q]');
      if (qBtn) { search(qBtn.getAttribute('data-q')); return; }

      var cand = e.target.closest('[data-cid]');
      if (cand) {
        var id = cand.getAttribute('data-cid');
        var major = CATALOG.filter(function (x) { return x.id === id; })[0];
        if (major) {
          document.getElementById('campus').value = major.campus;
          state.campus = major.campus;
          document.getElementById('q').value = major.name;
          search(major.name);
        }
        return;
      }

      if (e.target.id === 'regen') {
        if (state.current) renderSummary(state.current, true);
      }
    });

    var pill = document.getElementById('dataPill');
    var meta = DATA.meta || {};
    var cat = (DATA.catalog && DATA.catalog.meta) ? DATA.catalog.meta : {};
    var enteredKeys = {};
    var verifiedKeys = {};
    var allKeys = {};
    DATA.programs.forEach(function (p) {
      var k = p.campus + '|' + p.major;
      allKeys[k] = 1;
      if (isVerified(p) || isRecorded(p)) enteredKeys[k] = 1;
      if (isVerified(p)) verifiedKeys[k] = 1;
    });
    var enteredCount = Object.keys(enteredKeys).length;
    var verifiedCount = Object.keys(verifiedKeys).length;
    var majorTotal = Object.keys(allKeys).length;
    pill.textContent = verifiedCount
      ? '目录 ' + CATALOG.length + ' · 已核对 ' + verifiedCount
      : (enteredCount
        ? '目录 ' + CATALOG.length + ' · 已录入 ' + enteredCount
        : '目录 ' + CATALOG.length + ' · 已结构化 ' + DATA.programs.length);

    var disclaimerEl = document.getElementById('disclaimer');
    if (disclaimerEl && meta.disclaimer) disclaimerEl.textContent = meta.disclaimer;

    document.getElementById('footMeta').textContent =
      '专业目录：' + (cat.title || '教务处') + '（' + (cat.year || '') + '）' +
      ' · 数据版本 ' + (meta.version || '-') +
      ' · 方案：已核对 ' + DATA.programs.filter(isVerified).length + ' 条、待核对 ' +
      DATA.programs.filter(isRecorded).length + ' 条';

    document.addEventListener('keydown', function (e) {
      if (e.key !== '/') return;
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' ||
        a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      e.preventDefault();
      var input = document.getElementById('q');
      input.focus();
      input.select();
    });

    var params = new URLSearchParams(location.search);
    var campusParam = campusId(params.get('campus') || '');
    if (campusParam) {
      document.getElementById('campus').value = campusParam;
    }

    var ready = detectApi();
    if (params.get('q')) {
      ready.then(function () {
        document.getElementById('q').value = params.get('q');
        search(params.get('q'));
      });
    } else {
      renderCatalog();
    }
  }

  init();

  /* 供自动化冒烟测试使用，浏览器控制台也可直接调用 */
  window.__DLUT_DEBUG = {
    search: search, resolve: resolve, state: state, localSummary: localSummary,
    renderRemote: renderRemote, setApiMode: setApiMode, askRemote: askRemote
  };
})();
