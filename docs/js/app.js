const POLL_MS = 30_000;
const FULL_RELOAD_MS = 5 * 60_000; // full page reload, so stale HTML/JS/CSS never lingers
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const el = {
  setupNotice: document.getElementById('setupNotice'),
  cards: document.getElementById('summaryCards'),
  tableBody: document.querySelector('#campaignTable tbody'),
  monthlyBody: document.querySelector('#monthlyTable tbody'),
  quarterlyBody: document.querySelector('#quarterlyTable tbody'),
  audienceBody: document.querySelector('#audienceTable tbody'),
  insightsList: document.getElementById('insightsList'),
  lastUpdated: document.getElementById('lastUpdated'),
  refreshBtn: document.getElementById('refreshBtn'),
  dateFrom: document.getElementById('dateFrom'),
  dateTo: document.getElementById('dateTo'),
  audienceFilter: document.getElementById('audienceFilter'),
  applyFilterBtn: document.getElementById('applyFilterBtn'),
  clearFilterBtn: document.getElementById('clearFilterBtn'),
  filterSummary: document.getElementById('filterSummary'),
};

let chart = null;
let monthlyChart = null;
let quarterlyChart = null;
let allCampaigns = [];

function rateClass(v) {
  if (v >= 20) return 'rate-good';
  if (v >= 8) return 'rate-mid';
  return 'rate-low';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

// Mirrors fetch-data.js's aggregation so date-filtered views (computed here,
// client-side, since the filter range is a browser-only selection) match
// exactly what the server would produce for the same campaign set.
function buildComparison(campaigns) {
  if (!campaigns.length) return null;
  const avg = (fn) => Math.round((campaigns.reduce((s, c) => s + fn(c), 0) / campaigns.length) * 10) / 10;
  const best = (fn) => campaigns.reduce((b, c) => (fn(c) > fn(b) ? c : b), campaigns[0]);
  return {
    totalNewsletters: campaigns.length,
    totalSent: campaigns.reduce((s, c) => s + c.sent, 0),
    avgOpenRate: avg((c) => c.openRate),
    avgClickRate: avg((c) => c.clickRate),
    avgReplyRate: avg((c) => c.replyRate),
    bestOpenRate: best((c) => c.openRate),
    bestClickRate: best((c) => c.clickRate),
  };
}

function aggregatePeriods(campaigns, { keyOf, labelOf, sortKey }) {
  const groups = new Map();
  for (const c of campaigns) {
    if (!c.sentDate) continue;
    const d = new Date(c.sentDate);
    const key = keyOf(d);
    if (!groups.has(key)) {
      groups.set(key, {
        period: key, label: labelOf(d), sortKey: sortKey(d),
        newsletters: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replies: 0, unsubscribed: 0, bounced: 0,
      });
    }
    const g = groups.get(key);
    g.newsletters += 1;
    g.sent += c.sent;
    g.delivered += c.delivered;
    g.opened += c.opened;
    g.clicked += c.clicked;
    g.replies += c.replies;
    g.unsubscribed += c.unsubscribed;
    g.bounced += c.bounced;
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      openRate: pct(g.opened, g.delivered || g.sent),
      clickRate: pct(g.clicked, g.delivered || g.sent),
      replyRate: pct(g.replies, g.delivered || g.sent),
    }))
    .sort((a, b) => b.sortKey - a.sortKey);
}

function buildMonthlyReport(campaigns) {
  return aggregatePeriods(campaigns, {
    keyOf: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    labelOf: (d) => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
    sortKey: (d) => d.getFullYear() * 12 + d.getMonth(),
  });
}

