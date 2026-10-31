# Proof board: node-graph proofs verified by Lean 4

The math gameplay's first activity. A story `proof` node opens a **proof board**:
the player builds a proof as a node graph from authored theorem cards and a small
set of reasoning nodes, and the host verifies it with Lean 4. The player never
sees or writes Lean.

Principles (from the original design discussion):

- Players operate a visual, constrained proof language; Lean is only the judge.
- No LLM. Freedom comes from wiring nodes, choosing card arguments, stating
  intermediate claims and witnesses in a small formula language.
- Automation fills mechanical steps (`omega`, `decide`, ...) only where a puzzle
  allows it, and only sees the facts the player wired into it.
- Lean correct and puzzle constraints satisfied are both required: puzzles
  whitelist cards, node kinds and tactics.

```text
ProofBoard (React, shared by game + editor preview)
   │ graph JSON                         ▲ ProofCheckResult
   ▼                                    │
host command proof_check / proof_submit (Rust)
   │ vectspace-proof: validate → formula AST → Lean source + span map
   ▼
vectproofd (Lean 4, persistent)  ── imports VectProof once, ~50 ms / check
   │ Lean JSON messages incl. [[vs]] records
   ▼
vectspace-proof: map records + errors back to nodes/ports → ProofCheckResult
```

## 1. Lean workspace (`lean/`)

| Path                          | Role                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `lean/lean-toolchain`         | pinned `leanprover/lean4:v4.35.0`                            |
| `lean/VectProof/Elab.lean`    | `vs_*%` term elaborators, `#vs_verdict`, `vs_only` tactic   |
| `lean/VectProofServer.lean`   | `vectproofd` line-protocol server                           |
| `lean/.lake/build/bin/`       | built `vectproofd.exe` (not committed)                       |
| `lean/.lake/build/lib/lean/`  | built `VectProof` oleans (`LEAN_PATH`)                       |

Build with `npm run lean:build` (runs `lake build` in `lean/`; needs elan). The
server links Lean's shared runtime, so `<sysroot>/bin` must be on `PATH`, and it
needs `LEAN_SYSROOT=<sysroot>` and `LEAN_PATH=lean/.lake/build/lib/lean`.

### Elaborators (contract between generated source and the checker)

| Syntax                     | Meaning                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `vs_proof% t`              | outermost; finishes elaboration, emits one `[[vs]]{"records":[...]}` info message |
| `vs_node% "KEY" t`         | record `{kind:"node", key, type, sorry}` (type of the value)            |
| `vs_port% "KEY" t`         | record `{kind:"port", key, type}` (expected type, may be null); on type mismatch record `{kind:"mismatch", key, expected, actual}` and continue with `sorry` |
| `vs_hole% "KEY"`           | record `{kind:"hole", key, type}`; elaborates to `sorry`                |
| `vs_local% "KEY" x t`      | record `{kind:"local", key, type}` for binder `x`, then elaborate `t`   |
| `vs_probe% [t₁, …] t`      | elaborate dangling `tᵢ` (feedback only, no expected type), then `t`     |
| `#vs_verdict Name`         | emit `[[vs]]{"verdict":"Name","axioms":[...]}`                          |
| `vs_only [f₀, …]` (tactic) | clear every proof in context except the listed facts                    |

`type`, `expected`, `actual` are Lean pretty-printed strings. Records are
de-duplicated per `(kind, key)`, last wins. Cascading mismatches whose sides
already contain error-recovery `sorry` are not recorded.

### Server protocol (`vectproofd`)

One JSON object per line on stdin/stdout:

```text
← {"ready":true,"lean":"4.35.0"}                       (after import, ~2 s)
→ {"id":7,"source":"<commands without import header>"}
← {"id":7,"messages":[<Lean message JSON>...],"elapsedMs":42}
← {"id":null,"error":"invalid json"}                    (malformed request)
```

A Lean message JSON has `severity` (`information`/`warning`/`error`), `pos` and
`endPos` (`{line, column}`: line 1-based, **column 0-based in Unicode code
points**), `kind` and `data` (text). Each request starts from the same imported
environment. The host enforces a wall-clock timeout by killing and restarting
the process; generated sources also set `maxHeartbeats`.

