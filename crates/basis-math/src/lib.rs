//! Basis-AMM fixed-point math shared by the NEAR contract and mirrored by the TypeScript SDK.
//!
//! Units: collateral micro-USD (6 decimals), prices in `[0, 1_000_000]`, reference units in
//! micro-units, leverage in basis points of 1x, fractions in ppm. No floating point.

pub mod book;
pub mod fair;
pub mod fees;
pub mod fixed;
pub mod position;
pub mod stress;
pub mod vault;

pub use fixed::*;
