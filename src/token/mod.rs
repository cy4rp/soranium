pub mod sosshitsu;
pub mod trait_value;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::units::Amount;

pub use self::sosshitsu::{Sosshitsu, SosshitsuId};
pub use self::trait_value::TraitValue;

/// A Soranium token — carries a Sosshitsu across economies.
///
/// The token contains *only* trait-realisation data; no extraneous functionality.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Token {
    /// Globally unique token identifier.
    pub id: String,
    /// The trait bundle this token carries.
    pub sosshitsu: Sosshitsu,
    /// Owner address.
    pub owner: String,
    /// Balance locked in this token (in Metal).
    pub balance: Amount,
    /// Whether the token has been activated via staking.
    pub activated: bool,
}

impl Token {
    /// Mint a new token with the given trait composition.
    pub fn mint(sosshitsu: Sosshitsu, owner: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            sosshitsu,
            owner: owner.into(),
            balance: Amount::ZERO,
            activated: false,
        }
    }

    /// Sosshitsu fingerprint.
    pub fn sosshitsu_id(&self) -> SosshitsuId {
        self.sosshitsu.id()
    }

    /// Complexity of the underlying trait bundle.
    pub fn complexity(&self) -> u64 {
        self.sosshitsu.complexity()
    }

    /// Activate the token (requires a valid stake).
    pub fn activate(&mut self) {
        self.activated = true;
    }

    /// Deactivate (stake withdrawn).
    pub fn deactivate(&mut self) {
        self.activated = false;
    }

    /// Transfer ownership.
    pub fn transfer(&mut self, new_owner: impl Into<String>) {
        self.owner = new_owner.into();
    }

    /// Credit Metal to the token balance.
    pub fn credit(&mut self, amount: Amount) {
        self.balance = self.balance.saturating_add(amount);
    }

    /// Debit Metal from the token balance; returns false if insufficient.
    pub fn debit(&mut self, amount: Amount) -> bool {
        match self.balance.checked_sub(amount) {
            Some(new) => {
                self.balance = new;
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_token() -> Token {
        let s = Sosshitsu::from_entries([
            ("power", TraitValue::Int(10)),
            ("name", TraitValue::Str("alpha".into())),
        ]);
        Token::mint(s, "addr_001")
    }

    #[test]
    fn mint_defaults() {
        let t = make_token();
        assert!(!t.activated);
        assert!(t.balance.is_zero());
        assert_eq!(t.owner, "addr_001");
    }

    #[test]
    fn activate_deactivate() {
        let mut t = make_token();
        t.activate();
        assert!(t.activated);
        t.deactivate();
        assert!(!t.activated);
    }

    #[test]
    fn credit_debit() {
        let mut t = make_token();
        t.credit(Amount::from_sora(10));
        assert!(t.debit(Amount::from_sora(3)));
        assert_eq!(t.balance, Amount::from_sora(7));
        assert!(!t.debit(Amount::from_sora(100)));
    }

    #[test]
    fn transfer_ownership() {
        let mut t = make_token();
        t.transfer("addr_002");
        assert_eq!(t.owner, "addr_002");
    }
}
