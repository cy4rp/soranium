/// Soranium unit system.
///
/// 1 Sora  = 100_000_000 Metal (10^8)
/// 0.00000001 Sora = 1 Metal
///
/// All internal arithmetic uses Metal (u64) to avoid floating-point errors.
use std::fmt;

use serde::{Deserialize, Serialize};

/// Number of Metal per Sora (10^8).
pub const METAL_PER_SORA: u64 = 100_000_000;

/// Smallest representable amount — one Metal.
pub const ONE_METAL: Amount = Amount(1);

/// One full Sora expressed in Metal.
pub const ONE_SORA: Amount = Amount(METAL_PER_SORA);

/// Fixed-point amount stored in Metal units.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Amount(u64);

impl Amount {
    pub const ZERO: Self = Self(0);

    /// Create from raw Metal count.
    pub fn from_metal(metal: u64) -> Self {
        Self(metal)
    }

    /// Create from whole Sora count.
    pub fn from_sora(sora: u64) -> Self {
        Self(sora.saturating_mul(METAL_PER_SORA))
    }

    /// Raw Metal value.
    pub fn as_metal(self) -> u64 {
        self.0
    }

    /// Whole Sora component (truncated).
    pub fn whole_sora(self) -> u64 {
        self.0 / METAL_PER_SORA
    }

    /// Fractional Metal remainder after whole Sora.
    pub fn fractional_metal(self) -> u64 {
        self.0 % METAL_PER_SORA
    }

    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        self.0.checked_add(rhs.0).map(Self)
    }

    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        self.0.checked_sub(rhs.0).map(Self)
    }

    pub fn saturating_add(self, rhs: Self) -> Self {
        Self(self.0.saturating_add(rhs.0))
    }

    pub fn saturating_sub(self, rhs: Self) -> Self {
        Self(self.0.saturating_sub(rhs.0))
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }
}

impl fmt::Display for Amount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let whole = self.whole_sora();
        let frac = self.fractional_metal();
        if frac == 0 {
            write!(f, "{} SORA", whole)
        } else {
            write!(f, "{}.{:08} SORA", whole, frac)
        }
    }
}

impl std::ops::Add for Amount {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}

impl std::ops::Sub for Amount {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metal_sora_conversion() {
        let amt = Amount::from_sora(1);
        assert_eq!(amt.as_metal(), 100_000_000);
        assert_eq!(amt.whole_sora(), 1);
        assert_eq!(amt.fractional_metal(), 0);
    }

    #[test]
    fn one_metal_is_smallest() {
        let amt = Amount::from_metal(1);
        assert_eq!(amt.whole_sora(), 0);
        assert_eq!(amt.fractional_metal(), 1);
        assert_eq!(format!("{}", amt), "0.00000001 SORA");
    }

    #[test]
    fn display_format() {
        let amt = Amount::from_metal(123_456_789);
        assert_eq!(format!("{}", amt), "1.23456789 SORA");
    }

    #[test]
    fn arithmetic() {
        let a = Amount::from_sora(5);
        let b = Amount::from_sora(3);
        assert_eq!((a - b).as_metal(), Amount::from_sora(2).as_metal());
        assert_eq!((a + b).as_metal(), Amount::from_sora(8).as_metal());
    }

    #[test]
    fn checked_underflow() {
        let a = Amount::from_sora(1);
        let b = Amount::from_sora(2);
        assert!(a.checked_sub(b).is_none());
    }
}
