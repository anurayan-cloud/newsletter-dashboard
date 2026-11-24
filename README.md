# Newsletter Analytics Dashboard

Analytics dashboard for the weekly newsletters sent through Zoho Campaigns —
per-send stats, Doctors vs Marketing audience split, monthly/quarterly
reports, date/audience filters and automatic insights.

## How it works

```
 Zoho Campaigns API ──▶ npm run fetch (your PC, every 30 min) ──▶ docs/data.json
                                                                       │ git commit + push
                                                                       ▼
                                                        GitHub Pages serves docs/
```

- **`docs/`** is the whole website (static HTML/JS/CSS + `data.json`), served by GitHub Pages.
- **`fetch-data.js`** pulls every sent campaign from Zoho, classifies it
  (Doctors / Marketing), filters out non-newsletters and test sends, rewrites
  `docs/data.json` **only if something changed**, then commits and pushes it.
- **Why it runs on a PC and not in GitHub Actions:** Zoho rejects OAuth calls
  from cloud/datacenter IP ranges (this was confirmed — the same token works
  from an office PC and fails from a hosting provider).

## Setup (on the machine that does the fetching)

1. **Zoho API credentials** — in https://api-console.zoho.in/ create a
   Server-based client, generate an authorization code with scope
   `ZohoCampaigns.campaign.ALL`, and exchange it for a refresh token.
2. `copy .env.example .env` and fill in `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
   `ZOHO_REFRESH_TOKEN` (and `ZOHO_DC` if not `in`). `.env` is git-ignored.
3. `npm install`
4. Make sure `git push` works non-interactively from this machine
   (`gh auth login` + `gh auth setup-git`, or a stored credential).
5. `npm run fetch` — pulls from Zoho and publishes.
6. Schedule `node fetch-data.js` (working directory = this folder) to run
   every 30 minutes, e.g. with Windows Task Scheduler (`NewsletterDashboardFetch`).

## Local preview

```
npm start      # http://localhost:4100  (serves docs/)
```

## Notes

- Updates only happen while the fetching PC is on and online; otherwise the
  site simply shows the last published data.
- `data.json` contains campaign names and engagement numbers. The repo
  visibility therefore decides who can read them — keep that in mind before
  making the repo public.
- Tunables (`MIN_RECIPIENTS`, `NEWSLETTER_NAME_PATTERN`, `DOCTOR_LIST_PATTERN`)
  live in `.env.example`.
