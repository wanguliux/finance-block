<p align="center">
<a href="./README.zh-CN.md">🇨🇳 中文</a> &nbsp;|&nbsp; <b>🇺🇸 English</b>
</p>

# Finance Block

An Obsidian personal-finance plugin built to manage your finances across every stage of life. It brings double-entry bookkeeping, transaction log, budget tracking, income/expense heatmap, cash-flow simulation, asset overview, and recurring expenses/loans all into **code blocks**, using beancount-style bookkeeping — your ledger *is* a `fin-beancount` code block, the **single source of truth**; every view derives live from the same data. Data lives as plain text (Markdown / JSON) inside your vault — linkable, git-able, hand-editable.

> Plugin ID: `finance-block` ｜ Minimum Obsidian version: `1.13.4` ｜ License: MIT ｜ Languages: 中文 / English

---

## 🧭 Design Philosophy: Your Ledger Is Your Note

Most budgeting apps lock your data in a private database — exporting, linking notes, or switching tools is a fight. This plugin does the opposite: **the ledger is the note**. Everything revolves around "single source of truth + live derivation":

| What you get | How it's guaranteed | Module |
|--------------|---------------------|--------|
| **Book an entry without knowing debit/credit** | The UI only asks for positive amounts + a direction label; signs are derived from account class; zero-sum validation catches mistakes instantly | Ledger §1 |
| **The ledger is always the truth** | Single source of truth: every view derives live from the ledger + config at render time — no cached copies to drift | Philosophy |
| **The net-worth identity always holds** | Accounts must belong to one of five classes (Asset / Liability / Equity / Income / Expense), making "Assets − Liabilities = Equity + retained earnings" a structural invariant | Ledger §1 |
| **See exactly the transactions you want** | Multi-dimensional log filters: date window / amount range / account / category / owner / block-ref ID | Log §2 |
| **Know the moment you overspend** | Budget shows execution rate per category × period with three-level status | Budget §3 |
| **See at a glance where money goes** | Income/expense heatmap: green = income, red = spending, calendar + category matrix | Heatmap §4 |
| **Answer "when am I free?"** | Cash-flow simulator: 3 withdrawal strategies × Monte Carlo × life-event shocks | Simulator §5 |
| **Set it once, automated forever** | Recurring-expense / loan plans generate pending entries automatically, one-click to post | Automation §7 |

The modules below go into detail.

---

## ✨ Features

### 1. Double-Entry Source of Truth — Book It Without Knowing Accounting

The ledger is a ` ```fin-beancount``` ` code block using a lightweight custom double-entry syntax (all legs must sum to 0, to the cent). **You never type a negative number** — the UI only asks for positive amounts; signs are derived from the account class.

- **N-leg dynamic entry**: split one purchase into "Food + Daily goods"? Add legs freely with "Split entry", hit "Auto-balance" to fill the missing amount, or "Flip direction" to toggle income/expense.
- **Draft / Posted states**: draft blocks (without a `^t-` ref line) count toward nothing; click "Post" to append the block reference and write the entry into the ledger file — post when you're ready, or "Post all" to clear at once.
- **Soft warning layer**: sign may be flipped / account not declared in settings / category tag inconsistent with the structure — hints only, never blocking; hover for full explanations.
- **Ledger chain**: after a rollover, blocks annotate where they were carried from and where they were rolled to — a decade of ledgers stays traceable.
- Posted entries can be grouped flat / by day / by week / by month / custom, with per-group net totals and counts.

**Example**: record a lunch with no signs, no negatives —

```fin-beancount
2026-08-03 * Lunch beef noodles
  Expense:Food  3500
  Bank-Card   -3500
  type: Food
  owner: Me
```

### 2. Transaction Log — See Exactly What You Want

`finance-log` renders the feed in reverse-chronological order with an income / expense / net summary (drafts excluded).

