# Complete Product Blueprint: YouTube Channel Intelligence & Optimization Platform

Building an app like vidIQ's Feed requires shifting from a traditional dashboard to an **action-oriented, personalized insight engine**. The core philosophy, as vidIQ describes it, is to "remove decision fatigue" by surfacing a single, high-impact optimization action at a time, rather than overwhelming the creator with endless charts.

Below is a comprehensive requirements document for an end-to-end channel analysis app, derived from an analysis of vidIQ's Feed functionality and the broader creator tool ecosystem.

---

## 📋 Executive Summary & Product Vision

**Product Goal:** Build a YouTube channel growth co-pilot that analyzes a creator's channel and their competitive niche to deliver a personalized feed of actionable, single-focus optimization cards (e.g., "Improve this title," "Add a missing description," "Here is a trending keyword in your niche").

**Target User:** Solo YouTubers and small content teams who need clear, prioritized guidance to improve click-through rates (CTR), watch time, and subscriber growth without needing to be data analysts.

**Core Differentiator:** The Feed. Unlike raw analytics dashboards, the Feed acts as a "clever prompt" system, translating complex data into one immediate, skippable, or actionable task at a time.

---

## ⚙️ Functional Requirements (End-to-End Channel Analysis)

### 1. Channel Health & Performance Audit Engine

Before generating insights, the system must ingest and compute a baseline audit of the channel.

- **Public & Private Data Ingestion:**
  - Connect via YouTube OAuth to pull private analytics: Impressions, CTR, Average View Duration (AVD), Watch Time, Traffic Sources, Audience Retention, and Subscriber Growth/Loss.
  - Pull public data for competitors and niche benchmarking: Video views, likes, comments, upload frequency, and tags.
