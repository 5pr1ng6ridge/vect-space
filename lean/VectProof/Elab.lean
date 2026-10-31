import Lean

/-!
# Proof-board elaboration hooks

The game compiles a player's proof graph into one Lean term. Every graph
element is wrapped in one of the term elaborators below so that, after
elaboration, the checker can report back per graph element:

* `vs_node% "n3" t`   — the type of node `n3`'s value,
* `vs_port% "n3/p0" t` — the type input port `n3/p0` expects; when the
  connected value does not fit, a structured mismatch instead of a Lean error,
* `vs_hole% "n3/p1"`   — an unconnected input port: its goal, closed by `sorry`,
* `vs_local% "n6/l0" x t` — the type of a binder a node introduces.

`vs_proof%` wraps the whole term, finishes elaboration (including tactic
blocks) and emits all records as one info message prefixed with `[[vs]]`.
`#vs_verdict` reports the axioms a finished theorem depends on, so the host can
tell a complete proof from one that still contains `sorry`.

Player input never reaches Lean as text: the host emits every term from a
validated AST. These hooks only observe elaboration; they never add axioms.
-/

open Lean Elab Term Meta

namespace VectProof

def marker : String := "[[vs]]"

inductive RecKind where
  | node | port | hole | binder | mismatch
  deriving Inhabited, BEq

def RecKind.name : RecKind → String
  | .node => "node"
  | .port => "port"
  | .hole => "hole"
  | .binder => "local"
  | .mismatch => "mismatch"

structure Rec where
  kind : RecKind
  key : String
  value? : Option Expr := none
  expected? : Option Expr := none
  actual? : Option Expr := none
  lctx : LocalContext
  insts : LocalInstances
  deriving Inhabited

initialize recsRef : IO.Ref (Array Rec) ← IO.mkRef #[]

private def push (kind : RecKind) (key : String) (value? expected? actual? : Option Expr := none) :
    TermElabM Unit := do
  let r : Rec := { kind, key, value?, expected?, actual?, lctx := ← getLCtx, insts := ← getLocalInstances }
  recsRef.modify (·.push r)

/-- Elaborates with error recovery even inside tactic blocks, so one broken
node does not hide feedback for its siblings. -/
private def recovering (x : TermElabM α) : TermElabM α :=
  withReader (fun ctx => { ctx with errToSorry := true }) x

private def keyOf (stx : Syntax) : String :=
  stx.isStrLit?.getD ""

syntax (name := vsProof) "vs_proof% " term : term
syntax (name := vsNode) "vs_node% " str term : term
syntax (name := vsPort) "vs_port% " str term : term
syntax (name := vsHole) "vs_hole% " str : term
syntax (name := vsLocal) "vs_local% " str ident term : term
syntax (name := vsProbe) "vs_probe% " "[" term,* "]" term : term

@[term_elab vsNode] def elabNode : TermElab := fun stx expected? => do
  let e ← recovering <| elabTerm stx[2] expected?
  push .node (keyOf stx[1]) (value? := e)
  return e

@[term_elab vsPort] def elabPort : TermElab := fun stx expected? => do
  let key := keyOf stx[1]
  push .port key (expected? := expected?)
  let e ← recovering <| elabTerm stx[2] expected?
  let some expected := expected? | return e
  let actual ← inferType e
  if ← isDefEq actual expected then
    return e
  -- A side already carrying error-recovery `sorry` was reported where it broke.
  unless (← instantiateMVars expected).hasSyntheticSorry || (← instantiateMVars actual).hasSyntheticSorry do
    push .mismatch key (expected? := expected) (actual? := actual)
  mkLabeledSorry expected (synthetic := true) (unique := true)

@[term_elab vsHole] def elabHole : TermElab := fun stx expected? => do
  let type ← match expected? with
    | some t => pure t
    | none => mkFreshTypeMVar
  push .hole (keyOf stx[1]) (expected? := type)
  mkLabeledSorry type (synthetic := true) (unique := true)

