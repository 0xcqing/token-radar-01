// Token Radar reads window.RADAR (written beside dashboard/ by main.ts) and renders the ranked
// pre-token board, filters, sortable columns, a live-token comparables view and a detail drawer.
// Every byte shown is in data.js: no fetch, no framework and no network.
(function () {
  'use strict';

  var D = window.RADAR;
  var app = document.getElementById('app');
  if (!D) {
    var miss = document.createElement('div');
    miss.className = 'shell';
    var p = document.createElement('p');
    p.className = 'lede';
    p.textContent = 'No data.js was found beside the page. Run main.ts to write one from the snapshot.';
    miss.appendChild(p);
    app.appendChild(miss);
    return;
  }

  var state = { q: '', category: 'all', chain: 'all', watch: false, sort: 'rank', dir: 1, selected: null, tab: 'board' };
  var catCounts = {};
  var chainCounts = {};
  var rowBySlug = {};
  var maxImplied = D.rows.length ? D.rows[0].implied_value_usd : 1;

  D.rows.forEach(function (r) {
    rowBySlug[r.slug] = r;
    var c = r.category || 'Other';
    catCounts[c] = (catCounts[c] || 0) + 1;
    (r.chains || []).forEach(function (ch) { chainCounts[ch] = (chainCounts[ch] || 0) + 1; });
  });

  // ---------------------------------------------------------------- formatting

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 730) return (d / 365).toFixed(1) + 'y';
    if (d >= 60) return Math.round(d / 30) + 'mo';
    return Math.round(d) + 'd';
  }
  function fmtRatio(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3) + 'x';
  }

  // ---------------------------------------------------------------- dom

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    if (typeof child === 'string' || typeof child === 'number') { node.appendChild(document.createTextNode(String(child))); return; }
    node.appendChild(child);
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'onclick') node.addEventListener('click', v);
        else if (k === 'oninput') node.addEventListener('input', v);
        else if (k === 'onchange') node.addEventListener('change', v);
        else if (k === 'onkeydown') node.addEventListener('keydown', v);
        else if (k === 'style') node.setAttribute('style', v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function section(title, content) {
    return el('section', { class: 'detail-section' }, el('h3', { text: title }), content);
  }
  function statCard(label, value, note) {
    return el('div', { class: 'stat' }, el('span', { text: label }), el('b', { text: value }), el('i', { text: note }));
  }
  function meter(value, cls) {
    return el('span', { class: 'meter ' + (cls || ''), 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.min(100, value)) + '%' }));
  }

  // ---------------------------------------------------------------- hash state

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var params = new URLSearchParams(raw);
    if (params.has('q')) state.q = params.get('q') || '';
    if (params.has('category')) state.category = params.get('category') || 'all';
    if (params.has('chain')) state.chain = params.get('chain') || 'all';
    if (params.has('watch')) state.watch = params.get('watch') === '1';
    if (params.has('sort')) state.sort = params.get('sort') || 'rank';
    if (params.has('dir')) state.dir = params.get('dir') === '1' ? 1 : -1;
    if (params.has('tab')) state.tab = params.get('tab') === 'live' ? 'live' : 'board';
    if (params.has('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watch) params.set('watch', '1');
    if (state.sort !== 'rank') params.set('sort', state.sort);
    if (state.dir !== 1) params.set('dir', String(state.dir));
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    try {
      window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
    } catch (err) {
      // file:// in a locked-down browser: the initial hash still drives the screenshots.
    }
  }

  function sanitize() {
    if (state.category !== 'all' && !catCounts[state.category]) state.category = 'all';
    if (state.chain !== 'all' && !chainCounts[state.chain]) state.chain = 'all';
    if (state.selected && !rowBySlug[state.selected]) state.selected = null;
    if (['rank', 'name', 'category', 'tvl', 'change', 'implied', 'confidence'].indexOf(state.sort) < 0) state.sort = 'rank';
  }

  // ---------------------------------------------------------------- filtering and sorting

  function matches(r) {
    if (state.watch && !r.watchlist) return false;
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    if (state.q) {
      var q = state.q.toLowerCase();
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function visibleRows() {
    return D.rows.filter(matches).sort(function (a, b) {
      var k = state.sort;
      var d = state.dir;
      var av;
      var bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'category') { av = (a.category || '').toLowerCase(); bv = (b.category || '').toLowerCase(); }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'change') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (k === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else if (k === 'confidence') { av = a.confidence; bv = b.confidence; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -d;
      if (av > bv) return d;
      return a.rank - b.rank;
    });
  }
  function visibleLive() {
    var q = state.q.trim().toLowerCase();
    if (!q) return D.live;
    return D.live.filter(function (r) {
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortBy(key) {
    if (state.sort === key) state.dir = -state.dir;
    else {
      state.sort = key;
      state.dir = (key === 'rank' || key === 'name' || key === 'category') ? 1 : -1;
    }
    writeHash();
    renderWithFocus();
  }
  function resetFilters() {
    state.q = '';
    state.category = 'all';
    state.chain = 'all';
    state.watch = false;
    state.sort = 'rank';
    state.dir = 1;
    state.selected = null;
    writeHash();
    render();
  }

  // ---------------------------------------------------------------- header, hero, controls

  function topbar() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'logo', 'aria-hidden': 'true' }),
        el('div', null, el('b', { class: 'brand-name', text: 'Token Radar' }), el('span', { class: 'brand-sub', text: 'pre-token intelligence' }))
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + D.as_of }),
        el('span', { class: 'dot-sep' }),
        el('span', { text: D.model_version + ' model' }),
        el('span', { class: 'pill', text: 'DefiLlama index' })
      )
    );
  }

  function hero() {
    return el('section', { class: 'hero' },
      el('div', { class: 'hero-copy' },
        el('p', { class: 'eyebrow', text: 'IMPLIED FDV · NOT A PRICE' }),
        el('h1', { text: D.board_size + ' pre-token protocols, ranked by what a token could be worth' }),
        el('p', { class: 'lede', text: 'The ' + D.watchlist_size + '-protocol watchlist is the floor, never the ceiling. The model takes mcap/TVL medians from ' + D.comparable_sample + ' live-token comparables, then adjusts for seven-day growth, how long each record has run without a token, chain quality and whether the record is an independent launch.' })
      ),
      el('div', { class: 'stats' },
        statCard('Watchlist', D.watchlist_size + ' / ' + D.watchlist_size, 'every slug covered'),
        statCard('Scored', String(D.board_size), 'pre-token records'),
        statCard('Below floor', String(D.below_floor), 'TVL under ' + fmtUsd(D.floor_usd)),
        statCard('Live comparables', String(D.live_size), D.comparable_sample + ' usable ratios'),
        statCard('Median multiple', D.overall_multiple.toFixed(2) + 'x', 'mcap / TVL')
      )
    );
  }

  function optionsFor(counts) {
    return Object.keys(counts).sort(function (a, b) {
      var x = a.toLowerCase();
      var y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  function controls() {
    var boardTab = el('button', {
      type: 'button', class: 'seg-btn' + (state.tab === 'board' ? ' active' : ''), text: 'Ranked board',
      onclick: function () { state.tab = 'board'; state.selected = null; writeHash(); render(); }
    });
    var liveTab = el('button', {
      type: 'button', class: 'seg-btn' + (state.tab === 'live' ? ' active' : ''), text: 'Live comparables (' + D.live_size + ')',
      onclick: function () { state.tab = 'live'; state.selected = null; writeHash(); render(); }
    });
    var search = el('input', {
      type: 'search', id: 'q', value: state.q, placeholder: 'Search protocol, slug, category or chain', 'aria-label': 'Search the board',
      oninput: function (e) { state.q = e.target.value; writeHash(); renderWithFocus(); }
    });
    var children = [
      el('div', { class: 'seg' }, boardTab, liveTab),
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search)
    ];
    if (state.tab === 'board') {
      var catSelect = el('select', {
        id: 'category', 'aria-label': 'Filter by category',
        onchange: function (e) { state.category = e.target.value; writeHash(); renderWithFocus(); }
      },
        el('option', { value: 'all', text: 'All categories' }),
        optionsFor(catCounts).map(function (c) {
          return el('option', { value: c, text: c + ' (' + catCounts[c] + ')', selected: c === state.category });
        })
      );
      var chainSelect = el('select', {
        id: 'chain', 'aria-label': 'Filter by chain',
        onchange: function (e) { state.chain = e.target.value; writeHash(); renderWithFocus(); }
      },
        el('option', { value: 'all', text: 'All chains' }),
        optionsFor(chainCounts).map(function (c) {
          return el('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === state.chain });
        })
      );
      var toggle = el('button', {
        type: 'button', id: 'watch-toggle', class: 'toggle', 'aria-pressed': state.watch ? 'true' : 'false',
        onclick: function () { state.watch = !state.watch; writeHash(); renderWithFocus(); }
      }, el('span', { class: 'track', 'aria-hidden': 'true' }), el('span', { text: 'Watchlist only' }));
      children.push(el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Category' }), catSelect));
      children.push(el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Chain' }), chainSelect));
      children.push(toggle);
      children.push(el('button', { type: 'button', class: 'ghost', text: 'Reset', onclick: resetFilters }));
      children.push(el('span', { class: 'count' }, el('b', { text: String(visibleRows().length) }), ' of ' + D.board_size + ' rows'));
    } else {
      children.push(el('span', { class: 'count' }, el('b', { text: String(visibleLive().length) }), ' of ' + D.live.length + ' live comparables'));
    }
    return el('div', { class: 'controls' }, children);
  }

  // ---------------------------------------------------------------- board

  function th(key, label) {
    if (!key) return el('th', { scope: 'col', text: label });
    var active = state.sort === key;
    return el('th', { scope: 'col' },
      el('button', {
        type: 'button', class: 'sort-btn' + (active ? ' active' : ''),
        onclick: function () { sortBy(key); }
      }, label, active ? el('span', { class: 'arrow', text: state.dir === 1 ? '▲' : '▼' }) : null)
    );
  }

  function chainChips(chains) {
    var box = el('div', { class: 'chips' });
    if (!chains || chains.length === 0) {
      box.appendChild(el('span', { class: 'chip more', text: 'unknown' }));
      return box;
    }
    chains.slice(0, 2).forEach(function (c) { box.appendChild(el('span', { class: 'chip chain', text: c })); });
    if (chains.length > 2) box.appendChild(el('span', { class: 'chip more', text: '+' + (chains.length - 2) }));
    return box;
  }

  function boardRow(r) {
    var tr = el('tr', {
      'data-slug': r.slug,
      'data-selected': state.selected === r.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { openDetail(r.slug); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
    });
    var confClass = 'lv-' + r.confidence_label.toLowerCase();
    tr.appendChild(el('td', { class: 'rank-cell' }, el('span', { class: 'rank-num' + (r.rank <= 3 ? ' top' : ''), text: String(r.rank) })));
    tr.appendChild(el('td', { class: 'proto-cell' },
      el('div', { class: 'proto-name' }, el('b', { text: r.name }), r.watchlist ? el('span', { class: 'watch-badge', text: 'WATCH' }) : null),
      el('span', { class: 'slug', text: r.slug })
    ));
    tr.appendChild(el('td', null, el('span', { class: 'chip cat', text: r.category || 'Other' })));
    tr.appendChild(el('td', null, chainChips(r.chains)));
    tr.appendChild(el('td', { class: 'num', title: fmtFull(r.tvl_usd), text: fmtUsd(r.tvl_usd) }));
    tr.appendChild(el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }));
    tr.appendChild(el('td', null,
      el('div', { class: 'implied-cell' },
        el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(4, Math.round((r.implied_value_usd / maxImplied) * 100)) + '%' })),
        el('b', { class: 'num', title: fmtFull(r.implied_value_usd), text: fmtUsd(r.implied_value_usd) })
      )
    ));
    tr.appendChild(el('td', null,
      el('span', { class: 'conf-cell' },
        el('span', { class: 'meter small', 'aria-hidden': 'true' }, el('i', { class: confClass, style: 'width:' + r.confidence + '%' })),
        el('span', { class: 'conf-text', text: r.confidence_label + ' ' + r.confidence })
      )
    ));
    return tr;
  }

  function emptyState() {
    return el('div', { class: 'empty' },
      el('h3', { text: 'No protocol matches those filters' }),
      el('p', { text: 'Clear the search or choose another category, chain or watchlist setting.' }),
      el('button', { class: 'primary', type: 'button', text: 'Reset filters', onclick: resetFilters })
    );
  }

  function boardPanel() {
    var list = visibleRows();
    var tbody = el('tbody');
    list.forEach(function (r) { tbody.appendChild(boardRow(r)); });
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', null,
          el('h2', { text: 'Ranked board' }),
          el('p', { class: 'panel-sub', text: 'Pre-token records, highest implied value first. Select a row for the model and its farm plan.' })
        ),
        el('div', { class: 'legend' },
          el('span', { class: 'legend-item' }, el('i', { class: 'swatch implied', 'aria-hidden': 'true' }), 'implied FDV'),
          el('span', { class: 'legend-item' }, el('i', { class: 'swatch conf', 'aria-hidden': 'true' }), 'confidence')
        )
      ),
      list.length === 0 ? emptyState() : el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null,
            th('rank', '#'), th('name', 'Protocol'), th('category', 'Category'), th(null, 'Chains'),
            th('tvl', 'TVL'), th('change', '7d'), th('implied', 'Implied FDV'), th('confidence', 'Confidence')
          )),
          tbody
        )
      )
    );
  }

  function multipleTable(title, rows, first) {
    var tbody = el('tbody');
    rows.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { text: r.key }),
        el('td', { class: 'num', text: String(r.count) }),
        el('td', { class: 'num', text: fmtRatio(r.median) }),
        el('td', { class: 'num accent', text: fmtRatio(r.multiple) })
      ));
    });
    return el('div', { class: 'mini-table' },
      el('h3', { text: title }),
      el('table', null,
        el('thead', null, el('tr', null,
          el('th', { text: first }), el('th', { class: 'num', text: 'n' }),
          el('th', { class: 'num', text: 'median' }), el('th', { class: 'num', text: 'used' })
        )),
        tbody
      )
    );
  }

  function modelPanel() {
    return el('section', { class: 'panel model-panel' },
      el('div', { class: 'panel-head' },
        el('div', null,
          el('h2', { text: 'The valuation model' }),
          el('p', { class: 'panel-sub', text: 'One function scores every row; no protocol name is hand-picked.' })
        )
      ),
      el('div', { class: 'model-body' },
        el('div', { class: 'formula', text: 'implied = TVL × category median × chain/quality × structure × growth × maturity' }),
        el('div', { class: 'model-cols' },
          multipleTable('Category multiples', D.categories.slice(0, 8), 'Category'),
          multipleTable('Chain multiples', D.chains.slice(0, 8), 'Chain')
        ),
        el('p', { class: 'model-note', text: 'Category and chain multiples are robust medians of the ' + D.comparable_sample + ' mcap/TVL ratios inside [0.005, 25]. Small samples shrink toward the ' + D.overall_multiple.toFixed(3) + 'x whole-set median, and a category is clamped to 0.3x..2.5x that median so one rich comparable cannot set a price. Growth is weighted at ' + D.model.growth_weight + ', the maturity multiplier runs ' + D.model.maturity_floor + ' to ' + (D.model.maturity_floor + D.model.maturity_range) + ' over ' + D.model.maturity_days + ' days, and a bridge, wrapped, staked, versioned or exchange product gets a ' + D.model.structure_derivative + 'x structure factor.' })
      )
    );
  }

  function livePanel() {
    var list = visibleLive();
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null,
          el('div', { class: 'proto-name' }, el('b', { text: r.name })),
          el('span', { class: 'slug', text: r.slug })
        ),
        el('td', null, el('span', { class: 'chip cat', text: r.category || 'Other' })),
        el('td', null, chainChips(r.chains)),
        el('td', { class: 'num', title: fmtFull(r.tvl_usd), text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', title: fmtFull(r.mcap_usd), text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio.toFixed(3) + 'x' }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) })
      ));
    });
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', null,
          el('h2', { text: 'Live-token comparables' }),
          el('p', { class: 'panel-sub', text: 'These records already carry a market cap, so they set the multiples and are never ranked. ' + D.named_size + ' more records name a token but carry no market cap, and they are excluded from the board too.' })
        ),
        el('div', { class: 'legend' }, el('span', { class: 'legend-item', text: 'not a ranking' }))
      ),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null,
            el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { text: 'Chains' }),
            el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }),
            el('th', { class: 'num', text: 'mcap / TVL' }), el('th', { class: 'num', text: '7d' })
          )),
          tbody
        )
      )
    );
  }

  // ---------------------------------------------------------------- detail drawer

  function inputGrid(items) {
    var grid = el('div', { class: 'input-grid' });
    items.forEach(function (it) {
      grid.appendChild(el('div', { class: 'input-cell' },
        el('span', { class: 'label', text: it[0] }),
        el('b', { text: it[1] }),
        el('span', { class: 'cell-note', text: it[2] })
      ));
    });
    return grid;
  }

  function addWalk(container, label, value, note, strong) {
    container.appendChild(el('div', { class: 'walk-row' + (strong ? ' strong' : '') },
      el('span', { class: 'walk-label', text: label }),
      el('b', { class: 'walk-value', text: value }),
      el('span', { class: 'walk-note', text: note })
    ));
  }

  function populateDetail(row) {
    var panel = document.getElementById('detail');
    panel.textContent = '';
    var m = row.model;
    var tie = m.tie_adjustment;
    panel.appendChild(el('div', { class: 'detail-head' },
      el('div', { class: 'detail-title' },
        el('span', { class: 'rank-pill', text: 'Rank ' + row.rank + ' of ' + D.board_size }),
        el('h2', { text: row.name }),
        el('p', { class: 'detail-sub', text: (row.category || 'Other') + ' · ' + ((row.chains || []).join(', ') || 'chain not recorded') })
      ),
      el('button', { class: 'icon-btn', type: 'button', text: 'Close', 'aria-label': 'Close details', onclick: hideDetail })
    ));

    panel.appendChild(el('div', { class: 'badges' },
      el('span', { class: 'badge accent', text: row.watchlist ? 'On the ' + D.watchlist_size + '-protocol watchlist' : 'Below the watchlist floor' }),
      el('span', { class: 'badge ' + (row.structure.derivative ? 'warn' : 'ok'), text: row.structure.kind }),
      el('span', { class: 'badge', text: 'records no token' })
    ));

    panel.appendChild(el('div', { class: 'detail-value' },
      el('div', null,
        el('span', { class: 'label', text: 'Implied FDV' }),
        el('strong', { class: 'big', text: fmtUsd(row.implied_value_usd) }),
        el('span', { class: 'sub', text: fmtFull(row.implied_value_usd) + ' · model estimate, not a price' })
      ),
      el('div', { class: 'conf-block' },
        el('span', { class: 'label', text: 'Confidence' }),
        el('div', { class: 'conf-row' }, meter(row.confidence, 'small'), el('b', { text: row.confidence_label + ' ' + row.confidence }))
      )
    ));

    var left = el('div', { class: 'detail-col' });
    left.appendChild(section('Inputs', inputGrid([
      ['TVL', fmtUsd(row.tvl_usd), fmtFull(row.tvl_usd)],
      ['Seven-day change', fmtPct(row.change_7d), row.change_7d === null ? 'not reported' : 'snapshot field'],
      ['Age since listing', fmtAge(row.age_days), row.listed_at ? 'listed ' + row.listed_at : 'not recorded'],
      ['Category', row.category || 'Other', m.category_comparables + ' comparable records'],
      ['Chains', (row.chains || []).join(', ') || 'not recorded', m.chain_comparables + ' chain sample points'],
      ['Record', 'mcap none · gecko none · symbol none', row.watchlist ? 'watchlist member' : 'pre-token, outside watchlist']
    ])));

    var walk = el('div', { class: 'walk' });
    addWalk(walk, 'Category multiple', fmtRatio(m.category_multiple), 'median ' + fmtRatio(m.category_median) + ' from ' + m.category_comparables + ' token record' + (m.category_comparables === 1 ? '' : 's') + ', shrunk toward ' + fmtRatio(D.overall_multiple));
    addWalk(walk, 'Chain factor', fmtRatio(m.chain_factor), m.chain_comparables + ' chain sample points, clamped 0.6x to 1.6x');
    addWalk(walk, 'Quality factor', fmtRatio(m.quality_factor), 'TVL depth plus chain breadth');
    addWalk(walk, 'Structure factor', fmtRatio(m.structure_factor), row.structure.note);
    addWalk(walk, 'Growth multiplier', fmtRatio(m.growth_multiplier), '7d ' + fmtPct(row.change_7d) + ', clamped -50%..+100%, weight 0.35');
    addWalk(walk, 'Maturity multiplier', fmtRatio(m.maturity_multiplier), (row.age_days === null ? 'unknown age uses 540 days' : 'age ' + row.age_days + ' days') + ', caps at 1,460 days');
    addWalk(walk, 'Raw value', fmtUsd(m.raw_value), 'before the distinct-value tie-break');
    addWalk(walk, 'Tie adjustment', (tie >= 0 ? '+' : '-') + fmtUsd(Math.abs(tie)), 'deterministic ordering only');
    addWalk(walk, 'Implied value', fmtUsd(row.implied_value_usd), 'TVL × category × chain/quality × structure × growth × maturity', true);
    left.appendChild(section('How the model got here', walk));

    var right = el('div', { class: 'detail-col' });
    var steps = el('ol', { class: 'steps' });
    row.farm_steps.forEach(function (s) { steps.appendChild(el('li', null, el('span', { class: 'step-text', text: s }))); });
    right.appendChild(section('Farm plan', steps));

    var changes = el('ul', { class: 'change-list' });
    row.what_would_change.forEach(function (s) { changes.appendChild(el('li', { text: s })); });
    right.appendChild(section('What would change it', changes));

    panel.appendChild(el('div', { class: 'detail-grid' }, left, right));
  }

  function highlight(slug) {
    var rows = document.querySelectorAll('tr[data-slug]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-selected', rows[i].getAttribute('data-slug') === slug ? 'true' : 'false');
    }
  }

  function openDetail(slug) {
    var row = rowBySlug[slug];
    if (!row) return;
    state.selected = slug;
    writeHash();
    highlight(slug);
    populateDetail(row);
    document.getElementById('detail').hidden = false;
    document.getElementById('scrim').hidden = false;
    document.body.classList.add('detail-open');
    document.getElementById('detail').scrollTop = 0;
  }

  function hideDetail() {
    state.selected = null;
    writeHash();
    var panel = document.getElementById('detail');
    panel.hidden = true;
    panel.textContent = '';
    document.getElementById('scrim').hidden = true;
    document.body.classList.remove('detail-open');
    highlight(null);
  }

  // ---------------------------------------------------------------- render

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(topbar());
    shell.appendChild(hero());
    shell.appendChild(controls());
    if (state.tab === 'live') shell.appendChild(livePanel());
    else {
      shell.appendChild(boardPanel());
      shell.appendChild(modelPanel());
    }
    app.appendChild(shell);
    if (state.selected && rowBySlug[state.selected]) openDetail(state.selected);
    else hideDetail();
  }

  function renderWithFocus() {
    var active = document.activeElement;
    var id = active && active.id;
    var start = null;
    if (active && typeof active.selectionStart === 'number') start = active.selectionStart;
    render();
    if (id) {
      var next = document.getElementById(id);
      if (next) {
        next.focus();
        if (start !== null && next.setSelectionRange) {
          try { next.setSelectionRange(start, start); } catch (err) { /* select elements have no selection range */ }
        }
      }
    }
  }

  document.getElementById('scrim').addEventListener('click', hideDetail);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) hideDetail();
  });

  readHash();
  sanitize();
  render();
})();
