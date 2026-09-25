// The workflow check as a step before a deploy. Each JSON file the `paths` glob matches is
// read here; what the check reads (an n8n workflow, a LangGraph graph, a Dify app's export as JSON,
// or a Power Automate or Logic Apps definition; detect.js) is posted to the check, and what is not is
// skipped and counted, never sent. Each finding comes back as a GitHub annotation on the file, at the
// node's line when the file names it. No dependency: Node's own fetch, fs, path and the runner's git.
//
// Under `fail-on: new`, the default, only what the change adds fails the job. The base is
// the pull request's base commit, or the commit before the push. A file the same at the base is not
// sent; a changed one is sent once, as it is now and as it was at the base, and the check
// answers which findings the change added and which it removed. What is new is the check's answer,
// not this step's: nothing here compares findings.
//
// What the change does is written to the job's summary, and with a `github-token` as one
// comment on the pull request, edited on later pushes. Every line of it is the check's answer for the
// base and the head, rendered: the findings, steps and connections added and removed, the writes a
// trigger now reaches or no longer reaches, and each changed step's neighbours. Nothing here derives
// any of it.
//
// Without a key the step reads each file free and never fails the job: whatever `fail-on`
// says, findings are warnings, nothing is compared with the base (comparing two versions is paid),
// and one notice says what a key adds. A check that cannot be reached or cannot read a file is a
// warning too. With a key, `fail-on` works as above.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { detect } from "./detect.js";

// Its own name, which the check's guess at scanners does not match.
export const USER_AGENT = "muoto-workflow-action/1";
export const ENDPOINT = "https://workflow.muoto.xyz/api/check";
export const BUY = "https://workflow.muoto.xyz/buy.html";
export const FREE = `No key: this step read each file with the free check and reports what it finds as warnings, so it never fails the job. A key lets this step fail the job on new findings and say what each change did; buy a pack at ${BUY} and pass its key from a repository secret.`;
const SKIP_DIRS = new Set([".git", "node_modules"]);

// The test the check makes, not a copy of it: the check imports the same module (detect.js), so a
// file the check would read is never skipped and one it would refuse as not a workflow never sent.
export { detect };

// A glob as a pattern over the path from the workspace, with / between parts: ** is any number of
// folders, * and ? stay inside one.
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function walk(dir, root, into) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), root, into);
    } else if (e.isFile()) into.push(relative(root, join(dir, e.name)).split(sep).join("/"));
  }
  return into;
}

