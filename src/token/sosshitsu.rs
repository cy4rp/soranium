/// Sosshitsu (素質) — the immutable trait bundle that a Soranium token carries.
///
/// A Sosshitsu is a named, ordered collection of `TraitValue` entries.
/// It defines a token's *capability* and nothing else.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use super::trait_value::TraitValue;

/// Unique fingerprint derived from the trait composition.
pub type SosshitsuId = [u8; 32];

/// One trait definition: a name and its primitive value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraitEntry {
    pub name: String,
    pub value: TraitValue,
}

/// The complete trait bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sosshitsu {
    traits: BTreeMap<String, TraitValue>,
}

impl Sosshitsu {
    pub fn new() -> Self {
        Self {
            traits: BTreeMap::new(),
        }
    }

    /// Build from an iterator of (name, value) pairs.
    pub fn from_entries(entries: impl IntoIterator<Item = (impl Into<String>, TraitValue)>) -> Self {
        let traits = entries
            .into_iter()
            .map(|(k, v)| (k.into(), v))
            .collect();
        Self { traits }
    }

    /// Add or overwrite a trait.
    pub fn set(&mut self, name: impl Into<String>, value: TraitValue) {
        self.traits.insert(name.into(), value);
    }

    /// Read a trait value.
    pub fn get(&self, name: &str) -> Option<&TraitValue> {
        self.traits.get(name)
    }

    /// Number of traits.
    pub fn len(&self) -> usize {
        self.traits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.traits.is_empty()
    }

    /// Iterate over traits in deterministic (alphabetical) order.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &TraitValue)> {
        self.traits.iter()
    }

    /// Complexity score — number of distinct type tags used × trait count.
    /// Higher complexity → higher rule-space in the liquidity pool.
    pub fn complexity(&self) -> u64 {
        let type_diversity: u64 = {
            let mut seen = std::collections::HashSet::new();
            for v in self.traits.values() {
                seen.insert(v.type_tag());
            }
            seen.len() as u64
        };
        type_diversity * self.traits.len() as u64
    }

    /// Deterministic content hash (SHA-256).
    pub fn id(&self) -> SosshitsuId {
        let mut hasher = Sha256::new();
        for (k, v) in &self.traits {
            hasher.update(k.as_bytes());
            hasher.update(b":");
            hasher.update(v.type_tag().as_bytes());
            hasher.update(b"=");
            hasher.update(format!("{v}").as_bytes());
            hasher.update(b"\n");
        }
        hasher.finalize().into()
    }

    /// Schema signature — type tags only, for cross-economy compatibility checks.
    pub fn schema(&self) -> Vec<(&str, &str)> {
        self.traits
            .iter()
            .map(|(k, v)| (k.as_str(), v.type_tag()))
            .collect()
    }

    /// Two Sosshitsu share the same schema when their trait names and types match.
    pub fn schema_compatible(&self, other: &Self) -> bool {
        self.schema() == other.schema()
    }
}

impl Default for Sosshitsu {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Sosshitsu {
        Sosshitsu::from_entries([
            ("active", TraitValue::Bool(true)),
            ("level", TraitValue::Int(5)),
            ("class", TraitValue::Str("warrior".into())),
        ])
    }

    #[test]
    fn basic_operations() {
        let s = sample();
        assert_eq!(s.len(), 3);
        assert_eq!(s.get("level"), Some(&TraitValue::Int(5)));
    }

    #[test]
    fn deterministic_id() {
        let a = sample();
        let b = sample();
        assert_eq!(a.id(), b.id());
    }

    #[test]
    fn complexity_all_types() {
        let s = sample();
        // 3 distinct types × 3 traits = 9
        assert_eq!(s.complexity(), 9);
    }

    #[test]
    fn complexity_single_type() {
        let s = Sosshitsu::from_entries([
            ("a", TraitValue::Bool(true)),
            ("b", TraitValue::Bool(false)),
        ]);
        // 1 type × 2 traits = 2
        assert_eq!(s.complexity(), 2);
    }

    #[test]
    fn schema_compatibility() {
        let a = sample();
        let mut b = Sosshitsu::from_entries([
            ("active", TraitValue::Bool(false)),
            ("level", TraitValue::Int(99)),
            ("class", TraitValue::Str("mage".into())),
        ]);
        assert!(a.schema_compatible(&b));

        b.set("extra", TraitValue::Int(0));
        assert!(!a.schema_compatible(&b));
    }
}