function buildQuarterlyReport(campaigns) {
  return aggregatePeriods(campaigns, {
    keyOf: (d) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`,
    labelOf: (d) => `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`,
    sortKey: (d) => d.getFullYear() * 4 + Math.floor(d.getMonth() / 3),
  });
}

// --- Insights engine --------------------------------------------------
// Runs against whatever campaign set is currently in view (respects the
// date/audience filters, same as every other panel), so insights stay
// accurate as new sends come in — nothing here is hardcoded to specific
// dates or audience names.

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(nums) {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
}

function byAudienceChrono(campaigns) {
  const groups = new Map();
  for (const c of campaigns) {
    const key = c.audience || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  groups.forEach((list) => list.sort((a, b) => new Date(a.sentDate || 0) - new Date(b.sentDate || 0)));
  return groups;
}

// Flags a run of 3+ consecutive sends (per audience) where the open rate
// falls below half that audience's own median — then reports whether the
// most recent sends have recovered.
function detectEngagementDips(campaigns) {
  const insights = [];
  byAudienceChrono(campaigns).forEach((sorted, audience) => {
    if (sorted.length < 6) return;
    const med = median(sorted.map((c) => c.openRate));
    if (med <= 0) return;
    const threshold = med * 0.5;

    let run = [];
    const runs = [];
    sorted.forEach((c) => {
      if (c.openRate < threshold) {
        run.push(c);
      } else {
        if (run.length >= 3) runs.push(run);
        run = [];
      }
    });
    if (run.length >= 3) runs.push(run);

    runs.forEach((dipRun) => {
      const startIdx = sorted.indexOf(dipRun[0]);
      const after = sorted.slice(startIdx + dipRun.length, startIdx + dipRun.length + 2);
      const recovered = after.length > 0 && after.every((c) => c.openRate >= med * 0.8);
      const isOngoing = startIdx + dipRun.length >= sorted.length;
      const low = Math.min(...dipRun.map((c) => c.openRate));
      const high = Math.max(...dipRun.map((c) => c.openRate));
      insights.push({
        severity: isOngoing ? 'high' : recovered ? 'positive' : 'medium',
        title: `${audience} engagement dropped for ${dipRun.length} sends in a row`,
        detail: `Open rate fell to ${low}%–${high}% (vs a typical ${Math.round(med * 10) / 10}%) from ${fmtDate(dipRun[0].sentDate)} to ${fmtDate(dipRun[dipRun.length - 1].sentDate)}.`
          + (isOngoing ? ' Still in this range as of the latest send.' : recovered ? ' It has since recovered.' : ' Recovery is not yet confirmed by the sends right after it.'),
      });
    });
  });
  return insights;
}

// Flags a single send whose open/click/reply rate is far above its
// audience's own average — worth reverse-engineering what worked.
function detectStandoutSends(campaigns) {
  const insights = [];
  byAudienceChrono(campaigns).forEach((list, audience) => {
    if (list.length < 4) return;
    [
      { field: 'openRate', label: 'open rate' },
      { field: 'clickRate', label: 'click rate' },
      { field: 'replyRate', label: 'reply rate' },
    ].forEach(({ field, label }) => {
      const avg = mean(list.map((c) => c[field]));
      if (avg <= 0) return;
      const best = list.reduce((b, c) => (c[field] > b[field] ? c : b), list[0]);
      if (best[field] >= avg * 2.5 && best[field] - avg >= 1) {
        insights.push({
          severity: 'info',
          title: `Standout ${label}: "${best.campaignName}" (${audience})`,
          detail: `${best[field]}% vs a ${audience} average of ${Math.round(avg * 10) / 10}% — sent ${fmtDate(best.sentDate)}. Worth checking what was different about the subject line, timing, or content.`,
        });
      }
    });
  });
  return insights;
}

// Compares each audience's click rate against the overall average to catch
// an audience that essentially never clicks (which can point at tracking
// links being stripped by a corporate/hospital email gateway).
function detectClickGap(campaigns) {
  const groups = byAudienceChrono(campaigns);
  if (groups.size < 2) return [];
  const overallAvg = mean(campaigns.map((c) => c.clickRate));
  if (overallAvg <= 0) return [];

  const insights = [];
  groups.forEach((list, audience) => {
    if (list.length < 4) return;
    const avg = mean(list.map((c) => c.clickRate));
    if (avg <= overallAvg * 0.25 && overallAvg - avg >= 0.15) {
      insights.push({
        severity: 'medium',
        title: `${audience} rarely clicks through`,
        detail: `${Math.round(avg * 100) / 100}% average click rate vs ${Math.round(overallAvg * 10) / 10}% overall. If this audience is on a corporate/hospital email system, tracked links are sometimes stripped or blocked — worth testing a plain-text fallback or a "view in browser" link.`,
      });
    }
  });
  return insights;
}

// Compares bounce rate between the first and second half of the
// (chronologically sorted) campaign set to surface list-hygiene trends.
function detectBounceTrend(campaigns) {
  if (campaigns.length < 10) return [];
  const sorted = [...campaigns].sort((a, b) => new Date(a.sentDate || 0) - new Date(b.sentDate || 0));
  const mid = Math.floor(sorted.length / 2);
  const first = sorted.slice(0, mid);
  const second = sorted.slice(mid);
  const firstAvg = mean(first.map((c) => c.bounceRate));
  const secondAvg = mean(second.map((c) => c.bounceRate));
  const delta = secondAvg - firstAvg;
  if (Math.abs(delta) < 0.75) return [];
  return [{
    severity: delta < 0 ? 'positive' : 'high',
    title: delta < 0 ? 'Bounce rate has improved' : 'Bounce rate is climbing',
    detail: `Average bounce rate went from ${Math.round(firstAvg * 10) / 10}% (earlier sends) to ${Math.round(secondAvg * 10) / 10}% (recent sends).`
      + (delta < 0 ? ' Whatever list-cleaning changed is working.' : ' Worth reviewing list hygiene — a growing bounce rate risks sender reputation.'),
  }];
}

// Quarter-over-quarter open rate trend, using the same aggregation as the
// Quarterly report panel so the number always matches what's shown there.
function detectQuarterlyTrend(campaigns) {
  const quarters = buildQuarterlyReport(campaigns).filter((q) => q.newsletters >= 2);
  if (quarters.length < 2) return [];
  const ordered = [...quarters].sort((a, b) => a.sortKey - b.sortKey);
  const last = ordered[ordered.length - 1];
  const prev = ordered[ordered.length - 2];
  const delta = last.openRate - prev.openRate;
  if (Math.abs(delta) < 1) return [];
  return [{
    severity: delta > 0 ? 'positive' : 'medium',
    title: `Open rate ${delta > 0 ? 'up' : 'down'} quarter over quarter`,
    detail: `${prev.label}: ${prev.openRate}% → ${last.label}: ${last.openRate}% (${delta > 0 ? '+' : ''}${Math.round(delta * 10) / 10} points).`,
  }];
}

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2, positive: 3 };

function computeInsights(campaigns) {
  if (campaigns.length < 4) return [];
  const insights = [
    ...detectEngagementDips(campaigns),
    ...detectQuarterlyTrend(campaigns),
    ...detectClickGap(campaigns),
    ...detectBounceTrend(campaigns),
    ...detectStandoutSends(campaigns),
  ];
  return insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function renderInsights(campaigns) {
  const insights = computeInsights(campaigns);
  if (!insights.length) {
    el.insightsList.innerHTML = '<p class="muted">Not enough data in this range to surface insights yet.</p>';
    return;
  }
  el.insightsList.innerHTML = insights.map((i) => `
    <div class="insight insight-${i.severity}">
      <div class="insight-title">${i.title}</div>
      <div class="insight-detail">${i.detail}</div>
    </div>
  `).join('');
}

function renderCards(comparison) {
  if (!comparison) {
    el.cards.innerHTML = '';
    return;
  }
  const items = [
    { label: 'Newsletters sent', value: comparison.totalNewsletters },
    { label: 'Total recipients', value: comparison.totalSent.toLocaleString() },
    { label: 'Avg. open rate', value: `${comparison.avgOpenRate}%` },
    { label: 'Avg. click rate', value: `${comparison.avgClickRate}%` },
    { label: 'Avg. reply rate', value: `${comparison.avgReplyRate}%` },
    { label: 'Best open rate', value: `${comparison.bestOpenRate.openRate}%`, sub: comparison.bestOpenRate.campaignName },
  ];
  el.cards.innerHTML = items.map((i) => `
    <div class="card">
      <div class="value">${i.value}</div>
      <div class="label">${i.label}</div>
      ${i.sub ? `<div class="sub">${i.sub}</div>` : ''}
    </div>
  `).join('');
}

function renderTable(campaigns) {
  if (!campaigns.length) {
    el.tableBody.innerHTML = '<tr class="empty-row"><td colspan="13">No newsletters in this range.</td></tr>';
    return;
  }
  el.tableBody.innerHTML = campaigns.map((c) => `
    <tr>
      <td>${c.campaignName}</td>
      <td>${c.audience || '—'}</td>
      <td>${fmtDate(c.sentDate)}</td>
      <td>${c.sent.toLocaleString()}</td>
      <td>${c.delivered.toLocaleString()}</td>
      <td>${c.opened.toLocaleString()}</td>
      <td class="${rateClass(c.openRate)}">${c.openRate}%</td>
      <td>${c.clicked.toLocaleString()}</td>
      <td class="${rateClass(c.clickRate)}">${c.clickRate}%</td>
      <td>${c.replies.toLocaleString()}</td>
      <td>${c.unsubscribed.toLocaleString()}</td>
      <td>${c.spam.toLocaleString()}</td>
      <td>${c.bounced.toLocaleString()}</td>
    </tr>
  `).join('');
}

function renderPeriodTable(tbody, periods) {
  if (!periods.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No data in this range.</td></tr>';
    return;
  }
  tbody.innerHTML = periods.map((p) => `
    <tr>
      <td>${p.label}</td>
      <td>${p.newsletters}</td>
      <td>${p.sent.toLocaleString()}</td>
      <td>${p.delivered.toLocaleString()}</td>
      <td>${p.opened.toLocaleString()}</td>
      <td class="${rateClass(p.openRate)}">${p.openRate}%</td>
      <td>${p.clicked.toLocaleString()}</td>
      <td class="${rateClass(p.clickRate)}">${p.clickRate}%</td>
      <td>${p.replies.toLocaleString()}</td>
      <td>${p.unsubscribed.toLocaleString()}</td>
      <td>${p.bounced.toLocaleString()}</td>
    </tr>
  `).join('');
}

function renderPeriodChart(existing, canvasId, periods) {
  const ordered = [...periods].sort((a, b) => a.sortKey - b.sortKey);
  const data = {
    labels: ordered.map((p) => p.label),
    datasets: [
      { label: 'Open rate %', data: ordered.map((p) => p.openRate), backgroundColor: '#2563eb' },
      { label: 'Click rate %', data: ordered.map((p) => p.clickRate), backgroundColor: '#ea580c' },
    ],
  };
  if (existing) {
    existing.data = data;
    existing.update();
    return existing;
  }
  return new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${v}%` } } },
    },
  });
}

