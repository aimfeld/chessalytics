#!/usr/bin/env node
// Headless layout harness for dashboard/static/charts.js.
//
// Loads the REAL charts.js off disk into a node:vm sandbox behind a minimal
// DOM shim, invokes every chart entry point with synthetic worst-case
// fixture data, and measures the SVG geometry it actually emits at four
// phone viewport widths. It must never re-implement chart gutter/tick math
// itself — every geometric decision comes from charts.js; this file only
// measures and asserts.
//
// Usage: node dashboard/check_layout.mjs [--checks fit|labels|all]
//   fit    - SVG width fits its container; no preserveAspectRatio scale-down;
//            no text clipped outside the chart's own width.
//   labels - no two same-baseline text nodes overlap.
//   all    - both groups (default).
//
// No npm install, no network, no database, no browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARTS_PATH = path.join(__dirname, "static", "charts.js");
const STYLES_PATH = path.join(__dirname, "static", "styles.css");

const VIEWPORTS = [320, 360, 390, 414];
const EPS = 0.5; // float slack for box-overlap/edge comparisons

/* ---------------------------------------------------------------------- *
 * Width chain — mirrored from dashboard/static/styles.css. If these ever
 * drift from the stylesheet, assertNoDrift() below fails loudly rather than
 * silently measuring a fiction (see PLAN 260824-dsj must_haves.key_links).
 *
 * Below NARROW_BREAKPOINT, styles.css's @media(max-width:560px) block
 * reduces .wrap/.card padding — mirrored here so a viewport at or under that
 * breakpoint uses the reduced chain.
 * ---------------------------------------------------------------------- */
const WRAP_MAX_WIDTH = 1140; // .wrap{max-width:1140px ...}
const WRAP_PADDING_X = 24; // .wrap{padding:0 24px 96px}
const CARD_PADDING_X = 18; // .card{padding:18px 18px 10px}
const WRAP_PADDING_DECL = "padding:0 24px 96px";
const CARD_PADDING_DECL = "padding:18px 18px 10px";
const NARROW_BREAKPOINT = 560; // @media(max-width:560px)
const WRAP_PADDING_X_NARROW = 12; // .wrap{padding:0 12px 64px} inside the breakpoint
const CARD_PADDING_X_NARROW = 12; // .card{padding:14px 12px 10px} inside the breakpoint
const WRAP_PADDING_DECL_NARROW = "padding:0 12px 64px";
const CARD_PADDING_DECL_NARROW = "padding:14px 12px 10px";

function assertNoDrift() {
  const css = readFileSync(STYLES_PATH, "utf8");
  const decls = [WRAP_PADDING_DECL, CARD_PADDING_DECL, WRAP_PADDING_DECL_NARROW, CARD_PADDING_DECL_NARROW];
  for (const decl of decls) {
    if (css.includes(decl)) continue;
    console.error(`DRIFT: expected "${decl}" in ${STYLES_PATH} but it was not found.`);
    console.error("The harness width-chain constants and styles.css have diverged — update both together.");
    process.exit(1);
  }
}

function paddingFor(viewport) {
  return viewport <= NARROW_BREAKPOINT
    ? { wrap: WRAP_PADDING_X_NARROW, card: CARD_PADDING_X_NARROW }
    : { wrap: WRAP_PADDING_X, card: CARD_PADDING_X };
}

function containerWidth(viewport) {
  const { wrap, card } = paddingFor(viewport);
  const wrapW = Math.min(viewport, WRAP_MAX_WIDTH);
  const cardW = wrapW - 2 * wrap;
  return cardW - 2 * card;
}

function describeChain(viewport) {
  const { wrap, card } = paddingFor(viewport);
  const wrapW = Math.min(viewport, WRAP_MAX_WIDTH);
  const cardW = wrapW - 2 * wrap;
  const chartW = cardW - 2 * card;
  return `${viewport} -> wrap ${wrapW} -> card ${cardW} -> chart ${chartW}`;
}

/* ---------------------------------------------------------------------- *
 * Minimal DOM shim. Covers exactly the surface charts.js touches:
 * document.querySelector/documentElement/createElementNS, getComputedStyle,
 * and per-node setAttribute/appendChild/innerHTML/textContent/closest/
 * clientWidth/parentElement/style/addEventListener.
 * ---------------------------------------------------------------------- */
function makeNode(tag) {
  return {
    tag,
    attrs: {},
    children: [],
    style: {},
    innerHTML: "",
    textContent: "",
    clientWidth: 0,
    parentElement: null,
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    // Real closest() may legitimately return null; frame() already wraps
    // the subsequent .querySelector(...) lookup in try/catch.
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    addEventListener() {
      /* no-op: pointer handlers are never fired by this harness, so
         getBoundingClientRect is never reached */
    },
  };
}