- **Multi-dimensional filters**: start date + days back (leave empty for a rolling 30-day window), amount range (operator + guided input, e.g. `>100` or `100-200`), account (any leg matches), category, owner, and block-reference ID (multiple IDs with `;`, overrides the date window).
- Income / expense / draft tabs + keyword search across narration and accounts.

**Scenario**: "How much did I spend on food last month?" Write a `finance-log` with `type: Food` and `day: 31` — the summary bar answers directly.

### 3. Budget Tracker — Know the Moment You Overspend

- Set a spending cap and period (daily / weekly / monthly / yearly / custom N days) per category in Settings → Budgets.
- The view renders **execution rate** + period progress bars + three-level status (safe / near / over) — you see the overspend coming before it happens.

### 4. Income/Expense Heatmap — See Where Money Goes at a Glance

- **Dual-direction coloring**: green = net income, red = net spending, blank = no activity (China bookkeeping convention); each direction normalizes on its own scale so payday doesn't wash out spending days.
- **Two views**: calendar overview (day granularity, spot your rhythm instantly) + category matrix (category × week/month granularity, with per-category trend sparklines and sortable row headers).
- Rolling N-day window (default 182, 7–365), category filter; hover for amount / count / period-over-period change, click a cell to expand that day's detail.

### 5. Cash-Flow Simulator — Answer "When Will I Be Free?"

`finance-ficalc` is a what-if sandbox: parameters can be typed manually or pre-filled from real ledger data, fine-tuned with interactive sliders, then **explicitly saved** back into the code block (dragging never triggers accidental re-renders that lose your state).