function renderChart(campaigns) {
  const ordered = [...campaigns].sort((a, b) => new Date(a.sentDate || 0) - new Date(b.sentDate || 0));
  const labels = ordered.map((c) => c.campaignName.replace(/^Newsletter_?/i, ''));
  const openRates = ordered.map((c) => c.openRate);
  const clickRates = ordered.map((c) => c.clickRate);

  const data = {
    labels,
    datasets: [
      { label: 'Open rate %', data: openRates, borderColor: '#2563eb', backgroundColor: '#2563eb22', tension: 0.3, fill: true },
      { label: 'Click rate %', data: clickRates, borderColor: '#ea580c', backgroundColor: '#ea580c22', tension: 0.3, fill: true },
    ],
  };

  if (chart) {
    chart.data = data;
    chart.update();
    return;
  }
  chart = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${v}%` } } },
    },
  });
}

function dateFilteredCampaigns() {
  const from = el.dateFrom.value ? new Date(el.dateFrom.value) : null;
  const to = el.dateTo.value ? new Date(el.dateTo.value) : null;
  if (to) to.setHours(23, 59, 59, 999); // inclusive of the whole "to" day

  return allCampaigns.filter((c) => {
    if (!c.sentDate) return false;
    const d = new Date(c.sentDate);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

function renderAudienceComparison(campaigns) {
  const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
  const groups = ['Doctors', 'Marketing'].map((name) => {
    const list = campaigns.filter((c) => c.audience === name);
    return { name, list, comparison: buildComparison(list) };
  });
  if (groups.every((g) => !g.comparison)) {
    el.audienceBody.innerHTML = '<tr class="empty-row"><td colspan="10">No data in this range.</td></tr>';
    return;
  }
  el.audienceBody.innerHTML = groups.map(({ name, list, comparison: c }) => {
    if (!c) return `<tr><td>${name}</td><td colspan="9" class="muted">No sends in this range</td></tr>`;
    return `
      <tr>
        <td>${name}</td>
        <td>${c.totalNewsletters}</td>
        <td>${c.totalSent.toLocaleString()}</td>
        <td>${sum(list, (x) => x.delivered).toLocaleString()}</td>
        <td>${sum(list, (x) => x.opened).toLocaleString()}</td>
        <td class="${rateClass(c.avgOpenRate)}">${c.avgOpenRate}%</td>
        <td>${sum(list, (x) => x.clicked).toLocaleString()}</td>
        <td class="${rateClass(c.avgClickRate)}">${c.avgClickRate}%</td>
        <td>${sum(list, (x) => x.replies).toLocaleString()}</td>
        <td>${c.avgReplyRate}%</td>
      </tr>
    `;
  }).join('');
}

function renderAll() {
  const dateFiltered = dateFilteredCampaigns();
  const audience = el.audienceFilter.value;
  const campaigns = audience ? dateFiltered.filter((c) => c.audience === audience) : dateFiltered;

  const isFiltered = Boolean(el.dateFrom.value || el.dateTo.value || audience);
  el.filterSummary.textContent = isFiltered ? `${campaigns.length} of ${allCampaigns.length} newsletters` : '';

  renderAudienceComparison(dateFiltered);
  renderInsights(campaigns);

  renderCards(buildComparison(campaigns));
  renderTable(campaigns);
  renderChart(campaigns);

  const monthly = buildMonthlyReport(campaigns);
  const quarterly = buildQuarterlyReport(campaigns);
  renderPeriodTable(el.monthlyBody, monthly);
  renderPeriodTable(el.quarterlyBody, quarterly);
  monthlyChart = renderPeriodChart(monthlyChart, 'monthlyChart', monthly);
  quarterlyChart = renderPeriodChart(quarterlyChart, 'quarterlyChart', quarterly);
}

async function load() {
  // data.json is a static file in the repo, republished by the local fetch
  // script. The query string defeats CDN/browser caching of the old copy.
  let snapshot = null;
  try {
    const res = await fetch(`data.json?v=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) snapshot = await res.json();
  } catch {
    snapshot = null;
  }

  el.setupNotice.classList.toggle('hidden', Boolean(snapshot));
  el.lastUpdated.textContent = snapshot && snapshot.lastUpdated
    ? `Data updated ${new Date(snapshot.lastUpdated).toLocaleString()}`
    : 'No data yet';

  allCampaigns = (snapshot && snapshot.campaigns) || [];
  renderAll();
}

el.refreshBtn.addEventListener('click', async () => {
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = 'Reloading...';
  try {
    await load();
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = 'Reload';
  }
});

el.applyFilterBtn.addEventListener('click', renderAll);
el.audienceFilter.addEventListener('change', renderAll);
el.clearFilterBtn.addEventListener('click', () => {
  el.dateFrom.value = '';
  el.dateTo.value = '';
  el.audienceFilter.value = '';
  renderAll();
});

load();
setInterval(load, POLL_MS);
setInterval(() => window.location.reload(), FULL_RELOAD_MS);
