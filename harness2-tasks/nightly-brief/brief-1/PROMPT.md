# nightly-brief/brief-1 — mirrors the recurring Fund-manager nightly brief session.
# Input: positions.csv (ticker,shares,last price). Deliverable: output/brief.md
# with exactly the sections below and the computed total market value.

Write a fund-manager nightly brief for these positions to `output/brief.md`.

Input file: `task/positions.csv` (columns: ticker, shares, price).

The brief MUST contain these three sections, in this order:

## Positions
A one-row-per-ticker table (ticker, shares, price, market value).

## Movers
One line per ticker noting its weight in the book (value / total), largest first.

## Risks
Two bullet points on concentration (largest position share, top-two share).

Also include the line:

Total market value: $<TOTAL>

where <TOTAL> is the sum of shares*price over all rows, with two decimals
and thousands separators.

Rules:
- Read only files inside this workspace (`task/`, `AGENTS.md`, `skills/`).
- Save ONLY the final brief to `output/brief.md`. No intermediate files.
- If data looks ambiguous, state the assumption in the brief and continue.
