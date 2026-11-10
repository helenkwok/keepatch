// Keepatch: a slow, resumable maintenance report for a public repository.
// Reads pull requests, checks and bug issues; ranks them with fixed rules; keeps one report issue
// and one issue per task that needs work. It never touches code, branches or merges.
//
// As a GitHub Action it takes the inputs in action.yml. By hand:
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name node keepatch.mjs
//   KEEPATCH_REPOS="owner/a owner/b"  repositories to read (default: GITHUB_REPOSITORY only)
//   KEEPATCH_DRY_RUN=1                print what it would write, write nothing
//   node keepatch.mjs --self-test
import assert from "node:assert/strict";

const LABEL = "keepatch";
const STALE_DAYS = 30;
const BOTS = new Set(["dependabot[bot]", "renovate[bot]"]);
const ADVISORY = /GHSA-[0-9a-z]{4}-|CVE-\d{4}-\d+/i;
const SECURITY = /\bsecurity\b|\bvulnerab/i;

// ---- pure rules ---------------------------------------------------------------------------

// Check runs and commit statuses at one commit -> "failing" | "running" | "passing" | "none".
// "none" also covers checks that only skipped: a green tick with nothing behind it is not a pass.
export function checkState(runs, statuses = []) {
  const bad = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];
  if (runs.some((r) => bad.includes(r.conclusion)) || statuses.some((s) => s.state === "failure" || s.state === "error")) return "failing";
  if (runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending")) return "running";
  if (runs.some((r) => r.conclusion === "success") || statuses.some((s) => s.state === "success")) return "passing";
  return "none";
}

// One task -> { priority, reasons }. Higher first. Every point is explained in `reasons`.
export function rank(t) {
  const reasons = [];
  let p = 0;
  const add = (n, why) => { p += n; reasons.push(why); };
  if (t.kind === "main") add(100, "checks fail on the default branch");
  if (t.kind === "bug") add(40, "open bug report");
  if (t.kind === "pin") {
    if (t.diverged) add(15, `pinned commit is not on ${t.branch}; ${t.behind} commits there are not in it`);
    else add(t.behind >= 100 ? 45 : t.behind >= 20 ? 35 : 25, `${t.behind} commits behind ${t.branch}; pinned commit is from ${t.pinnedDate}`);
  }
  if (t.kind === "pr") {
    if (t.security) add(90, "mentions a security advisory");
    if (t.checks === "failing") add(t.bot ? 70 : 60, "checks fail");
    if (t.checks === "none") add(55, "no check ran on the current commit");
    if (t.checks === "running") reasons.push("checks still running");
    if (t.checks === "passing" && !t.draft) add(t.bot ? 50 : 45, "passes checks and waits for a merge");
    if (t.checks === "passing" && !t.reviewedAtHead) reasons.push("no review of the current commit");
    if (t.bot && t.jump === "breaking") add(15, "breaking by semver: read the changelog before merging");
    if (t.conflict) add(20, "conflicts with the base branch");
    if (t.ageDays >= STALE_DAYS) add(30, `open for ${t.ageDays} days`);
  }
  if (t.kind === "pr" || t.kind === "bug") p += Math.min(t.ageDays, 20) / 2; // older first within a tier, capped
  return { priority: Math.round(p), reasons };
}

// Was the commit `head` reviewed? Either a pull request review of that commit, or a review bot's
// summary comment that names it. CodeRabbit posts no pull request review when it has nothing to
// flag: it edits one comment that lists the commit range it read (seen on StochCraft #97).
// Simplified: text match on the bot's comment; replace if the bot offers a structured record.
const REVIEW_BOTS = new Set(["coderabbitai[bot]"]);
const NOT_A_REVIEW = /review in progress|currently processing|review skipped|rate limit/i;
export const reviewedAt = (head, reviews, comments = []) =>
  reviews.some((r) => r.commit_id === head && r.state !== "PENDING") ||
  comments.some((c) => REVIEW_BOTS.has(c.user?.login) && c.body.includes(head) && !NOT_A_REVIEW.test(c.body));

