# Design QA

## Signal data fetch time

- Source visual truth: `/var/folders/xx/1h1hmbcn1xvgs5_sft5jmpgc0000gp/T/codex-clipboard-44a45f30-8b91-4b3a-a4d1-880ba4d6463c.png`
- Implementation full page: `/Users/henry/projects/binance/artifacts/signal-data-fetch-time-full.png`
- Implementation focused region: `/Users/henry/projects/binance/artifacts/signal-data-fetch-time-focus.png`
- Normalized comparison: `/Users/henry/projects/binance/artifacts/signal-data-fetch-time-comparison.png`
- Source pixels: 2662 × 304
- Desktop viewport: 1280 × 720 CSS px, DPR 2
- Implementation full-page pixels: 1280 × 2150
- Focused implementation pixels: 1220 × 180
- Mobile viewport: 390 × 844 CSS px
- State: local historical signals during off-hours; timestamps fall back to the
  trace timestamp for records created before `dataFetchedAt` existed

### Full-view comparison evidence

The source is itself a focused crop of the complete signal section rather than
a full Dashboard. The complete implementation page was captured to confirm the
section remains in its existing position and that surrounding layout was not
changed. The source crop and implementation signal region were then normalized
to the same 1220 px width for the full available visual-target comparison.

### Focused comparison evidence

- The five-column table, header alignment, row density, typography hierarchy,
  colors, borders, and signal context match the supplied signal-section target.
- The final header intentionally reads `拉取时间` instead of the source's
  `更新时间` so its meaning matches the newly recorded backend event.
- Existing records show their trace timestamp as a compatibility fallback.
  New scans expose the moment both 1-minute and 15-minute K-line requests finish.

### Required fidelity surfaces

- Fonts and typography: existing system and monospace stack, weights, sizes,
  line heights, and compact hierarchy are unchanged.
- Spacing and layout rhythm: column tracks, 10 px gaps, row height, padding,
  section spacing, radii, and borders remain aligned with the source.
- Colors and visual tokens: existing dark panel, muted labels, green/red
  semantics, and grid texture are preserved.
- Image quality and asset fidelity: the target contains no raster imagery,
  logo change, illustration, or custom icon asset.
- Copy and content: only the time-column label changes, clarifying that the
  value is the data fetch completion time.

### Responsive and interaction checks

- Desktop document width and scroll width are both 1280 px.
- At 390 px, document width and scroll width are both 390 px; five signal rows
  remain visible by default and all ten rows retain machine-readable timestamps.
- Hovering a time exposes the complete localized timestamp through its title.
- Browser console contains no warnings or errors at either viewport.

### Comparison history

1. The first implementation pass replaced the ambiguous update time with the
   explicit fetch completion time while preserving the existing table layout.
2. The normalized source/implementation comparison found no actionable
   P0/P1/P2 layout, typography, color, asset, or copy issue.

final result: passed

---

## Asset trend dashboard

- Source: `/var/folders/xx/1h1hmbcn1xvgs5_sft5jmpgc0000gp/T/codex-clipboard-3297066c-fd2f-4bbb-af6d-f33a5efa0e41.png`
- Implementation full view: `/Users/henry/projects/binance/artifacts/asset-trend-dashboard-desktop.png`
- Implementation focused view: `/Users/henry/projects/binance/artifacts/asset-trend-chart-desktop.png`
- Mobile focused view: `/Users/henry/projects/binance/artifacts/asset-trend-chart-mobile.png`
- Focused comparison: `/Users/henry/projects/binance/artifacts/asset-trend-reference-implementation.png`
- Source dimensions: 2360 × 962
- Desktop viewport and screenshot: 1440 × 1000 viewport, 1440 × 1863 full-page image, DPR 1
- Focused desktop chart: 1220 × 276
- Mobile viewport: 390 × 844; focused chart: 366 × 218

### Comparison evidence

The complete Dashboard was reviewed for hierarchy and spacing, then the source
chart and implemented chart were normalized to 1220 px wide and reviewed
together. The focused comparison verifies the requested smooth blue line,
point markers, USD grid, date axis, and translucent area fill while preserving
the existing dark operational visual language.