## 2. Content: cards and puzzles

`manifest.yaml` gains `proofs: [proofs/<file>.yaml, ...]`. Each proof document:

```yaml
cards:
  - id: and_intro               # [a-z][a-z0-9_]*, unique across all proof docs
    name: 合取引入               # display name
    description: 由 p 与 q 得到 p ∧ q   # optional, markup text
    params:                     # explicit, in order; the player may fill them
      - { name: p, type: Prop }
      - { name: q, type: Prop }
    premises: ["p", "q"]        # formulas over params; become input ports p0, p1
    conclusion: "p ∧ q"         # formula over params; the output port
    lean: "⟨p0, p1⟩"             # trusted Lean term proving the conclusion;
                                # params and premises p0, p1, … are in scope
puzzles:
  - id: and_comm                # [a-z][a-z0-9_]*, unique across all proof docs
    title: 合取交换
    description: 已知 $p \land q$，证明 $q \land p$。   # optional, markup text
    variables:                  # free names usable in every formula
      - { name: p, type: Prop }
      - { name: q, type: Prop }
    hypotheses:                 # become `given` nodes
      - { name: h, statement: "p ∧ q", label: 已知 }   # label optional
    goal: "q ∧ p"
    cards: [and_intro, and_left, and_right]
    nodes: [card, claim]        # allowed node kinds besides given/goal;
                                # default: all kinds except `auto`
    tactics: []                 # allowed auto recipes (§5); `auto` needs ≥1
    solution:                   # optional reference ProofGraph (§4), checked
      nodes: [...]              # by `npm run proofs:check`
      edges: [...]
```

Types (`type:` fields) use the formula language: `Prop`, `Nat`/`ℕ`, `Int`/`ℤ`,
arrows such as `Nat → Nat` or `Nat → Prop`. Card `lean:` is authored, trusted
Lean; it is the only Lean text that is not generated from an AST.

Content validation (load time, in Rust): ids, unique names, every formula parses
with its declared names in scope, card references exist, `nodes`/`tactics` are
known, `auto` allowed only with tactics, solution graph structurally valid.

## 3. Formula language

Used for content statements and for everything the player types (card
arguments, claims, witnesses). Parsed by Rust into an AST; Lean source and LaTeX
are both emitted from the AST, never from raw text.

- **Identifiers**: first char ASCII letter or Greek `α`–`ω` except `λ`; then ASCII
  letters/digits, `_`, `'`, subscript digits `₀`–`₉`; at most 32 chars. Reserved
  (rejected as names): Lean keywords (`fun by have show from let in at do if then
  else match with end sorry theorem def example open import namespace section
  variable universe axiom instance structure class where calc suffices obtain
  forall exists`), `Type Sort Prop Nat Int True False not`, and any name starting
  with `vs`/`VS`.
- **Strict mode** (player and content input): an identifier must be a declared
  name in scope (puzzle variables, card params, graph binders) or bound by a
  quantifier in the same formula. Anything else is an error, so no Lean
  construct can be injected.
- **Atoms**: identifiers, decimal numerals (≤ 18 digits), `True`, `False`, types
  `Prop Nat Int ℕ ℤ`, parentheses, type ascription `(e : T)`.