function makeDom() {
  const tipNode = makeNode("div");
  const doc = {
    querySelector(sel) {
      return sel === "#tip" ? tipNode : makeNode("div");
    },
    documentElement: makeNode("html"),
    createElementNS(_ns, tag) {
      return makeNode(tag);
    },
  };
  // Colors are never measured by any assertion; any non-empty placeholder is fine.
  const getComputedStyle = () => ({ getPropertyValue: () => "#000000" });
  return { document: doc, getComputedStyle, makeNode };
}

function loadCharts(dom) {
  const code = readFileSync(CHARTS_PATH, "utf8");
  const sandbox = { document: dom.document, getComputedStyle: dom.getComputedStyle, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: CHARTS_PATH });
  return sandbox.__fc;
}

/* ---------------------------------------------------------------------- *
 * Fixtures — real worst-case label strings from dashboard/queries.py and
 * dashboard/app.js (see PLAN 260824-dsj measured_baseline).
 * ---------------------------------------------------------------------- */
function generateDateLabels(startISO, n) {
  const start = new Date(startISO + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start.getTime() + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
}
function wave(n, base, amp) {
  return Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + amp * Math.sin(i / 3))));
}
function waveFrac(n, base, amp) {
  return Array.from({ length: n }, (_, i) => Math.max(0, Math.min(1, base + amp * Math.sin(i / 3))));
}

const DATE_LABELS = generateDateLabels("2026-07-23", 33); // widest short() form, e.g. "23 Jul"
const RETENTION_LABELS = Array.from({ length: 14 }, (_, i) => "day-" + (i + 1));

