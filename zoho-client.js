// Thin client for the Zoho Campaigns REST API (v1.1).
//
// Endpoint names below match Zoho's published docs as of this writing
// (https://www.zoho.com/campaigns/help/developers/). Zoho occasionally
// tweaks field names in the JSON payload — if fetch-data.js logs a
// "couldn't find expected field" warning after your first real run,
// open data/debug-last-response.json and adjust the mapCampaignSummary()
// function in fetch-data.js to match what's actually there.

const ACCOUNTS_HOST = (dc) => `https://accounts.zoho.${dc}`;
const CAMPAIGNS_HOST = (dc) => `https://campaigns.zoho.${dc}`;

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken({ dc, clientId, clientSecret, refreshToken }) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${ACCOUNTS_HOST(dc)}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = await res.json();

  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho OAuth token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }

  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in || 3600) * 1000),
  };
  return cachedToken.accessToken;
}

async function zohoGet(dc, path, params, accessToken) {
  const url = new URL(`${CAMPAIGNS_HOST(dc)}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Zoho API returned non-JSON from ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || body.status === 'error') {
    throw new Error(`Zoho API error from ${path}: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * List ALL sent campaigns, most recent first.
 *
 * Zoho's /recentsentcampaigns silently caps at 100 results no matter what
 * `limit` is, which drops older history once an account has sent more than
 * 100 campaigns. /recentcampaigns supports fromindex/range paging and
 * reports total_record_count, so page through it until everything is read.
 * Returned in the same { recent_sent_campaigns: [...] } shape as before.
 */
async function listSentCampaigns({ dc, accessToken, pageSize = 100, maxPages = 50 }) {
  const all = [];
  let total = Infinity;
  for (let page = 0; page < maxPages && all.length < total; page += 1) {
    const res = await zohoGet(dc, '/api/v1.1/recentcampaigns', {
      resfmt: 'JSON',
      sort: 'desc',
      status: 'sent',
      fromindex: page * pageSize + 1,
      range: pageSize,
    }, accessToken);
    const batch = res.recent_campaigns || [];
    total = Number(res.total_record_count) || batch.length;
    if (!batch.length) break;
    all.push(...batch);
  }
  return { recent_sent_campaigns: all, total_record_count: total };
}

/** Full stats (opens/clicks/bounces/etc.) for a single campaign. */
async function getCampaignReport({ dc, accessToken, campaignKey }) {
  return zohoGet(dc, '/api/v1.1/getcampaigndetails', {
    resfmt: 'JSON',
    campaignkey: campaignKey,
    campaigntype: 'normal',
  }, accessToken);
}

module.exports = { getAccessToken, listSentCampaigns, getCampaignReport };
