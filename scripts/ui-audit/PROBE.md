# PROBE.md — rerunning the H-rule computed-style probe

Run UIFIX-2026-08-29, feedback-harness artefact 3. This is the exact procedure
that produced `reports/state/phase0/probe-baseline.{md,json}`. A wave-gate agent
following it reproduces that matrix identically, so a difference in the output is
a difference in the app, not in the method.

Vehicle: **UD-12 Option A** — the Playwright MCP plugin driving live Chrome. No
`@playwright/test` dependency, no CI wiring, no npm dependency of any kind.

---

## 1. What the probe measures

Rule **H**: control height comes from a `--control-height` token —
**36px under `(pointer: fine)`, 44px under `(pointer: coarse)`**.

Seven consumers:

| control | selector | route it renders on |
|---|---|---|
| `ui/Input .input` | `[class*="Input_input__"]` | `/settings/notices` |
| `ui/Button .button` | `[class*="Button_button__"]` | `/settings/notices` |
| `ui/SegmentedControl .segment` | `[class*="SegmentedControl_segment__"]` | `/settings/notices` |
| `SettingsTabs .tab` | `[class*="SettingsTabs_tab__"]` | `/settings/notices` (≥768px only) |
| `ZoneControls .rangeInput` | `[class*="ZoneControls_rangeInput__"]` | `/restricted/browse`, filter panel **open** |
| `ZoneControls .densitySegment` | `[class*="ZoneControls_densitySegment__"]` | `/restricted/browse` |
| `MetadataCard .actionPill` | `[class*="MetadataCard_actionPill__"]` | `/items/movie/<general movie id>` |

Widths: **380×844, 768×1024, 1280×800, 2560×1440**. Pointers: **fine, coarse**.
7 controls × 4 widths × 2 pointers, one row per distinct geometry variant.

### Route choice matters

`/settings/notices` is the only settings route that renders all four generic
controls at once. Do not substitute:

- `/settings/libraries` has **no** `ui/Button` (0 matches at every width);
- `/settings/users` has **no** `SegmentedControl` (0 matches);
- `/settings/account` **redirects to `/profile`**;
- `/styleguide` has Input/Button/Segment but **no** `SettingsTabs`.

`/login` and `/setup` both redirect to `/home` while an admin session is live.

---

## 2. Preconditions

1. **Dev stack up.** `curl -sf http://localhost:3000 >/dev/null`. If not running:

   ```bash
   cd "/Users/ozzy/App Development/Loombre"
   export DATABASE_URL=postgres://loombre:loombre@localhost:5442/loombre
   pnpm dev            # compose up + server + worker + web
   ```

   Pinning `DATABASE_URL` is mandatory — without it the server silently uses an
   embedded Postgres while the worker uses the compose one on 5442
   (standing repo memory). Web is `:3000`, API is `:3001`.

2. **Authenticated as admin.** Seeded credentials, from
   `packages/db/seed/seed.mjs:29-35`: user **`admin`**, password
   **`loombre-seed-admin`**. The playwright-mcp Chrome profile normally still
   carries the session; check with `browser_evaluate`:

   ```js
   () => ({ signedIn: /SIGN OUT/i.test(document.body.innerText),
            user: (document.querySelector('[class*="Sidebar_userName__"]')||{}).textContent })
   ```

   If signed out, log in through `/login` — do not mutate the DB.

3. **Restricted zone unlocked.** Seeded PIN **`0000`**
   (`seed.mjs:35`, `argon2id('0000')`). Navigate `/restricted/browse`, click
   **"Unlock with PIN"**, type `0000` into the PIN textbox. It is an in-app
   dialog, not a JS dialog — safe to drive. The unlock is session-scoped and
   re-locks after 30 min idle, so re-check before a long run. Without it both
   ZoneControls rows come back `NOT-RENDERED`.

4. **A general-class movie id** for the `.actionPill` route. After a `db:reset`,
   re-derive:

   ```bash
   docker exec loombre-dev-postgres-1 psql -U loombre -d loombre -A -t -c \
     "select ci.id from catalog_items ci join libraries l on l.id=ci.library_id \
      where l.content_class='general' and ci.item_type='movie' limit 1;"
   ```

   The baseline used `01a01f7a-3553-7dc2-a5a3-6d79eb442a79` (Black Widow).

