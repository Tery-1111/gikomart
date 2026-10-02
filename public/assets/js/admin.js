// GikoMart admin portal controller. A classic script (no modules); all dynamic
// content is built with createElement and textContent. The session token lives
// only in memory for the life of this page and is never written to browser
// storage; reloading or closing the tab signs the admin out.

(function () {
  'use strict';

  let session = null;
  let busy = false;
  const views = {};
  let activeView = null;
  let reportStatusFilter = 'open';
  let reportTypeFilter = '';
  let paymentStatusFilter = '';
  let paymentTypeFilter = '';

  // ── Element helpers ──────────────────────────────────────────────────────
  function el(tag, props, text) {
    const node = document.createElement(tag);
    if (props) {
      if (props.className !== undefined) node.className = props.className;
      if (props.id !== undefined) node.id = props.id;
      if (props.type !== undefined) node.type = props.type;
      if (props.value !== undefined) node.value = props.value;
      if (props.hidden !== undefined) node.hidden = props.hidden;
      if (props.dataset) {
        Object.keys(props.dataset).forEach(function (key) {
          node.dataset[key] = props.dataset[key];
        });
      }
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtTime(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function fmtNum(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtMoney(n) {
    return 'KSh ' + fmtNum(n);
  }

  // ── Session / API ────────────────────────────────────────────────────────
  function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers['X-Admin-Session'] = session;
    const options = { method: method, headers: headers };
    if (body !== undefined) options.body = JSON.stringify(body);
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && session) {
          logout('Session expired. Sign in again.');
          throw new Error('unauthorized');
        }
        return { status: res.status, data: data };
      });
    }, function () {
      throw new Error('network');
    });
  }

  function setLoginMessage(msg) {
    const loginMsg = document.getElementById('loginMsg');
    loginMsg.textContent = msg || '';
    loginMsg.className = msg ? 'error' : '';
  }

  function showLogin(msg) {
    document.getElementById('loginSection').hidden = false;
    document.getElementById('appSection').hidden = true;
    document.getElementById('signOutBtn').hidden = true;
    clear(document.getElementById('viewBody'));
    const viewMsg = document.getElementById('viewMsg');
    viewMsg.textContent = '';
    viewMsg.className = '';
    setLoginMessage(msg);
  }

  function showApp() {
    document.getElementById('loginSection').hidden = true;
    document.getElementById('appSection').hidden = false;
    document.getElementById('signOutBtn').hidden = false;
  }

  function logout(msg) {
    session = null;
    activeView = null;
    showLogin(msg);
  }

  // ── Sign-in ──────────────────────────────────────────────────────────────
  function handleLogin(event) {
    event.preventDefault();
    const adminKey = document.getElementById('adminKey');
    const totpCode = document.getElementById('totpCode');
    const loginBtn = document.getElementById('loginBtn');
    const key = adminKey.value.trim();
    const code = totpCode.value.trim();

    if (!key) { setLoginMessage('Enter the admin key.'); return; }
    if (!/^\d{6}$/.test(code)) { setLoginMessage('Enter the 6-digit code.'); return; }
    if (busy) return;

    busy = true;
    loginBtn.disabled = true;

    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ code: code }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 200 && data && typeof data.token === 'string' && data.token) {
          session = data.token;
          adminKey.value = '';
          totpCode.value = '';
          showApp();
          activateView('dashboard');
          return;
        }
        totpCode.value = '';
        if (res.status === 429) {
          const secs = data.retryAfterSec;
          setLoginMessage(typeof secs === 'number'
            ? 'Too many attempts. Try again in ' + secs + ' seconds.'
            : 'Too many attempts. Try again later.');
        } else if (res.status === 401) {
          setLoginMessage('Invalid or already used code.');
        } else if (res.status === 403) {
          setLoginMessage('Invalid admin key.');
        } else if (res.status === 400) {
          setLoginMessage('Check the code and that 2FA is set up.');
        } else {
          setLoginMessage('Sign-in failed.');
        }
      });
    }, function () {
      totpCode.value = '';
      setLoginMessage('Could not connect.');
    }).finally(function () {
      adminKey.value = '';
      busy = false;
      loginBtn.disabled = false;
    });
  }

  // ── Views ────────────────────────────────────────────────────────────────
  function assertOk(status) {
    if (status !== 200) throw new Error(status === 429 ? '429' : 'http');
  }

  function showViewFailure(text) {
    const viewBody = document.getElementById('viewBody');
    const viewMsg = document.getElementById('viewMsg');
    clear(viewBody);
    viewMsg.className = 'error';
    viewMsg.textContent = text;
    const retry = el('button', { id: 'retryBtn', type: 'button' }, 'Retry');
    retry.addEventListener('click', function () { activateView(activeView); });
    viewBody.appendChild(retry);
  }

  async function activateView(name) {
    if (!session) return;
    activeView = name;
    const tabs = document.querySelectorAll('#tabs .tab');
    for (let i = 0; i < tabs.length; i += 1) {
      if (tabs[i].dataset.view === name) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    clear(document.getElementById('viewBody'));
    const viewMsg = document.getElementById('viewMsg');
    viewMsg.className = '';
    viewMsg.textContent = 'Loading…';
    try {
      await views[name].load();
    } catch (err) {
      const message = err && err.message;
      if (message === 'unauthorized') return;
      showViewFailure(message === '429'
        ? 'Too many requests. Wait a minute and try again.'
        : 'Could not load this view.');
    }
  }

  views.dashboard = {
    load: async function () {
      const result = await api('GET', '/api/admin/metrics');
      assertOk(result.status);
      const data = result.data || {};
      const listings = data.listings || {};
      const stores = data.stores || {};
      const payments = data.payments || {};
      const revenue = data.revenue || {};
      const byType = revenue.byType30d || {};
      clear(document.getElementById('viewBody'));
      const viewMsg = document.getElementById('viewMsg');
      viewMsg.className = '';
      viewMsg.textContent = '';

      const rows = [
        ['listings.active', 'Active listings', fmtNum(listings.active)],
        ['listings.flagged', 'Flagged listings', fmtNum(listings.flagged)],
        ['stores.active', 'Active stores', fmtNum(stores.active)],
        ['stores.flagged', 'Flagged stores', fmtNum(stores.flagged)],
        ['stores.suspended', 'Suspended stores', fmtNum(stores.suspended)],
        ['payments.pending', 'Pending payments', fmtNum(payments.pending)],
        ['payments.completed24h', 'Completed payments (24h)', fmtNum(payments.completed24h)],
        ['payments.failed24h', 'Failed payments (24h)', fmtNum(payments.failed24h)],
        ['revenue.last24h', 'Revenue (24h)', fmtMoney(revenue.last24h)],
        ['revenue.last7d', 'Revenue (7 days)', fmtMoney(revenue.last7d)],
        ['revenue.last30d', 'Revenue (30 days)', fmtMoney(revenue.last30d)],
        ['revenue.listing30d', 'Listing revenue (30 days)', fmtMoney(byType.listing)],
        ['revenue.boost30d', 'Boost revenue (30 days)', fmtMoney(byType.boost)],
        ['revenue.store30d', 'Store revenue (30 days)', fmtMoney(byType.store)],
        ['reports.open', 'Open reports', fmtNum((data.reports || {}).open)],
        ['blocks.total', 'Blocked contacts', fmtNum((data.blocks || {}).total)],
      ];
      const dl = el('dl', { id: 'metrics' });
      rows.forEach(function (row) {
        const card = el('div', { className: 'metric', dataset: { metric: row[0] } });
        card.appendChild(el('dt', null, row[1]));
        card.appendChild(el('dd', null, row[2]));
        dl.appendChild(card);
      });
      document.getElementById('viewBody').appendChild(dl);
      document.getElementById('viewBody').appendChild(el('p', null, 'Generated ' + fmtTime(data.generatedAt)));
      const reload = el('button', { id: 'dashReload', type: 'button' }, 'Refresh');
      reload.addEventListener('click', function () { activateView('dashboard'); });
      document.getElementById('viewBody').appendChild(reload);
    },
  };

  views.health = {
    load: async function () {
      const result = await api('GET', '/api/admin/health');
      assertOk(result.status);
      const data = result.data || {};
      const checks = data.checks || {};
      clear(document.getElementById('viewBody'));
      const viewMsg = document.getElementById('viewMsg');
      viewMsg.className = '';
      viewMsg.textContent = '';

      const rows = [
        ['status', 'Status', data.status === undefined ? '—' : String(data.status)],
        ['mongodb', 'MongoDB', checks.mongodb ? 'up' : 'down'],
        ['cloudinary', 'Cloudinary', checks.cloudinary ? 'up' : 'down'],
        ['timestamp', 'Checked', fmtTime(data.timestamp)],
        ['uptimeSec', 'Uptime', fmtNum(data.uptimeSec) + ' s'],
      ];
      const dl = el('dl', { id: 'healthList' });
      rows.forEach(function (row) {
        const card = el('div', { dataset: { health: row[0] } });
        card.appendChild(el('dt', null, row[1]));
        card.appendChild(el('dd', null, row[2]));
        dl.appendChild(card);
      });
      document.getElementById('viewBody').appendChild(dl);
      const reload = el('button', { id: 'healthReload', type: 'button' }, 'Refresh');
      reload.addEventListener('click', function () { activateView('health'); });
      document.getElementById('viewBody').appendChild(reload);
    },
  };

  // ── Reports and payments ─────────────────────────────────────────────────
  function errorText(data) {
    return data && typeof data.error === 'string' ? data.error : 'error';
  }

  function filterSelect(id, options, value) {
    const node = el('select', { id: id });
    options.forEach(function (opt) {
      const option = el('option', null, opt.label);
      option.value = opt.value;
      node.appendChild(option);
    });
    node.value = value;
    return node;
  }

  function maskPhone(value) {
    if (typeof value === 'string' && /^\d{9,15}$/.test(value)) {
      return value.slice(0, 4) + '***' + value.slice(-2);
    }
    return value;
  }

  views.reports = {
    load: async function () {
      const params = new URLSearchParams();
      params.set('status', reportStatusFilter);
      if (reportTypeFilter) params.set('targetType', reportTypeFilter);
      const result = await api('GET', '/api/admin/reports?' + params.toString());
      assertOk(result.status);
      const data = result.data || {};
      const reports = Array.isArray(data.reports) ? data.reports : [];
      const viewBody = document.getElementById('viewBody');
      const viewMsg = document.getElementById('viewMsg');
      clear(viewBody);
      viewMsg.className = '';
      viewMsg.textContent = reports.length ? '' : 'Nothing to show.';

      const statusSel = filterSelect('reportStatus', [
        { value: 'open', label: 'open' },
        { value: 'actioned', label: 'actioned' },
        { value: 'dismissed', label: 'dismissed' },
        { value: 'all', label: 'all' },
      ], reportStatusFilter);
      statusSel.addEventListener('change', function () { reportStatusFilter = statusSel.value; activateView('reports'); });

      const typeSel = filterSelect('reportType', [
        { value: '', label: 'All types' },
        { value: 'listing', label: 'listing' },
        { value: 'store', label: 'store' },
      ], reportTypeFilter);
      typeSel.addEventListener('change', function () { reportTypeFilter = typeSel.value; activateView('reports'); });

      const reload = el('button', { id: 'reportsReload', type: 'button' }, 'Reload');
      reload.addEventListener('click', function () { activateView('reports'); });

      const toolbar = el('div', { className: 'toolbar' });
      toolbar.appendChild(statusSel);
      toolbar.appendChild(typeSel);
      toolbar.appendChild(reload);
      viewBody.appendChild(toolbar);
      viewBody.appendChild(el('p', null, 'Apply the moderation action first, then record the resolution.'));

      const wrap = el('div', { className: 'scroll' });
      const table = el('table', { id: 'reportsTable' });
      const headRow = el('tr');
      ['Time', 'Type', 'Target ID', 'Reason', 'Details', 'Status', 'Actions'].forEach(function (heading) {
        headRow.appendChild(el('th', null, heading));
      });
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');

      reports.forEach(function (report) {
        const row = el('tr', { dataset: { reportId: report.id } });
        row.appendChild(el('td', null, fmtTime(report.createdAt)));
        row.appendChild(el('td', null, String(report.targetType)));
        row.appendChild(el('td', null, String(report.targetId)));
        row.appendChild(el('td', null, String(report.reason)));
        row.appendChild(el('td', null, report.details ? String(report.details) : '—'));
        let statusText = String(report.status);
        if (report.status !== 'open') {
          statusText += ' / ' + String(report.moderationAction);
          if (report.note) statusText += ' / ' + String(report.note);
        }
        row.appendChild(el('td', null, statusText));

        const actions = el('td');
        if (report.status === 'open') {
          const rowMsg = el('span', { dataset: { role: 'rowMsg' } });
          actions.appendChild(rowMsg);

          const resolution = el('select', { dataset: { field: 'resolution' } });
          ['actioned', 'dismissed'].forEach(function (v) {
            const option = el('option', null, v);
            option.value = v;
            resolution.appendChild(option);
          });
          resolution.value = 'actioned';

          const modOptions = ['none', 'approved', 'flagged', 'removed'];
          if (report.targetType === 'store') modOptions.push('suspended');
          const moderationAction = el('select', { dataset: { field: 'moderationAction' } });
          modOptions.forEach(function (v) {
            const option = el('option', null, v);
            option.value = v;
            moderationAction.appendChild(option);
          });
          moderationAction.value = 'none';

          const note = el('input', { dataset: { field: 'note' } });
          note.maxLength = 200;
          note.placeholder = 'Note (optional)';

          const applyModeration = function (value) {
            let path;
            let body;
            if (report.targetType === 'listing') {
              path = '/api/listings/' + encodeURIComponent(report.targetId) + '/moderate';
              body = { action: value };
            } else if (value === 'suspended') {
              path = '/api/admin/stores/' + encodeURIComponent(report.targetId) + '/suspend';
            } else {
              path = '/api/admin/stores/' + encodeURIComponent(report.targetId) + '/moderate';
              body = { action: value };
            }
            api('PUT', path, body).then(function (outcome) {
              if (outcome.status === 200) {
                rowMsg.textContent = 'Applied: ' + value;
                resolution.value = 'actioned';
                const available = moderationAction.options;
                for (let i = 0; i < available.length; i += 1) {
                  if (available[i].value === value) moderationAction.value = value;
                }
              } else {
                rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
              }
            }, function () {
              rowMsg.textContent = 'Failed: error';
            });
          };

          const buttonDefs = [
            ['approved', 'Approve'],
            ['flagged', 'Flag'],
            ['removed', 'Remove'],
          ];
          if (report.targetType === 'store') buttonDefs.push(['suspended', 'Suspend store']);
          buttonDefs.forEach(function (def) {
            const btn = el('button', { type: 'button', dataset: { action: 'moderate', value: def[0] } }, def[1]);
            armed(btn, def[1], function () { applyModeration(def[0]); });
            actions.appendChild(btn);
          });

          const resolveBtn = el('button', { type: 'button', dataset: { action: 'resolve' } }, 'Record resolution');
          resolveBtn.addEventListener('click', function () {
            const body = { resolution: resolution.value, note: note.value.trim() };
            if (resolution.value === 'actioned') body.moderationAction = moderationAction.value;
            api('PUT', '/api/admin/reports/' + encodeURIComponent(report.id) + '/resolve', body).then(function (outcome) {
              if (outcome.status === 200) {
                activateView('reports');
              } else {
                rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
              }
            }, function () {
              rowMsg.textContent = 'Failed: error';
            });
          });

          actions.appendChild(resolution);
          actions.appendChild(moderationAction);
          actions.appendChild(note);
          actions.appendChild(resolveBtn);
        }
        row.appendChild(actions);
        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
      viewBody.appendChild(wrap);
    },
  };

  views.payments = {
    load: async function () {
      const params = new URLSearchParams();
      if (paymentStatusFilter) params.set('status', paymentStatusFilter);
      if (paymentTypeFilter) params.set('type', paymentTypeFilter);
      const query = params.toString();
      const result = await api('GET', '/api/admin/payments' + (query ? '?' + query : ''));
      assertOk(result.status);
      const data = result.data || {};
      const payments = Array.isArray(data.payments) ? data.payments : [];
      const viewBody = document.getElementById('viewBody');
      const viewMsg = document.getElementById('viewMsg');
      clear(viewBody);
      viewMsg.className = '';
      viewMsg.textContent = payments.length ? '' : 'Nothing to show.';

      const statusSel = filterSelect('paymentStatus', [
        { value: '', label: 'All statuses' },
        { value: 'pending', label: 'pending' },
        { value: 'completed', label: 'completed' },
        { value: 'failed', label: 'failed' },
      ], paymentStatusFilter);
      statusSel.addEventListener('change', function () { paymentStatusFilter = statusSel.value; activateView('payments'); });

      const typeSel = filterSelect('paymentType', [
        { value: '', label: 'All types' },
        { value: 'listing', label: 'listing' },
        { value: 'boost', label: 'boost' },
        { value: 'store', label: 'store' },
      ], paymentTypeFilter);
      typeSel.addEventListener('change', function () { paymentTypeFilter = typeSel.value; activateView('payments'); });

      const reload = el('button', { id: 'paymentsReload', type: 'button' }, 'Reload');
      reload.addEventListener('click', function () { activateView('payments'); });

      const toolbar = el('div', { className: 'toolbar' });
      toolbar.appendChild(statusSel);
      toolbar.appendChild(typeSel);
      toolbar.appendChild(reload);
      viewBody.appendChild(toolbar);

      const wrap = el('div', { className: 'scroll' });
      const table = el('table', { id: 'paymentsTable' });
      const headRow = el('tr');
      ['Time', 'Type', 'Status', 'Amount', 'Item', 'Invoice', 'Phone', 'Actions'].forEach(function (heading) {
        headRow.appendChild(el('th', null, heading));
      });
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');

      payments.forEach(function (payment) {
        const row = el('tr', { dataset: { paymentId: payment._id } });
        row.appendChild(el('td', null, fmtTime(payment.createdAt)));
        row.appendChild(el('td', null, String(payment.type)));
        row.appendChild(el('td', null, String(payment.status)));
        row.appendChild(el('td', null, fmtMoney(payment.amount)));
        row.appendChild(el('td', null, String(payment.package || payment.boostType || payment.storePlan || '—')));
        row.appendChild(el('td', null, payment.invoiceId ? String(payment.invoiceId) : '—'));
        row.appendChild(el('td', null, maskPhone(payment.phoneNumber)));

        const actions = el('td');
        const invoiceId = typeof payment.invoiceId === 'string' && payment.invoiceId ? payment.invoiceId : null;
        if (payment.status !== 'completed' && invoiceId) {
          const rowMsg = el('span', { dataset: { role: 'rowMsg' } });
          actions.appendChild(rowMsg);
          const replay = el('button', { type: 'button', dataset: { action: 'replay', invoice: invoiceId } }, 'Replay payment');
          armed(replay, 'Replay payment', function () {
            api('POST', '/api/admin/payments/' + encodeURIComponent(invoiceId) + '/replay').then(function (outcome) {
              if (outcome.status === 200) {
                rowMsg.textContent = 'Replay requested';
                activateView('payments');
              } else {
                rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
              }
            }, function () {
              rowMsg.textContent = 'Failed: error';
            });
          });
          actions.appendChild(replay);
        }
        row.appendChild(actions);
        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
      viewBody.appendChild(wrap);
    },
  };

  // ── Two-click confirmation ───────────────────────────────────────────────
  // First click arms the button ("Confirm?"); a second click within 4 seconds
  // runs the action. Used by the destructive actions (moderation, replay,
  // unblock). This is the only timer in this file; there is no polling.
  function armed(btn, label, fn) {
    let timer = null;
    btn.addEventListener('click', function () {
      if (btn.dataset.armed === '1') {
        if (timer) { clearTimeout(timer); timer = null; }
        btn.textContent = label;
        delete btn.dataset.armed;
        fn();
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = 'Confirm?';
      timer = setTimeout(function () {
        btn.textContent = label;
        delete btn.dataset.armed;
        timer = null;
      }, 4000);
    });
  }

  // ── Wire up ──────────────────────────────────────────────────────────────
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('signOutBtn').addEventListener('click', function () { logout(''); });
  const tabButtons = document.querySelectorAll('#tabs .tab');
  for (let i = 0; i < tabButtons.length; i += 1) {
    tabButtons[i].addEventListener('click', function () { activateView(this.dataset.view); });
  }
})();