- **Channel Scorecard Calculation:** Compute a 0–100 health score across key pillars, similar to competitor tools:
  - **Upload Consistency:** Variance in days between recent uploads.
  - **SEO & Metadata Completeness:** Percentage of videos with optimized titles, descriptions, and tags.
  - **Engagement Rate:** (Likes + Comments) / Views, benchmarked against the channel's own median and niche peers.
  - **Views Per Subscriber (VPS):** A measure of how well content resonates with the existing audience.
  - **Outlier Detection:** Calculate an "Outlier Score" for each video (Video Views / Channel's Median Views) to identify unexpected winners.
- **Baseline Metrics Header:** Display Total Subscribers and Total Public Views prominently at the top of the Feed for instant health checks.

### 2. The Feed: Personalized Insight Cards (Core Feature)

The Feed is a dynamic list of cards. Each card must focus on exactly one optimization area, be tailored to the channel, and be immediately actionable or skippable.

**Card Types & Required Logic:**

| Card Type | When It Triggers | Required Data / Logic | Actionable Output |
| :--- | :--- | :--- | :--- |
| **Title Suggestion** | CTR is below niche average, or a video is underperforming relative to its thumbnail impressions. | Compare current title against high-CTR patterns in the same niche; analyze viewer search intent. | 3–5 alternative title options with predicted CTR impact. **Action:** Apply title via API. |
| **Thumbnail Insight** | Impressions are high but CTR is low, indicating a visual disconnect. | Analyze contrast, text legibility, and visual clutter. Benchmark against top-performing thumbnails in the niche. | Specific feedback (e.g., "Increase contrast," "Reduce text") and A/B test preview. |
| **Missing Tags / Description** | A recent upload lacks a description or has fewer than N relevant tags. | Extract keywords from the video transcript or title. Identify missing high-volume tags. | Auto-generated description draft and a list of 10–15 relevant tags. **Action:** Publish directly to YouTube. |
| **Trending Keywords** | A keyword in the channel's niche shows a sudden spike in search volume. | Ingest YouTube search trend data (via API or scraping) and match it to the channel's content pillars. | The rising keyword, its search volume trajectory, and a content idea prompt. |
| **Niche Outliers** | A video from a competitor (or a small channel in the niche) gets 5x–10x its normal views. | Continuously scan competitor uploads; calculate outlier score. Identify common patterns (format, topic, title structure). | A link to the outlier video with a breakdown of *why* it likely worked (e.g., "This format is currently resonating"). |
| **Traffic Source Discovery** | A "Related Video" is sending an unusual amount of traffic to the user's channel. | Analyze YouTube Analytics "Traffic Source: Related Video" data. | The name of the referring video and an insight into what content YouTube is associating with the user's brand. |
| **Milestone / Achievement** | The channel hits a new record (views in a day, subscriber count). | Monitor time-series data for record-breaking events. | A celebratory card with no required action, designed to reinforce progress. |

**Card Interaction Requirements:**

- **Apply/Publish:** Directly update YouTube metadata via API for supported cards (Title, Description, Tags).
- **Regenerate:** Fetch a fresh set of AI-generated suggestions for creative cards.
- **Ask AI Coach:** Open a contextual chat with an AI assistant, pre-loaded with the card's data and suggestion, for deeper strategic discussion.
- **Dismiss:** Permanently remove the card (must be irreversible to prevent feed clutter).

### 3. AI Coach (Contextual Assistant)

- A conversational AI interface that has access to the channel's analytics data and the context of the currently viewed Feed card.
- Must answer questions like: *"Why is this title suggestion better?"* or *"Give me a content plan based on this trending keyword."*
- Should leverage an LLM with tool-use capabilities (or a custom MCP-like server) to query live channel data, rather than relying on static training data.

### 4. Competitor & Niche Tracking

- **Competitor Watchlist:** Allow users to add up to 3–5 competitor channels (depending on plan) to track their upload frequency, top-performing recent videos, and outlier scores.
- **Niche Benchmarking:** Compare the user's channel metrics (CTR, AVD, VPS) against an aggregated median of competitors in the same content category.

---

## 🛠️ Data & Technical Requirements

### 1. Data Sources & APIs

| Source | Purpose | Key Considerations |
| :--- | :--- | :--- |
| **YouTube Data API v3** | Public metadata (titles, tags, view counts, likes, comments). | **Hard Quota Limit:** Default is **10,000 units/day**. A `search.list` call costs 100 units; `videos.list` costs 1 unit. **Mitigation:** Cache aggressively, use `videos.list` with comma-separated IDs (up to 50 per call), and request a quota increase for production. |
| **YouTube Analytics API** | Private channel data (CTR, AVD, watch time, traffic sources, subscriber data). | Requires OAuth 2.0. Data is near-real-time but not instant (typically 24–48 hour lag for some metrics). `ids=channel==MINE` is the standard query pattern. |
| **YouTube Reporting API** | Bulk, historical data exports (for deep audits and trend analysis). | Reports are generated asynchronously. The **backfill window is 30 days**, so you must start the pipeline well before launch to have historical context. |
| **Third-Party Search Volume API** | Keyword search volume and competition data. | YouTube's own API does not expose search volume. Use a provider (e.g., DataForSEO, or a custom scraper) to get "rising" and "volume" signals for the Trending Keywords card. |

### 2. Architecture & Processing Pipeline

- **Ingestion Layer:** Scheduled jobs (e.g., Airflow, Cron) to pull Analytics API data daily and Reporting API data via bulk jobs.
- **Storage:** A relational database (PostgreSQL) for user/channel metadata and a time-series or columnar store (BigQuery/ClickHouse) for analytics metrics to enable fast aggregation and outlier detection.
- **Computation Layer:** A rules engine and scoring service that continuously evaluates the channel state against the "Trigger Conditions" of each Feed Card.
- **AI Layer:** An LLM service (e.g., OpenAI API, Anthropic) for generating titles, descriptions, and powering the AI Coach. **Important:** Prompts must be grounded in retrieved channel data (RAG pattern) to prevent hallucinations.
- **Presentation Layer:** A modern web app (React/Next.js) with a responsive Feed UI, plus a browser extension for inline YouTube Studio integration (a key vidIQ differentiator).

---

## 🛡️ Non-Functional Requirements

- **Performance:** Feed cards must load in under 2 seconds. AI-generated suggestions should stream in progressively.
- **Scalability:** The system must handle analysis for thousands of channels. Use queue-based processing for card generation and API calls.
- **Data Freshness:** Public metrics (views) can be updated near-real-time (subject to API caching). Private analytics can have a 24–48 hour lag; this must be clearly communicated in the UI.
- **Security:** OAuth tokens must be encrypted at rest. The app should follow the principle of least privilege, requesting only the YouTube scopes necessary for optimization (read analytics + write metadata).
- **Freemium Gating Logic:** Implement a credit system for AI actions (e.g., 150 free credits/month, then pay-per-use or subscription). Lock certain premium cards behind a 12-hour timer for free users to drive upgrades (a pattern used by vidIQ).

---

## 🚀 Suggested MVP Scope (Phase 1)

To launch quickly, focus on the highest-value cards that require the least complex data pipelines:

1. **Channel Connection & Basic Audit:** OAuth flow, compute upload consistency and VPS.
2. **Feed with 4 Card Types:** **Title Suggestion** (rule-based + LLM), **Missing Tags/Description** (text extraction + LLM), **Niche Outliers** (public data only), and **Milestones** (simple threshold alerts).
3. **AI Coach (Limited):** Contextual chat for the Title and Tags cards only.
4. **Direct Apply:** One-click publish for Tags and Descriptions to demonstrate immediate value.
5. **Basic Competitor Tracking:** Watch up to 3 channels (public data only).

This scope delivers the core "single-action" value proposition while avoiding the complexity of deep private analytics ingestion (like CTR and Retention) in the very first release.

**Product Codename:** "Signal" — a personalized, action-oriented growth co-pilot for YouTube creators.

**Positioning:** Unlike passive analytics dashboards, Signal operates as a **decision engine**. It ingests the creator's private analytics, monitors the competitive niche, and emits a prioritized feed of single-action optimization cards. Every card is either **applyable in one click** or **dismissible in one tap**, eliminating decision fatigue.

**Non-goal for v1:** Video editing, thumbnail design tools, and full social-media management. Signal is focused exclusively on **post-publish optimization and pre-publish intelligence**.

---

## Part 1 — Product Surface & User Journeys

### 1.1 Primary User Personas

| Persona | Pain | What Signal Delivers |
| --- | --- | --- |
| **Solo Creator (0–50k subs)** | Doesn't know *what* to fix first; drowns in YouTube Studio tabs. | A ranked feed of 5–10 concrete actions per week. |
| **Small Team Lead (50k–500k)** | Needs to delegate optimization without losing strategic control. | Shared workspace, role-based permissions, audit trail of applied changes. |
| **Agency / Multi-Channel Manager** | Manages 5–50 channels; needs cross-channel outlier detection. | Portfolio view, bulk competitor tracking, API access. |

### 1.2 End-to-End User Journey (First 30 Days)

**Day 0 — Onboarding & Connection**

1. User signs up via email or Google OAuth.
2. **Channel Connection Flow:** OAuth 2.0 consent screen requesting scopes: `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl` (for metadata writes). The consent is scoped to the **specific YouTube channel** selected by the user, not just the Google account.
3. **Initial Audit (asynchronous):** The system queues a full historical sync:
   - **Data API:** Last 90 days of video metadata (`videos.list`, 1 unit per call, up to 50 IDs per request).
   - **Analytics API:** Daily metrics for the last 365 days (views, CTR, AVD, watch time, traffic sources, subscriber deltas).
   - **Reporting API:** Bulk backfill of `channel_traffic_source_a3` and `video_basic_a3` reports for the last 30 days (the maximum backfill window).
4. **Audit Report Screen:** User sees a one-time "Channel Health Scorecard" — not a dashboard, but a **diagnosis** with 3–5 immediate red flags (e.g., "Your last 5 videos have 40% lower CTR than your 90-day median").

**Day 1–7 — Feed Activation**

1. The Feed populates with cards. The first card is always a **Quick Win** (low effort, high impact): typically a title or tag fix on a recent underperformer.
2. User applies or dismisses. Dismissed cards never reappear. Applied cards trigger an **optimization log entry**.

**Day 8–30 — Habit Loop**

1. Daily digest email / push: "3 actions waiting for you. Estimated impact: +12% CTR on recent uploads."
2. **AI Coach** becomes the secondary surface: user asks "Why did my last video underperform?" and receives an answer grounded in **live channel data**, not generic advice.

### 1.3 Key Screens & Interaction Contracts

| Screen | Core Interaction | Success Metric |
| --- | --- | --- |
| **Feed** | Infinite scroll of cards; each card has Apply / Regenerate / Ask AI / Dismiss. | ≥ 3 actions taken per week per active channel. |
| **Channel Audit** | One-time scorecard + persistent "Health" tab. | 80% of users view audit within 24h of connecting. |
| **Competitor Watchlist** | Add up to N channels; view outlier scores and upload cadence. | ≥ 50% of paid users track ≥ 1 competitor. |
| **AI Coach** | Chat interface with contextual card data pre-loaded. | ≥ 40% of Feed card "Ask AI" clicks convert to a follow-up question. |
| **Optimization Log** | Timeline of every applied change, with before/after metric snapshots. | Demonstrable CTR lift on applied cards (tracked at 7/14/28 days). |

---

## Part 2 — System Architecture (Production-Grade)

### 2.1 Architectural Principles

1. **Read-heavy, write-light.** The system reads enormous volumes of public and private data but writes only metadata (titles, descriptions, tags). This asymmetry drives the storage and caching strategy.
2. **Event-driven card generation.** Cards are not computed on page load. They are produced by a **rules engine** triggered by data arrival events (new analytics sync, new competitor upload, trending keyword spike).
3. **LLM as a reasoning layer, not a data source.** Every LLM prompt is grounded in retrieved metrics via RAG. The LLM never invents numbers; it receives a structured "evidence packet" and returns a structured recommendation.
4. **Quota-aware by design.** The YouTube Data API now enforces **100 `search.list` calls/day** and **10,000 units/day** for other methods per project. The architecture treats every API call as a scarce resource, with aggressive caching, batching, and fallback scraping for public data.

### 2.2 High-Level Architecture Diagram (Textual)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│  Next.js Web App  │  React Native Mobile  │  Chrome Extension (optional)     │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │ HTTPS / WebSocket (SSE for streaming AI)
┌────────────────────────────────────▼────────────────────────────────────────┐
│                           API GATEWAY & BFF                                  │
│  Kong / AWS API Gateway  │  FastAPI (Python) BFF  │  Auth (Clerk/Auth0)     │
│  Rate limiting  │  Request validation  │  Session management                │
└──────┬──────────────────────────────┬───────────────────────────────────────┘
       │                              │
┌──────▼──────────┐          ┌────────▼──────────────────────────────────────┐
│  CORE SERVICES   │          │           INTELLIGENCE SERVICES               │
│                  │          │                                               │
│  User Service    │          │  Audit Engine (scoring, outlier detection)    │
│  Channel Service │◄────────►│  Card Generator (rules engine + LLM)         │
│  Billing Service │          │  AI Coach Service (RAG + LLM orchestration)   │
│  Notification    │          │  Competitor Intelligence Service              │
│  Service         │          │  Keyword & Trend Service                      │
└──────┬───────────┘          └────────┬──────────────────────────────────────┘
       │                               │
┌──────▼───────────────────────────────▼──────────────────────────────────────┐
│                           DATA & MESSAGING LAYER                             │
│                                                                              │
│  PostgreSQL (OLTP: users, channels, cards, billing)                          │
│  ClickHouse (OLAP: time-series metrics, outlier computations)                │
│  Redis (Cache: API responses, session, rate-limit counters)                 │
│  Apache Kafka / Redpanda (Event bus: data.arrived, card.triggered)          │
│  S3 / MinIO (Raw payloads, Reporting API CSVs, LLM prompt/response logs)   │
│  Vector Store (Pinecone/pgvector: niche content embeddings for RAG)        │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────────┐
│                        INGESTION & COMPUTE LAYER                             │
│                                                                              │
│  Apache Airflow (DAG orchestration for batch syncs)                         │
│  Celery / Temporal (async task queue for card generation, LLM calls)        │
│  YouTube Data API Client (quota-aware, batched)                            │
│  YouTube Analytics API Client (OAuth token refresh, backoff)                │
│  YouTube Reporting API Client (job creation, CSV polling)                   │
│  Scraping Pool (Playwright / Residential proxies for public data fallback)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Data Model (Core Tables)

**PostgreSQL (Transactional)**

```sql
-- Users and channels
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  plan_tier TEXT DEFAULT 'free',  -- free, boost, max, enterprise
  ai_credits_remaining INT DEFAULT 150,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE channels (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  youtube_channel_id TEXT UNIQUE NOT NULL,
  title TEXT,
  subscriber_count BIGINT,
  median_views_90d BIGINT,  -- computed, cached
  oauth_refresh_token_encrypted BYTEA,  -- encrypted at rest
  last_synced_at TIMESTAMPTZ
);

-- Feed cards
CREATE TABLE cards (
  id UUID PRIMARY KEY,
  channel_id UUID REFERENCES channels(id),
  card_type TEXT NOT NULL,  -- title_suggestion, outlier_alert, etc.
  payload JSONB NOT NULL,   -- full card content
  status TEXT DEFAULT 'pending',  -- pending, applied, dismissed, expired
  triggered_by_event_id TEXT,  -- traceability
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  INDEX idx_channel_status (channel_id, status)
);

-- Optimization log (audit trail)
CREATE TABLE optimizations (
  id UUID PRIMARY KEY,
  card_id UUID REFERENCES cards(id),
  video_id TEXT,
  field_changed TEXT,  -- title, description, tags
  old_value TEXT,
  new_value TEXT,
  applied_at TIMESTAMPTZ,
  metric_snapshot_7d JSONB,  -- populated later for impact tracking
  metric_snapshot_28d JSONB
);
```

**ClickHouse (Analytical)**

```sql
-- Daily video metrics (from Analytics API)
CREATE TABLE video_daily_metrics (
  channel_id UUID,
  video_id String,
  date Date,
  views UInt64,
  impressions UInt64,
  ctr Float32,
  avg_view_duration_seconds Float32,
  watch_time_minutes Float64,
  subscribers_gained Int32,
  subscribers_lost Int32,
  traffic_source_related_video UInt64,
  traffic_source_search UInt64,
  traffic_source_browse UInt64
) ENGINE = MergeTree()
ORDER BY (channel_id, video_id, date);

-- Competitor public snapshots (from Data API / scraping)
CREATE TABLE competitor_video_snapshots (
  competitor_channel_id String,
  video_id String,
  snapshot_date Date,
  views UInt64,
  likes UInt32,
  comments UInt32,
  title String,
  tags Array(String)
) ENGINE = ReplacingMergeTree(snapshot_date)
ORDER BY (competitor_channel_id, video_id, snapshot_date);
```

---

## Part 3 — The Data Ingestion Pipeline (End-to-End)

### 3.1 Daily Sync DAG (Airflow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DAG: daily_channel_sync                                                     │
│ Schedule: every 6 hours per active channel (staggered to spread API load)   │
└─────────────────────────────────────────────────────────────────────────────┘

Task 1: fetch_analytics_daily
  → YouTube Analytics API: ids=channel==MINE, metrics=views,impressions,ctr,
    averageViewDuration,estimatedMinutesWatched,subscribersGained,subscribersLost
  → dimensions=video,day; startDate=7 days ago; endDate=yesterday
  → Write to ClickHouse: video_daily_metrics
  → Emit event: "analytics.arrived" to Kafka

Task 2: fetch_video_metadata
  → YouTube Data API: videos.list (batched, 50 IDs per call)
  → For each recent video, fetch title, description, tags, statistics
  → Write to PostgreSQL: video_metadata (or ClickHouse if high volume)
  → Cost: ~1 unit per 50 videos; aggressively cached (metadata changes are rare)

Task 3: fetch_traffic_sources
  → YouTube Analytics API: dimensions=video,insightTrafficSourceType
  → Identify "RELATED_VIDEO" traffic and the referring video IDs
  → Write to ClickHouse; emit event "traffic_source.arrived"

Task 4: compute_channel_baseline
  → ClickHouse query: median views per video over last 90 days
  → Compute 7-day and 28-day median CTR, AVD
  → Update PostgreSQL channels.median_views_90d
  → Emit event: "baseline.computed"
```

**Critical quota note:** `search.list` is restricted to **100 calls/day** as of June 2026. Signal must **never** use `search.list` for routine syncs. Keyword discovery and competitor discovery use a dedicated "Search Budget" service that distributes the 100 daily calls across the highest-priority users/niches.

### 3.2 Competitor Ingestion (Public Data)

Competitor channels are ingested via a **hybrid strategy**:

1. **Primary:** Data API `channels.list` and `playlistItems.list` + `videos.list` (1 unit per call). This is quota-cheap for metadata but does not provide view velocity.
2. **Secondary (velocity):** Scheduled scraping of the competitor's `/videos` tab via a headless browser pool (Playwright) behind residential proxies. This bypasses the API quota for public view-count snapshots, enabling frequent polling (every 6 hours) without consuming units.
3. **Outlier computation:** The **Outlier Multiplier** is calculated as:

```
outlier_multiplier = video_views / median_views_of_channel_last_30_uploads
```

A multiplier ≥ 2 is flagged as an outlier; ≥ 10 is a "monster outlier" and triggers an immediate high-priority card.

### 3.3 Reporting API Backfill (One-Time, On Channel Connection)

The Reporting API is asynchronous: you create a job, Google generates CSV files, and you poll for completion. The backfill DAG:

1. Create jobs for `channel_traffic_source_a3` and `video_basic_a3`.
2. Poll `jobs.list` every 15 minutes until reports are ready.
3. Download CSVs to S3, parse, and load into ClickHouse.
4. **Constraint:** Backfill only covers the last **30 days**. Historical depth beyond 30 days must come from the Analytics API's 365-day window (which provides aggregated metrics, not raw event-level rows).

---

## Part 4 — The Card Generation Engine (Core Intelligence)

### 4.1 Event-Driven Rules Engine

Cards are produced by rules that listen to Kafka events. Each rule has:

- **Trigger condition:** a SQL-like predicate over the latest state.
- **Evidence assembly:** a function that gathers the data packet the LLM will receive.
- **Output schema:** the card type and its required fields.

**Example rule: "CTR Drop on Recent Upload"**

```python
# Pseudocode — CardGenerator service
@on_event("analytics.arrived")
def evaluate_ctr_drop(event):
    channel = get_channel(event.channel_id)
    recent_videos = query_clickhouse("""
        SELECT video_id, ctr, impressions, date
        FROM video_daily_metrics
        WHERE channel_id = {channel_id}
          AND date >= today() - 7
          AND impressions > 1000  -- statistical significance floor
    """)
    baseline_ctr = channel.median_ctr_90d
    for v in recent_videos:
        if v.ctr < baseline_ctr * 0.7:  # 30% below baseline
            evidence = build_ctr_evidence(v, baseline_ctr, channel.niche_peers)
            card = llm_generate_card("title_suggestion", evidence)
            emit_card(channel.id, card)
```

### 4.2 LLM RAG Architecture for Card Generation

Every LLM call follows a three-stage pipeline:

**Stage A — Evidence Retrieval (deterministic, no LLM)**

The Evidence Assembler gathers:

- The target video's current title, description, tags, and thumbnail metadata.
- The last 10 videos from the same channel with their CTR and AVD.
- **Niche peer benchmarks:** the top 5 outlier videos in the same content category (via embedding similarity over titles/transcripts in the vector store).
- **Search intent signals:** top autocomplete suggestions for the video's primary keyword (via Data API `search.list` — used sparingly from the daily budget).

**Stage B — Structured Prompt Construction**

The LLM receives a **JSON evidence packet**, not free-text. Example:

```json
{
  "task": "generate_title_suggestions",
  "channel_baseline_ctr": 4.2,
  "video": {
    "current_title": "How I Fixed My Posture in 30 Days",
    "ctr": 2.1,
    "impressions": 45000,
    "avg_view_duration_seconds": 142
  },
  "niche_peers": [
    {"title": "I Tried Fixing My Posture for 30 Days (Here's What Happened)", "ctr": 7.8},
    {"title": "The Posture Fix That Actually Works (Science-Based)", "ctr": 9.1}
  ],
  "constraints": {"max_length": 70, "language": "en"}
}
```

**Stage C — Structured Output Validation**

The LLM (GPT-4o / Claude / Gemini) is called with **JSON mode** and a schema. The response is validated against the schema before a card is created. If validation fails, the card is regenerated with a repair prompt. **No raw LLM output ever reaches the user without schema validation.**

**Cost control:** Each card generation consumes **AI credits** (see billing section). The system uses a **two-tier model router**:

- **Fast/cheap model** (e.g., GPT-4o-mini, Claude Haiku) for simple cards (milestones, missing tags).
- **Frontier model** (GPT-4o, Claude Sonnet) for title suggestions and AI Coach conversations where reasoning quality matters.

### 4.3 AI Coach Architecture (Conversational RAG)

The AI Coach is **not** a generic chatbot. It is a tool-augmented agent with access to a **YouTube MCP Server** — a Model Context Protocol server that exposes 40+ tools for querying the channel's analytics, metadata, and competitor data.

```
User message → Intent classifier → Tool selection → MCP tool execution → 
Data retrieval → LLM synthesis → Streamed response (SSE)
```

Key tools exposed to the Coach:

| Tool | What it retrieves |
| --- | --- |
| `get_video_performance(video_id)` | CTR, AVD, retention curve, traffic sources for a specific video. |
| `compare_to_niche(video_id)` | Peer benchmark for the same topic/format. |
| `list_recent_outliers(competitor_channel_id)` | Outlier videos from a tracked competitor. |
| `get_keyword_trend(keyword)` | Search volume trajectory (from third-party data). |
| `get_channel_audit()` | Current health score and sub-scores. |

The Coach's system prompt is **dynamically injected** with the channel's identity and the active card's evidence packet, so the conversation starts with full context.

---

## Part 5 — Audit Engine & Scoring

### 5.1 Channel Health Score (0–100)

The composite score is a weighted average of five pillar scores, each normalized to 0–100:

| Pillar | Weight | Computation |
| --- | --- | --- |
| **CTR Health** | 25% | `min(100, (channel_median_ctr / niche_median_ctr) * 80)` — capped to prevent outliers. |
| **Retention Health** | 25% | `min(100, (channel_median_avd / niche_median_avd) * 100)`. |
| **Upload Consistency** | 15% | `max(0, 100 - (stddev_days_between_uploads / 7) * 20)` over last 8 uploads. |
| **Metadata Completeness** | 15% | Percentage of last 20 videos with ≥ 3 tags, ≥ 200-char description, and a custom thumbnail. |
| **Engagement Rate** | 20% | `min(100, ((likes + comments) / views) / niche_engagement_median * 80)`. |

The scorecard also surfaces **Outlier Frequency**: the percentage of the last 30 uploads with an outlier multiplier ≥ 2. This is displayed as a separate "Viral Coefficient" rather than folded into the health score.

### 5.2 Statistical Guardrails

- **Minimum impressions threshold:** CTR cards only trigger if the video has ≥ 1,000 impressions in the evaluation window. This prevents noise from tiny sample sizes.
- **Maturity window:** Videos published less than 48 hours ago are excluded from CTR and AVD analysis. Analytics data has a 24–48 hour lag; evaluating too early produces false signals.
- **Baseline recomputation:** Baselines are recomputed daily, not per-card, to ensure consistency and reduce compute cost.

---

## Part 6 — API Design (Public & Internal)

### 6.1 REST API (Public, versioned)

The platform exposes a REST API for agency/enterprise customers and internal frontend consumption.

**Authentication:** OAuth 2.0 bearer tokens (JWT) issued by the Auth service. API keys for server-to-server integrations.

**Core Endpoints:**

```
GET  /v1/channels/{channel_id}/audit
     → Returns health score, pillar scores, outlier coefficient.

GET  /v1/channels/{channel_id}/cards?status=pending&limit=20
     → Paginated feed of cards.

POST /v1/cards/{card_id}/apply
     → Applies the optimization to YouTube via Data API.
     → Body: { "confirm": true, "dry_run": false }
     → Returns: { "applied": true, "optimization_id": "..." }

POST /v1/cards/{card_id}/dismiss
     → Marks card dismissed (irreversible).

POST /v1/coach/chat
     → Body: { "channel_id": "...", "message": "...", "context_card_id": "..." }
     → Returns: SSE stream of tokens.

GET  /v1/competitors/{competitor_id}/outliers?window=30d
     → Returns outlier videos with multipliers.
```

**Write safety:** Every `apply` endpoint is idempotent and requires a **dry-run preview** by default. The actual write to YouTube uses the Data API `videos.update` method with a partial resource update (only the changed field, not the full object).

### 6.2 Internal gRPC Services

Service-to-service communication uses gRPC for low-latency calls:

- `AuditService.GetChannelScore(channel_id) → ScoreResponse`
- `CardService.GenerateCards(event) → CardList`
- `EvidenceService.Assemble(context) → EvidencePacket`

Protocol Buffers define the contracts. gRPC is chosen over REST for internal calls because card generation pipelines are latency-sensitive and benefit from binary serialization and streaming.

---

## Part 7 — Billing, Credits & Monetization

### 7.1 Plan Structure

| Plan | Price | AI Credits / Month | Competitor Slots | Key Features |
| --- | --- | --- | --- | --- |
| **Free** | $0 | 150 | 0 | Basic audit, 1 card type (milestones), AI Coach limited to 5 messages/day. |
| **Boost** | $19/mo | 2,000 | 3 | All card types, full AI Coach, competitor outliers, direct apply. |
| **Max** | $49/mo | 6,000 | 10 | Priority card generation, advanced trend forecasting, API access. |
| **Enterprise** | Custom | Unlimited | Unlimited | SSO, dedicated quota pools, white-label reports. |

### 7.2 Credit Consumption Model

Credits are consumed per LLM-powered action:

| Action | Credit Cost | Rationale |
| --- | --- | --- |
| Generate title suggestions (3–5 options) | 5 credits | Frontier model call + validation. |
| Generate description + tags | 3 credits | Smaller output, cheaper model. |
| AI Coach message (with tool calls) | 2 credits per message | Tool orchestration + synthesis. |
| Regenerate a card | Same as generation | No discount; each regeneration is a new LLM call. |
| Apply a card | 0 credits | Write operation does not use LLM. |

**Free-tier gating:** Free users see premium cards in a "locked" state with a 12-hour countdown. After 12 hours, the card either unlocks (if credits are available) or expires. This creates urgency without forcing an immediate paywall.

### 7.3 Stripe Integration

- Subscription billing via **Stripe Checkout** and **Stripe Billing Portal**.
- Usage-based credit top-ups: users can purchase additional credit packs (e.g., 500 credits for $5).
- Webhook handling for `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`.
- **Dunning management:** Failed payments trigger a 3-email sequence; access downgrades to Free after 7 days of grace.

---

## Part 8 — Security, Compliance & Token Management

### 8.1 OAuth Token Lifecycle

YouTube OAuth access tokens expire in **3,600 seconds (1 hour)** ; refresh tokens are long-lived but can be revoked by the user at any time.

**Token service design:**

```
┌─────────────────────────────────────────────────────────────────┐
│ Token Vault (HashiCorp Vault / AWS Secrets Manager)              │
│  - Stores refresh tokens encrypted with AES-256-GCM              │
│  - Encryption key rotated every 90 days via KMS                  │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Token Refresh Worker (Celery, per-channel scheduled task)        │
│  - Refreshes access token 5 minutes before expiry                │
│  - On invalid_grant (revoked token):                             │
│      1. Mark channel as "reauth_required"                        │
│      2. Send email + in-app banner                               │
│      3. Pause all card generation for that channel               │
└─────────────────────────────────────────────────────────────────┘
```

**Critical rule:** The OAuth consent is scoped to the **specific YouTube channel** selected at consent time, not just the Google account. A user with multiple brand channels must connect each channel separately.

### 8.2 Data Privacy

- **PII minimization:** The platform stores only the channel ID, channel title, and email. No viewer-level or demographic PII is stored beyond what the Analytics API returns in aggregate.
- **Right to deletion:** A `DELETE /v1/account` endpoint purges all channel data, cards, optimizations, and LLM logs within 30 days, and revokes the OAuth token via Google's revocation endpoint.
- **LLM data handling:** LLM prompts and responses are logged for debugging but **stripped of channel-identifying information** after 7 days. Enterprise customers can opt out of logging entirely (zero-retention mode with the LLM provider).

### 8.3 YouTube API Terms Compliance

- **No data resale:** Public competitor data is used only to generate insights for the authenticated user, never exposed as a raw bulk export.
- **Quota segregation:** Each customer tenant does **not** have its own Google Cloud project (that would violate the spirit of the quota system). Instead, the platform uses a small number of shared projects with quota distributed via the Search Budget service. Enterprise customers may bring their own Google Cloud project for dedicated quota.
- **Storage limitation:** Analytics API data is retained for a maximum of 365 days in ClickHouse, aligned with the API's own data retention window.

---

## Part 9 — Observability, Reliability & Operations

### 9.1 SLIs and SLOs

| Service Level Indicator | Target SLO |
| --- | --- |
| Feed API p95 latency | < 800 ms |
| Card generation end-to-end latency (event → card visible) | < 5 minutes p95 |
| AI Coach first-token latency | < 2 seconds p95 |
| OAuth token refresh success rate | > 99.5% |
| Daily sync completion rate (all active channels) | > 99.9% |
| YouTube API error rate (4xx/5xx) | < 2% |

### 9.2 Monitoring Stack

- **Metrics:** Prometheus + Grafana. Key dashboards: YouTube API quota consumption per bucket, LLM token cost per card type, card apply success rate.
- **Tracing:** OpenTelemetry. Every card is traceable from trigger event → evidence assembly → LLM call → validation → persistence.
- **Logging:** Structured JSON logs shipped to Loki. LLM prompts/responses logged to S3 with a 90-day lifecycle policy (except zero-retention tenants).
- **Alerting:** PagerDuty for SLO breaches. Slack for quota approaching limits (80% of daily `search.list` budget consumed by 10am → alert).

### 9.3 Failure Modes & Mitigations

| Failure | Mitigation |
| --- | --- |
| YouTube API quota exhausted at 2pm | **Quota-aware scheduler** prioritizes paid users and recently active channels. Free-tier syncs are deferred to off-peak hours. |
| LLM provider outage | **Multi-provider fallback:** primary (OpenAI) → secondary (Anthropic) → cached/rule-based fallback (template titles). |
| Reporting API job stuck | Airflow sensor times out after 2 hours; creates a new job and alerts. Backfill is idempotent (deduplication by report ID). |
| OAuth token revoked mid-session | API returns `401` with `reauth_required`; frontend shows a reconnection modal; card generation paused. |

---

## Part 10 — Deployment & Infrastructure

### 10.1 Cloud Topology

- **Primary region:** AWS `us-east-1` (lowest latency to YouTube API endpoints).
- **Compute:** EKS (Kubernetes) for stateless services; Celery workers on spot instances for batch/LLM tasks.
- **Managed data:** RDS for PostgreSQL (Multi-AZ), ClickHouse Cloud or self-managed on EKS with S3-backed storage.
- **Networking:** VPC with private subnets for data services; public subnets only for the API gateway and load balancers.
- **CI/CD:** GitHub Actions → Docker build → ECR → ArgoCD (GitOps) → EKS. Database migrations via Alembic, run as Kubernetes pre-sync Jobs.

### 10.2 Environment Strategy

| Environment | Purpose | Data |
| --- | --- | --- |
| **Dev** | Feature development; mock YouTube APIs. | Synthetic data. |
| **Staging** | Integration testing with real YouTube APIs (limited to internal test channels). | Anonymized production snapshot (weekly refresh). |
| **Production** | Live customers. | Real data. |

**Feature flags:** LaunchDarkly (or Unleash) gates new card types. A new card type is rolled out to 5% of paid users, monitored for apply rate and CTR lift, then expanded.

---

## Part 11 — Full Rollout Plan (Not an MVP — a Phased Production Launch)

The user explicitly requested a **complete product, not an MVP**. The rollout is structured as **three production releases**, each fully operational and revenue-generating.

### Release 1 — "Foundation" (Months 1–4)

**Scope:**

- OAuth connection for YouTube channels (single channel per account).
- Audit engine with all five pillars and the composite health score.
- Feed with **six card types:** Title Suggestion, Missing Tags/Description, Milestone, Niche Outlier, Upload Consistency Alert, and Traffic Source Discovery.
- AI Coach with five core tools (video performance, niche comparison, outlier listing, channel audit, keyword trend).
- Competitor watchlist (3 slots on Boost).
- Stripe billing (Free, Boost, Max tiers).
- Web app only (no extension).

**Production-readiness gates:**

- 99.5% OAuth refresh success over a 7-day soak test.
- Card generation p95 < 5 minutes for 1,000 concurrent channels.
- LLM cost per active channel < $0.80/month at current pricing.

### Release 2 — "Intelligence" (Months 5–8)

**Scope:**

- **Trend Forecasting:** predict keyword volume spikes 7–14 days ahead using time-series models (Prophet/LSTM) over historical search signals.
- **Thumbnail A/B Testing Guidance:** analyze thumbnail contrast, text density, and facial presence; recommend A/B test variants (not generate thumbnails — recommend).
- **Competitor "What Changed" Alerts:** detect when a tracked competitor changes a title, thumbnail, or tags on an existing video (via snapshot diffing).
- **Chrome Extension:** inline optimization scores on YouTube Studio pages, with a "Send to Signal Feed" button.
- **API access** for Max tier.

### Release 3 — "Scale" (Months 9–12)

**Scope:**

- **Multi-channel portfolio view:** agency dashboard with cross-channel outlier aggregation and bulk card application.
- **Custom AI Coach personas:** "Growth Strategist," "SEO Auditor," "Content Researcher" — each with a different tool set and prompting strategy.
- **Enterprise SSO** (SAML/OIDC) and audit logs.
- **White-label reports:** PDF export of channel audits with custom branding.
- **Mobile app** (React Native) with push notifications for high-priority cards.

---

## Part 12 — Key Risks & Open Decisions

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **YouTube API quota policy changes** | High | Architecture already treats `search.list` as a scarce resource; scraping fallback for public data; enterprise BYO-project option. |
| **LLM hallucination in titles/descriptions** | Medium | Schema validation, evidence-only prompting, human review before apply (user must confirm). |
| **vidIQ / TubeBuddy feature parity pressure** | Medium | Differentiate on **outlier-first intelligence** and **single-action feed**, not dashboard breadth. |
| **Creator churn** | Medium | Track 28-day CTR lift on applied cards; surface "Your optimizations drove +X views" as a retention lever. |
| **Reporting API 30-day backfill limit** | Low | Analytics API provides 365-day aggregated metrics; only event-level raw data is limited to 30 days. |

**Open decision (defer to Release 2):** Whether to build an in-house search-volume index (scraping YouTube autocomplete + Google Trends) or license a third-party provider (DataForSEO, Semrush API). The build is expensive; the license is predictable but adds per-query cost. Recommendation: **license for Release 1, build a hybrid index for Release 2** to reduce dependency.

---

## Summary: What "Complete Product" Means Here

This blueprint specifies a system that is:

- **Operationally complete:** OAuth lifecycle, token vault, quota-aware scheduling, multi-provider LLM fallback, SLOs, alerting, and incident response are all defined.
- **Commercially complete:** Four-tier billing, credit metering, Stripe webhooks, dunning, and plan gating are production-specified.
- **Data-complete:** The full pipeline from YouTube API ingestion → ClickHouse aggregation → evidence assembly → LLM card generation → PostgreSQL persistence → API delivery is traceable end-to-end.
- **User-complete:** The creator journey from first OAuth click to habitual daily feed usage is mapped, with screen-level interaction contracts and success metrics.

The phased rollout delivers **revenue from Release 1** while building toward the full intelligence platform, rather than shipping a stripped-down proof-of-concept.
