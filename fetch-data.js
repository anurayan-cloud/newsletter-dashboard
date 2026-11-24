// Pulls sent-campaign reports from Zoho Campaigns and writes a normalized
// snapshot to docs/data.json, which the GitHub Pages dashboard reads.
//
// Run directly:  node fetch-data.js
//   1. fetches + normalizes everything from Zoho (must run on a machine Zoho
//      accepts — Zoho flags OAuth calls from cloud/datacenter IPs),
//   2. rewrites docs/data.json only if the data actually changed,
//   3. commits and pushes it, which republishes the Pages site.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAccessToken, listSentCampaigns, getCampaignReport } = require('./zoho-client');

const DATA_DIR = path.join(__dirname, 'data'); // local-only scratch (git-ignored)
const DATA_FILE = path.join(__dirname, 'docs', 'data.json'); // published
const DEBUG_FILE = path.join(DATA_DIR, 'debug-last-response.json');
const MIN_RECIPIENTS = Number(process.env.MIN_RECIPIENTS || 50);
// Only keep the actual weekly newsletter series — Zoho's campaign list also
// includes one-off product/marketing sends (Cipla, Hetero, "Thank you
// Mailer", etc.) that aren't newsletters and shouldn't be in this dashboard.
const NAME_FILTER = new RegExp(process.env.NEWSLETTER_NAME_PATTERN || '^news\\s*letter', 'i');
// Every newsletter edition is actually sent as two separate campaigns — one
// to the "Doctors" mailing list, one to everyone else (HR, Marketing List,
// Aristo, etc.). Classify each campaign by which list(s) it went to.
const DOCTOR_LIST_PATTERN = new RegExp(process.env.DOCTOR_LIST_PATTERN || 'doctor', 'i');

