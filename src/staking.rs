/// Staking — land-based activation for Soranium tokens.
///
/// Sora = 1つの空を1人が見える土地の広さ = 0.25 m² of land.
/// Staking 0.25 m² activates one token, enabling micro-gas mining.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::units::Amount;

/// Area of one Sora land unit in square metres.
pub const SORA_LAND_AREA_M2: f64 = 0.25;

/// A single land stake record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stake {
    pub owner: String,
    /// Number of 0.25 m² land plots staked.
    pub land_plots: u64,
    /// Amount of Sora locked.
    pub locked_amount: Amount,
    /// Tokens activated by this stake.
    pub activated_tokens: Vec<String>,
    /// Whether the stake is currently active.
    pub active: bool,
}

/// Manages all staking state.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StakingPool {
    stakes: HashMap<String, Stake>,
    total_staked: Amount,
    total_land_plots: u64,
}

impl StakingPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stake land to activate token mining.
    /// Each plot is 0.25 m² and costs 1 Sora to stake.
    pub fn stake(
        &mut self,
        owner: &str,
        land_plots: u64,
        amount: Amount,
        token_ids: Vec<String>,
    ) -> Result<(), StakingError> {
        if land_plots == 0 {
            return Err(StakingError::ZeroPlots);
        }

        let required = Amount::from_sora(land_plots);
        if amount.as_metal() < required.as_metal() {
            return Err(StakingError::InsufficientStake {
                required,
                provided: amount,
            });
        }

        let stake = Stake {
            owner: owner.to_string(),
            land_plots,
            locked_amount: amount,
            activated_tokens: token_ids,
            active: true,
        };

        self.total_staked = self.total_staked.saturating_add(amount);
        self.total_land_plots += land_plots;
        self.stakes.insert(owner.to_string(), stake);

        Ok(())
    }

    /// Unstake — deactivates tokens and returns locked amount.
    pub fn unstake(&mut self, owner: &str) -> Result<Amount, StakingError> {
        let stake = self
            .stakes
            .get_mut(owner)
            .ok_or(StakingError::NotFound)?;

        if !stake.active {
            return Err(StakingError::AlreadyUnstaked);
        }

        stake.active = false;
        let refund = stake.locked_amount;
        self.total_staked = self.total_staked.saturating_sub(refund);
        self.total_land_plots = self.total_land_plots.saturating_sub(stake.land_plots);

        Ok(refund)
    }

    /// Look up a stake.
    pub fn get_stake(&self, owner: &str) -> Option<&Stake> {
        self.stakes.get(owner)
    }

    /// Whether the given owner has an active stake.
    pub fn is_active(&self, owner: &str) -> bool {
        self.stakes
            .get(owner)
            .map(|s| s.active)
            .unwrap_or(false)
    }

    /// Total Sora locked across all stakes.
    pub fn total_staked(&self) -> Amount {
        self.total_staked
    }

    /// Total land area staked (in m²).
    pub fn total_land_area_m2(&self) -> f64 {
        self.total_land_plots as f64 * SORA_LAND_AREA_M2
    }

    /// Number of active stakers.
    pub fn active_stakers(&self) -> usize {
        self.stakes.values().filter(|s| s.active).count()
    }
}

/// Staking errors.
#[derive(Debug, thiserror::Error)]
pub enum StakingError {
    #[error("cannot stake zero plots")]
    ZeroPlots,
    #[error("insufficient stake: required {required}, provided {provided}")]
    InsufficientStake { required: Amount, provided: Amount },
    #[error("stake not found")]
    NotFound,
    #[error("already unstaked")]
    AlreadyUnstaked,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stake_and_unstake() {
        let mut pool = StakingPool::new();
        pool.stake("alice", 1, Amount::from_sora(1), vec!["tok1".into()])
            .unwrap();
        assert!(pool.is_active("alice"));
        assert_eq!(pool.total_land_area_m2(), 0.25);

        let refund = pool.unstake("alice").unwrap();
        assert_eq!(refund, Amount::from_sora(1));
        assert!(!pool.is_active("alice"));
    }

    #[test]
    fn insufficient_stake() {
        let mut pool = StakingPool::new();
        let result = pool.stake("bob", 2, Amount::from_sora(1), vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn zero_plots_rejected() {
        let mut pool = StakingPool::new();
        let result = pool.stake("charlie", 0, Amount::from_sora(1), vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn multiple_stakers() {
        let mut pool = StakingPool::new();
        pool.stake("alice", 4, Amount::from_sora(4), vec![])
            .unwrap();
        pool.stake("bob", 2, Amount::from_sora(2), vec![])
            .unwrap();
        assert_eq!(pool.active_stakers(), 2);
        assert_eq!(pool.total_staked(), Amount::from_sora(6));
        assert_eq!(pool.total_land_area_m2(), 1.5);
    }
}