function buildCases(fc) {
  const n = DATE_LABELS.length;
  return [
    {
      chart: "lineChart",
      name: "lineChart every=7 (actives)",
      invoke: (host) =>
        fc.lineChart(host, {
          labels: DATE_LABELS,
          h: 300,
          every: 7,
          series: [
            { name: "MAU (30-day)", values: wave(n, 400, 60), color: "#B25A28", area: true },
            { name: "WAU (7-day)", values: wave(n, 180, 40), color: "#0F8A7A" },
            { name: "DAU", values: wave(n, 60, 20), color: "#3C63D8" },
          ],
        }),
    },
    {
      chart: "lineChart",
      name: "lineChart every=5 pctAxis (accuracy)",
      invoke: (host) =>
        fc.lineChart(host, {
          labels: DATE_LABELS,
          h: 220,
          every: 5,
          mark: false,
          pctAxis: true,
          yMax: 1,
          fmt: (v) => Math.round(v * 100) + "%",
          series: [
            { name: "Right move", values: waveFrac(n, 0.7, 0.1), color: "#3C63D8" },
            { name: "Right verdict", values: waveFrac(n, 0.5, 0.1), color: "#A8790E" },
          ],
        }),
    },
    {
      chart: "lineChart",
      name: "lineChart retention xfmt every=1 yMax=1",
      invoke: (host) =>
        fc.lineChart(host, {
          labels: RETENTION_LABELS,
          h: 250,
          mark: false,
          every: 1,
          pctAxis: true,
          yMax: 1,
          xfmt: (_lb, i) => String(i + 1),
          xcap: "days since first visit",
          fmt: (v) => Math.round(v * 100) + "%",
          series: [
            { name: "Registered accounts", values: waveFrac(14, 0.3, 0.1), color: "#B25A28", area: true },
            { name: "Guest sessions", values: waveFrac(14, 0.15, 0.05), color: "#B44A8E" },
          ],
        }),
    },
    {
      chart: "barChart",
      name: "barChart every=10 (signups)",
      invoke: (host) =>
        fc.barChart(host, {
          labels: DATE_LABELS,
          h: 220,
          every: 10,
          series: [
            { name: "Registered signups", values: wave(n, 20, 8), color: "#B25A28" },
            { name: "Guest sessions", values: wave(n, 40, 12), color: "#B44A8E" },
          ],
        }),
    },
    {
      chart: "barChart",
      name: "barChart every=10 log=true (imports)",
      invoke: (host) =>
        fc.barChart(host, {
          labels: DATE_LABELS,
          h: 220,
          every: 10,
          log: true,
          series: [{ name: "Games imported", values: wave(n, 500, 300), color: "#8B5E3C" }],
          extra: () => [
            { k: "Jobs", v: 3 },
            { k: "Failed", v: 0 },
          ],
        }),
    },
    {
      chart: "barChart",
      name: "barChart every=7 stacked (bot)",
      invoke: (host) =>
        fc.barChart(host, {
          labels: DATE_LABELS,
          h: 250,
          every: 7,
          series: [
            { name: "Human win", values: wave(n, 10, 4), color: "#1F7A3D" },
            { name: "Draw", values: wave(n, 5, 2), color: "#8A7A6B" },
            { name: "Bot win", values: wave(n, 8, 3), color: "#A8321F" },
          ],
        }),
    },
    {
      chart: "gbar",
      name: "gbar 5-bucket (time-to-import)",
      invoke: (host) =>
        fc.gbar(host, {
          labels: ["Under 5 min", "5–60 min", "1–24 h", "Later than a day", "Never"],
          h: 250,
          max: 1,
          yFmt: (v) => Math.round(v * 100) + "%",
          fmt: (v) => Math.round(v * 100) + "%",
          series: [
            { name: "Registered accounts", color: "#B25A28", values: [0.4, 0.25, 0.15, 0.1, 0.1] },
            { name: "Guest sessions", color: "#B44A8E", values: [0.5, 0.2, 0.15, 0.1, 0.05] },
          ],
        }),
    },
    {
      chart: "gbar",
      name: "gbar 2-group (stickiness)",
      invoke: (host) =>
        fc.gbar(host, {
          labels: ["Registered", "Guest"],
          h: 250,
          max: 1,
          yFmt: (v) => Math.round(v * 100) + "%",
          fmt: (v) => Math.round(v * 100) + "%",
          series: [
            { name: "Imported games", color: "#0F8A7A", values: [0.6, 0.3] },
            { name: "Never imported", color: "#8A7A6B", values: [0.4, 0.7] },
          ],
        }),
    },
    {
      chart: "gbar",
      name: "gbar 3-metric (conversion compare)",
      invoke: (host) =>
        fc.gbar(host, {
          labels: ["Imported games", "Came back a 2nd day", "Played the bot"],
          h: 240,
          max: 1,
          yFmt: (v) => Math.round(v * 100) + "%",
          fmt: (v) => Math.round(v * 100) + "%",
          series: [
            { name: "Converted to an account", color: "#0F8A7A", values: [0.7, 0.5, 0.3] },
            { name: "Stayed a guest", color: "#B44A8E", values: [0.3, 0.2, 0.1] },
          ],
        }),
    },
    {
      chart: "funnel",
      name: "funnel registered",
      invoke: (host) =>
        fc.funnel(host, {
          color: "#B25A28",
          unit: "of registered accounts",
          rows: [
            { label: "Account created", value: 1000 },
            { label: "Chess account linked", value: 700 },
            { label: "Import started", value: 500 },
            { label: "At least 1 game imported", value: 300 },
            { label: "5+ games imported", value: 100 },
          ],
        }),
    },
    {
      chart: "funnel",
      name: "funnel guest",
      invoke: (host) =>
        fc.funnel(host, {
          color: "#B44A8E",
          unit: "of guest sessions",
          rows: [
            { label: "Guest session started", value: 2000 },
            { label: "Chess account linked", value: 300 },
            { label: "Import started", value: 900 },
            { label: "At least 1 game imported", value: 400 },
            { label: "5+ games imported", value: 50 },
          ],
        }),
    },
    {
      chart: "hbar",
      name: "hbar persona",
      invoke: (host) =>
        fc.hbar(host, {
          rows: [
            { label: "Aggressive", value: 420, color: "#B25A28", sub: "12 players · 48% human score" },
            { label: "Positional", value: 310, color: "#0F8A7A", sub: "9 players · 52% human score" },
            { label: "Custom", value: 90, color: "#3C63D8", sub: "3 players · 61% human score" },
          ],
        }),
    },
    {
      chart: "hbar",
      name: "hbar bot elo",
      invoke: (host) =>
        fc.hbar(host, {
          fmt: (v) => Math.round(v * 100) + "%",
          rows: [{ label: "1700 bot", value: 0.55, color: "#3C63D8", sub: "84 games" }],
        }),
    },
    {
      chart: "sparkline",
      name: "sparkline",
      invoke: (host) => fc.sparkline(host, wave(30, 40, 15), "#B25A28"),
    },
  ];
}

/* ---------------------------------------------------------------------- *
 * Rendering + tree walking helpers.
 * ---------------------------------------------------------------------- */
function renderCase(dom, testCase, viewport) {
  const host = dom.makeNode("div");
  host.clientWidth = containerWidth(viewport);
  testCase.invoke(host);
  const svg = host.children.find((c) => c.tag === "svg");
  return { case: testCase, viewport, host, svg };
}

function collectTag(node, tag, out = []) {
  if (node.tag === tag) out.push(node);
  for (const child of node.children || []) collectTag(child, tag, out);
  return out;
}

function findAttr(node, key) {
  if (node.attrs && node.attrs[key] !== undefined) return true;
  return (node.children || []).some((child) => findAttr(child, key));
}