function num(v) {
  const n = Number(String(v ?? '0').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

// Zoho's report payload nests stats under slightly different keys across
// API versions/accounts. This pulls the first matching field it finds so a
// small drift in Zoho's response shape doesn't break the whole run.
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// getcampaigndetails nests the stats block under one of a few possible
// wrapper keys depending on account/API version. Merge whatever we find so
// pick() below can look the fields up flat regardless of nesting.
function flattenReport(report) {
  const wrapperKeys = ['campaign-reports', 'campaign_reports', 'reports', 'report', 'campaignreport'];
  let merged = { ...report };
  for (const key of wrapperKeys) {
    let val = report && report[key];
    if (Array.isArray(val)) val = val[0];
    if (val && typeof val === 'object') {
      merged = { ...merged, ...val };
    }
  }
  return merged;
}

function toIso(epochMsOrString) {
  if (!epochMsOrString) return null;
  const n = Number(epochMsOrString);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(epochMsOrString);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getAudience(report) {
  const lists = (report && report.associated_mailing_lists) || [];
  const names = lists.map((l) => l.listname || '');
  return names.some((n) => DOCTOR_LIST_PATTERN.test(n)) ? 'Doctors' : 'Marketing';
}

function mapCampaignSummary(listEntry, report) {
  const r = flattenReport(report);
  const sent = num(pick(r, 'emails_sent_count', 'sent_count', 'Total_count', 'sent'));
  const delivered = num(pick(r, 'delivered_count', 'delivered')) || sent;
  const opened = num(pick(r, 'opens_count', 'opened', 'opens'));
  const opensWithBots = num(pick(r, 'opens_with_bot_count', 'opens_including_bots')) || opened;
  const clicked = num(pick(r, 'unique_clicks_count', 'clicks_count', 'clicked', 'clicks'));
  const unsubscribed = num(pick(r, 'unsub_count', 'unsubscribe_count', 'unsubscribes'));
  const spam = num(pick(r, 'spams_count', 'complaints_count', 'spam_count', 'marked_spam'));
  const forwards = num(pick(r, 'forwards_count', 'forwards'));
  const replies = num(pick(r, 'autoreply_count', 'replies_count', 'replied', 'reply_count'));
  const bounced = num(pick(r, 'bounces_count', 'bounce_count', 'bounced', 'total_bounces'));

  return {
    campaignKey: listEntry.campaign_key || listEntry.campaignkey || listEntry.CAMPAIGNKEY,
    campaignName: listEntry.campaign_name || listEntry.campaignname || listEntry.CAMPAIGNNAME || 'Untitled',
    audience: getAudience(report),
    sentDate: toIso(listEntry.sent_time || listEntry.sentdate || listEntry.SENTTIME),
    sent,
    delivered,
    opened,
    opensWithBots,
    unopened: num(pick(r, 'unopened')) || Math.max(sent - opened, 0),
    clicked,
    unsubscribed,
    spam,
    forwards,
    replies,
    bounced,
    openRate: pct(opened, delivered || sent),
    openRateWithBots: pct(opensWithBots, delivered || sent),
    clickRate: pct(clicked, delivered || sent),
    replyRate: pct(replies, delivered || sent),
    bounceRate: pct(bounced, sent),
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Groups campaigns by month/quarter and sums raw counts before computing
// rates, so a period's open rate reflects (total opens / total delivered)
// rather than an average of already-rounded per-campaign percentages.
function aggregatePeriods(campaigns, { keyOf, labelOf, sortKey }) {
  const groups = new Map();
  for (const c of campaigns) {
    if (!c.sentDate) continue;
    const d = new Date(c.sentDate);
    const key = keyOf(d);
    if (!groups.has(key)) {
      groups.set(key, {
        period: key,
        label: labelOf(d),
        sortKey: sortKey(d),
        newsletters: 0,
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        replies: 0,
        unsubscribed: 0,
        bounced: 0,
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

function buildComparison(campaigns) {
  if (!campaigns.length) return null;
  const avg = (fn) => Math.round((campaigns.reduce((s, c) => s + fn(c), 0) / campaigns.length) * 10) / 10;
  const best = (fn) => campaigns.reduce((b, c) => (fn(c) > fn(best ? b : c) ? c : b), campaigns[0]);
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

async function refresh() {
  const dc = process.env.ZOHO_DC || 'in';
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN in .env');
  }

  const accessToken = await getAccessToken({ dc, clientId, clientSecret, refreshToken });
  const list = await listSentCampaigns({ dc, accessToken });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DEBUG_FILE, JSON.stringify(list, null, 2));

  const entries = list.recent_sent_campaigns || list.campaigns || list.data || [];
  if (!Array.isArray(entries)) {
    throw new Error('Unexpected shape from recentsentcampaigns — see data/debug-last-response.json');
  }

  const campaigns = [];
  for (const entry of entries) {
    const key = entry.campaign_key || entry.campaignkey || entry.CAMPAIGNKEY;
    if (!key) continue;
    let report = null;
    try {
      report = await getCampaignReport({ dc, accessToken, campaignKey: key });
    } catch (err) {
      console.warn(`Report fetch failed for campaign ${key}: ${err.message}`);
    }
    campaigns.push(mapCampaignSummary(entry, report));
  }

  const nonNewsletterCount = campaigns.filter((c) => !NAME_FILTER.test(c.campaignName)).length;
  const newsletters = campaigns.filter((c) => NAME_FILTER.test(c.campaignName));
  if (nonNewsletterCount) {
    console.log(`Excluded ${nonNewsletterCount} non-newsletter campaign(s) (name doesn't match ${NAME_FILTER}).`);
  }

  const excludedCount = newsletters.filter((c) => c.sent < MIN_RECIPIENTS).length;
  const filtered = newsletters.filter((c) => c.sent >= MIN_RECIPIENTS);
  if (excludedCount) {
    console.log(`Excluded ${excludedCount} campaign(s) sent to fewer than ${MIN_RECIPIENTS} recipients (test sends).`);
  }

  filtered.sort((a, b) => new Date(b.sentDate || 0) - new Date(a.sentDate || 0));

  const snapshot = {
    lastUpdated: new Date().toISOString(),
    dataCenter: dc,
    campaigns: filtered,
    comparison: buildComparison(filtered),
    monthly: buildMonthlyReport(filtered),
    quarterly: buildQuarterlyReport(filtered),
  };

  if (!filtered.length) {
    // Never replace a good published snapshot with an empty one.
    throw new Error('Zoho returned no newsletters after filtering — refusing to overwrite docs/data.json.');
  }

  return snapshot;
}

// lastUpdated changes on every run, so compare everything else — otherwise
// every 30-minute run would create a commit even when nothing changed.
function withoutTimestamp(snapshot) {
  const { lastUpdated, ...rest } = snapshot || {};
  return JSON.stringify(rest);
}

function writeIfChanged(snapshot) {
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    existing = null;
  }
  if (existing && withoutTimestamp(existing) === withoutTimestamp(snapshot)) {
    return false;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  return true;
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Publishing = commit + push of docs/data.json. GitHub Pages then serves the
// new file. Zoho only accepts API calls from non-datacenter IPs, which is why
// this runs on a local machine instead of in GitHub Actions.
function publishToGitHub() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) {
    console.log('Not a git repository yet — data written locally only, nothing published.');
    return false;
  }
  git('add', 'docs/data.json');
  if (!git('diff', '--cached', '--name-only')) {
    console.log('No data changes to publish.');
    return false;
  }
  git('commit', '-m', `Update newsletter data (${new Date().toISOString().slice(0, 16)}Z)`);
  git('push');
  return true;
}

if (require.main === module) {
  refresh()
    .then((snap) => {
      console.log(`Fetched ${snap.campaigns.length} newsletter(s).`);
      if (!writeIfChanged(snap)) {
        console.log('Data unchanged since the last run — nothing to publish.');
        return;
      }
      console.log(`Wrote ${DATA_FILE}`);
      if (publishToGitHub()) console.log('Published to GitHub.');
    })
    .catch((err) => {
      console.error('Refresh failed:', err.message);
      process.exit(1);
    });
}

module.exports = { refresh, DATA_FILE };
