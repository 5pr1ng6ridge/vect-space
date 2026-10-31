//! Lean JSON records and error attribution.
use crate::{
    check::CheckMode,
    compile::{CompiledProof, Position},
    feedback::*,
    formula, validation,
};
use serde_json::Value;
fn displayed(text: &str) -> ProofFormula {
    ProofFormula {
        text: text.into(),
        latex: formula::display_latex(text),
    }
}
fn position(v: &Value) -> Option<Position> {
    Some(Position {
        line: v["line"].as_u64()? as usize,
        column: v["column"].as_u64()? as usize,
    })
}
fn apply_record(result: &mut ProofCheckResult, r: &Value) {
    let Some(key) = r["key"].as_str() else { return };
    let ty = r["type"].as_str().map(displayed);
    let (node, port) = key.split_once('/').unwrap_or((key, ""));
    match r["kind"].as_str().unwrap_or_default() {
        "node" => {
            result.nodes.insert(
                key.into(),
                NodeFeedback {
                    r#type: ty,
                    sorry: r["sorry"].as_bool().unwrap_or(false),
                },
            );
        }
        "local" => {
            result
                .locals
                .insert(key.into(), LocalFeedback { r#type: ty });
        }
        "port" => {
            result.ports.entry(key.into()).or_default().expected = ty;
        }
        "hole" => {
            if !port.is_empty() {
                let p = result.ports.entry(key.into()).or_default();
                p.open = true;
                if ty.is_some() {
                    p.expected = ty;
                }
            }
            let mut d = validation::diagnostic("open_port", "这里还需要一个证明", Some(node));
            if !port.is_empty() {
                d.port = Some(port.into());
            }
            result.diagnostics.push(d);
        }
        "mismatch" => {
            if let (Some(expected), Some(actual)) = (r["expected"].as_str(), r["actual"].as_str()) {
                result.ports.entry(key.into()).or_default().mismatch = Some(PortMismatch {
                    expected: displayed(expected),
                    actual: displayed(actual),
                });
                let mut d = validation::diagnostic(
                    "mismatch",
                    format!("类型不匹配：需要 {expected}，得到 {actual}"),
                    Some(node),
                );
                d.port = Some(port.into());
                d.detail = Some(format!("expected: {expected}\nactual: {actual}"));
                result.diagnostics.push(d);
            }
        }
        _ => {}
    }
}
pub(crate) fn map_output(
    mut compiled: CompiledProof,
    response: &Value,
    mode: CheckMode,
) -> ProofCheckResult {
    let mut verdict = false;
    for m in response["messages"].as_array().into_iter().flatten() {
        let data = m["data"].as_str().unwrap_or_default();
        if let Some(start) = data.find("[[vs]]") {
            if let Ok(payload) = serde_json::from_str::<Value>(&data[start + 6..]) {
                if let Some(records) = payload["records"].as_array() {
                    // Last record wins for each kind/key, even with captured duplicate payloads.
                    let mut dedup = std::collections::BTreeMap::new();
                    for r in records {
                        dedup.insert((r["kind"].to_string(), r["key"].to_string()), r);
                    }
                    for r in dedup.values() {
                        apply_record(&mut compiled.result, r);
                    }
                }
                if payload["verdict"] == "VS.puzzle" {
                    verdict = payload["axioms"].as_array().is_some_and(|a| {
                        a.iter().all(|x| {
                            matches!(
                                x.as_str(),
                                Some("propext" | "Classical.choice" | "Quot.sound")
                            )
                        })
                    });
                }
                continue;
            }
        }
        if m["kind"].as_str().is_some_and(|k| k.contains("hasSorry")) {
            continue;
        }
        if m["severity"] != "error" {
            continue;
        }
        let target = position(&m["pos"])
            .and_then(|a| compiled.target(a, position(&m["endPos"]).unwrap_or(a)))
            .cloned()
            .unwrap_or_default();
        let (code, message) = if data.contains("Unknown identifier")
            || data.contains("Unknown constant")
            || data.contains("unknown identifier")
        {
            ("unknown_name", "无法识别此名称")
        } else if target.field.as_deref() == Some("tactic")
            || data.contains("omega")
            || data.contains("unsolved goals")
            || data.contains("Tactic")
            || data.contains("tactic")
        {
            ("tactic_failed", "自动推导失败：所连接的事实不足以得到目标")
        } else if data.contains("function expected") || data.contains("Function expected") {
            ("lean", "这里需要一个蕴含或全称命题")
        } else {
            ("lean", "此证明步骤无法通过检查")
        };
        let mut d = validation::diagnostic(code, message, target.node.as_deref());
        d.port = target.port;
        d.field = target.field;
        d.edge = target.edge;
        d.detail = Some(data.into());
        compiled.result.diagnostics.push(d);
    }
    let error = compiled.result.diagnostics.iter().any(|d| {
        d.severity == DiagnosticSeverity::Error
            && (mode == CheckMode::Verify
                || d.node
                    .as_ref()
                    .is_none_or(|n| compiled.reachable.contains(n)))
    });
    compiled.result.status = if verdict && !error {
        ProofStatus::Complete
    } else {
        ProofStatus::Incomplete
    };
    compiled.result.elapsed_ms = response["elapsedMs"].as_u64().unwrap_or(0);
    compiled.result
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn raw_errors_use_innermost_target_and_verdict_rejects_sorry() {
        use crate::compile::{SourceSpan, Target};
        let make = || CompiledProof {
            source: String::new(),
            spans: vec![SourceSpan {
                start: Position { line: 3, column: 4 },
                end: Position { line: 3, column: 9 },
                target: Target {
                    node: Some("extra".into()),
                    field: Some("term".into()),
                    ..Target::default()
                },
            }],
            result: validation::empty_result(),
            reachable: BTreeSet::from(["goal".into()]),
        };
        let response = serde_json::json!({"messages":[
            {"severity":"error","pos":{"line":3,"column":5},"endPos":{"line":3,"column":8},"data":"Unknown identifier `x`"},
            {"severity":"information","data":"[[vs]]{\"verdict\":\"VS.puzzle\",\"axioms\":[]}"}
        ]});
        let feedback = map_output(make(), &response, CheckMode::Feedback);
        assert_eq!(feedback.status, ProofStatus::Complete);
        assert_eq!(feedback.diagnostics[0].code, "unknown_name");
        assert_eq!(feedback.diagnostics[0].field.as_deref(), Some("term"));
        assert_eq!(
            feedback.diagnostics[0].detail.as_deref(),
            Some("Unknown identifier `x`")
        );
        assert_eq!(
            map_output(make(), &response, CheckMode::Verify).status,
            ProofStatus::Incomplete
        );
        let sorry = serde_json::json!({"messages":[{"severity":"information","data":"[[vs]]{\"verdict\":\"VS.puzzle\",\"axioms\":[\"sorryAx\"]}"}]});
        assert_eq!(
            map_output(make(), &sorry, CheckMode::Feedback).status,
            ProofStatus::Incomplete
        );
    }
    #[test]
    fn captured_records_and_verdict() {
        let compiled = CompiledProof {
            source: String::new(),
            spans: vec![],
            result: validation::empty_result(),
            reachable: BTreeSet::from(["goal".into()]),
        };
        let records = serde_json::json!({"records":[{"kind":"node","key":"n","type":"True","sorry":false},{"kind":"port","key":"goal/in","type":"True"},{"kind":"local","key":"i/l0","type":"Nat"}]});
        let response = serde_json::json!({"messages":[{"severity":"information","data":format!("[[vs]]{records}")},{"severity":"information","data":"[[vs]]{\"verdict\":\"VS.puzzle\",\"axioms\":[\"propext\"]}"},{"severity":"warning","kind":"hasSorry","data":"declaration uses sorry"}],"elapsedMs":42});
        let result = map_output(compiled, &response, CheckMode::Verify);
        assert_eq!(result.status, ProofStatus::Complete);
        assert_eq!(result.nodes["n"].r#type.as_ref().unwrap().text, "True");
        assert_eq!(result.elapsed_ms, 42);
        assert!(result.diagnostics.is_empty());
    }
}
