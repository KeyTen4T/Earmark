# Working with Keaton (all projects)

These apply in every project unless the project's CLAUDE.md or the user says otherwise.

## Delegate the heavy work to opencode (DeepSeek)

Claude is the lead: it talks to the user, plans, writes the brief, and reviews. Token-heavy work goes
to opencode through the `ocd` command (`~/.local/bin/ocd`; source in the Earmark repo at
`tools/ocd/ocd`, installed by Earmark's `new-machine.sh`).

```bash
ocd -C /abs/project/dir --check "<project checks>" "self-contained task brief"   # do the work
ocd -C /abs/project/dir --plan "question"                # read-only investigation
ocd -C /abs/project/dir -s <session id> "follow-up"      # continue; it keeps its context
ocd -C /abs/project/dir -f brief.md                      # long brief from a file
```

- Always pass `-C` with an absolute path. Long tasks: `-t 2400`.
- opencode starts with no knowledge of the conversation: the brief names the goal, files, constraints,
  acceptance criteria and how to verify. Split big jobs into separately verifiable tasks.
- It runs with permissions auto-approved, so never send it anything destructive or outward-facing
  (deleting data, git push, releases, deploys, sending messages, changing live servers or accounts).
  Claude does those itself, after asking.
- Claude keeps: understanding the request, design decisions, and review.

### When to delegate

Decide per task, by judgment, not by default. Delegation pays when it keeps bulk (big file reads,
build logs, test-fix loops) out of Claude's context and the result can be checked; it loses when the
brief and review cost more than doing the work, or when a weaker model is likely to get it subtly
wrong.

Delegate when most of these hold:
- The task is mechanical and can be stated fully upfront: multi-file changes, adding tests, fixing
  build/type/lint errors, renames, ports, boilerplate, chasing a failing test.
- It needs a lot of reading or running that Claude would otherwise pull into its context, e.g.
  "find where X happens" across a large codebase, or iterating on a long build.
- Success is checkable: a test, typecheck or build that `--check` can run.

Do it directly when any of these hold:
- It is small: a few lines, or a change Claude can make in about as many calls as a brief would take.
- It is judgment-heavy: design, architecture, a subtle or intermittent bug, concurrency, security,
  data migration or anything that could lose data, where "correct" is hard to state in a brief.
- Reviewing it properly would mean reading all of the code anyway.
- It is outward-facing or destructive (never delegated, see above).

Mixed tasks: Claude does the thinking (diagnosis, design, the tricky core) and delegates the
mechanical remainder with a precise brief. When unsure, prefer doing it directly: a wrong delegation
costs a review plus a redo.

Say the choice in one short line (e.g. "Delegating this: mechanical, covered by tests" or "Doing this
myself: subtle sync logic") so the user can overrule it.
- If `ocd` reports ERROR (quota, auth, service down) or is not installed, say so and ask before doing
  the task directly.
- A run pauses while the computer sleeps.

## Keep Claude round-trips low

Every Claude call re-reads the whole conversation, so most of the cost is the number of calls.

- One complete brief per task, so it does not need follow-ups.
- Always pass `--check` with the project's checks: the command in its CLAUDE.md, else what it
  obviously uses (`npm test`, typecheck, `pytest`, `cargo test`, a build). ocd runs it itself after
  opencode finishes, sends failures back to the same session to fix (2 rounds by default), and reports
  PASS/FAIL with the real output plus a `git diff --stat`. That result is ocd's, not the model's
  claim, so do not re-run the checks separately. If a project has no checks, say so to the user.
- Run ocd with Bash `run_in_background` and wait for the completion notification. Do not `sleep`,
  poll the log, or `ls`/`grep` to watch progress. Independent tasks can run in parallel.
- Review: read the report, then `git diff` only the files that matter (logic, anything touching data,
  security, money, sync or deletion), not every file. Send corrections with `-s` in one batch.
- Exit codes: 0 ok, 2 check still failing after the fix rounds (look at the failure, then one `-s`
  follow-up or fix it), 1 error, 124 timeout.
- The user is very tech literate but does not write code: normal technical language is fine; don't
  ask them to write or edit code. Say what opencode did, what was verified, and what they should try
  themselves (things checks cannot cover, like how the app looks or behaves).
