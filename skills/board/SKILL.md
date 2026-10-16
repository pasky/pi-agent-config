---
name: board
description: Convene a board of frontier models from different labs that work a hard problem independently, cross-examine each other, and hand back a decision memo — instead of asking the user. Use for deep design/strategy decisions, "what should we do about X", ideation, root-cause puzzles, or when the user says "advisory board", "ask the board", "dueling models", "let the models discuss".
---

# Board

Models from different labs have different blind spots; their disagreement is
information. You (the orchestrator) run the board: pick everything yourself,
run the phases, apply the rules mechanically, deliver a memo. Do not have
opinions on the merits — report what survived.

## 1. Convene (decide alone, don't ask)

Write a short charter to `BOARD/charter.md`:

- **Question** — one sentence, plus what decision/action it feeds.
- **Shape** — pick one:
  - *ideas* ("what could we do?") — items are proposals
  - *decide* ("A or B or…?") — items are options, incl. ones nobody asked about
  - *diagnose* ("why does X happen?") — items are hypotheses, always incl. "the framing is wrong"; plus discriminating experiments
  - *estimate* ("how much / how likely?") — items are numbers with reasoning
- **Seats** — the roster below, unless the user names seats. Roster entries
  are modes from `~/.pi/agent/modes.json`; pass each to `agent-start` as
  `model: "<provider>/<modelId>:<thinkingLevel>"`, seat name = mode name.

  **Current roster:** `best` (Fable), `deep` (GPT Astra), `oracle` (Gemini
  Argon).

  Roster principle (for when the user asks to revise it): one seat per
  frontier lab with genuinely different training. Never two seats from the
  same lab (e.g. not Opus next to Fable), and no seat whose model is strictly
  dominated by the others: a weaker extra seat adds noise, not perspective.
- **Context** — files/paths/facts every seat must read first.

Only ask the user if the question itself is ambiguous enough that seats would
answer different questions. Otherwise go.

## 2. Mechanics

- `BOARD=~/.pi/boards/<YYYYMMDD>-<slug>/` — absolute path, outside any worktree.
- Seats are side agents: `agent-start` with `model` set, `branchHint`
  `board-<slug>-<seat>`. Kickoff = charter + the seat rules below + phase 1.
- Barrier: call `agent-wait-any` on the not-yet-done seats until every seat
  is `waiting_user` and its file for the current phase/round exists. Never
  start the next round early.
- Next phase: `agent-send` to each seat with the file paths it may now read.
- End: `agent-send` `/quit` to each seat (nothing to merge).
- If side agents are unavailable (no tmux/git), run each phase per seat via
  the `subagent` tool, passing the seat its own earlier files.

Seat rules (include in every kickoff):

> You are seat `<seat>` on an advisory board of models from different labs.
> Discussion only: never commit, merge, or edit the project — except
> throwaway experiments in your own worktree when a phase asks for evidence.
> Write only to the file you are told to, under `BOARD`. Do not read other
> seats' files until a phase gives you their paths. Be specific and
> concrete; no hedging boilerplate. Never concede just because others
> disagree — only to a named argument or evidence. When done with a phase,
> stop and wait.

## 3. Phases

**Phase 1 — Independent work** (blind) → `BOARD/items/<seat>.md`
Study the context, produce 5–10 numbered items (per shape), ids `<seat>-<n>`.
At least two must be ones you expect the other seats *won't* come up with.
Each item: what, why, and how it could fail.

**Phase 2 — Discussion**, in rounds → `BOARD/rounds/<NN>-<seat>.md`
Lockstep: every seat posts round N before anyone sees round N (no anchoring
on whoever speaks first). Each round, a seat reads all items and all earlier
rounds, then writes:

- **Round 1 only — cross-examination:** for every other seat's item rate
  **upside** if it works, **probability** it works, **cost** (1–10 each), and
  give a **fatal flaw** only if you have a specific, checkable one.
- **Later rounds — debate:** answer objections aimed at you (refute, revise
  the item, or concede with the named argument); press your objections that
  went unanswered; address other seats by name; propose new items the
  discussion revealed (`<seat>-<n>`, they join the pool); when a disputed
  crux is cheaply checkable (code, benchmark, search, calculation), check it
  and post the result.
- **Every round ends with a Position block:** your **champion** (one item,
  any seat's, that you'd bet on, and why), items you consider dead (with the
  flaw), and the open cruxes as you see them.

Between rounds you moderate — steer attention, never take positions. Read the
round, then send the next one with an optional short moderator note, e.g.
"X and Y talk past each other on <crux> — settle what evidence would decide
it", "<item> hasn't been examined by anyone", "<seat>'s objection to <item>
is still unanswered".

Keep going while rounds produce movement: a new argument, new item, new
evidence, a changed position or champion. Stop after a round with no
movement, when the remaining disagreements are purely about values, or at
round 8.

## 4. Synthesis rules (apply mechanically)

1. **Independence first** — never let seats see each other before phase 2,
   nor the current round before it closes.
2. **Conviction beats consensus** — any champion reaches the finals. Rank by
   upside (then probability), never by averaged score. A big spread between
   seats marks a crux, not a weak item.
3. **Ideas die only by a fatal flaw** that survived the discussion (or was
   conceded with a named argument). Low enthusiasm kills nothing.
4. **Fork, don't blend** — never merge a bold item and a safe one into a
   compromise that loses the bold one's core. Present them side by side.

## 5. Memo → `BOARD/memo.md`, then summarize it to the user

- **Bottom line** — the safe pick and the boldest survivor (if different),
  one paragraph each, with who championed them.
- **Cruxes for the user** — only questions of preference/values the board
  can't settle: "if you value X → A; if Y → B". Factual cruxes are not for
  the user; say how they were (or can cheaply be) checked.
- **Killed** — item, the fatal flaw, who raised it (one line each).
- **Dissent** — the strongest unresolved objection, in its author's words.
- **Next step** — if the bold option is cheap to try, the experiment.
