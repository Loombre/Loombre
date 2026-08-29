// scripts/ui-audit/probe-snippet.js — run UIFIX-2026-08-29 H-rule probe.
//
// NOT a standalone node script. This is the payload for the Playwright MCP
// plugin's `browser_run_code_unsafe` tool: call it with
//
//   filename: "scripts/ui-audit/probe-snippet.js"
//
// (the tool loads the file and invokes the exported function with `page`), or
// paste the body into the tool's `code` argument. It needs a live dev stack and
// a browser already carrying the seeded admin session — see PROBE.md for the
// full preconditions, especially the restricted-zone unlock, without which the
// two ZoneControls rows come back NOT-RENDERED.
//
// Returns TSV. Column `env` echoes the pointer media-query state read back out
// of the page, so every row proves which pointer mode actually applied rather
// than trusting that the emulation call took effect.

async (page) => {
  const BASE = 'http://localhost:3000';
  // Any general-class movie with a MetadataCard. Re-derive after a db:reset:
  //   docker exec loombre-dev-postgres-1 psql -U loombre -d loombre -A -t -c \
  //     "select ci.id from catalog_items ci join libraries l on l.id=ci.library_id \
  //      where l.content_class='general' and ci.item_type='movie' limit 1;"
  const MOVIE = '01a01f7a-3553-7dc2-a5a3-6d79eb442a79';

  const WIDTHS = [[380, 844], [768, 1024], [1280, 800], [2560, 1440]];

  // Routes chosen because each actually RENDERS its controls:
  //   /settings/notices carries Input + Button + SegmentedControl + SettingsTabs
  //   together (settings/libraries has no ui/Button; settings/users no segment).
  //   /styleguide is a viable alternative for Input/Button/Segment only.
  const ROUTES = [
    { route: '/settings/notices', controls: [
      ['ui/Input .input', 'Input_input__'],
      ['ui/Button .button', 'Button_button__'],
      ['ui/SegmentedControl .segment', 'SegmentedControl_segment__'],
      ['SettingsTabs .tab', 'SettingsTabs_tab__'],
    ] },
    { route: '/restricted/browse', openFilters: true, controls: [
      ['ZoneControls .rangeInput', 'ZoneControls_rangeInput__'],
      ['ZoneControls .densitySegment', 'ZoneControls_densitySegment__'],
    ] },
    { route: `/items/movie/${MOVIE}`, controls: [
      ['MetadataCard .actionPill', 'MetadataCard_actionPill__'],
    ] },
  ];

  // Runs INSIDE the page. CSS-module classes are hashed as
  // `<Module>_<class>__<hash>`, so each control is addressed by a
  // [class*="Module_class__"] substring. The trailing double underscore stops
  // Module_tab__ from also matching Module_tabs__hash.
  const inPage = (controls) => {
    const rows = [];
    for (const [label, pat] of controls) {
      const nodes = [...document.querySelectorAll(`[class*="${pat}"]`)];
      if (nodes.length === 0) {
        // Recorded, never silently skipped: a control that does not render at a
        // width is a real result (SettingsTabs .tab genuinely has no node at 380).
        rows.push([label, 0, 0, 'NOT-RENDERED', '', '', '']);
        continue;
      }
      const seen = new Map();
      for (const el of nodes) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const key = `${cs.minHeight}|${cs.height}|${r.height > 0}`;
        if (!seen.has(key)) {
          seen.set(key, { mh: cs.minHeight, h: cs.height, rh: +r.height.toFixed(2), n: 0 });
        }
        seen.get(key).n++;
      }
      const vis = nodes.filter((e) => e.getBoundingClientRect().height > 0).length;
      for (const v of seen.values()) rows.push([label, nodes.length, vis, v.mh, v.h, v.rh, v.n]);
    }
    const env = `pc=${matchMedia('(pointer: coarse)').matches}`
      + ` pf=${matchMedia('(pointer: fine)').matches}`
      + ` iw=${innerWidth} mtp=${navigator.maxTouchPoints}`;
    return { rows, env };
  };

  const cdp = await page.context().newCDPSession(page);
  const lines = [
    'pointer\twidth\troute\tcontrol\tmatched\tvisible\tminHeight\theight\trectHeight\tnVariant\tenv',
  ];

  for (const pointer of ['fine', 'coarse']) {
    // Touch emulation ALONE flips (pointer: coarse) / (pointer: fine).
    // Deliberately NOT setDeviceMetricsOverride: that would couple pointer type
    // to viewport, and the two axes must stay independent for this matrix.
    await cdp.send(
      'Emulation.setTouchEmulationEnabled',
      pointer === 'coarse' ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    );

    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      for (const spec of ROUTES) {
        await page.goto(BASE + spec.route, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
        if (spec.openFilters) {
          // The zone filter panel is closed on every load; rangeInput only
          // mounts once it is open.
          try {
            await page.getByRole('button', { name: /Filters/i }).first().click({ timeout: 3000 });
            await page.waitForTimeout(300);
          } catch { /* recorded downstream as NOT-RENDERED */ }
        }
        await page.waitForTimeout(350);
        const { rows, env } = await page.evaluate(inPage, spec.controls);
        for (const r of rows) lines.push([pointer, w, spec.route, ...r, env].join('\t'));
      }
    }
  }

  // Always hand the browser back in the default (fine) state.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.detach();
  return lines.join('\n');
}
// NOTE: no trailing semicolon and no `export` — the MCP tool evaluates this
// file as a single expression, so anything after the closing brace is a
// SyntaxError.
