// CLANKER 500 — pure-function unit tests. Extracts self-contained functions from the
// page source (single source of truth) and asserts their behavior. Run by verify.sh.
const fs = require("fs");

function extractFn(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("function not found: " + name);
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const html = fs.readFileSync(__dirname + "/../site/broadcast.html", "utf8");
const impliedProb = eval("(" + extractFn(html, "impliedProb") + ")");

let fails = 0;
const approx = (a, b) => a != null && b != null && Math.abs(a - b) < 0.01;
function eq(got, want, msg) { if (!approx(got, want)) { console.log("  ✗", msg, "→ got", got, "want", want); fails++; } }
function isNull(got, msg) { if (got !== null) { console.log("  ✗", msg, "→ got", got, "want null"); fails++; } }

// pool share is the parimutuel truth
let r = impliedProb({ pool: { guard: 5, courier: 5 } });
eq(r.guard, 50, "equal pool → guard 50%"); eq(r.courier, 50, "equal pool → courier 50%");
r = impliedProb({ pool: { guard: 3, courier: 5 } });
eq(r.guard, 37.5, "pool 3/5 → guard 37.5%"); eq(r.courier, 62.5, "pool 3/5 → courier 62.5%");
// probabilities sum to 100
eq(r.guard + r.courier, 100, "probabilities sum to 100");
// odds fallback when no pool (normalized inverse)
r = impliedProb({ odds: { guard: 2, courier: 2 } });
eq(r.guard, 50, "even odds → 50%");
r = impliedProb({ odds: { guard: 1.5, courier: 3 } });
eq(r.guard, 66.67, "odds 1.5/3 → guard 66.7%"); eq(r.courier, 33.33, "odds 1.5/3 → courier 33.3%");
// pool takes precedence over odds
r = impliedProb({ pool: { guard: 1, courier: 3 }, odds: { guard: 2, courier: 2 } });
eq(r.guard, 25, "pool wins over odds");
// neither → null (no fabricated numbers)
r = impliedProb({});
isNull(r.guard, "no data → guard null"); isNull(r.courier, "no data → courier null");

// drawSpark — builds the SVG polyline points (x: 0..100, y inverted so a higher value sits higher)
const drawSpark = eval("(" + extractFn(html, "drawSpark") + ")");
function spark(arr) { let p; drawSpark(arr, { setAttribute: (k, v) => { p = v; } }); return p; }
if (spark([5]) !== undefined) { console.log("  ✗ drawSpark <2 points should no-op"); fails++; }
{
  const p = spark([0, 10]);
  if (p !== "0.0,23.0 100.0,2.0") { console.log("  ✗ drawSpark [0,10] →", p); fails++; }
}
{
  const p = spark([5, 5, 5]); // flat series → rng guard, all mid-height
  if (p !== "0.0,23.0 50.0,23.0 100.0,23.0") { console.log("  ✗ drawSpark flat →", p); fails++; }
}
{
  const ys = spark([1, 2, 3]).split(" ").map(s => parseFloat(s.split(",")[1])); // higher value → smaller y
  if (!(ys[0] > ys[1] && ys[1] > ys[2])) { console.log("  ✗ drawSpark not monotonic", ys); fails++; }
}

// betTier — alert size thresholds: 2 whale (>=50), 1 big (>=10), 0 normal
const betTier = eval("(" + extractFn(html, "betTier") + ")");
eq(betTier(0), 0, "betTier 0 → normal");
eq(betTier(9.99), 0, "betTier 9.99 → normal");
eq(betTier(10), 1, "betTier 10 → big");
eq(betTier(49.99), 1, "betTier 49.99 → big");
eq(betTier(50), 2, "betTier 50 → whale");
eq(betTier(1000), 2, "betTier 1000 → whale");

if (fails) { console.log("UNIT FAILED (" + fails + ")"); process.exit(1); }
console.log("UNIT OK (impliedProb, drawSpark, betTier)");
