/// A single trait value — the atomic element of a Soranium token.
///
/// Soranium tokens are composed exclusively of `TraitValue` entries.
/// Only three primitive types are permitted: bool, string, and integer.
/// This constraint keeps tokens minimal — they realise trait abilities
/// and nothing else.
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TraitValue {
    Bool(bool),
    Str(String),
    Int(i64),
}

impl TraitValue {
    pub fn type_tag(&self) -> &'static str {
        match self {
            Self::Bool(_) => "bool",
            Self::Str(_) => "string",
            Self::Int(_) => "int",
        }
    }
}

impl fmt::Display for TraitValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bool(v) => write!(f, "{v}"),
            Self::Str(v) => write!(f, "\"{v}\""),
            Self::Int(v) => write!(f, "{v}"),
        }
    }
}

impl From<bool> for TraitValue {
    fn from(v: bool) -> Self {
        Self::Bool(v)
    }
}

impl From<String> for TraitValue {
    fn from(v: String) -> Self {
        Self::Str(v)
    }
}

impl From<&str> for TraitValue {
    fn from(v: &str) -> Self {
        Self::Str(v.to_owned())
    }
}

impl From<i64> for TraitValue {
    fn from(v: i64) -> Self {
        Self::Int(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_tags() {
        assert_eq!(TraitValue::Bool(true).type_tag(), "bool");
        assert_eq!(TraitValue::Str("x".into()).type_tag(), "string");
        assert_eq!(TraitValue::Int(42).type_tag(), "int");
    }

    #[test]
    fn conversions() {
        let v: TraitValue = true.into();
        assert_eq!(v, TraitValue::Bool(true));

        let v: TraitValue = "hello".into();
        assert_eq!(v, TraitValue::Str("hello".into()));

        let v: TraitValue = 7i64.into();
        assert_eq!(v, TraitValue::Int(7));
    }
}
