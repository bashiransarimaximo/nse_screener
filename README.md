# NSE Momentum Screener

A full-stack web app for screening NSE (National Stock Exchange of India) stocks using multi-factor momentum + quality scoring.

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, Recharts
- **Backend**: Express 5, TypeScript, Node.js 20
- **Database**: PostgreSQL + Drizzle ORM (for run history snapshots)
- **Data**: Yahoo Finance (price + fundamentals), with local file cache
- **AI**: Anthropic Claude (optional — AI explain feature)
- **Email**: Resend (optional — scheduled email reports)
- **Monorepo**: pnpm workspaces

## Features

- Screen Nifty 50, Auto, IT, Pharma, Bank, Smallcap 250, Microcap 250 indices
- Multi-factor scoring: ROC, RSI, MACD, OBV, CMF, Supertrend, EMA rank, ATR, Beta
- Fundamental overlay: PE, PEG, ROE, ROA, sales growth, profit growth, OPM
- RS vs Nifty, 52W high/low proximity, volume ratio
- Conviction grades (HIGH / MEDIUM / LOW) + technical + VQ grades
- Run history with score trend charts per stock
- Watchlist / baskets
- AI stock explanation (sparkle icon, streaming)
- Email scheduling with CSV attachment (Resend)
- Excel / CSV export

## Quick Start

### Prerequisites

| Tool | Version |
|------|--------|
| Node.js | 20+ |
| pnpm | 9+ |
| PostgreSQL | 14+ (or Docker) |

```bash
npm install -g pnpm
```

### 1. Install dependencies

```bash
pnpm install
```

### 2. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nse_screener
PORT=5000
ANTHROPIC_API_KEY=your-key   # optional
RESEND_API_KEY=your-key       # optional
```

### 3. Start PostgreSQL

```bash
docker run -d --name nse-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=nse_screener \
  -p 5432:5432 postgres:16
```

### 4. Push database schema

```bash
pnpm run db:push
```

### 5. Start servers

```bash
# Terminal 1 — API server
PORT=5000 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nse_screener pnpm run dev:server

# Terminal 2 — Frontend
pnpm run dev:client
```

Open **http://localhost:3000** → click **Run Screen** → select an index → scores in ~30–60s.

## Project Structure

```
nse-screener/
├── packages/
│   ├── db/                  # Drizzle ORM + PostgreSQL schema
│   ├── api-zod/             # Shared Zod schemas + TypeScript types
│   ├── api-client-react/    # TanStack Query hooks
│   └── anthropic/           # Anthropic SDK client
├── server/                  # Express 5 API server
│   └── src/
│       ├── routes/          # All API routes
│       ├── priceCache.ts    # OHLCV file cache (4h TTL)
│       └── tickerHistory.ts # Daily score snapshots
└── client/                  # React 18 + Vite frontend
    └── src/
        ├── pages/Home.tsx   # Main app UI
        └── components/ui/   # shadcn/ui components
```

## Deployment (Railway / Render / Fly.io)

This app needs:
1. A **PostgreSQL** database (any provider)
2. A **Node.js** server (for the Express API + serving the built frontend)

Set these env vars on your platform:
- `DATABASE_URL`
- `PORT`
- `ANTHROPIC_API_KEY` (optional)
- `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (optional)

Build command: `pnpm install && pnpm run build`  
Start command: `node server/dist/index.mjs`