// A security item: the title or a label says so, or the text names an advisory. The word
// "security" in a body is not enough: Dependabot quotes upstream release notes there, and they
// mention security all the time (seen on StochCraft #99).
export const isSecurity = (title, body = "", labels = []) =>
  SECURITY.test(title) || ADVISORY.test(title) || ADVISORY.test(body) || labels.some((l) => /security/i.test(l));

// What a version bump means under semver, read from an update bot's title ("from 1.2.3 to 2.0.0").
// "breaking" is a new major version, or a new minor of a 0.x version (breaking under Cargo's rules).
// On 9,122 Dependabot pull requests this rule alone ranked the ones that later failed or needed a
// fix well above chance (AUROC 0.69 for Cargo); grouped updates carry no version and return null.
const BUMP = /from v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\S* to v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i;
export function semverJump(title) {
  const m = BUMP.exec(title);
  if (!m) return null;
  const [a0, a1, , b0, b1] = m.slice(1).map((x) => Number(x ?? 0));
  if (b0 !== a0 || (a0 === 0 && b1 !== a1)) return "breaking";
  return b1 !== a1 ? "minor" : "patch";
}

// Git dependencies pinned to a revision in a Cargo manifest: [{ name, git, rev }]. Update bots
// do not follow these, so nothing says when a pin has fallen behind.
// Simplified: inline tables on one line (`name = { git = "...", rev = "..." }`), which is how
// workspaces write them. Use a TOML parser if multi-line dependency tables turn up.
export function cargoPins(toml) {
  const out = [];
  for (const line of toml.split("\n")) {
    const m = /^\s*([\w-]+)\s*=\s*\{(.*)\}/.exec(line);
    const git = m && /\bgit\s*=\s*"([^"]+)"/.exec(m[2]), rev = m && /\brev\s*=\s*"([0-9a-f]{7,40})"/.exec(m[2]);
    if (git && rev) out.push({ name: m[1], git: git[1].replace(/\.git$/, ""), rev: rev[1] });
  }
  return out;
}

// A task gets its own issue only when something has to be done about it.
export const needsIssue = (t) => t.kind === "main" || (t.kind === "pr" && (t.checks === "failing" || t.checks === "none"));