**If Chrome refuses to start** with `Browser is already in use for
…/ms-playwright-mcp/mcp-chrome-<id>`, an orphaned automation Chrome from a prior
session holds the profile lock. Find it and kill only that one — it is
identifiable by its `--user-data-dir=…/ms-playwright-mcp/…` flag and is never the
user's personal Chrome:

```bash
ps -eo pid,command | grep 'ms-playwright-mcp' | grep -v grep
kill <pid>
```

---

## 3. Run it

Load the tool once:

```
ToolSearch  select:mcp__plugin_playwright_playwright__browser_run_code_unsafe,mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_evaluate,mcp__plugin_playwright_playwright__browser_click,mcp__plugin_playwright_playwright__browser_type
```

Then call `browser_run_code_unsafe` with an **absolute** `filename` (verified
working 2026-08-29 — it reproduced the baseline's 64 rows exactly):

```
filename: /Users/ozzy/App Development/Loombre/scripts/ui-audit/probe-snippet.js
```

(or paste that file's body into the `code` argument). The tool evaluates the file
as a **single expression**, so the snippet ends with a bare `}` — no trailing
semicolon, no `export`. Adding either is a `SyntaxError: Unexpected token ';'`.

It returns TSV:

```
pointer  width  route  control  matched  visible  minHeight  height  rectHeight  nVariant  env
```

Convert to the machine format with the same reducer the baseline used — effective
height is `min-height` when it is a real length, else `height`:

```js
const eff = (r) => (r.minHeight !== 'auto' && !Number.isNaN(parseFloat(r.minHeight)))
  ? parseFloat(r.minHeight) : parseFloat(r.height);
```

### Pointer emulation — the one subtle part

Coarse pointer is reached with **CDP `Emulation.setTouchEmulationEnabled`
alone**:

```js
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
```

This flips `matchMedia('(pointer: coarse)')` false→true and `'(pointer: fine)'`
true→false, and takes `navigator.maxTouchPoints` 0→5. It needs no new browser and
no re-login.

Deliberately **do not** add `Emulation.setDeviceMetricsOverride({mobile:true})`:
it also works, but it couples pointer type to viewport, and this matrix needs the
two axes independent. Use `page.setViewportSize()` for width and touch emulation
for pointer.

Always restore `{ enabled: false }` and `cdp.detach()` at the end — the snippet
does — so the next agent inherits a fine-pointer browser.

Every row echoes the pointer state read back out of the page (`env` column). Trust
that column, not the fact that the emulation call returned.

---

## 4. Reading the result

- A control with **0 matches** is reported `NOT-RENDERED`, not skipped. That is a
  real result: `SettingsTabs .tab` genuinely has no node at 380px, because the
  phone build shows the settings hub instead of the desktop tab list. **Assert
  `matched > 0` before asserting a height**, or a gate will pass against nothing.
- `matched` vs `visible` differ where a control is in a collapsed section
  (`.actionPill` is 4/2 at every width; `.input` is 1/0 at 380px). `min-height`
  still computes for a zero-box node, so the H assertion stays meaningful — but a
  screenshot of that control at that width is not.
- More than one row per (control, width, pointer) means the control renders in
  more than one geometry; each variant is listed with its node count.

## 5. Baseline to compare against (2026-08-29)

**0 of 7 controls meet the H rule. 0 of 7 vary with pointer at all** — the fine
and coarse halves of the matrix are byte-identical.

| control | fine | coarse |
|---|---|---|
| `ui/Input .input` | 44 | 44 |
| `ui/Button .button` | 44 | 44 |
| `ui/SegmentedControl .segment` | 44 | 44 |
| `SettingsTabs .tab` | 34.84 | 34.84 |
| `ZoneControls .rangeInput` | 21.5 | 21.5 |
| `ZoneControls .densitySegment` | 36 | 36 |
| `MetadataCard .actionPill` | 44 | 44 |

Corroborated statically — both greps return **zero** hits today:

```bash
grep -rn  'control-height'              apps/web/src --include='*.css'   # token absent
grep -rnE 'pointer:\s*(coarse|fine)'    apps/web/src --include='*.css'   # no pointer media
```

No CSS in the tree can branch on pointer, so identical columns are expected. When
H lands, both greps go non-zero and the two columns must diverge to 36 / 44.
