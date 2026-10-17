---
name: board
description: Convene a board of frontier models from different labs that work a hard problem independently, cross-examine each other, and hand back a decision memo — instead of asking the user. Use for deep design/strategy decisions, "what should we do about X", ideation, root-cause puzzles, or when the user says "advisory board", "ask the board", "dueling models", "let the models discuss".
---

# Board

Models from different labs have different blind spots; their disagreement is
information. Two roles, neither has opinions on the merits:

- **Convener** — the session the user asked (you, unless you were started as
  chair). Does §1, hands off to a chair, then §6. It holds the user's context;
  everything in between is mechanical.
- **Chair** — a side agent that runs §2–§5 (seats, rounds, memo), applying
  the rules mechanically and reporting what survived.

## 1. Convene (decide alone, don't ask)

Write a short charter to `BOARD/charter.md`:

- **Question** — one sentence, plus what decision/action it feeds.
- **Shape** — pick one:
  - *ideas* ("what could we do?") — 5–7 proposals per seat
  - *decide* ("A or B or…?") — 3–5 options, always incl. do-nothing/baseline
  - *diagnose* ("why does X happen?") — 3–5 hypotheses (need not be exclusive,
    incl. "the framing is wrong"), each with a discriminating test
  - *estimate* ("how much / how likely?") — one number per seat, with an
    interval, its assumptions, and what it's most sensitive to
- **Seats** — the roster below, unless the user names seats. Roster entries
  are modes from `~/.pi/agent/modes.json`; pass each to `agent-start` as
  `model: "<provider>/<modelId>:<thinkingLevel>"`. Seat name = short model
  name (fable, astra, …), not the mode name (mode names imply rank).

  **Current roster:** `best` (Fable), `deep` (GPT Astra), `oracle` (Gemini
  Argon).

  Roster principle (for when the user asks to revise it): one seat per
  frontier lab with genuinely different training. Never two seats from the
  same lab (e.g. not Opus next to Fable), and no seat whose model is strictly
  dominated by the others: a weaker extra seat adds noise, not perspective.
- **Context** — seats can't see your conversation. Write `BOARD/context.md`:
  the relevant facts and user preferences from the conversation, and absolute
  paths into the main checkout for everything they must read (their worktrees
  contain only committed HEAD — no uncommitted files, empty submodules).

Only ask the user if the question itself is ambiguous enough that seats would
answer different questions. Otherwise go: start the chair with `agent-start`
(no `model` — it runs your mode; `branchHint` `board-chair-<word>`) and the
description "You are the chair of the board in `<BOARD>`: read
`~/.pi/agent/skills/board/SKILL.md` and run §2–§5. Don't ask the user
anything; stop when `memo.md` is written." Then end your turn — don't block
on it; you'll be notified when the chair goes idle.

## 2. Mechanics (chair)

- `BOARD=~/.pi/boards/<YYYYMMDD>-<slug>/` — absolute, outside any worktree;
  add a suffix if it already exists.
- Seats are side agents: `agent-start` with `model` set and `branchHint`
  `board-<seat>-<word>` (ids are truncated to 3 words — keep the seat name in
  them). Kickoff = seat rules below + charter path + phase 1.
- Each round: write instructions to `BOARD/prompts/<NN>-<seat>.md`, then
  `agent-send` a one-liner pointing at it (`agent-send` marks the seat
  `running` immediately).
- Barrier: `agent-wait-any` until every seat is `waiting_user` (a file that
  exists may still be rewritten — idle status is the signal), then check its
  output file. Missing → one nudge. `failed`/`crashed` → continue with ≥2
  seats and say so in the memo.
- Read seats' Position blocks by default; open full posts only where a crux
  needs it.
- End: `agent-send` `/quit` to each seat (nothing to merge) once the memo is
  written.
- Subagents are not a proper substitute for side agents (chair or seats):
  they're one-shot, so a seat can't carry its own reasoning across rounds.

Seat rules (include in every kickoff):