// Uses the SAME estimator charts.js itself uses (fc.textPx) — never a
// private copy — so the harness and the renderer agree by construction.
function textBox(fc, node) {
  const text = node.textContent || "";
  const fontPx = parseFloat(node.attrs["font-size"] || "12");
  const family = node.attrs["font-family"] || "";
  const mono = /mono/i.test(family);
  const width = fc.textPx(text, fontPx, mono);
  const x = parseFloat(node.attrs.x || "0");
  const anchor = node.attrs["text-anchor"] || "start";
  if (anchor === "end") return { lo: x - width, hi: x };
  if (anchor === "middle") return { lo: x - width / 2, hi: x + width / 2 };
  return { lo: x, hi: x + width };
}

/* ---------------------------------------------------------------------- *
 * Assertion groups.
 * ---------------------------------------------------------------------- */
function checkFit(fc, result, violations) {
  const { case: c, viewport, host, svg } = result;
  if (!svg) {
    violations.push(`${c.name} @ ${viewport}px: no <svg> emitted`);
    return;
  }
  const containerW = host.clientWidth;
  const svgW = Number(svg.attrs.width);
  const svgH = Number(svg.attrs.height);
  if (svgW > containerW) {
    violations.push(`${c.name} @ ${viewport}px: svg width ${svgW} > container ${containerW}`);
  }
  const vb = String(svg.attrs.viewBox || "").trim().split(/\s+/).map(Number);
  if (vb.length !== 4 || vb[2] !== svgW || vb[3] !== svgH) {
    violations.push(`${c.name} @ ${viewport}px: viewBox "${svg.attrs.viewBox}" != width/height ${svgW}x${svgH}`);
  }
  if (findAttr(svg, "preserveAspectRatio")) {
    violations.push(`${c.name} @ ${viewport}px: preserveAspectRatio found — scale-down is forbidden (C-5)`);
  }
  if (typeof fc.textPx !== "function") return; // reported once at startup
  for (const t of collectTag(svg, "text")) {
    const box = textBox(fc, t);
    if (box.lo < -EPS || box.hi > svgW + EPS) {
      violations.push(
        `${c.name} @ ${viewport}px: text "${t.textContent}" box [${box.lo.toFixed(1)}, ${box.hi.toFixed(1)}] exceeds chart width ${svgW}`,
      );
    }
  }
}

function checkLabels(fc, result, violations) {
  if (typeof fc.textPx !== "function") return; // reported once at startup
  const { case: c, viewport, svg } = result;
  if (!svg) return;
  const byY = new Map();
  for (const t of collectTag(svg, "text")) {
    const y = t.attrs.y;
    if (y === undefined) continue;
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(t);
  }
  for (const nodes of byY.values()) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = textBox(fc, nodes[i]);
        const b = textBox(fc, nodes[j]);
        if (a.lo < b.hi - EPS && b.lo < a.hi - EPS) {
          violations.push(
            `${c.name} @ ${viewport}px: text "${nodes[i].textContent}" overlaps "${nodes[j].textContent}" at y=${nodes[i].attrs.y}`,
          );
        }
      }
    }
  }
}

/* ---------------------------------------------------------------------- *
 * Main.
 * ---------------------------------------------------------------------- */
function parseArgs(argv) {
  const idx = argv.indexOf("--checks");
  const val = idx >= 0 ? argv[idx + 1] : "all";
  if (!["fit", "labels", "all"].includes(val)) {
    console.error(`Unknown --checks value "${val}"; expected fit, labels or all.`);
    process.exit(1);
  }
  return val;
}

function run(checks) {
  assertNoDrift();
  const dom = makeDom();
  const fc = loadCharts(dom);
  const violations = [];
  if (typeof fc.textPx !== "function") {
    console.error("MISSING: __fc.textPx is not exported by charts.js yet (Task 2 of PLAN 260824-dsj adds it).");
    console.error("Text-box and label-overlap checks cannot run without it — this is expected RED before Task 2.");
    violations.push("__fc.textPx is not exported by charts.js");
  }
  const cases = buildCases(fc);
  for (const viewport of VIEWPORTS) {
    console.log(describeChain(viewport));
    for (const testCase of cases) {
      const result = renderCase(dom, testCase, viewport);
      if (checks === "fit" || checks === "all") checkFit(fc, result, violations);
      if (checks === "labels" || checks === "all") checkLabels(fc, result, violations);
    }
  }
  if (violations.length) {
    console.error(`\nFAIL: ${violations.length} layout violation(s):`);
    violations.forEach((v) => console.error("  - " + v));
    process.exit(1);
  }
  console.log(`\nOK: all charts fit within their container at ${VIEWPORTS.join("/")}px (checks=${checks}).`);
  process.exit(0);
}

run(parseArgs(process.argv.slice(2)));
