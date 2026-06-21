/// Soranium — trait-composed token system.
///
/// Tokens carry *Sosshitsu* (素質): immutable trait bundles composed of
/// `(bool, string, int)` primitives. The system realises trait abilities
/// and nothing else.
///
/// # Architecture
///
/// ```text
/// ┌────────────┐    ┌──────────────┐    ┌─────────────┐
/// │  Sosshitsu  │───▶│    Token     │───▶│  Liquidity  │
/// │ (bool,str,  │    │  (activated  │    │    Pool     │
/// │  int)       │    │   via stake) │    │  (rule-based│
/// └────────────┘    └──────────────┘    │  flow)      │
///                          │            └─────────────┘
///                    ┌─────┴─────┐            │
///                    │  Staking  │      ┌─────┴─────┐
///                    │ (0.25 m²  │      │  Trading  │
///                    │  land)    │      │ (order    │
///                    └───────────┘      │  book)    │
///                          │            └───────────┘
///                    ┌─────┴─────┐
///                    │  Mining   │
///                    │ (micro-   │
///                    │  gas)     │
///                    └───────────┘
/// ```
///
/// # Units
///
/// - **1 Sora** = 100,000,000 Metal (10^8)
/// - **1 Metal** = 0.00000001 Sora (smallest unit)
/// - Land unit: 0.25 m² per Sora staked
pub mod mining;
pub mod pool;
pub mod staking;
pub mod token;
pub mod trading;
pub mod units;