> You are seat `<seat>` on an advisory board of models from different labs.
> Discussion only: never commit, merge, or edit the project (project
> AGENTS.md rules about committing don't apply to you) — except throwaway
> experiments in your own worktree when a phase asks for evidence. Read
> project files via the absolute paths in `BOARD/context.md`. Write only the
> file you are told to, under `BOARD`. Do not read other seats' files until a
> phase gives you their paths, and never read the parent Pi session. Be
> specific and concrete; keep round posts short, roughly 700 words — a guide,
> not a limit to trim to (everyone re-reads them every round; phase-1 items
> aren't capped). Never concede just because
> others disagree — only to a named argument or evidence. When done with a
> phase, stop and wait.

## 3. Phases

**Phase 1 — Independent work** (blind) → `BOARD/items/<seat>.md`
Study the context, produce items per shape, ids `<seat>-<n>`. In *ideas* and
*decide*, at least two must be ones you expect the other seats *won't* come
up with. Each item: what, why, and how it could fail.

**Phase 2 — Discussion**, in rounds → `BOARD/rounds/<NN>-<seat>.md`
Lockstep: every seat posts round N before anyone sees round N (no anchoring
on whoever speaks first). Each round, a seat reads the items and earlier
rounds (from round 3: the previous round in full, older ones via their
Position blocks), then writes:

- **Round 1 — cross-examination:** for every other seat's item, give a
  **fatal flaw** only if you have a specific, checkable one, and rate
  **upside** if it works, **probability** it works, **cost** (1–10 each; a
  scaffold to force commitment, never aggregated). *estimate:* say which
  assumptions you reject and give your revised number instead. *diagnose:*
  rate the tests, and run any cheap one (< 10 min, no installs, own
  worktree) before round 2.
- **Later rounds — debate:** answer objections aimed at you — refute, patch a
  narrow defect in place, or concede naming the flaw. If addressing an
  objection would cut the item's upside or scope or blend in another seat's
  approach, **fork** it as a new `<seat>-<n>`; the original stays alive.
  Press your objections that went unanswered; address seats by name; propose
  new items the discussion revealed; check cheaply checkable cruxes and post
  the result. **If you don't champion the most-championed item, try to kill
  it** by testing its decisive premise.
- **Every round ends with a Position block:** your **champion** (one item,
  any seat's, plus its **drop-condition** — the finding that would make you
  abandon it), ≤ 2 compatible **co-picks**, items you consider dead (with the
  flaw), open cruxes. Switching champion requires a named reason. In the
  last round, add a ≤ 80-word pitch for your champion and its strongest
  objection.

Between rounds you moderate — steer attention, never take positions. After
round 1, map obvious duplicates to one id (authors may object). Note in the
next prompt e.g. "X and Y talk past each other on <crux>", "<item> hasn't
been examined", "<seat>'s objection to <item> is still unanswered" (ask once).

Run at least 2 rounds, at most 5. Stop when no Position block changed and no
new evidence was posted; if a seat named a feasible check, run one more round
for it.

## 4. Synthesis rules (apply mechanically)

1. **Independence first** — never let seats see each other before phase 2,
   nor the current round before it closes.
2. **Conviction beats consensus** — every final champion and co-pick is a
   finalist; no endorsement counts, no averaged scores. A big spread between
   seats marks a crux, not a weak item.
3. **Ideas die only by a fatal flaw**: the author conceded, or a posted check
   or counterexample (a logical one counts) went unrefuted after one response
   round. Never by majority or silence. For an unresolved objection against a
   finalist, the third seat rules `sustained`/`refuted` in one sentence; the
   finalist stays, tagged `[Disputed: <flaw>]` (or `[Unanswered: <flaw>]`).
4. **Premise audit** — a non-author must have inspected each finalist's
   decisive premise (source, check, or run) and stated what that does and
   doesn't establish. Otherwise tag it `[Conditional on <premise>]`. Ask for
   the missing audits in the last round.
5. **Fork, don't blend** — compatible finalists form a slate; rival ones are
   presented side by side with the seats' own "if X → A, if Y → B" conditions.
   Never merge them into a compromise.

## 5. Memo → `BOARD/memo.md` (chair), then stop

- **Bottom line** — the finalists (slate and/or forks): who championed each,
  the seat's verbatim pitch, its downside, its tags. No "safe pick" labels —
  likely-to-work is not the same as safe.
- **Cruxes for the user** — only questions of preference/values the board
  can't settle: "if you value X → A; if Y → B". Factual cruxes are not for
  the user; say how they were (or can cheaply be) checked.
- **Killed** — item, the fatal flaw, who raised it (one line each).
- **Dissent** — the strongest unresolved objection, in its author's words.
- **Next step** — the cheapest experiment, usually a champion's
  drop-condition.

## 6. Deliver (convener)

When notified that the chair is idle: read `memo.md` (not the rounds),
spot-check the decisive factual claims of the finalists yourself, summarize
the memo to the user, then `agent-send` `/quit` to the chair.
