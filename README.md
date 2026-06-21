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

## Build & Run (Core)

```bash
cargo build
cargo test
cargo run
```

## STAS Swap API (`swap-api/`)

On-chain STAS 3.0 divisible swap API. Maker/Taker atomic swap with partial fills, order book, and ARC broadcast.

### Quick Start

```bash
cd swap-api
npm install
cp .env.example .env    # ARC_URL を自前ノードに向ける
npm run dev             # http://localhost:3000
npm test                # オフライン自己テスト
```

### Docker

```bash
cd swap-api
docker compose up --build
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/offers` | オファー作成 (Maker) |
| `GET` | `/offers` | 板取得 |
| `GET` | `/offers/:id/quote` | 必要wanted量の見積り |
| `POST` | `/offers/:id/take` | テイク (部分テイク可) |
| `POST` | `/offers/:id/cancel` | キャンセル |
| `POST` | `/inspect` | STASスクリプト解析 |
| `GET` | `/tx/:txid` | ARCステータス |
| `GET` | `/health` | ヘルスチェック |

### Bench (throughput test)

`npm run dev` 後 `http://localhost:3000/` でブラウザUIから高速swapスループットテストを実行可能。

## License

MIT