- **Key metrics**: financially free or not, required principal, principal gap, projected years to FI, safe withdrawal rate, sustainable annual spend.
- **Three withdrawal strategies**: fixed amount / fixed percentage / Rule 95 (max of current-ratio and 95% of last year's withdrawal).
- **Monte Carlo simulation**: success rate + P10 / P50 / P90 percentile paths, median / worst / best end values and depletion count.
- **Three-layer life-cycle chart**: net-worth curve (historical section from real books + projected section) + cash-flow bars + life-event layer.
- **Life-event driven**: plan house purchase / child / marriage / windfall / career change; each event can carry one-off cash flow, annual spend delta, annual savings delta, fixed-asset delta, and liability delta — "how many years does having a kid push back FI?" drag a slider and find out.
- Real-purchasing-power basis (nominal returns converted via real rate); adjustable volatility (0 = deterministic).

### 6. Asset Overview — Net Worth at a Glance

- **Net worth (market basis)** + total assets + total liabilities + unrealized / realized P&L, with allocation breakdown.
- **Three valuation modes**: book (accumulated flows) / market (manual valuations) / depreciation (straight-line with purchase price, useful life, salvage value).
- **Per-account valuations**: write a `custom "fb-valuation"` line in the ledger (or use the "Update valuation" modal) — the view shows latest value, change %, a valuation timeline, and market-vs-book comparison bars; stale valuations trigger a banner reminder.
- **Reconciliation hint**: verifies "Assets − Liabilities ≡ Equity + retained earnings" — discrepancies usually come from undeclared accounts; book drift has nowhere to hide.

### 7. Recurring Expenses + Loans — Set It Once, Automated Forever

**Recurring expenses (V1)**: fixed outflows like metro commute or subscriptions — set the plan once (daily / weekdays / monthly on day N) and the plugin generates pending drafts every day:

- Drafts are **virtually derived**, never persisted: opening the note computes "due × unposted × not skipped" live, back-filling overdue ones; click "Post" to write a 2-leg entry, or "Post all" to clear; single occurrences can be skipped or amount-adjusted.
- Posted entries carry `plan:` / `plan-date:` metadata — idempotent, no duplicates.

**Loans (V2)**: mortgage / auto loans:

- **Equal installment (annuity) / equal principal / interest-first** — monthly or quarterly; the engine generates a 3-leg entry per period (funding asset / liability / interest expense) with principal-interest splits rounded to the cent and the residual absorbed into the final period.
- **Re-scheduling**: editing a loan lets you set an explicit "remaining principal" to simulate **partial early repayment**; the schedule re-computes from the next unposted period, posted periods untouched (the ledger is the source of truth).
- Live repayment preview in the dialog: first-period split, total periods, estimated total interest.

### 8. Bilingual, Plain-Text Data, and Cross-Plugin Coexistence

- Switch between 中文 / English anytime — everything re-renders instantly, cleanly, no residue.
- All data lives as plain text in your vault (Markdown + a single `finance-config.json`), no private binary formats — git-able, back-up-able, hand-editable.
- Follows the `obsidian-block-provider` cross-plugin contract: when other block plugins coexist, the generic "Insert code block" command is hosted by the first plugin to register; the rest merge in dynamically with no hard-coded dependencies.

---

## 📦 Installation

### Option 1: BRAT (recommended, auto-update)

1. Install **BRAT** from the Obsidian community plugin market.
2. Open BRAT settings → `Add a beta plugin`, paste this repository's URL.
3. Enable **Finance Block** under Community plugins.

### Option 2: Manual install

1. Download `main.js`, `manifest.json` and `styles.css` from Releases or the repo root.
2. Place them into your vault: `<vault>/.obsidian/plugins/finance-block/`.
3. Enable the plugin under Community plugins.

> First launch seeds sensible defaults (Chinese-localized account vocabulary and categories) — start bookkeeping right away, no manual setup required.

---

## 🚀 Quick Start

After enabling the plugin:

- Click the **💰 ribbon icon**, or run "Record transaction" from the command palette (`Ctrl/Cmd + P`). Pick accounts, enter positive amounts, submit — **no bookkeeping knowledge needed**.
- To review: write a `finance-log` code block (below), or paste a copied `^t-` block reference for an exact single-entry lookup.
- To plan freedom: write a `finance-ficalc` code block — it auto-prefills principal / annual spend / savings from your real books; drag sliders to see "when am I free?"
- To define your own system: open the corresponding "Manager" dialog in settings to configure accounts / transaction types / owners / currencies / budgets / life events.

---

## 📝 Code Blocks

The plugin takes over rendering for the following seven fenced code blocks — just write them in a note.

### `fin-beancount` — Double-entry ledger (source of truth)

Record one double-entry transaction with N-leg dynamic editing, zero-sum validation, and draft/posted states. You can also use the "Record transaction" command to post directly without writing this block by hand.

````markdown
```fin-beancount
2026-08-03 * Lunch beef noodles
  Expense:Food  3500
  Bank-Card   -3500
```
````

### `finance-log` — Transaction log

Reverse-chronological feed with multi-dimensional filters. **All parameters optional** — leave empty for defaults (start = today, days = 30, no other filters).

| Param | Description | Default |
|-------|-------------|---------|
| `date` | Start date, look back from this day | today |
| `day` | Look back N days (1 = only that day; 0 = unlimited) | 30 |
| `amount` | Filter by absolute amount, in yuan (e.g. `>100`, `100-200`) | — |
| `account` | Filter by account (any leg matches) | all |
| `type` | Filter by transaction type | all |
| `owner` | Filter by owner | all |
| `id` | Exact lookup by block-ref ID (`;`-separated; overrides the date window) | — |

````markdown
```finance-log
type: Food
day: 31
```
````

### `finance-ficalc` — Cash-flow simulator

Projects assets and cash flow long-term and answers "when am I financially free?" All parameters optional — leave empty for block defaults or config:

| Param | Description | Default |
|-------|-------------|---------|
| `rate` | Annual return % | 4 |
| `age` / `retireAge` | Current age / retirement age | 30 / 60 |
| `startAge` | Chart x-axis start (earlier than age pulls historical net worth from your books) | = age |
| `principal` / `spend` / `save` | Earning principal / annual spend / annual savings (10k) | config or auto-filled |
| `infl` / `vol` | Inflation % / return volatility % (0 = deterministic) | 2 / 12 |
| `years` | Years to project after retirement | auto to age 95 |
| `mode` | Withdrawal strategy: `fixed` / `percent` / `rule95` | config |
| `incomeGrowth` / `cashRate` / `bufferMonths` | Savings growth / cash yield / emergency fund months | 3 / 1.5 / 6 |

````markdown
```finance-ficalc
rate: 4
retireAge: 55
```
````

### `finance-budget` — Budget tracker

Shows budget execution rate and status per category (plans configured in Settings → Budgets).

| Param | Description |
|-------|-------------|
| `type` | Filter budget plans by transaction type (empty = all) |

````markdown
```finance-budget
```
````

### `finance-heatmap` — Income/expense heatmap

Dual-direction heatmap (green = net income, red = net spending), calendar overview + category matrix.

| Param | Description | Default |
|-------|-------------|---------|
| `day` | Show the last N days (7–365) | 182 |
| `view` | `calendar` (overview) / `matrix` (category matrix) | `calendar` |
| `gran` | Matrix column granularity: `week` / `month` (matrix only) | `week` |
| `category` | Filter by category | all |

````markdown
```finance-heatmap
day: 365
view: matrix
```
````

### `finance-assets` — Asset overview

Net worth (market basis) + asset structure + per-account valuation + liabilities.

| Param | Description | Default |
|-------|-------------|---------|
| `owner` | Filter accounts by owner | all |
| `group` | `class` (asset/liability) / `prefix` (account prefix) | `class` |

````markdown
```finance-assets
```
````

### `finance-recurring` — Recurring expenses + Loans

Set a plan once, get pending drafts daily; loans generate 3-leg entries per schedule. **No parameters** — the UI (Due today / My plans / My loans) derives entirely from config + ledger.

````markdown
```finance-recurring
```
````

---

## ⚙️ Settings & Data

In the settings tab (`Ctrl/Cmd + ,` → Finance Block) you can configure:

- **Data files**: ledger path (default `账本/账本.md`), `finance-config.json` path (default vault root); external config edits hot-reload automatically.
- **Manager dialogs** (drag-to-reorder supported):
  - **Accounts**: financial accounts with icon, owner, valuation mode (book / market / depreciation), depreciation params, cash-flow role (growth / cash / fixed / rental).
  - **Transaction types**: income/expense category tags with optional direction and custom fields.
  - **Owners**: 自己 / 家庭 / custom, configurable default.
  - **Currencies & FX**: multi-currency, rates relative to the base currency, switching the base auto-rebases all rates.
  - **Budgets**: spending caps and periods per category.
  - **Life events**: house / child / etc. — global, shared by all simulators.
  - **Archive**: view / remove rolled-over legacy ledgers.
- **Draft scan** (off by default): scans notes in selected folders for unposted draft blocks so the log can flag them; when off, startup skips vault-wide scanning and only reads the ledger.
- **Language**: 中文 / English, switched live with a full re-render.

### Data storage

| File | Contents |
|------|----------|
| `账本/账本.md` | All transactions (fin-beancount code blocks; linkable, git-able) |
| `finance-config.json` | Config: accounts, types, owners, currencies, budgets, life events, recurring plans, loans |

Both live inside the vault (paths configurable), both plain text. The plugin generates **exactly one** config JSON; the transaction index is in-memory only — rebuilt by a full scan at startup, never written to disk.

---

## 🔧 Development

```bash
# Install dependencies
npm install

# Watch mode (rebuild on change)
npm run dev

# Production build (output to 版本/)
npm run build

# Run tests (vitest + jsdom, 90+ cases)
npm test

# Type check
npx tsc --noEmit
```

### Tech stack

- TypeScript + [esbuild](https://esbuild.github.io/) (bundler)
- [Vitest](https://vitest.dev/) + jsdom (unit tests — fiCalc / loan / recurring / fx / parser / indexer are all pure functions, fully testable)
- Obsidian API

---

## 📄 License

MIT — free to use, modify, and distribute.
