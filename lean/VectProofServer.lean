import Lean
import VectProof

/-!
# `vectproofd`

Line protocol on stdin/stdout, one JSON object per line:

* on start, after importing `VectProof`: `{"ready":true,"lean":"<version>"}`
* request:  `{"id":7,"source":"<commands, no import header>"}`
* response: `{"id":7,"messages":[<Lean JSON message>...],"elapsedMs":42}`
* a malformed request: `{"id":null,"error":"..."}`

Each request elaborates against a fresh copy of the imported environment, so
requests never see each other's declarations. The host enforces timeouts by
killing the process; `maxHeartbeats` in the generated source bounds work.
Search paths come from `LEAN_SYSROOT` / `LEAN_PATH` like the `lean` binary.
-/

open Lean

def respond (j : Json) : IO Unit := do
  let out ← IO.getStdout
  out.putStrLn j.compress
  out.flush

def handle (env : Environment) (line : String) : IO Json := do
  let .ok req := Json.parse line | return Json.mkObj [("id", Json.null), ("error", "invalid json")]
  let id := (req.getObjVal? "id").toOption.getD Json.null
  let .ok source := req.getObjValAs? String "source"
    | return Json.mkObj [("id", id), ("error", "missing source")]
  let start ← IO.monoMsNow
  let (_, msgs) ← Elab.process source env {} (fileName := "<proof>")
  let jsons ← msgs.toList.mapM (·.toJson)
  let elapsed := (← IO.monoMsNow) - start
  return Json.mkObj [("id", id), ("messages", Json.arr jsons.toArray), ("elapsedMs", elapsed)]

partial def loop (env : Environment) : IO Unit := do
  let stdin ← IO.getStdin
  let line ← stdin.getLine
  if line.isEmpty then return
  let line := line.trimAscii.toString
  unless line.isEmpty do
    respond (← handle env line)
  loop env

unsafe def main : IO Unit := do
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let env ← importModules #[{ module := `VectProof }] {} (loadExts := true)
  respond (Json.mkObj [("ready", true), ("lean", Lean.versionString)])
  loop env
