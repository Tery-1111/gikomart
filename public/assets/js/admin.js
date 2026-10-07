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
  let grantStatusFilter = 'pending';
  let reportStatusFilter = 'open';
  let reportTypeFilter = '';
  let paymentStatusFilter = '';
  let paymentTypeFilter = '';
  let auditActionFilter = '';
  let auditResourceFilter = '';

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
        ['payments.granted30d', 'Free grants (30 days)', fmtNum(payments.granted30d)],
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

  // Mask a phone for non-grant surfaces (payments table). Grant requests show
  // the full number in their session-gated queue (see views.grants).
  function maskPhone(value) {
    if (typeof value === 'string' && /^\d{9,15}$/.test(value)) {
      return value.slice(0, 4) + '***' + value.slice(-2);
    }
    return value;
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

  // ── Blocks and audit log ─────────────────────────────────────────────────
  function detailsText(metadata) {
    const json = JSON.stringify(metadata || {});
    return json.length > 200 ? json.slice(0, 200) + '…' : json;
  }

  views.blocks = {
    load: async function () {
      const viewBody = document.getElementById('viewBody');
      const first = await api('GET', '/api/admin/blocks');
      assertOk(first.status);

      clear(viewBody);
      const viewMsg = document.getElementById('viewMsg');
      viewMsg.className = '';
      viewMsg.textContent = '';

      const form = el('form', { id: 'blockForm' });
      form.setAttribute('novalidate', '');
      form.setAttribute('autocomplete', 'off');

      const typeSel = filterSelect('blockType', [
        { value: 'phone', label: 'Phone number' },
        { value: 'listing', label: 'Listing ID' },
        { value: 'store', label: 'Store ID' },
      ], 'phone');
      const target = el('input', { id: 'blockTarget', type: 'tel' });
      target.setAttribute('autocomplete', 'off');
      const reason = el('input', { id: 'blockReason' });
      reason.maxLength = 200;
      reason.placeholder = 'Reason (required)';
      const submit = el('button', { id: 'blockSubmit', type: 'submit' }, 'Add block');
      const blockMsg = el('p', { id: 'blockMsg' });
      blockMsg.setAttribute('role', 'status');

      const applyType = function () {
        if (typeSel.value === 'phone') {
          target.type = 'tel';
          target.placeholder = 'Phone number';
        } else {
          target.type = 'text';
          target.placeholder = typeSel.value === 'listing' ? 'Listing ID' : 'Store ID';
        }
      };
      typeSel.addEventListener('change', applyType);
      applyType();

      form.appendChild(typeSel);
      form.appendChild(target);
      form.appendChild(reason);
      form.appendChild(submit);
      form.appendChild(blockMsg);
      viewBody.appendChild(form);

      const listContainer = el('div');
      viewBody.appendChild(listContainer);

      function renderList(blocks) {
        viewMsg.textContent = blocks.length ? '' : 'Nothing to show.';
        clear(listContainer);
        const wrap = el('div', { className: 'scroll' });
        const table = el('table', { id: 'blocksTable' });
        const headRow = el('tr');
        ['Time', 'Type', 'Source ID', 'Reason', 'Added by', 'Actions'].forEach(function (heading) {
          headRow.appendChild(el('th', null, heading));
        });
        const thead = el('thead');
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = el('tbody');
        blocks.forEach(function (block) {
          const row = el('tr', { dataset: { blockId: block.id } });
          row.appendChild(el('td', null, fmtTime(block.createdAt)));
          row.appendChild(el('td', null, String(block.sourceType)));
          row.appendChild(el('td', null, block.sourceId ? String(block.sourceId) : '—'));
          row.appendChild(el('td', null, String(block.reason)));
          row.appendChild(el('td', null, String(block.createdBy)));
          const actions = el('td');
          const rowMsg = el('span', { dataset: { role: 'rowMsg' } });
          actions.appendChild(rowMsg);
          const btn = el('button', { type: 'button', dataset: { action: 'unblock' } }, 'Remove block');
          armed(btn, 'Remove block', function () {
            api('DELETE', '/api/admin/blocks/' + encodeURIComponent(block.id)).then(function (outcome) {
              if (outcome.status === 200) refreshList();
              else rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
            }, function () {
              rowMsg.textContent = 'Failed: error';
            });
          });
          actions.appendChild(btn);
          row.appendChild(actions);
          tbody.appendChild(row);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        listContainer.appendChild(wrap);
      }

      function refreshList() {
        return api('GET', '/api/admin/blocks').then(function (result) {
          if (result.status !== 200) {
            showViewFailure(result.status === 429
              ? 'Too many requests. Wait a minute and try again.'
              : 'Could not load this view.');
            return;
          }
          renderList(Array.isArray(result.data.blocks) ? result.data.blocks : []);
        }, function () {
          showViewFailure('Could not load this view.');
        });
      }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        const targetValue = target.value.trim();
        const reasonValue = reason.value.trim();
        if (!targetValue) { blockMsg.textContent = 'Enter a target.'; return; }
        if (!reasonValue) { blockMsg.textContent = 'Enter a reason.'; return; }
        const body = { sourceType: typeSel.value, reason: reasonValue };
        if (typeSel.value === 'phone') body.phone = targetValue;
        else body.sourceId = targetValue;
        api('POST', '/api/admin/blocks', body).then(function (outcome) {
          if (outcome.status === 200 || outcome.status === 201) {
            blockMsg.textContent = 'Added: ' + outcome.data.created + ' new, '
              + outcome.data.alreadyBlocked + ' already blocked.';
            target.value = '';
            reason.value = '';
            refreshList();
          } else {
            blockMsg.textContent = 'Failed: ' + errorText(outcome.data);
            target.value = '';
          }
        }, function () {
          target.value = '';
          blockMsg.textContent = 'Failed: error';
        });
      });

      renderList(Array.isArray(first.data.blocks) ? first.data.blocks : []);
    },
  };

  views.audit = {
    load: async function () {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (auditActionFilter) params.set('action', auditActionFilter);
      if (auditResourceFilter) params.set('resource', auditResourceFilter);
      const result = await api('GET', '/api/admin/audit-logs?' + params.toString());
      assertOk(result.status);
      const data = result.data || {};
      const logs = Array.isArray(data.logs) ? data.logs : [];
      const viewBody = document.getElementById('viewBody');
      const viewMsg = document.getElementById('viewMsg');
      clear(viewBody);
      viewMsg.className = '';
      viewMsg.textContent = logs.length ? '' : 'Nothing to show.';

      const actionInput = el('input', { id: 'auditAction' });
      actionInput.placeholder = 'Action (optional)';
      actionInput.value = auditActionFilter;
      const resourceInput = el('input', { id: 'auditResource' });
      resourceInput.placeholder = 'Resource (optional)';
      resourceInput.value = auditResourceFilter;
      const loadBtn = el('button', { id: 'auditLoad', type: 'button' }, 'Load');
      loadBtn.addEventListener('click', function () {
        auditActionFilter = actionInput.value.trim();
        auditResourceFilter = resourceInput.value.trim();
        activateView('audit');
      });
      const toolbar = el('div', { className: 'toolbar' });
      toolbar.appendChild(actionInput);
      toolbar.appendChild(resourceInput);
      toolbar.appendChild(loadBtn);
      viewBody.appendChild(toolbar);

      const wrap = el('div', { className: 'scroll' });
      const table = el('table', { id: 'auditTable' });
      const headRow = el('tr');
      ['Time', 'Actor', 'Action', 'Resource', 'Resource ID', 'Result', 'Details'].forEach(function (heading) {
        headRow.appendChild(el('th', null, heading));
      });
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');
      table.appendChild(tbody);
      wrap.appendChild(table);
      viewBody.appendChild(wrap);

      let lastTimestamp = logs.length ? logs[logs.length - 1].timestamp : null;

      const appendRows = function (rows) {
        rows.forEach(function (log) {
          const row = el('tr', { dataset: { audit: '1' } });
          row.appendChild(el('td', null, fmtTime(log.timestamp)));
          row.appendChild(el('td', null, String(log.actor)));
          row.appendChild(el('td', null, String(log.action)));
          row.appendChild(el('td', null, String(log.resource)));
          row.appendChild(el('td', null, log.resourceId ? String(log.resourceId) : '—'));
          row.appendChild(el('td', null, String(log.result)));
          row.appendChild(el('td', null, detailsText(log.metadata)));
          tbody.appendChild(row);
        });
      };

      const syncMore = function (rows) {
        const existing = document.getElementById('auditMore');
        if (existing) existing.remove();
        if (rows.length !== 50) return;
        const more = el('button', { id: 'auditMore', type: 'button' }, 'Load older');
        more.addEventListener('click', function () {
          const older = new URLSearchParams(params);
          if (lastTimestamp !== null) older.set('before', String(lastTimestamp));
          api('GET', '/api/admin/audit-logs?' + older.toString()).then(function (outcome) {
            if (outcome.status !== 200) {
              showViewFailure(outcome.status === 429
                ? 'Too many requests. Wait a minute and try again.'
                : 'Could not load this view.');
              return;
            }
            const more2 = Array.isArray(outcome.data.logs) ? outcome.data.logs : [];
            appendRows(more2);
            if (more2.length) lastTimestamp = more2[more2.length - 1].timestamp;
            syncMore(more2);
          }, function () {
            showViewFailure('Could not load this view.');
          });
        });
        viewBody.appendChild(more);
      };

      appendRows(logs);
      syncMore(logs);
    },
  };

  // ── Grant free access (mock payment) ─────────────────────────────────────
  // Completes a pending listing/store payment without a real IntaSend webhook.
  // Exactly one identifier is required; the server rejects a request with none.
  views.grant = {
    load: async function () {
      const body = document.getElementById('viewBody');
      const viewMsg = document.getElementById('viewMsg');
      clear(body);
      viewMsg.className = '';
      viewMsg.textContent = '';

      const form = el('form', { id: 'grantForm' });
      form.setAttribute('novalidate', '');
      form.setAttribute('autocomplete', 'off');

      const phoneInput = el('input', { id: 'grantPhone', type: 'tel' });
      phoneInput.placeholder = 'Phone number';
      phoneInput.setAttribute('autocomplete', 'off');

      const paymentInput = el('input', { id: 'grantPaymentId' });
      paymentInput.placeholder = 'Payment ID';
      paymentInput.setAttribute('autocomplete', 'off');

      const invoiceInput = el('input', { id: 'grantInvoiceId' });
      invoiceInput.placeholder = 'Invoice ID';
      invoiceInput.setAttribute('autocomplete', 'off');

      const previewBtn = el('button', { id: 'grantPreviewBtn', type: 'button' }, 'Preview');
      const submit = el('button', { id: 'grantSubmit', type: 'submit' }, 'Grant access');
      const previewMsg = el('p', { id: 'grantPreviewMsg' });
      previewMsg.setAttribute('role', 'status');
      const grantMsg = el('p', { id: 'grantMsg' });
      grantMsg.setAttribute('role', 'status');

      form.appendChild(phoneInput);
      form.appendChild(paymentInput);
      form.appendChild(invoiceInput);
      form.appendChild(previewBtn);
      form.appendChild(submit);
      form.appendChild(previewMsg);
      form.appendChild(grantMsg);
      body.appendChild(form);
      body.appendChild(el('p', null, 'Provide any one of phone number, payment ID, or invoice ID. Preview first, then grant the previewed payment.'));

      // The grant button is only enabled once a preview has succeeded for the
      // CURRENT input values. Any edit invalidates it, so the granted payment is
      // always exactly the one the admin saw previewed.
      let previewedId = null;
      let previewedKey = null;

      function currentSelector() {
        const phone = phoneInput.value.trim();
        const paymentId = paymentInput.value.trim();
        const invoiceId = invoiceInput.value.trim();
        if (paymentId) return { paymentId: paymentId };
        if (invoiceId) return { invoiceId: invoiceId };
        if (phone) return { phoneNumber: phone };
        return null;
      }

      function currentKey() {
        const sel = currentSelector();
        return sel ? JSON.stringify(sel) : '';
      }

      function invalidate() {
        previewedId = null;
        previewedKey = null;
        submit.disabled = true;
      }

      submit.disabled = true;

      [phoneInput, paymentInput, invoiceInput].forEach(function (input) {
        input.addEventListener('input', function () {
          invalidate();
          previewMsg.textContent = '';
        });
      });

      previewBtn.addEventListener('click', function () {
        const selector = currentSelector();
        previewMsg.textContent = '';
        invalidate();
        if (!selector) {
          previewMsg.textContent = 'Enter one of: phone number, payment ID, or invoice ID.';
          return;
        }
        api('POST', '/api/admin/grant-preview', selector).then(function (outcome) {
          if (outcome.status === 200) {
            const p = (outcome.data || {}).payment || {};
            const name = p.title || p.storeName || '(no name)';
            const plan = p.package || p.storePlan || '(no plan)';
            previewMsg.textContent = 'Will grant: ' + String(p.type) + ' ' + String(name)
              + ' (' + String(plan) + '), created ' + fmtTime(p.createdAt)
              + ', phone ' + String(p.phoneMasked);
            previewedId = p.id;
            previewedKey = currentKey();
            submit.disabled = false;
          } else {
            previewMsg.textContent = 'Failed: ' + errorText(outcome.data);
          }
        }, function () {
          previewMsg.textContent = 'Failed: error';
        });
      });

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        grantMsg.textContent = '';
        // Grant exactly the previewed payment id, and no other selector.
        if (!previewedId || previewedKey !== currentKey()) {
          grantMsg.textContent = 'Preview the payment first.';
          return;
        }
        api('POST', '/api/admin/grant-free-access', { paymentId: previewedId }).then(function (outcome) {
          if (outcome.status === 200) {
            const data = outcome.data || {};
            const resource = data.resource || {};
            grantMsg.textContent = 'Free access granted: ' + String(resource.type) + ' ' + String(resource.id);
            phoneInput.value = '';
            paymentInput.value = '';
            invoiceInput.value = '';
            invalidate();
          } else {
            grantMsg.textContent = 'Failed: ' + errorText(outcome.data);
          }
        }, function () {
          grantMsg.textContent = 'Failed: error';
        });
      });
    },
  };

  // ── Free Grant requests ──────────────────────────────────────────────────
  // Administrative free-access requests (no payment involved). Approving one
  // lets the SELLER redeem it on their own device, where the owner token is
  // minted. The admin never handles the seller's claim token — except as a
  // deliberate, explicit rotation: for an approved grant whose token was lost
  // before redemption, the admin can mint a NEW continuation credential
  // (see mintGrantContinuation below), which atomically replaces the stored
  // hash so the old token stops working.

  // Copy text to the clipboard with the same execCommand fallback the seller
  // app uses (JSDOM/test and older browsers have no navigator.clipboard).
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch (err) { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }

  // Direct WhatsApp contact: the number is already normalized to
  // 254[17]XXXXXXXX, exactly the format wa.me expects — no reformatting.
  // presetText (optional) is sent as the prefilled message, e.g. a
  // continuation link minted for this grant.
  function buildGrantContactAnchor(grant, presetText) {
    const anchor = el('a', null, 'WhatsApp Seller');
    const message = presetText
      || 'Hi! Your GikoMart Free Grant was approved. Open GikoMart, tap "Request a Free Grant" in the Sell tab, and it will guide you to finish publishing your ' + (grant.type === 'store' ? 'store' : 'listing') + '.';
    anchor.href = 'https://wa.me/' + String(grant.whatsapp) + '?text=' + encodeURIComponent(message);
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    return anchor;
  }

  // Mint a NEW continuation credential for an approved, unprovisioned grant.
  // The endpoint atomically replaces the stored claimTokenHash and returns the
  // raw token exactly once — it lives only in this closure and is never stored,
  // logged, or re-fetched. The row then offers: the #grant=<id>/<token> link
  // (hash fragment, never sent to a server), a copy button, the WhatsApp
  // message carrying the link, and a reveal control for the token itself.
  // Closing the tab discards it; minting again revokes it.
  function mintGrantContinuation(grant) {
    const result = { done: false };
    result.promise = api('POST', '/api/admin/grants/' + encodeURIComponent(grant.id) + '/continuation-token', {}).then(function (outcome) {
      if (outcome.status !== 200) throw new Error(errorText(outcome.data));
      const data = outcome.data || {};
      const claimId = String(data.claimId || grant.id);
      const token = String(data.claimToken || '');
      if (!token) throw new Error('empty token');
      result.done = true;

      let origin = '';
      try { origin = window.location.origin; } catch (err) { /* JSDOM guards */ }
      // The admin portal and the seller app share an origin; the fragment is
      // never transmitted, so the absolute origin is only a display concern.
      if (!origin) origin = 'https://gikomart.co.ke';
      const link = origin + '/#grant=' + encodeURIComponent(claimId) + '/' + encodeURIComponent(token);
      const waMessage = 'Hi! Here is your GikoMart Free Grant continuation link. Open it on the phone or computer where you want to finish publishing your ' + (grant.type === 'store' ? 'store' : 'listing') + '. Anyone who has the link can finish the request, so keep it private. Link: ' + link;

      const row = document.querySelector('#grantsTable tr[data-grant-id="' + grant.id + '"]');
      const rowMsg = row ? row.querySelector('[data-role="rowMsg"]') : document.createElement('span');
      if (!row) return; // view reloaded mid-flight — token discarded unused
      clear(rowMsg);

      rowMsg.appendChild(el('strong', null, 'Continuation link (shown only once — the previous token no longer works):'));
      const openAnchor = el('a', null, 'Open link');
      openAnchor.href = link;
      rowMsg.appendChild(openAnchor);
      if (grant.whatsapp) {
        rowMsg.appendChild(buildGrantContactAnchor(grant, waMessage));
      }
      const copyBtn = el('button', { type: 'button' }, 'Copy link');
      copyBtn.addEventListener('click', async function () {
        const ok = await copyText(link);
        copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
        setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 3000);
      });
      rowMsg.appendChild(copyBtn);
      // No raw-token span is rendered: the token travels inside the link
      // (href + copy + WhatsApp message) and nowhere else, so it never
      // appears as page text — not even hidden-and-revealable.
    });
    return result;
  }

  views.grants = {
    load: async function () {
      // 'provisioned' is a client-side view over the approved dataset (rows
      // whose provisioning fields are set) — the API only knows the three
      // stored statuses, and its whitelist would fall back to 'pending'.
      const apiStatus = grantStatusFilter === 'provisioned' ? 'approved' : grantStatusFilter;
      const result = await api('GET', '/api/admin/grants?status=' + encodeURIComponent(apiStatus));
      assertOk(result.status);
      const data = result.data || {};
      const allRequests = Array.isArray(data.requests) ? data.requests : [];
      const requests = grantStatusFilter === 'provisioned'
        ? allRequests.filter(function (grant) { return grant.provisioned; })
        : allRequests;
      const viewBody = document.getElementById('viewBody');
      const viewMsg = document.getElementById('viewMsg');
      clear(viewBody);
      viewMsg.className = '';
      viewMsg.textContent = requests.length ? '' : 'Nothing to show.';
      viewBody.appendChild(el('p', null, 'Approve or reject seller requests for a free package. Approval cannot be undone here — the seller then redeems it on their own device.'));

      // Answer "why can't I unapprove?" in place, where the expectation
      // actually forms. The full rationale lives in docs/DECISIONS.md
      // (record #36) — not served by this app, hence the repo link.
      const rationaleNote = el('p', { className: 'view-note' });
      rationaleNote.appendChild(document.createTextNode("Why can't I unapprove? Approval is a one-way atomic write — reversing it could race an in-flight redemption or provisioning, strand minted continuation tokens, and break the audit trail. Rationale: "));
      const rationaleLink = el('a', null, 'docs/DECISIONS.md · record #36');
      rationaleLink.href = 'https://github.com/Tery-1111/gikomart/blob/main/docs/DECISIONS.md';
      rationaleLink.target = '_blank';
      rationaleLink.rel = 'noopener noreferrer';
      rationaleNote.appendChild(rationaleLink);
      viewBody.appendChild(rationaleNote);

      // History filter (pending default preserved).
      const filterWrap = el('div', { className: 'filter-row' });
      const statusSel = filterSelect('grantStatusFilter', [
        { value: 'pending', label: 'pending' },
        { value: 'approved', label: 'approved' },
        { value: 'rejected', label: 'rejected' },
        { value: 'provisioned', label: 'provisioned' },
      ], grantStatusFilter);
      statusSel.addEventListener('change', function () {
        grantStatusFilter = statusSel.value;
        activateView('grants');
      });
      filterWrap.appendChild(el('label', null, 'Status: '));
      filterWrap.appendChild(statusSel);
      viewBody.appendChild(filterWrap);

      const wrap = el('div', { className: 'scroll' });
      const table = el('table', { id: 'grantsTable' });
      const headRow = el('tr');
      ['Time', 'Type', 'Package', 'Phone', 'Status', 'Actions'].forEach(function (heading) {
        headRow.appendChild(el('th', null, heading));
      });
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');

      requests.forEach(function (grant) {
        const row = el('tr', { dataset: { grantId: grant.id } });
        row.appendChild(el('td', null, fmtTime(grant.createdAt)));
        const typeCell = el('td');
        typeCell.appendChild(document.createTextNode(String(grant.type)));
        // Test requests (agent QA runs) are marked so they are never mistaken
        // for real sellers in a queue that serves real people.
        if (grant.isTest) {
          typeCell.appendChild(document.createTextNode(' '));
          typeCell.appendChild(el('span', { className: 'qa-badge' }, 'QA/test'));
        }
        row.appendChild(typeCell);
        row.appendChild(el('td', null, String(grant.package || grant.storePlan || '—')));
        row.appendChild(el('td', null, grant.whatsapp ? String(grant.whatsapp) : '—'));
        row.appendChild(el('td', null, grant.status + (grant.provisioned ? ' / provisioned' : '')));

        const actions = el('td');
        const rowMsg = el('span', { dataset: { role: 'rowMsg' } });
        actions.appendChild(rowMsg);
        // QA/test marker toggle: visible for every status so a flag can be
        // corrected after the fact. Same two-click guard as the other actions.
        const qaLabel = grant.isTest ? 'Unmark QA/test' : 'Mark QA/test';
        const qaBtn = el('button', { type: 'button' }, qaLabel);
        armed(qaBtn, qaLabel, function () {
          api('POST', '/api/admin/grants/' + encodeURIComponent(grant.id) + '/qa-flag', { isTest: !grant.isTest }).then(function (outcome) {
            if (outcome.status === 200) activateView('grants');
            else rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
          }, function () { rowMsg.textContent = 'Failed: error'; });
        });
        actions.appendChild(qaBtn);
        // Direct WhatsApp contact: the number is already normalized to
        // 254[17]XXXXXXXX, exactly the format wa.me expects — no reformatting.
        if (grant.whatsapp) {
          actions.appendChild(buildGrantContactAnchor(grant, null));
        }
        // Deliberate rotation for an approved grant whose claim token was
        // lost before redemption: mint a NEW credential (revoking the old
        // one) and hand the seller a #grant= fragment link + WhatsApp message.
        if (grant.status === 'approved' && !grant.provisioned) {
          const mintBtn = el('button', { type: 'button' }, 'New continuation link');
          armed(mintBtn, 'New continuation link', function () {
            const minted = mintGrantContinuation(grant);
            minted.promise.catch(function (err) {
              rowMsg.textContent = 'Failed: ' + (err && err.message ? err.message : 'error');
            });
          });
          actions.appendChild(mintBtn);
        }
        if (grant.status === 'pending') {
          const approve = el('button', { type: 'button' }, 'Approve');          armed(approve, 'Approve', function () {
            api('POST', '/api/admin/grants/' + encodeURIComponent(grant.id) + '/approve').then(function (outcome) {
              if (outcome.status === 200) activateView('grants');
              else rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
            }, function () { rowMsg.textContent = 'Failed: error'; });
          });
          const reject = el('button', { type: 'button' }, 'Reject');
          armed(reject, 'Reject', function () {
            api('POST', '/api/admin/grants/' + encodeURIComponent(grant.id) + '/reject').then(function (outcome) {
              if (outcome.status === 200) activateView('grants');
              else rowMsg.textContent = 'Failed: ' + errorText(outcome.data);
            }, function () { rowMsg.textContent = 'Failed: error'; });
          });
          actions.appendChild(approve);
          actions.appendChild(reject);
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
  // admin.js is loaded with defer from <head>, which already guarantees
  // execution after the DOM is parsed; the DOMContentLoaded wrapper is a
  // belt-and-braces guard so element lookup can never race document parsing
  // regardless of how the script is loaded.
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('signOutBtn').addEventListener('click', function () { logout(''); });
    const tabButtons = document.querySelectorAll('#tabs .tab');
    for (let i = 0; i < tabButtons.length; i += 1) {
      tabButtons[i].addEventListener('click', function () { activateView(this.dataset.view); });
    }
  });
})();
