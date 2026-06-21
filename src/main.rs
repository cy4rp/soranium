use soranium::mining::MiningEngine;
use soranium::pool::{LiquidityPool, PoolRule};
use soranium::staking::StakingPool;
use soranium::token::{Sosshitsu, Token, TraitValue};
use soranium::trading::{OrderBook, Side};
use soranium::units::Amount;

fn main() {
    println!("=== Soranium ===");
    println!("Trait-composed token system with micro-gas mining\n");

    // 1. Create Sosshitsu (trait bundles).
    let warrior_traits = Sosshitsu::from_entries([
        ("class", TraitValue::Str("warrior".into())),
        ("level", TraitValue::Int(10)),
        ("active", TraitValue::Bool(true)),
    ]);

    let mage_traits = Sosshitsu::from_entries([
        ("class", TraitValue::Str("mage".into())),
        ("level", TraitValue::Int(15)),
        ("active", TraitValue::Bool(true)),
    ]);

    println!("Warrior complexity: {}", warrior_traits.complexity());
    println!("Mage complexity:    {}", mage_traits.complexity());
    println!();

    // 2. Mint tokens.
    let mut warrior = Token::mint(warrior_traits, "alice");
    let mut mage = Token::mint(mage_traits, "bob");

    // 3. Staking — each stakes 1 plot (0.25 m²) of land.
    let mut staking = StakingPool::new();

    staking
        .stake(
            "alice",
            1,
            Amount::from_sora(1),
            vec![warrior.id.clone()],
        )
        .unwrap();
    warrior.activate();

    staking
        .stake(
            "bob",
            1,
            Amount::from_sora(1),
            vec![mage.id.clone()],
        )
        .unwrap();
    mage.activate();

    println!(
        "Staking: {} active stakers, {:.2} m² total land",
        staking.active_stakers(),
        staking.total_land_area_m2()
    );
    println!();

    // 4. Mining — micro-gas costs.
    let mut engine = MiningEngine::new();
    engine.set_difficulty(1);

    let gas = engine.gas_cost();
    println!("Mining gas cost: {} ({} Metal)", gas, gas.as_metal());

    if let Some(nonce) = engine.find_nonce("alice", 100_000) {
        let block = engine.mine("alice", nonce).unwrap();
        warrior.credit(block.reward);
        println!(
            "Block #{} mined by alice — reward: {}",
            block.index, block.reward
        );
    }

    if let Some(nonce) = engine.find_nonce("bob", 100_000) {
        let block = engine.mine("bob", nonce).unwrap();
        mage.credit(block.reward);
        println!(
            "Block #{} mined by bob   — reward: {}",
            block.index, block.reward
        );
    }
    println!();

    // 5. Liquidity pool — rule-based architecture.
    let mut pool = LiquidityPool::new("main-pool");
    pool.add_rule(PoolRule::MinComplexity(3));
    pool.add_rule(PoolRule::RequireActive("active".into()));

    let warrior_id = warrior.id.clone();
    let _mage_id = mage.id.clone();

    pool.deposit(warrior).unwrap();
    pool.deposit(mage).unwrap();

    println!(
        "Pool '{}': {} tokens, avg complexity {:.1}, liquidity {}",
        pool.name,
        pool.token_count(),
        pool.avg_complexity(),
        pool.total_liquidity()
    );
    println!();

    // 6. Trading — high-speed order book.
    let mut book = OrderBook::new();

    book.submit(
        "alice",
        &warrior_id,
        Side::Sell,
        Amount::from_metal(100),
        Amount::from_sora(1),
    );

    let trades = book.submit(
        "bob",
        &warrior_id,
        Side::Buy,
        Amount::from_metal(100),
        Amount::from_sora(1),
    );

    println!("Trading: {} trade(s) executed", trades.len());
    for t in &trades {
        println!("  Trade {} — price: {}, qty: {}", t.id, t.price, t.quantity);
    }

    println!("\n=== Soranium system operational ===");
}
