/// Trading — high-speed order book for Soranium tokens.
///
/// Supports limit orders on Sosshitsu-bearing tokens.
/// Matching is O(1) per price level via sorted BTreeMap.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::units::Amount;

/// Side of an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

/// A limit order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub owner: String,
    /// Token ID being traded.
    pub token_id: String,
    pub side: Side,
    /// Price in Metal per unit.
    pub price: Amount,
    /// Remaining quantity in Metal.
    pub quantity: Amount,
    /// Timestamp (monotonic counter).
    pub timestamp: u64,
}

/// A completed trade.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub buy_order_id: String,
    pub sell_order_id: String,
    pub price: Amount,
    pub quantity: Amount,
    pub timestamp: u64,
}

/// Price-time priority order book.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OrderBook {
    /// Buy side: highest price first (negated key for BTreeMap).
    bids: BTreeMap<u64, Vec<Order>>,
    /// Sell side: lowest price first.
    asks: BTreeMap<u64, Vec<Order>>,
    trades: Vec<Trade>,
    clock: u64,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Submit a limit order. Returns any trades that were immediately matched.
    pub fn submit(&mut self, owner: &str, token_id: &str, side: Side, price: Amount, quantity: Amount) -> Vec<Trade> {
        self.clock += 1;

        let order = Order {
            id: Uuid::new_v4().to_string(),
            owner: owner.to_string(),
            token_id: token_id.to_string(),
            side,
            price,
            quantity,
            timestamp: self.clock,
        };

        match side {
            Side::Buy => self.match_buy(order),
            Side::Sell => self.match_sell(order),
        }
    }

    fn match_buy(&mut self, mut buy: Order) -> Vec<Trade> {
        let mut fills = Vec::new();
        let buy_price = buy.price.as_metal();

        let mut empty_levels = Vec::new();

        for (&ask_price, orders) in self.asks.iter_mut() {
            if ask_price > buy_price || buy.quantity.is_zero() {
                break;
            }

            let mut i = 0;
            while i < orders.len() && !buy.quantity.is_zero() {
                let sell = &mut orders[i];
                let fill_qty = std::cmp::min(buy.quantity.as_metal(), sell.quantity.as_metal());
                let fill_amount = Amount::from_metal(fill_qty);

                buy.quantity = buy.quantity.saturating_sub(fill_amount);
                sell.quantity = sell.quantity.saturating_sub(fill_amount);

                self.clock += 1;
                let trade = Trade {
                    id: Uuid::new_v4().to_string(),
                    buy_order_id: buy.id.clone(),
                    sell_order_id: sell.id.clone(),
                    price: Amount::from_metal(ask_price),
                    quantity: fill_amount,
                    timestamp: self.clock,
                };
                fills.push(trade.clone());
                self.trades.push(trade);

                if sell.quantity.is_zero() {
                    i += 1;
                } else {
                    break;
                }
            }

            // Remove filled sell orders.
            orders.retain(|o| !o.quantity.is_zero());
            if orders.is_empty() {
                empty_levels.push(ask_price);
            }
        }

        for level in empty_levels {
            self.asks.remove(&level);
        }

        // Rest goes on the book.
        if !buy.quantity.is_zero() {
            let key = buy.price.as_metal();
            self.bids.entry(key).or_default().push(buy);
        }

        fills
    }

    fn match_sell(&mut self, mut sell: Order) -> Vec<Trade> {
        let mut fills = Vec::new();
        let sell_price = sell.price.as_metal();

        let mut empty_levels = Vec::new();

        // Iterate bids from highest to lowest.
        for (&bid_price, orders) in self.bids.iter_mut().rev() {
            if bid_price < sell_price || sell.quantity.is_zero() {
                break;
            }

            let mut i = 0;
            while i < orders.len() && !sell.quantity.is_zero() {
                let buy = &mut orders[i];
                let fill_qty = std::cmp::min(sell.quantity.as_metal(), buy.quantity.as_metal());
                let fill_amount = Amount::from_metal(fill_qty);

                sell.quantity = sell.quantity.saturating_sub(fill_amount);
                buy.quantity = buy.quantity.saturating_sub(fill_amount);

                self.clock += 1;
                let trade = Trade {
                    id: Uuid::new_v4().to_string(),
                    buy_order_id: buy.id.clone(),
                    sell_order_id: sell.id.clone(),
                    price: Amount::from_metal(bid_price),
                    quantity: fill_amount,
                    timestamp: self.clock,
                };
                fills.push(trade.clone());
                self.trades.push(trade);

                if buy.quantity.is_zero() {
                    i += 1;
                } else {
                    break;
                }
            }

            orders.retain(|o| !o.quantity.is_zero());
            if orders.is_empty() {
                empty_levels.push(bid_price);
            }
        }

        for level in empty_levels {
            self.bids.remove(&level);
        }

        if !sell.quantity.is_zero() {
            let key = sell.price.as_metal();
            self.asks.entry(key).or_default().push(sell);
        }

        fills
    }

    /// Best bid price.
    pub fn best_bid(&self) -> Option<Amount> {
        self.bids.keys().next_back().map(|&p| Amount::from_metal(p))
    }

    /// Best ask price.
    pub fn best_ask(&self) -> Option<Amount> {
        self.asks.keys().next().map(|&p| Amount::from_metal(p))
    }

    /// Spread in Metal.
    pub fn spread(&self) -> Option<Amount> {
        match (self.best_ask(), self.best_bid()) {
            (Some(ask), Some(bid)) => ask.checked_sub(bid),
            _ => None,
        }
    }

    /// Total number of trades executed.
    pub fn trade_count(&self) -> usize {
        self.trades.len()
    }

    /// All executed trades.
    pub fn trades(&self) -> &[Trade] {
        &self.trades
    }

    /// Number of open bid orders.
    pub fn bid_depth(&self) -> usize {
        self.bids.values().map(|v| v.len()).sum()
    }

    /// Number of open ask orders.
    pub fn ask_depth(&self) -> usize {
        self.asks.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_order_matching() {
        let mut book = OrderBook::new();

        // Place sell at 100 Metal.
        book.submit("alice", "tok1", Side::Sell, Amount::from_metal(100), Amount::from_sora(1));

        // Place buy at 100 Metal — should match.
        let trades = book.submit("bob", "tok1", Side::Buy, Amount::from_metal(100), Amount::from_sora(1));

        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].quantity, Amount::from_sora(1));
    }

    #[test]
    fn partial_fill() {
        let mut book = OrderBook::new();

        book.submit("alice", "tok1", Side::Sell, Amount::from_metal(50), Amount::from_sora(3));
        let trades = book.submit("bob", "tok1", Side::Buy, Amount::from_metal(50), Amount::from_sora(1));

        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].quantity, Amount::from_sora(1));
        // alice still has 2 Sora on the book.
        assert_eq!(book.ask_depth(), 1);
    }

    #[test]
    fn no_match_different_price() {
        let mut book = OrderBook::new();

        book.submit("alice", "tok1", Side::Sell, Amount::from_metal(200), Amount::from_sora(1));
        let trades = book.submit("bob", "tok1", Side::Buy, Amount::from_metal(100), Amount::from_sora(1));

        assert!(trades.is_empty());
        assert_eq!(book.bid_depth(), 1);
        assert_eq!(book.ask_depth(), 1);
    }

    #[test]
    fn spread_calculation() {
        let mut book = OrderBook::new();

        book.submit("alice", "tok1", Side::Sell, Amount::from_metal(110), Amount::from_sora(1));
        book.submit("bob", "tok1", Side::Buy, Amount::from_metal(100), Amount::from_sora(1));

        let spread = book.spread().unwrap();
        assert_eq!(spread.as_metal(), 10);
    }

    #[test]
    fn multiple_fills() {
        let mut book = OrderBook::new();

        book.submit("s1", "tok1", Side::Sell, Amount::from_metal(10), Amount::from_sora(2));
        book.submit("s2", "tok1", Side::Sell, Amount::from_metal(11), Amount::from_sora(3));

        // Buy 4 Sora at up to 11 Metal — should fill 2 from s1 and 2 from s2.
        let trades = book.submit("buyer", "tok1", Side::Buy, Amount::from_metal(11), Amount::from_sora(4));

        assert_eq!(trades.len(), 2);
        assert_eq!(book.ask_depth(), 1); // s2 has 1 Sora left
    }
}