- **Operators**, loosest first (Lean precedences):

  | prec | operators (ASCII aliases)                                              | assoc |
  | ---- | ---------------------------------------------------------------------- | ----- |
  | —    | `∀ x y : T, P` `∃ x : T, P` (`forall`, `exists`); body extends right    | —     |
  | 20   | `↔` (`<->`)                                                             | none  |
  | 25   | `→` (`->`)                                                              | right |
  | 30   | `∨` (`\/`)                                                              | right |
  | 35   | `∧` (`/\`)                                                              | right |
  | 40   | prefix `¬` (`~`)                                                        | —     |
  | 50   | `=` `≠` (`!=`) `<` `>` `≤` (`<=`) `≥` (`>=`) `∣` (`\|`)                  | none  |
  | 65   | `+` `-`                                                                 | left  |
  | 70   | `*` `/` `%`                                                             | left  |
  | 75   | prefix `-`; `^` (right)                                                 |       |
  | max  | application `f x y` (only for function-typed names)                     | left  |

- **Lean emission**: canonical Unicode, fully parenthesized, `ℕ`→`Nat`, `ℤ`→`Int`,
  `!=`→`≠`.
- **LaTeX emission**: `\forall x\, y \in \mathbb{N},\ P`, `\exists`, `\neg`,
  `\land`, `\lor`, `\Rightarrow` (implication) / `\to` (in types),
  `\Leftrightarrow`, `\neq \le \ge \mid`, `\cdot` for `*`, `\bmod` for `%`,
  `{a}^{b}`, application `f(x, y)`, single-letter names as-is, longer names
  `\mathrm{…}`, `h₁`/`x1` → `h_{1}`/`x_{1}`, Greek → `\alpha`…, `Nat`→`\mathbb{N}`,
  `Int`→`\mathbb{Z}`, `True`→`\top`, `False`→`\bot`; minimal parentheses from
  precedence.
- **Display mode** (Lean pretty-printer output → LaTeX for showing node types and
  goals): lenient; also accepts unknown and dotted names (`Nat.succ`), binder
  groups `∀ (a b : Nat), …`, `↑x`, `?_`/`?m.12`/`sorry` (rendered `\square`).
  On failure the UI shows the Lean text in monospace.

## 4. Proof graph (wire format, Rust ↔ TypeScript)

```ts
interface ProofGraph { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] }

interface ProofGraphNode {
  id: string;              // ^[A-Za-z][A-Za-z0-9_-]{0,31}$, unique in the graph
  kind: ProofNodeKind;
  x: number; y: number;    // board coordinates, finite; UI only
  hypothesis?: string;     // given
  card?: string;           // card
  args?: string[];         // card: one formula per card param, "" = infer
  statement?: string;      // claim (required); intro/cases/exists_intro/exists_elim/induction/auto (optional)
  term?: string;           // inst, exists_intro (required)
  tactic?: string;         // auto (required)
  binders?: string[];      // intro (≥1 names), exists_elim ([var]), induction ([k])
}