// Titles and other outside text are untrusted: show them as inline code so they cannot mention
// people, add links or break the table.
export const safe = (s) => "`" + String(s).replace(/[`|\r\n]/g, " ").slice(0, 110) + "`";

const marker = (key) => `<!-- keepatch:key=${key} -->`;
export function readState(body) {
  const m = /<!-- keepatch:state (\{.*?\}) -->/s.exec(body || "");
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
export const keyOf = (body) => /<!-- keepatch:key=([\w-]+) -->/.exec(body || "")?.[1] ?? null;

function selfTest() {
  assert.equal(checkState([]), "none");
  assert.equal(checkState([{ status: "completed", conclusion: "skipped" }]), "none");
  assert.equal(checkState([{ status: "completed", conclusion: "success" }, { status: "in_progress" }]), "running");
  assert.equal(checkState([{ status: "completed", conclusion: "success" }], [{ state: "failure" }]), "failing");
  assert.equal(checkState([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), "passing");
  const pr = (o) => rank({ kind: "pr", ageDays: 1, ...o }).priority;
  assert.ok(rank({ kind: "main" }).priority > pr({ security: true, checks: "passing", bot: true }) - 60);
  assert.ok(pr({ security: true, checks: "passing", bot: true }) > pr({ checks: "failing", bot: true }));
  assert.ok(pr({ checks: "failing", bot: true }) > pr({ checks: "none" }));
  assert.ok(pr({ checks: "none" }) > pr({ checks: "passing", bot: true }));
  assert.ok(pr({ checks: "passing", bot: true }) > rank({ kind: "bug", ageDays: 1 }).priority);
  assert.equal(needsIssue({ kind: "pr", checks: "passing" }), false);
  assert.equal(isSecurity("Bump the actions group with 5 updates", "add security overrides for undici"), false);
  assert.equal(isSecurity("Bump tar from 6.2.0 to 6.2.1", "Fixes GHSA-f5x3-32g6-xq36"), true);
  assert.equal(isSecurity("[Security] Bump lodash"), true);
  assert.equal(isSecurity("Bump serde", "", ["dependencies", "security"]), true);
  assert.equal(semverJump("Bump serde from 1.0.219 to 1.0.228"), "patch");
  assert.equal(semverJump("Bump tokio from 1.46.0 to 1.47.1"), "minor");
  assert.equal(semverJump("Bump egui from 0.37.0 to 0.38.0"), "breaking");
  assert.equal(semverJump("bump actions/checkout from 4 to 5"), "breaking");
  assert.equal(semverJump("Bump the actions group with 5 updates"), null);
  assert.ok(pr({ checks: "passing", bot: true, jump: "breaking" }) > pr({ checks: "passing", bot: true, jump: "patch" }));
  assert.deepEqual(cargoPins(`[workspace.dependencies]
# a = { git = "https://example.com/x", rev = "0123456789" }
serde = "1"
craft-ui = { version = "0.1.0", git = "https://github.com/o/craft-libs", rev = "d836bea31b7d33d83023edc6bab9cd8059232471" }
egui = { git = "https://github.com/o/egui.git", rev = "6d518fc799" }
tagged = { git = "https://github.com/o/t", tag = "v1" }`), [
    { name: "craft-ui", git: "https://github.com/o/craft-libs", rev: "d836bea31b7d33d83023edc6bab9cd8059232471" },
    { name: "egui", git: "https://github.com/o/egui", rev: "6d518fc799" },
  ]);
  const pin = (o) => rank({ kind: "pin", branch: "main", pinnedDate: "2026-01-01", ...o });
  assert.ok(pin({ behind: 142 }).priority > pin({ behind: 30 }).priority && pin({ behind: 30 }).priority > pin({ behind: 3 }).priority);
  assert.ok(pin({ behind: 3 }).priority > pin({ behind: 400, diverged: true }).priority);
  assert.equal(needsIssue({ kind: "pin" }), false);
  const bot = (body) => [{ user: { login: "coderabbitai[bot]" }, body }];
  assert.equal(reviewedAt("abc", [{ commit_id: "abc", state: "COMMENTED" }]), true);
  assert.equal(reviewedAt("abc", [{ commit_id: "old", state: "APPROVED" }]), false);
  assert.equal(reviewedAt("abc", [], bot("between base and abc. No actionable comments")), true);
  assert.equal(reviewedAt("abc", [], bot("between base and abc. Review in progress")), false);
  assert.equal(reviewedAt("abc", [], bot("Rate limit exceeded for abc")), false);
  assert.equal(reviewedAt("abc", [], [{ user: { login: "someone" }, body: "abc looks fine" }]), false);
  assert.equal(safe("hi @someone `x` | y\n[a](b)"), "`hi @someone  x    y [a](b)`");
  const body = `${marker("pr-12")}\n<!-- keepatch:state {"runs":3,"head":"abc"} -->`;
  assert.equal(keyOf(body), "pr-12");
  assert.deepEqual(readState(body), { runs: 3, head: "abc" });
  assert.equal(readState("<!-- keepatch:state {oops} -->"), null);
  console.log("self-test ok");
}

// ---- GitHub -------------------------------------------------------------------------------

// An action's inputs arrive as INPUT_<NAME>; the plain variables are for running it by hand.
const input = (name) => process.env[`INPUT_${name}`];
// The host repository runs the workflow and holds the report and task issues. REPOS are read.
const HOST = process.env.GITHUB_REPOSITORY;
const REPOS = [...new Set((input("REPOS") || process.env.KEEPATCH_REPOS || HOST || "").split(/[\s,]+/).filter(Boolean))];
const TOKEN = input("TOKEN") || process.env.GITHUB_TOKEN;
const DRY = input("DRY_RUN") === "true" || !!process.env.KEEPATCH_DRY_RUN;

async function api(method, path, body, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept, "x-github-api-version": "2022-11-28", "user-agent": "keepatch" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : accept.endsWith("raw") ? res.text() : res.json();
}
// False once a list may have been cut short or something could not be read. A run that did not
// see everything must not conclude that a problem is gone, so it closes no task issue.
let complete = true;
// Simplified: first 100 of each list, no paging. Add paging when a repo has more open items.
async function list(path) {
  const r = await api("GET", path + (path.includes("?") ? "&" : "?") + "per_page=100");
  if ((Array.isArray(r) ? r : r.check_runs ?? []).length >= 100) complete = false;
  return r;
}
async function write(what, method, path, body) {
  console.log(`${DRY ? "would" : "did"}: ${what}`);
  return DRY ? null : api(method, `/repos/${HOST}${path}`, body);
}
const days = (iso, now) => Math.floor((now - Date.parse(iso)) / 864e5);
async function checksAt(r, sha) {
  const [runs, st] = await Promise.all([list(`${r}/commits/${sha}/check-runs`), api("GET", `${r}/commits/${sha}/status`)]);
  return { state: checkState(runs.check_runs, st.statuses), failing: runs.check_runs.filter((c) => c.conclusion === "failure").map((c) => c.name) };
}

// Pinned git dependencies that have fallen behind their upstream's default branch.
async function pinTasks(repo, branch) {
  const tree = await api("GET", `/repos/${repo}/git/trees/${branch}?recursive=1`);
  const manifests = tree.tree.filter((e) => e.type === "blob" && /(^|\/)Cargo\.toml$/.test(e.path)).slice(0, 40);
  const pins = new Map(); // one entry per upstream and revision, however many crates use it
  for (const f of manifests) {
    const toml = await api("GET", `/repos/${repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}?ref=${branch}`, null, "application/vnd.github.raw");
    for (const p of cargoPins(toml)) {
      const k = `${p.git}@${p.rev}`;
      pins.set(k, { ...p, names: (pins.get(k)?.names ?? new Set()).add(p.name) });
    }
  }
  const tasks = [];
  for (const p of pins.values()) {
    const up = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(p.git)?.[1];
    if (!up) { console.log(`pin not compared (not a GitHub URL): ${p.git}`); continue; }
    try {
      const upstream = await api("GET", `/repos/${up}`);
      const cmp = await api("GET", `/repos/${up}/compare/${p.rev}...${upstream.default_branch}`);
      if (!cmp.ahead_by) continue; // the pin is the newest commit
      const names = [...p.names];
      tasks.push({
        kind: "pin", key: `pin-${up}-${p.rev.slice(0, 7)}`.replace(/[^\w-]/g, "-"), url: `https://github.com/${up}/compare/${p.rev}...${upstream.default_branch}`,
        title: `${up} pinned at ${p.rev.slice(0, 10)} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""})`,
        behind: cmp.ahead_by, diverged: cmp.status === "diverged", branch: upstream.default_branch,
        pinnedDate: cmp.base_commit?.commit?.committer?.date?.slice(0, 10) ?? "an unknown date", ageDays: 0,
      });
    } catch (e) {
      console.log(`pin not compared: ${up} (${e.message})`);
    }
  }
  return tasks;
}

async function collect(repo, now) {
  const r = `/repos/${repo}`;
  const info = await api("GET", r);
  const tasks = [];
  const main = await checksAt(r, info.default_branch);
  if (main.state === "failing") tasks.push({ kind: "main", key: "main-ci", title: `Checks fail on ${info.default_branch}`, url: `${info.html_url}/actions`, checks: "failing", failing: main.failing, ageDays: 0 });
  for (const pr of await list(`${r}/pulls?state=open`)) {
    try {
      const [c, reviews, comments] = await Promise.all([checksAt(r, pr.head.sha), list(`${r}/pulls/${pr.number}/reviews`), list(`${r}/issues/${pr.number}/comments`)]);
      // `mergeable` is only on the single-PR endpoint, and is null while GitHub works it out.
      const full = await api("GET", `${r}/pulls/${pr.number}`);
      tasks.push({
        kind: "pr", key: `pr-${pr.number}`, title: pr.title, url: pr.html_url, head: pr.head.sha, checks: c.state, failing: c.failing,
        bot: BOTS.has(pr.user.login), draft: pr.draft, conflict: full.mergeable === false, jump: semverJump(pr.title),
        security: isSecurity(pr.title, pr.body || "", pr.labels.map((l) => l.name)),
        reviewedAtHead: reviewedAt(pr.head.sha, reviews, comments),
        ageDays: days(pr.created_at, now),
      });
    } catch (e) {
      // One unreadable pull request must not stop the report for the rest.
      console.log(`skipped ${repo} pr-${pr.number}: ${e.message}`);
      complete = false;
    }
  }
  for (const i of await list(`${r}/issues?state=open&labels=bug`)) {
    if (!i.pull_request && !i.labels.some((l) => l.name === LABEL)) tasks.push({ kind: "bug", key: `bug-${i.number}`, title: i.title, url: i.html_url, ageDays: days(i.created_at, now) });
  }
  try {
    tasks.push(...await pinTasks(repo, info.default_branch));
  } catch (e) {
    console.log(`pins not read for ${repo}: ${e.message}`);
  }
  return { state: `checks ${main.state}`, tasks: tasks.map((t) => ({ ...t, repo, ...rank(t) })) };
}

// ---- report and task issues ---------------------------------------------------------------

function reportBody(states, tasks, now, stateJson) {
  const many = REPOS.length > 1;
  const rows = tasks.map((t) => `| ${t.priority} |${many ? ` ${t.repo.split("/")[1]} |` : ""} [${t.key.replace(/^pin-.*/, "pin")}](${t.url}) | ${safe(t.title)} | ${t.checks ?? ""} | ${t.reasons.join("; ")} |`);
  return [
    marker("report"), `<!-- keepatch:state ${stateJson} -->`,
    `Updated ${new Date(now).toISOString().slice(0, 16)}Z by the scheduled Keepatch run. This issue is rewritten on every run.`,
    "", ...states.map(([repo, st]) => `- **${repo}:** ${st}`), "", `**Queue:** ${tasks.length} item${tasks.length === 1 ? "" : "s"}.`,
    complete ? "" : "\n**This run could not read everything** (a list reached 100 items, or something could not be read; see the run's log). The queue may be missing items, and no task issue was closed.", "",
    tasks.length ? `| Priority |${many ? " Repo |" : ""} Item | Title | Checks | Why |\n|---|${many ? "---|" : ""}---|---|---|---|\n${rows.join("\n")}` : "Nothing is waiting.",
    "", "Priority comes from fixed rules (`rank()` in Keepatch's `keepatch.mjs`). A passing check here means at least one check ran and succeeded on the current commit. A pin is a git dependency fixed to one commit, which update bots do not follow. Keepatch reports; people merge.",
  ].join("\n");
}

function taskBody(t, st) {
  return [
    marker(t.key), `<!-- keepatch:state ${JSON.stringify(st)} -->`,
    `${t.url}`, "", `**Why this is open:** ${t.reasons.join("; ")}.`,
    t.failing?.length ? `**Failing checks:** ${t.failing.map(safe).join(", ")}` : "",
    t.head ? `**Commit examined:** \`${t.head.slice(0, 12)}\`` : "", `**Seen on ${st.runs} run${st.runs === 1 ? "" : "s"}, first on ${st.first}.**`,
    "", "Keepatch closes this issue when the problem is gone. Link a fix with `Closes #<this issue>`.",
  ].filter((l) => l !== "").join("\n\n");
}

async function main() {
  if (!HOST || !TOKEN) throw new Error("set GITHUB_REPOSITORY and GITHUB_TOKEN");
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  const states = [], tasks = [];
  for (const repo of REPOS) {
    try {
      const d = await collect(repo, now);
      states.push([repo, d.state]); tasks.push(...d.tasks);
    } catch (e) {
      // One unreadable repository must not stop the report for the rest.
      console.log(`skipped ${repo}: ${e.message}`);
      states.push([repo, "could not be read"]); complete = false;
    }
  }
  tasks.sort((a, b) => b.priority - a.priority);

  const mine = (await list(`/repos/${HOST}/issues?state=open&labels=${LABEL}`)).filter((i) => !i.pull_request && keyOf(i.body));
  // One issue per key: the oldest keeps the key, and any other issue carrying the same marker
  // (an overlapping run, or a copied marker) is closed so it cannot sit there unowned.
  const byKey = new Map();
  for (const i of mine.sort((a, b) => a.number - b.number)) {
    const key = keyOf(i.body), first = byKey.get(key);
    if (!first) byKey.set(key, i);
    else await write(`close issue #${i.number} (same key ${key} as #${first.number})`, "PATCH", `/issues/${i.number}`, { state: "closed", state_reason: "not_planned" });
  }
  if (!DRY) await api("POST", `/repos/${HOST}/labels`, { name: LABEL, color: "5319e7", description: "Opened and updated by the Keepatch maintenance run" }).catch(() => {}); // exists already: fine

  // Task issues are kept only for the host repository: the workflow's token cannot write to the
  // others, and they did not ask for issues. Their items appear in the report.
  const hostRead = states.some(([repo, st]) => repo === HOST && st !== "could not be read");
  const active = new Set();
  for (const t of tasks.filter((t) => t.repo === HOST && needsIssue(t))) {
    active.add(t.key);
    const old = byKey.get(t.key), prev = readState(old?.body);
    const st = { head: t.head ?? null, checks: t.checks, first: prev?.first ?? today, runs: (prev?.runs ?? 0) + 1 };
    const title = `Keepatch: ${t.kind === "main" ? t.title : `#${t.key.slice(3)} ${t.checks === "none" ? "has no check on its current commit" : "fails checks"}`}`;
    if (old) await write(`update issue #${old.number} (${t.key}, run ${st.runs})`, "PATCH", `/issues/${old.number}`, { title, body: taskBody(t, st) });
    else await write(`open issue for ${t.key}`, "POST", "/issues", { title, body: taskBody(t, st), labels: [LABEL] });
  }
  const mayClose = complete && hostRead;
  if (!mayClose) console.log("this run did not read everything in the host repository: closing no task issue");
  for (const [key, issue] of byKey) {
    if (!mayClose || key === "report" || active.has(key)) continue;
    await write(`close issue #${issue.number} (${key} no longer needs work)`, "POST", `/issues/${issue.number}/comments`, { body: "The problem is gone on the latest run. Closing." });
    if (!DRY) await api("PATCH", `/repos/${HOST}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
  }

  const prevRuns = readState(byKey.get("report")?.body)?.runs ?? 0;
  const body = reportBody(states, tasks, now, JSON.stringify({ runs: prevRuns + 1, last: today }));
  const report = byKey.get("report");
  if (report) await write(`rewrite report issue #${report.number}`, "PATCH", `/issues/${report.number}`, { body });
  else await write("open the report issue", "POST", "/issues", { title: "Keepatch maintenance report", body, labels: [LABEL] });
  console.log("\n" + body);
}

if (process.argv.includes("--self-test")) selfTest();
else await main();