// The files `paths` names: one glob or several, split by commas or new lines, in path order.
export function matching(root, paths) {
  const globs = String(paths || "**/*.json").split(/[,\n]/).map((g) => g.trim().replace(/^\.\//, "")).filter(Boolean).map(globToRegExp);
  return walk(root, root, []).filter((f) => globs.some((g) => g.test(f))).sort();
}

// GitHub's escaping for a workflow command's message and for its properties.
const data = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function annotation(level, props, message) {
  const p = Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${prop(v)}`).join(",");
  return `::${level}${p ? " " + p : ""}::${data(message)}`;
}

// The first line of the file that names the node: n8n by "name", LangGraph by "id", and a Power
// Automate or Logic Apps action by its key, the line that opens its object.
export function lineOf(text, node) {
  if (node === undefined || node === null || node === "-") return undefined;
  const name = JSON.stringify(String(node)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = text.split("\n");
  for (const key of ['"name"', '"id"']) {
    const i = lines.findIndex((l) => l.includes(key) && new RegExp(`${key}\\s*:\\s*${name}`).test(l));
    if (i >= 0) return i + 1;
  }
  const i = lines.findIndex((l) => new RegExp(`${name}\\s*:\\s*\\{`).test(l));
  return i >= 0 ? i + 1 : undefined;
}

// One file to the check, with the base's text when there is one. What comes back: the report, a
// refusal with the check's sentence, or the check not reached (any other answer, or none). With a
// key, it goes as Authorization: Bearer, and a refusal of the key (401, 402) comes back with the
// check's sentence.
export async function post(endpoint, text, key, base = null) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(base === null ? { workflow: text } : { base, head: text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { unreached: `no answer (${e && e.name === "TimeoutError" ? "timed out" : (e && e.cause && e.cause.code) || (e && e.message) || e})` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: said below by its status
  }
  if (res.status === 200 && body && Array.isArray(body.findings)) return { report: body };
  if (res.status === 400 && body && typeof body.error === "string") return { refused: body.error };
  if ((res.status === 401 || res.status === 402) && body && typeof body.error === "string") return { unpaid: body.error };
  return { unreached: `it answered ${res.status}` };
}

// The base the change is measured from: the pull request's base commit, or the commit before the
// push, from the event the runner wrote. What comes back: { sha } or { none: why }.
export function baseOf(eventName, eventPath) {
  let event = null;
  try {
    event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : null;
  } catch {
    // said below: no event to read
  }
  if (!event) return { none: "the step found no event to read the base commit from" };
  if (event.pull_request) {
    const sha = event.pull_request.base && event.pull_request.base.sha;
    return sha ? { sha } : { none: "the pull request names no base commit" };
  }
  if (eventName === "push" || event.before !== undefined) {
    if (!event.before || /^0+$/.test(event.before)) return { none: "this push made the branch, so there is no commit before it" };
    return { sha: event.before };
  }
  return { none: `a ${eventName || "run"} event has no base commit; this runs on a pull request or a push` };
}

const git = (root, args, input) =>
  execFileSync("git", args, { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function hasCommit(root, sha) {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// The base commit in this checkout, fetched as one commit if it is not there. { sha } or { none: why }.
export function reachBase(root, base) {
  if (base.none) return base;
  if (!/^[0-9a-f]{7,64}$/i.test(base.sha)) return { none: `the base "${base.sha}" is not a commit` };
  if (hasCommit(root, base.sha)) return base;
  try {
    git(root, ["fetch", "--no-tags", "--quiet", "--depth=1", "origin", base.sha]);
  } catch (e) {
    const why = String((e && e.stderr) || (e && e.message) || e).trim().split("\n").filter(Boolean).pop();
    return { none: `the base commit ${base.sha.slice(0, 12)} is not in the checkout and could not be fetched (${why || "no reason given"})` };
  }
  return hasCommit(root, base.sha) ? base : { none: `the base commit ${base.sha.slice(0, 12)} is not in the checkout, and fetching it did not bring it` };
}

// A file as it was at the base: its text, or null when the base has no such file.
export function atBase(root, sha, file) {
  try {
    git(root, ["cat-file", "-e", `${sha}:./${file}`]);
  } catch {
    return null;
  }
  return git(root, ["cat-file", "blob", `${sha}:./${file}`]);
}

// --- what the change does, rendered ---

// Marks the one comment this step owns on a pull request, so a later push edits it.
export const MARK = "<!-- muoto-workflow-check -->";
// GitHub refuses a comment longer than 65536 characters.
export const COMMENT_MAX = 65000;
// A name as markdown shows it, quoted, with nothing in it read as markup.
const md = (s) => `“${String(s).replace(/([\\`*_[\]<>|#~])/g, "\\$1")}”`;
const edge = (c) => `${md(c.from)} → ${md(c.to)}${c.output > 0 ? ` (output ${c.output + 1})` : ""}`;
// What each side of a change holds, as the check names it.
const PARTS = ["findings", "steps", "connections", "reaches"];
const of = (side, part) => (side && Array.isArray(side[part]) ? side[part] : []);
const empty = (side) => PARTS.every((k) => !of(side, k).length);

// The changed steps and their neighbours as a mermaid flowchart: the steps the answer names, the
// connections it added (thick) and removed (dotted), and each neighbour pair it gave that neither
// connection already draws (a plain line: the answer says they are joined, not which way).
export function drawing(change) {
  const ids = new Map();
  const id = (name) => {
    if (!ids.has(name)) ids.set(name, `n${ids.size}`);
    return ids.get(name);
  };
  const added = new Set(of(change.added, "steps").map((s) => s.name));
  const removed = new Set(of(change.removed, "steps").map((s) => s.name));
  const lines = [];
  const pairs = new Set();
  const join = (a, b) => pairs.add([a, b].sort().join("\u0000"));
  for (const n of [...added, ...removed]) id(n);
  for (const c of of(change.added, "connections")) {
    lines.push(`  ${id(c.from)} ==>${c.output > 0 ? `|output ${c.output + 1}|` : ""} ${id(c.to)}`);
    join(c.from, c.to);
  }
  for (const c of of(change.removed, "connections")) {
    lines.push(`  ${id(c.from)} -.->${c.output > 0 ? `|output ${c.output + 1}|` : ""} ${id(c.to)}`);
    join(c.from, c.to);
  }
  for (const [a, b] of change.near || []) {
    const key = [a, b].sort().join("\u0000");
    if (pairs.has(key)) continue;
    pairs.add(key);
    lines.push(`  ${id(a)} --- ${id(b)}`);
  }
  if (!ids.size) return "";
  const label = (s) => String(s).replace(/"/g, "#quot;");
  const nodes = [...ids].map(([name, n]) => {
    const cls = added.has(name) && removed.has(name) ? ":::changed" : added.has(name) ? ":::added" : removed.has(name) ? ":::removed" : "";
    return `  ${n}["${label(name)}"]${cls}`;
  });
  return [
    "```mermaid",
    "flowchart LR",
    ...nodes,
    ...lines,
    "  classDef added stroke:#1a7f37,stroke-width:3px",
    "  classDef removed stroke:#cf222e,stroke-dasharray:5 4",
    "  classDef changed stroke:#9a6700,stroke-width:3px",
    "```",
  ].join("\n");
}

const list = (head, items) => (items.length ? [`**${head}**`, "", ...items.map((i) => `- ${i}`), ""] : []);
const finding = (f) => `${f.title}. ${f.why || ""}`.trim();

// One changed file's section: what the check answered for its base and its head.
export function changeSection(file, report) {
  if (empty(report.added) && empty(report.removed)) return `**\`${file}\`**: changed, with the same steps, connections, findings and reached writes as before.\n`;
  const a = report.added, r = report.removed;
  const addF = of(a, "findings"), remF = of(r, "findings");
  const body = [
    `### \`${file}\``,
    "",
    ...(addF.length || remF.length ? [] : ["No finding added or removed.", ""]),
    ...list("Findings this change adds", addF.map(finding)),
    ...list("Findings this change removes", remF.map(finding)),
    ...list("Writes a trigger now reaches", of(a, "reaches").map((x) => `${md(x.trigger)} now leads to ${md(x.write)}`)),
    ...list("Writes a trigger no longer reaches", of(r, "reaches").map((x) => `${md(x.trigger)} no longer leads to ${md(x.write)}`)),
    ...list("Steps added", of(a, "steps").map((s) => `${md(s.name)} (${s.type})`)),
    ...list("Steps removed", of(r, "steps").map((s) => `${md(s.name)} (${s.type})`)),
    ...list("Connections added", of(a, "connections").map(edge)),
    ...list("Connections removed", of(r, "connections").map(edge)),
  ];
  const picture = drawing(report);
  return [...body, ...(picture ? [picture, ""] : [])].join("\n");
}

// A file new in this change: it had nothing before, so it is listed with its findings, not drawn.
export function newSection(file, report) {
  const found = report.findings;
  return [`### \`${file}\` (new)`, "", ...(found.length ? list("Findings", found.map(finding)) : ["No findings.", ""])].join("\n");
}

export function summaryText(sections, counts) {
  return [MARK, "## Workflow check: what this change does", "", ...(sections.length ? sections : ["No workflow file differs from the one before the change.\n"]), counts, ""].join("\n");
}

// The comment as GitHub takes it: whole, or cut at a section with a pointer to the job's summary.
export function commentBody(sections, counts) {
  let text = summaryText(sections, counts);
  for (let n = sections.length - 1; text.length > COMMENT_MAX && n >= 0; n--)
    text = summaryText([...sections.slice(0, n), `The other ${sections.length - n} changed files are in the job's summary.\n`], counts);
  return text.slice(0, COMMENT_MAX);
}

// The pull request this run is for, from the event the runner wrote: its number, or null.
export function pullOf(eventPath) {
  try {
    const n = JSON.parse(readFileSync(eventPath, "utf8")).pull_request.number;
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// The one comment: edited if this step already left one on the pull request, posted if not.
// What comes back: { posted: id }, { edited: id } or { failed: why }. The token is never printed.
export async function comment({ api, repository, number, token, body }) {
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": USER_AGENT, "content-type": "application/json" };
  const call = async (method, path, payload) => {
    const res = await fetch(`${api}${path}`, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${method} ${path.split("?")[0]}`);
    return res.json();
  };
  try {
    let mine = null;
    for (let page = 1; page <= 20 && !mine; page++) {
      const got = await call("GET", `/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
      mine = got.find((c) => typeof c.body === "string" && c.body.startsWith(MARK)) || null;
      if (got.length < 100) break;
    }
    if (mine) return { edited: (await call("PATCH", `/repos/${repository}/issues/comments/${mine.id}`, { body })).id };
    return { posted: (await call("POST", `/repos/${repository}/issues/${number}/comments`, { body })).id };
  } catch (e) {
    return { failed: (e && e.name === "TimeoutError" ? "GitHub did not answer" : e && e.message) || String(e) };
  }
}

export async function run({ root, paths, failOn, endpoint, key: apiKey, eventName, eventPath, summaryPath, token, api, repository }, log = console.log) {
  const free = !apiKey;
  if (failOn !== "new" && failOn !== "findings" && failOn !== "never") {
    log(annotation(free ? "warning" : "error", {}, `fail-on is "${failOn}": it takes "new", "findings" or "never".`));
    if (!free) return 1;
  }
  const level = free || failOn === "never" ? "warning" : "error";
  if (free) log(annotation("notice", { title: "A key lets this step fail the job on new findings" }, FREE));
  // Under `new`, with a key: the base, or why there is none. With none, every finding is new, and it is said.
  let base = null;
  if (failOn === "new" && !free) {
    const reached = reachBase(root, baseOf(eventName, eventPath));
    if (reached.none) log(annotation("error", { title: "No base to compare with" }, `${reached.none[0].toUpperCase()}${reached.none.slice(1)}. Every finding is counted as new, so this step fails on any finding.`));
    else base = reached.sha;
  }
  let read = 0, findings = 0, already = 0, gone = 0, unchanged = 0, skipped = 0, refused = 0;
  const sections = [];
  const reach = (file, answer) => {
    if (answer.unpaid) {
      log(annotation(free ? "warning" : "error", { file, title: "The key was not accepted" }, answer.unpaid));
      log(`Workflow check: the key was not accepted (${answer.unpaid}), so the files were not checked.`);
      return false;
    }
    if (answer.unreached) {
      log(annotation(free ? "warning" : "error", { file, title: "The workflow check could not be reached" }, `${endpoint}: ${answer.unreached}. Nothing was checked from here on, so this is not a pass.`));
      log(`Workflow check: could not be reached at ${endpoint} (${answer.unreached}), so the files were not checked.`);
      return false;
    }
    return true;
  };
  for (const file of matching(root, paths)) {
    const text = readFileSync(join(root, file), "utf8");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      skipped++;
      continue;
    }
    if (!detect(value)) {
      skipped++;
      continue;
    }
    const before = base ? atBase(root, base, file) : null;
    if (before !== null && before === text) {
      unchanged++;
      continue;
    }
    // A base that is not a workflow is sent as nothing: the file is new as a workflow.
    let was = null;
    try {
      was = before !== null && detect(JSON.parse(before)) ? before : null;
    } catch {
      // not JSON at the base: nothing was there
    }
    const answer = await post(endpoint, text, apiKey, was);
    if (!reach(file, answer)) return free ? 0 : 1;
    if (answer.refused) {
      refused++;
      log(annotation(free ? "warning" : "error", { file, title: "The workflow check could not read this file" }, answer.refused));
      continue;
    }
    read++;
    const report = answer.report;
    if (base) sections.push(report.added && report.removed ? changeSection(file, report) : newSection(file, report));
    if (report.removed) gone += of(report.removed, "findings").length;
    if (report.unheard) log(annotation("notice", { file, line: lineOf(text, report.unheard.nodes && report.unheard.nodes[0]), title: report.unheard.title }, report.unheard.why));
    for (const f of report.findings) {
      const there = f.added === false;
      if (there) already++;
      else findings++;
      const node = f.node !== undefined && f.node !== "-" ? `Node “${f.node}”: ` : "";
      log(annotation(there ? "notice" : level, { file, line: lineOf(text, f.node), title: there ? `Already there before this change: ${f.title}` : f.title }, `${node}${f.why || f.title}`));
    }
  }
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const counts =
    failOn === "new" && !free
      ? `read ${noun(read, base ? "changed file" : "file", base ? "changed files" : "files")}, ${noun(findings, "new finding", "new findings")}, ${already} already there, ${noun(unchanged, "file", "files")} unchanged`
      : `read ${noun(read, "file", "files")}, ${noun(findings, "finding", "findings")}`;
  const last = `Workflow check: ${counts}, skipped ${noun(skipped, "file", "files")} that ${skipped === 1 ? "is" : "are"} not a workflow the check reads${refused ? `, and could not read ${noun(refused, "file", "files")}` : ""}.${gone ? ` The changes removed ${noun(gone, "finding", "findings")}.` : ""}`;
  log(last);
  // What the change does, only where there was a base to measure it from.
  if (base) {
    if (summaryPath) appendFileSync(summaryPath, summaryText(sections, last));
    const number = token && repository ? pullOf(eventPath) : null;
    if (number) {
      const done = await comment({ api: api || "https://api.github.com", repository, number, token, body: commentBody(sections, last) });
      if (done.failed) log(annotation("warning", { title: "The summary was not posted on the pull request" }, `${done.failed}. The token needs to be able to write to pull requests (permissions: pull-requests: write).`));
    }
  }
  if (free) return 0;
  if (refused) return 1;
  return findings && failOn !== "never" ? 1 : 0;
}

// As the runner starts it: the inputs come as INPUT_<NAME> in the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = (name, fallback) => (process.env[`INPUT_${name.toUpperCase()}`] || "").trim() || fallback;
  process.exitCode = await run({
    root: process.env.GITHUB_WORKSPACE || process.cwd(),
    paths: input("paths", "**/*.json"),
    failOn: input("fail-on", "new"),
    endpoint: input("endpoint", ENDPOINT),
    key: input("key", ""),
    eventName: process.env.GITHUB_EVENT_NAME || "",
    eventPath: process.env.GITHUB_EVENT_PATH || "",
    summaryPath: process.env.GITHUB_STEP_SUMMARY || "",
    token: input("github-token", ""),
    api: process.env.GITHUB_API_URL || "https://api.github.com",
    repository: process.env.GITHUB_REPOSITORY || "",
  });
}