@[term_elab vsLocal] def elabLocal : TermElab := fun stx expected? => do
  if let some d := (← getLCtx).findFromUserName? stx[2].getId then
    push .binder (keyOf stx[1]) (value? := d.toExpr)
  elabTerm stx[3] expected?

@[term_elab vsProbe] def elabProbe : TermElab := fun stx expected? => do
  for t in stx[2].getSepArgs do
    discard <| recovering <| elabTerm t none
  elabTerm stx[4] expected?

private def pp (e : Expr) : MetaM Json := do
  let e := (← instantiateMVars e).headBeta
  return Json.str (toString (← ppExpr e))

private def ppOpt : Option Expr → MetaM Json
  | some e => pp e
  | none => pure Json.null

private def recJson (r : Rec) : MetaM Json :=
  withLCtx r.lctx r.insts do
    let mut fields : List (String × Json) := [("kind", r.kind.name), ("key", r.key)]
    match r.kind with
    | .node | .binder =>
      if let some v := r.value? then
        let v ← instantiateMVars v
        fields := fields ++ [("type", ← pp (← inferType v)), ("sorry", v.hasSorry)]
    | .port | .hole =>
      fields := fields ++ [("type", ← ppOpt r.expected?)]
    | .mismatch =>
      fields := fields ++ [("expected", ← ppOpt r.expected?), ("actual", ← ppOpt r.actual?)]
    return Json.mkObj fields

/-- Keeps the last record per `(kind, key)`; elaborators can run more than
once when elaboration is postponed. -/
private def dedup (recs : Array Rec) : Array Rec := Id.run do
  let mut seen : Std.HashSet String := {}
  let mut out : Array Rec := #[]
  for r in recs.reverse do
    let k := r.kind.name ++ ":" ++ r.key
    unless seen.contains k do
      seen := seen.insert k
      out := out.push r
  return out.reverse

@[term_elab vsProof] def elabProof : TermElab := fun stx expected? => do
  recsRef.set #[]
  let e ← elabTermEnsuringType stx[1] expected?
  synthesizeSyntheticMVarsNoPostponing
  -- Placeholders left open only next to a hole or a reported error; close them
  -- so Lean does not add a second, less useful error for the same spot.
  for m in ← getMVars e do
    unless ← m.isAssigned do
      m.assign (← mkLabeledSorry (← m.getType) (synthetic := true) (unique := true))
  let recs ← dedup <$> recsRef.get
  recsRef.set #[]
  let mut items : Array Json := #[]
  for r in recs do
    items := items.push (← recJson r)
  logInfo m!"{marker}{(Json.mkObj [("records", Json.arr items)]).compress}"
  return e

syntax (name := vsVerdict) "#vs_verdict " ident : command

@[command_elab vsVerdict] def elabVerdict : Command.CommandElab := fun stx => do
  let name ← Command.liftCoreM <| realizeGlobalConstNoOverloadWithInfo stx[1]
  let axioms ← Command.liftCoreM <| collectAxioms name
  let json := Json.mkObj [
    ("verdict", toString name),
    ("axioms", Json.arr (axioms.map fun a => Json.str (toString a)))]
  logInfo m!"{marker}{json.compress}"

/-- `vs_only [f₀, f₁]` clears every proof in context except the listed facts,
so automation only sees what the player connected. Data variables stay. -/
syntax (name := vsOnly) "vs_only " "[" ident,* "]" : tactic

open Tactic in
@[tactic vsOnly] def evalOnly : Tactic := fun stx => do
  withMainContext do
    let keep ← stx[2].getSepArgs.mapM getFVarId
    let mut drop : Array FVarId := #[]
    for d in (← getLCtx) do
      if d.isImplementationDetail || keep.contains d.fvarId then continue
      if ← isProp d.type then drop := drop.push d.fvarId
    let g ← (← getMainGoal).tryClearMany drop
    replaceMainGoal [g]

end VectProof
