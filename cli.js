#!/usr/bin/env node
// The workflow check from a terminal: one file, or stdin, posted to the check as
// text/plain, and its findings printed. The same endpoint as the Action (check.js); its own
// user-agent, which the check's guess at scanners does not match either.
//
//   node cli.js [--share] [--endpoint URL] [FILE | -]
//
// With no FILE, or with -, the workflow is read from stdin. A key, when there is one, comes from the
// environment as WORKFLOW_CHECK_KEY, never from the command line, and goes as Authorization: Bearer.
//
// --share is off unless given. Given, it adds ?share=1 to the URL and nothing else: the check then
// keeps the text itself, with the day and the kind. Without it
// the check keeps only a row of counts.
//
// Exit status: 0 no findings, 1 findings, 2 the check refused the text or was not reached, or the
// command was misused.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ENDPOINT } from "./check.js";

export const CLI_USER_AGENT = "muoto-workflow-cli/1";

export const USAGE = "Usage: workflow-check [--share] [--endpoint URL] [FILE | -]\n  Reads FILE, or stdin, and sends it to the workflow check.\n  --share  also keep the workflow on the check's side (off unless given).";

// The command line as options: { share, endpoint, file } or { error }.
export function parse(argv) {
  const opts = { share: false, endpoint: ENDPOINT, file: "-" };
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--share") opts.share = true;
    else if (a === "--endpoint") {
      if (i + 1 >= argv.length) return { error: "--endpoint needs a URL." };
      opts.endpoint = argv[++i];
    } else if (a.startsWith("--endpoint=")) opts.endpoint = a.slice("--endpoint=".length);
    else if (a === "-h" || a === "--help") return { help: true };
    else if (a.startsWith("-") && a !== "-") return { error: `Unknown option ${a}.` };
    else if (file !== null) return { error: "One file at a time." };
    else file = a;
  }
  if (file !== null) opts.file = file;
  return opts;
}

// The request as it is sent: the URL, with share=1 only under --share, and fetch's init.
export function request({ endpoint, text, key = "", share = false }) {
  const url = new URL(endpoint);
  if (share) url.searchParams.set("share", "1");
  const headers = { "content-type": "text/plain; charset=utf-8", "user-agent": CLI_USER_AGENT };
  if (key) headers.authorization = `Bearer ${key}`;
  return { url: url.href, init: { method: "POST", headers, body: text } };
}

// The check's answer as lines for a person.
export function render(report) {
  const n = report.findings.length;
  const lines = report.findings.map((f) => {
    const node = f.node !== undefined && f.node !== "-" ? `Node “${f.node}”: ` : "";
    return `- ${f.title}\n  ${node}${f.why || f.title}`;
  });
  lines.push(n === 0 ? "No findings." : `${n} finding${n === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

async function readInput(file) {
  if (file !== "-") return readFileSync(file, "utf8");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv, env = process.env, out = console.log, err = console.error) {
  const opts = parse(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.error) {
    err(`${opts.error}\n${USAGE}`);
    return 2;
  }
  let text;
  try {
    text = await readInput(opts.file);
  } catch (e) {
    err(`Could not read ${opts.file}: ${(e && e.code) || e}`);
    return 2;
  }
  const { url, init } = request({ endpoint: opts.endpoint, text, key: (env.WORKFLOW_CHECK_KEY || "").trim(), share: opts.share });
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    err(`The check did not answer (${e && e.name === "TimeoutError" ? "timed out" : (e && e.cause && e.cause.code) || (e && e.message) || e}).`);
    return 2;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: said below by its status
  }
  if (res.status === 200 && body && Array.isArray(body.findings)) {
    out(render(body));
    return body.findings.length ? 1 : 0;
  }
  if (body && typeof body.error === "string") err(body.error);
  else err(`The check answered ${res.status}.`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
