# n8n workflow check

Checks your n8n workflows (and LangGraph graphs, Dify app exports, and Power Automate and Logic Apps
definitions) before you deploy them. It finds steps no trigger reaches, branches whose condition the
workflow itself decides so that one side can never run, fields a node reads that nothing before it
sets, nodes named in an expression that do not exist, loops with no way out and webhooks that let
anyone start a write. Each finding is shown on the file, at the line of the node it is about.

## Use

Add one step in front of your deploy, after the checkout your workflow already has:

```yaml
- uses: actions/checkout@v4
- uses: muoto-xyz/workflow-check@v1
```

That is all: nothing to install, no key. Without a key the step uses the free check, which has no
guarantees, and says so in its log. By default it reads every JSON file in the repository, skips
the ones that are not workflows, and fails the job only if the change adds a finding.

```yaml
- uses: muoto-xyz/workflow-check@v1
  with:
    paths: workflows/**/*.json   # a glob from the repository's root; several, one per line
    fail-on: new                 # the default: fail only on what this change adds
```

## Only what the change adds

A workflow your team has run for months may already have findings. With `fail-on: new` those do
not fail the job, and nothing needs to be kept in the repository to say which ones they are: the
step compares each file with the same file before the change, which git already has.

- **Before the change** is the pull request's base commit, or, on a push, the commit before the
  push. If that commit is not in the checkout (`actions/checkout` fetches only the last one), the
  step fetches that one commit.
- **A file the change did not touch** is not sent, and is counted as unchanged.
- **A changed file** is sent once, as it is now and as it was before the change, and spends one
  check. The check answers which of its findings the change added and which it removed.
- **A new finding** is one the file did not have before: no finding of the same kind, on the same
  node, about the same other node or field, was in that file before the change. New findings fail
  the job. Findings that were already there are shown as notices and never fail it.
- **A new file** had nothing before, so all its findings are new.
- **A renamed node** looks like a new node to the step, so its findings count as new in the change
  that renames it.

If the step cannot find or read the commit before the change (a push that creates a branch, a run
started by hand or on a schedule, a commit that cannot be fetched), it says so in an error, counts
every finding as new, and fails the job on any finding. It never passes as if nothing had changed.