interface ProofGraphEdge { from: string; from_port: string; to: string; to_port: string }
```

Absent optional fields serialize as absent (not `null`). Limits: ≤ 200 nodes, ≤
400 edges, formula text ≤ 200 chars.

### Node kinds and ports

`in` = input port (needs a proof), `out` = the node's value, `lᵢ` = local output
(binder) visible only inside the given scoped input.

| kind           | 中文       | fields                     | inputs                    | outputs (locals → scope)            | Lean (feedback form)                                        |
| -------------- | ---------- | -------------------------- | ------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `given`        | 已知       | `hypothesis`               | —                         | `out`                               | hypothesis binder                                            |
| `goal`         | 目标       | —                          | `in`                      | —                                   | root                                                         |
| `card`         | 定理卡     | `card`, `args`             | `p0…p(n-1)` (premises)    | `out`                               | `VS.card.ID a₀ … p₀ …` (`_` for empty args)                   |
| `mp`           | 推出       | —                          | `imp` (A → B), `arg` (A)  | `out`                               | `(imp) (arg)`                                                |
| `inst`         | 代入       | `term`                     | `all` (∀ x, P x)          | `out`                               | `(all) (term)`                                               |
| `intro`        | 引入       | `binders`, `statement?`    | `body`                    | `out`; `l0…` → `body`               | `fun b₀ b₁ => body`                                          |
| `cases`        | 分情况     | `statement?`               | `or`, `left`, `right`     | `out`; `l0` → `left`, `l1` → `right` | `Or.elim (or) (fun l => left) (fun r => right)`             |
| `exists_intro` | 构造       | `term`, `statement?`       | `proof`                   | `out`                               | `Exists.intro (term) (proof)`                                |
| `exists_elim`  | 取出       | `binders` ([x]), `statement?` | `exists`, `body`       | `out`; `l0` (x), `l1` (P x) → `body` | `Exists.elim (exists) (fun x h => body)`                    |
| `induction`    | 归纳       | `binders` ([k]), `statement?` | `base`, `step`         | `out`; `l0` (k), `l1` (ih) → `step`  | `fun k => by induction k with \| zero => exact base \| succ k ih => exact step` |
| `claim`        | 断言       | `statement`                | `in`                      | `out`                               | `show S from (in)`                                           |
| `auto`         | 推导       | `tactic`, `statement?`     | `facts` (multi, any count)| `out`                               | `by have f₀ := …; vs_only [f₀, …]; RECIPE`                   |

A `statement?` given on a node wraps it in `show S from …`; without it the node
takes its type from where it is connected, so nodes needing an expected type
(`intro`, `cases`, `exists_intro`, `exists_elim`, `induction`, `auto`) are only
checked once connected or stated.

Graph rules (Rust validates; the UI prevents what it can): exactly one `goal`;
`given.hypothesis` exists; edge endpoints and ports exist for the node; each
input port except `facts` has ≤ 1 edge; no cycles; node kind, card and tactic
allowed by the puzzle; `binders` are valid identifiers, unique across the graph,
not clashing with puzzle variables; a local may only feed nodes inside its
scope (reported per edge, compiled as a hole).

## 5. Compilation to Lean

Generated source (one request; one line per command, proof term on one line):

```lean
set_option autoImplicit false
set_option Elab.async false
set_option maxHeartbeats 200000
set_option pp.fieldNotation false
set_option pp.mvars false
namespace VS
theorem card.and_intro (p : Prop) (q : Prop) (p0 : p) (p1 : q) : (p ∧ q) := ⟨p0, p1⟩
end VS
theorem VS.puzzle (p : Prop) (q : Prop) (vsH0 : (p ∧ q)) : (q ∧ p) := vs_proof% (vs_probe% [ … ] (vs_port% "goal/in" ( … )))
#vs_verdict VS.puzzle
```

- Only the cards the puzzle allows are emitted. Card binders are params then
  `p0…`; the card's `lean` term follows `:=`.
- Hypotheses are binders `vsH0…`; `given` emits `vsH<i>`.
- Keys: node `ID`, input port `ID/PORT`, local `ID/lI`, goal port `goal/in`.
- Each connected input port emits `(vs_port% "ID/PORT" (child))` (except
  `facts`); an unconnected one `(vs_port% "ID/PORT" (vs_hole% "ID/PORT"))`.
  A child node emits `(vs_node% "ID" (…))`; a child local emits its binder name.
- Player binder names are emitted as typed (validated). Internal binders are
  `vsL<n>_<i>` (`n` = node index); `cases` binders and the `exists_elim` /
  `induction` hypothesis binder are internal.
- Shared nodes (several consumers) are emitted at each use; records dedupe.
- **Feedback mode** (`proof_check`): dangling roots (nodes with no consumer,
  other than `given`) go into a `vs_probe%`: top-level ones at the root, ones
  using a local inside that local's scope. Nodes that need an expected type and
  have no `statement` are skipped and reported `not_connected`.
- **Verify mode** (`proof_submit`, `proofs:check`): no probes.
- Every player formula emits as `(…)` from the AST; a field that failed to parse
  makes its node emit `(vs_hole% "ID")` and reports the syntax error.

### Auto recipes

`auto` emits `(by have f0 := (T₀); have f1 := (T₁); vs_only [f0, f1]; RECIPE)`:

| id        | 中文名     | RECIPE                         |
| --------- | ---------- | ------------------------------ |
| `omega`   | 线性算术   | `omega`                         |
| `decide`  | 判定       | `decide`                        |
| `rfl`     | 按定义相等 | `rfl`                           |
| `simp`    | 化简       | `simp_all`                      |
| `exact`   | 由已知     | `assumption`                    |
| `contradiction` | 矛盾 | `contradiction`                 |

### Span map and message mapping

The generator records `(start, end)` positions (line, code-point column) for
every node wrapper, port wrapper, player formula (`ID/args.i`, `ID/statement`,
`ID/term`), auto recipe (`ID/tactic`) and local reference (edge). A Lean error
maps to the innermost span containing `[pos, endPos]`; unmatched errors are
general diagnostics. Warnings of kind `hasSorry` are ignored.

## 6. Check result (wire format)

```ts
interface ProofFormula { text: string; latex: string | null }