### Findings

- Asset trend is the first content block below the compact wallet/risk header.
- The remaining Dashboard grid is tightened to 18–20 px gaps without changing
  order controls, position state, signals, strategy rules, or the action log.
- The chart renders 16 daily snapshots in the QA fixture, exposes a matching
  accessible label, and shows the exact date and USD value on pointer hover.
- The desktop document width equals its scroll width at 1440 px.
- At 390 px, the document width equals its scroll width and the chart uses a
  366 px card with compact axes. The full-page mobile capture exhibited the
  known in-app viewport compositor mismatch, so the chart was also captured
  directly from its measured bounds for visual inspection.
- Desktop and mobile checks completed with no console warnings or errors.

### Comparison history

1. First desktop pass confirmed the layout and surfaced that a full-page image
   made the chart detail difficult to judge.
2. Added a focused chart capture and a normalized source/implementation
   comparison; the axis, curve, fill, point density, and final date all match
   the reference hierarchy.
3. Verified the mobile chart separately at its measured 366 × 218 bounds and
   confirmed no horizontal overflow.

### Primary interactions

- Pointer hover selects the nearest daily point and displays its date and USD
  total. Verified with `2026-07-20` and `$55.00`.
- Resizing redraws the canvas at the current element dimensions.

final result: passed

---

- Source: `/var/folders/xx/1h1hmbcn1xvgs5_sft5jmpgc0000gp/T/codex-clipboard-025fd4c0-5a7e-497a-9206-bd67052ab82c.png`
- Implementation: `/Users/henry/projects/binance/artifacts/strategy-compact-default.jpg`
- Comparison: `/Users/henry/projects/binance/artifacts/strategy-before-after.jpg`
- Desktop viewport: 1280 × 720, DPR 2
- Mobile viewport: 390 × 844
- State: LIVE, active strategy is adaptive momentum, no completed strategy trades

## Comparison evidence

The source screenshot is the previous hero-heavy state. The implementation screenshot is the requested compact operational state. They were reviewed together in `artifacts/strategy-before-after.jpg`.

## Findings

- Removed the English eyebrow, oversized page title, explanatory paragraph, current-strategy promo card, and switch-boundary banner.
- Kept the current strategy and LIVE mode in the top navigation.
- Kept only returns, compact strategy metrics, entry/exit rules, and switch controls in the body.
- Desktop content is aligned within a 1180 px shell with no horizontal overflow.
- At 390 px, all four strategy cards collapse to 358 px wide and the document has no horizontal overflow.
- The restored desktop page reaches `document.readyState === "complete"` and no runtime-error element is present.

## History

1. Initial browser capture exposed a viewport capture mismatch; reset the temporary viewport capability and recaptured at the browser default.
2. Compared the before and after screenshots together and found no remaining promotional block or unintended empty region.

## Final result

passed

---

# iPhone Dashboard Design QA

- Source: `/Users/henry/.codex/generated_images/019f98f1-bb18-72b0-ae6a-a972861a6599/call_8jiZ3Bqb97dHOynpafJzNOr4.png`
- Implementation: `/tmp/binance-dashboard-mobile-top-390x844.png`
- Comparison: `/tmp/binance-dashboard-mobile-comparison.png`
- Mobile viewport: 390 × 844
- State: LIVE layout with current local wallet, risk, signal, and action data

## Comparison evidence

The selected combined mock and the implemented Dashboard were normalized to the same 390 × 844 viewport and reviewed side by side. The implementation preserves the approval-first hierarchy when an approval exists and uses the selected compact five-column signal table.

## Findings

- The document width and scroll width are both 390 px; no horizontal overflow is present.
- Header status, risk metrics, pending approval, position, signals, and actions follow the selected dark operational hierarchy.
- The signal table shows five rows by default and expands to ten rows; `aria-expanded` and button text return correctly when collapsed.
- Approval buttons are at least 52 px high globally and 56 px high at the iPhone breakpoint.
- The current runtime has no pending approval, so the verified empty approval state appears in the screenshot; approval rendering remains covered by the existing Dashboard tests.
- Full project suite passes 92/92.

## Final result

passed
