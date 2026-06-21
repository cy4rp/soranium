# Soranium

Trait-composed token system with micro-gas mining and high-speed trading.

## Concept

**Soranium** tokens carry *Sosshitsu* (素質) — immutable trait bundles composed exclusively of `(bool, string, int)` primitives. The system realises trait abilities and nothing else.

### Units

| Unit | Value |
|------|-------|
| 1 Sora | 100,000,000 Metal |
| 1 Metal | 0.00000001 Sora |

**Sora** = the area of land where one person can see one sky = **0.25 m²**.

### Architecture

```
Sosshitsu (素質)          Token                  Liquidity Pool
(bool, string, int)  →  (activated via stake)  →  (rule-based flow)
                              ↓                        ↓
                          Staking                  Trading
                        (0.25 m² land)          (order book)
                              ↓
                          Mining
                        (micro-gas)
```

## Modules

| Module | Description |
|--------|-------------|
| `token` | Sosshitsu trait bundles + Token type |
| `units` | Sora/Metal fixed-point arithmetic |
| `staking` | Land-based staking (0.25 m² per plot) |
| `mining` | Micro-gas PoW mining engine |
| `pool` | Rule-based liquidity pool |
| `trading` | Price-time priority order book |

## Build & Run

```bash
cargo build
cargo test
cargo run
```

## License

MIT