| input | default | |
|---|---|---|
| `paths` | `**/*.json` | Which files to read. JSON files that are not a workflow the check reads (an n8n workflow, a LangGraph graph, a Dify app's export, or a Power Automate or Logic Apps definition) are skipped and counted. |
| `fail-on` | `new` | `new` fails the job only on findings the change adds, and shows the ones already there as notices. `findings` fails the job when any file has one; `never` shows them as warnings and passes. |
| `key` | none | Your team's key, from a repository secret: `key: ${{ secrets.MUOTO_KEY }}`. Each workflow file read spends one check; a file the check cannot read, and a file that is not a workflow, spends none. Buy a pack at https://workflow.muoto.xyz/buy.html. If the key is unknown or has no checks left, the step fails and says so. |
| `github-token` | none | A token that can write to pull requests, usually `${{ github.token }}` with `pull-requests: write`. With it, what the change does is posted as one comment on the pull request, and edited on later pushes. |
| `endpoint` | `https://workflow.muoto.xyz/api/check` | Where the check answers. |

The last line of the step says what it did:

```
Workflow check: read 3 changed files, 2 new findings, 14 already there, 9 files unchanged, skipped 4 files that are not a workflow the check reads.
```

When the changes also removed findings, the line ends with how many: `The changes removed 3 findings.`

Under `findings` and `never` every workflow file is read, and the line reads
`read 12 files, 3 findings, ...`.

If the check cannot be reached, or answers with an error, the step fails whatever `fail-on` says,
and says the check could not be reached. A check that did not run is never shown as a pass.

## What the change does, on the pull request

A raw diff of an n8n workflow is mostly positions and ids. Under `fail-on: new` the step also writes,
for each workflow file the change touched, what the change does to it: the findings it adds and
removes, the steps and connections added and removed by name, each write a trigger now reaches or
no longer reaches, and a drawing of the changed steps and their neighbours. It goes to the job's
summary on every run. With a `github-token` that can write to pull requests, it is also posted as
one comment on the pull request, and later pushes edit that same comment instead of adding more.

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v4
  - uses: muoto-xyz/workflow-check@v1
    with:
      github-token: ${{ github.token }}
```

Without `github-token` nothing is posted, and the step does not mention it. A pull request from a
fork gets a token that cannot write, so there the summary stays on the job and the step says, in a
warning, that it could not post it.

For a change that adds a webhook, and connects it and an existing step to a new HTTP request that
charges a card, the summary and the comment read:

> ### `workflows/lead.json`
>
> **Findings this change adds**
>
> - Anyone who can reach “Order hook” can make “Charge card” act. “Order hook” asks whoever calls it for no authentication, and it leads to “Charge card”, which sends, creates or posts something. Anyone who finds its address can make it happen, as often as they like.
>
> **Writes a trigger now reaches**
>
> - “Order hook” now leads to “Charge card”
> - “Start” now leads to “Charge card”
>
> **Steps added**
>
> - “Charge card” (n8n-nodes-base.httpRequest)
> - “Order hook” (n8n-nodes-base.webhook)
>
> **Connections added**
>
> - “Order hook” → “Shape”
> - “Shape” → “Charge card”
>
> ```mermaid
> flowchart LR
>   n0["Charge card"]:::added
>   n1["Order hook"]:::added
>   n2["Shape"]
>   n1 ==> n2
>   n2 ==> n0
>   classDef added stroke:#1a7f37,stroke-width:3px
>   classDef removed stroke:#cf222e,stroke-dasharray:5 4
>   classDef changed stroke:#9a6700,stroke-width:3px
> ```
>
> Workflow check: read 1 changed file, 1 new finding, 0 already there, 0 files unchanged, skipped 0 files that are not a workflow the check reads.

In the drawing, a thick arrow is a connection the change added, a dotted one a connection it
removed, and a plain line joins a changed step to a neighbour. Added steps have a green border,
removed ones a dashed red one. A file the change touched without changing its steps, connections,
findings or the writes its triggers reach gets one line saying so. A new file lists its findings.
All of it is the check's answer for the file before and after the change, written out; the step
works none of it out itself.

The comment is the same text as the summary. On a pull request with many changed files it is cut at
a file, and the rest is on the job's summary.

## From a terminal

`cli.js` sends one workflow to the same check and prints what it finds:

```sh
node cli.js workflows/lead.json
cat workflows/lead.json | node cli.js
```

It posts the file as it is, as `text/plain`. A key, if you have one, is read from the
`WORKFLOW_CHECK_KEY` environment variable, never from the command line. It exits 0 with no
findings, 1 with findings, and 2 when the check could not read the file or was not reached.

`--share` is off unless you give it. With it, the request gains `?share=1` and nothing else, and
the check keeps the workflow itself, with the day and which kind of workflow it was, and nothing
about who sent it. Without it, only the row of counts below is kept.

## What is sent, and what is kept

- **Sent:** each file that is a workflow the check reads, as it is in your repository, to
  the endpoint above, one request per file. Under `fail-on: new`, only the files the change touched,
  each with the same file as it was before the change in the same request. Files that are not workflows are read in the job to
  tell, and never sent. The request carries the user-agent `muoto-workflow-action/1`, your key if
  you gave one, and nothing about your repository or the run.
- **Kept:** one row of counts per file: when, which kind of workflow it was, its size rounded up
  to a power of two, how many findings it had, and that it did not come from our own site; and a
  log line with the number of nodes and the kinds of finding. Never the file, its name, its nodes,
  your address or your repository. The answer is worked out in the request and the file is gone when it
  returns.
- **With `github-token`:** the step reads the pull request's comments and posts or edits its own,
  on GitHub, with that token. The token goes to GitHub only, never to the check, and is never printed.

If your workflows must not leave your network, tell us.

## How it works

`action.yml` runs `check.js` on Node 24, with no dependencies. It sends the files and shows the
answer; the check itself runs at the endpoint.
