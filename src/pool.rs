/// Liquidity Pool — rule-based architecture where Sosshitsu tokens flow.
///
/// The pool's complexity grows from composable rules that govern
/// how tokens enter, exit, and interact within the pool.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::token::{Sosshitsu, Token, TraitValue};
use crate::units::Amount;

/// A rule that governs token admission and behaviour in the pool.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum PoolRule {
    /// Token must have a specific trait with a matching type.
    RequireTrait { name: String, type_tag: String },
    /// Token must have minimum complexity score.
    MinComplexity(u64),
    /// Token must have at least N traits.
    MinTraitCount(usize),
    /// Token must have a specific bool trait set to true.
    RequireActive(String),
    /// Token must have an int trait ≥ threshold.
    MinIntValue { name: String, min: i64 },
}

impl PoolRule {
    /// Evaluate whether a Sosshitsu satisfies this rule.
    pub fn evaluate(&self, sosshitsu: &Sosshitsu) -> bool {
        match self {
            Self::RequireTrait { name, type_tag } => sosshitsu
                .get(name)
                .map(|v| v.type_tag() == type_tag.as_str())
                .unwrap_or(false),

            Self::MinComplexity(min) => sosshitsu.complexity() >= *min,

            Self::MinTraitCount(min) => sosshitsu.len() >= *min,

            Self::RequireActive(name) => matches!(
                sosshitsu.get(name),
                Some(TraitValue::Bool(true))
            ),

            Self::MinIntValue { name, min } => matches!(
                sosshitsu.get(name),
                Some(TraitValue::Int(v)) if *v >= *min
            ),
        }
    }
}

/// A liquidity pool where Sosshitsu-bearing tokens flow.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiquidityPool {
    pub name: String,
    rules: Vec<PoolRule>,
    tokens: HashMap<String, Token>,
    total_liquidity: Amount,
}

impl LiquidityPool {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            rules: Vec::new(),
            tokens: HashMap::new(),
            total_liquidity: Amount::ZERO,
        }
    }

    /// Add a rule to the pool.
    pub fn add_rule(&mut self, rule: PoolRule) {
        self.rules.push(rule);
    }

    /// Check whether a token is admissible under all rules.
    pub fn is_admissible(&self, token: &Token) -> bool {
        self.rules.iter().all(|r| r.evaluate(&token.sosshitsu))
    }

    /// Deposit a token into the pool. Returns error if rules not met.
    pub fn deposit(&mut self, token: Token) -> Result<(), PoolError> {
        if !token.activated {
            return Err(PoolError::TokenNotActivated);
        }
        if !self.is_admissible(&token) {
            return Err(PoolError::RuleViolation);
        }
        if self.tokens.contains_key(&token.id) {
            return Err(PoolError::AlreadyInPool);
        }

        self.total_liquidity = self.total_liquidity.saturating_add(token.balance);
        self.tokens.insert(token.id.clone(), token);
        Ok(())
    }

    /// Withdraw a token from the pool.
    pub fn withdraw(&mut self, token_id: &str) -> Result<Token, PoolError> {
        let token = self.tokens.remove(token_id).ok_or(PoolError::NotFound)?;
        self.total_liquidity = self.total_liquidity.saturating_sub(token.balance);
        Ok(token)
    }

    /// Get a reference to a token in the pool.
    pub fn get_token(&self, token_id: &str) -> Option<&Token> {
        self.tokens.get(token_id)
    }

    /// Number of tokens currently in the pool.
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// Total liquidity in the pool.
    pub fn total_liquidity(&self) -> Amount {
        self.total_liquidity
    }

    /// Average complexity of tokens in the pool.
    pub fn avg_complexity(&self) -> f64 {
        if self.tokens.is_empty() {
            return 0.0;
        }
        let sum: u64 = self.tokens.values().map(|t| t.complexity()).sum();
        sum as f64 / self.tokens.len() as f64
    }

    /// Number of rules governing this pool.
    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// List all tokens (read-only).
    pub fn tokens(&self) -> impl Iterator<Item = &Token> {
        self.tokens.values()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PoolError {
    #[error("token has not been activated via staking")]
    TokenNotActivated,
    #[error("token does not satisfy pool rules")]
    RuleViolation,
    #[error("token is already in the pool")]
    AlreadyInPool,
    #[error("token not found in pool")]
    NotFound,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::Sosshitsu;

    fn warrior_token() -> Token {
        let s = Sosshitsu::from_entries([
            ("class", TraitValue::Str("warrior".into())),
            ("level", TraitValue::Int(10)),
            ("active", TraitValue::Bool(true)),
        ]);
        let mut t = Token::mint(s, "alice");
        t.activate();
        t.credit(Amount::from_sora(5));
        t
    }

    #[test]
    fn basic_deposit_withdraw() {
        let mut pool = LiquidityPool::new("main");
        let token = warrior_token();
        let id = token.id.clone();

        pool.deposit(token).unwrap();
        assert_eq!(pool.token_count(), 1);
        assert_eq!(pool.total_liquidity(), Amount::from_sora(5));

        let withdrawn = pool.withdraw(&id).unwrap();
        assert_eq!(withdrawn.owner, "alice");
        assert_eq!(pool.token_count(), 0);
    }

    #[test]
    fn rule_enforcement() {
        let mut pool = LiquidityPool::new("elite");
        pool.add_rule(PoolRule::MinComplexity(6));
        pool.add_rule(PoolRule::RequireTrait {
            name: "class".into(),
            type_tag: "string".into(),
        });

        let token = warrior_token();
        // complexity = 3 types × 3 traits = 9 ≥ 6 ✓
        assert!(pool.is_admissible(&token));
        pool.deposit(token).unwrap();
    }

    #[test]
    fn inactive_token_rejected() {
        let mut pool = LiquidityPool::new("main");
        let s = Sosshitsu::from_entries([("x", TraitValue::Bool(true))]);
        let token = Token::mint(s, "bob"); // not activated
        assert!(pool.deposit(token).is_err());
    }

    #[test]
    fn rule_violation_rejected() {
        let mut pool = LiquidityPool::new("high-level");
        pool.add_rule(PoolRule::MinIntValue {
            name: "level".into(),
            min: 50,
        });

        let token = warrior_token(); // level = 10 < 50
        assert!(!pool.is_admissible(&token));
        assert!(pool.deposit(token).is_err());
    }

    #[test]
    fn avg_complexity() {
        let mut pool = LiquidityPool::new("mixed");
        let t1 = warrior_token();
        let mut t2 = {
            let s = Sosshitsu::from_entries([
                ("a", TraitValue::Bool(false)),
                ("b", TraitValue::Int(1)),
            ]);
            let mut t = Token::mint(s, "bob");
            t.activate();
            t
        };
        let _ = &mut t2;

        pool.deposit(t1).unwrap();
        pool.deposit(t2).unwrap();

        assert!(pool.avg_complexity() > 0.0);
    }
}