interface ProofCheckResult {
  status: 'complete' | 'incomplete' | 'unavailable';
  nodes: Record<string, { type?: ProofFormula; sorry?: boolean }>;
  ports: Record<string, {                 // key "ID/PORT"
    expected?: ProofFormula;              // what the port needs (Lean)
    open?: boolean;                       // unconnected hole
    mismatch?: { expected: ProofFormula; actual: ProofFormula };
  }>;
  locals: Record<string, { type?: ProofFormula }>;    // key "ID/lI"
  fields: Record<string, { latex?: string; error?: string }>;  // key "ID/statement" …
  diagnostics: ProofDiagnostic[];
  elapsed_ms: number;
}

interface ProofDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;      // see below
  message: string;   // Chinese, for the player
  detail?: string;   // raw Lean text, shown collapsed
  node?: string; port?: string; field?: string; edge?: number;  // target
}
```

`complete` ⇔ the puzzle theorem's verdict axioms ⊆ `{propext, Classical.choice,
Quot.sound}` and no error targets the goal-reachable part (feedback mode) / no
error at all (verify mode). `unavailable` ⇔ Lean could not run; structural and
formula feedback is still filled.

Diagnostic codes: `graph` (structural), `syntax` (formula), `scope`
(local outside scope / unknown name), `not_connected`, `open_port`, `mismatch`,
`unknown_name`, `tactic_failed`, `lean` (other Lean error), `unavailable`,
`timeout`. Messages are Chinese summaries (e.g. 类型不匹配：需要 …，得到 …;
自动推导失败：所连接的事实不足以得到目标; 这里需要一个蕴含或全称命题).

`ProofBoardSpec` (opening a board):

```ts
interface ProofBoardSpec {
  puzzle: { id: string; title: string; description: string | null;
            variables: { name: string; type: ProofFormula }[];
            hypotheses: { name: string; label: string | null; statement: ProofFormula }[];
            goal: ProofFormula };
  cards: { id: string; name: string; description: string | null;
           params: { name: string; type: ProofFormula }[];
           premises: ProofFormula[]; conclusion: ProofFormula }[];
  node_kinds: ProofNodeKind[];         // allowed besides given/goal
  tactics: { id: string; name: string }[];
  initial_graph: ProofGraph;           // given nodes + goal, laid out
}
```

## 7. Story integration

Scene node (scene `nodes` map entry):

```yaml
lab_and_comm:
  type: proof
  puzzle: and_comm
  next: after_and_comm
  abandon: gave_up          # optional; absent = the player cannot give up
```

All wire and content field names are snake_case, like the rest of the IPC.

- Runtime stops with prompt `{ kind: "proof", prompt_id, puzzle, draft, can_abandon }`;
  `draft` is the last synced `ProofGraph` (or null) and is saved with the
  snapshot, so save/load mid-puzzle restores the board.
- Core API: `update_proof_draft(graph)` (no revision bump, no cues),
  `complete_proof(expected_revision)` → `next`, `abandon_proof(expected_revision)`
  → `abandon`. Completing records the puzzle id in profile progression
  (`solved_proofs`), for later "proven theorems become cards".
- Host commands (game): `proof_board(puzzle)`, `proof_check(graph)`,
  `proof_save_draft(prompt_id, graph)` (rejected unless that proof prompt is
  still current), `proof_submit(expected_revision, graph)` (verify mode;
  commits through the normal runtime transaction only when complete),
  `proof_abandon(expected_revision)`. The Lean server starts lazily on
  `proof_board` and is shared by checks; one request at a time.
- Lean discovery (dev): sysroot from `VECTSPACE_LEAN_SYSROOT`, else
  `~/.elan/toolchains/<lean-toolchain with / → -- and : → --->`; server from
  `VECTSPACE_PROOF_SERVER`, else `lean/.lake/build/bin/vectproofd(.exe)`;
  `LEAN_PATH` = `lean/.lake/build/lib/lean`. Release packaging of Lean is not
  done yet.

## 8. Not in v1

Bundling Lean into the installer, Mathlib, puzzle-defined functions/constants,
player-proven theorems as cards, proof prompts in secondary windows, an editor
puzzle-authoring workspace.
