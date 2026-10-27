# trading-review/ledger-1 — mirrors trading-dashboard reconciliation work.
# Input: trades.csv (ticker,side,shares,price). Deliverable: output/summary.md
# with net positions and cash-flow totals.

Reconcile the trade ledger to `output/summary.md`.

Input file: `task/trades.csv` (columns: ticker, side, shares, price;
side is BUY or SELL).

The summary MUST contain these two sections, in this order:

## Net positions
A one-row-per-ticker table (ticker, net shares = buys minus sells).

## Cash flow
Three lines: total buy cost, total sell proceeds, and net cash
(proceeds minus cost), each as shares*price sums with two decimals.

Rules:
- Read only files inside this workspace (`task/`, `AGENTS.md`, `skills/`).
- Save ONLY the final summary to `output/summary.md`. No intermediate files.
- If data looks ambiguous, state the assumption in the summary and continue.
