use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub type VariableMap = BTreeMap<String, ScalarValue>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ScalarValue {
    Boolean(bool),
    Integer(i64),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableScope {
    Save,
    Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableType {
    Boolean,
    Integer,
    Number,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VariableDefinition {
    pub scope: VariableScope,
    #[serde(rename = "type")]
    pub value_type: VariableType,
    pub default: ScalarValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ValueOperand {
    Variable(VariableOperand),
    Literal(LiteralOperand),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VariableOperand {
    pub variable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LiteralOperand {
    pub value: ScalarValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MutationValue {
    Variable(VariableOperand),
    Literal(ScalarValue),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableOperation {
    #[default]
    Assign,
    Add,
    Sub,
    Mul,
    Mod,
    Append,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConditionExpression {
    Eq {
        left: ValueOperand,
        right: ValueOperand,
    },
    Ne {
        left: ValueOperand,
        right: ValueOperand,
    },
    Lt {
        left: ValueOperand,
        right: ValueOperand,
    },
    Le {
        left: ValueOperand,
        right: ValueOperand,
    },
    Gt {
        left: ValueOperand,
        right: ValueOperand,
    },
    Ge {
        left: ValueOperand,
        right: ValueOperand,
    },
    And {
        conditions: Vec<ConditionExpression>,
    },
    Or {
        conditions: Vec<ConditionExpression>,
    },
    Not {
        condition: Box<ConditionExpression>,
    },
}
