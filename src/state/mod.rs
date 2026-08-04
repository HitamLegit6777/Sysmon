//! Shared application state: the metrics types, the configuration, the alert
//! engine, and the central `AppState` store that holds the latest snapshot and
//! time-series history. `now_millis` is a small helper used throughout the
//! collectors for delta timing.

pub mod config;
pub mod metrics;
pub mod store;

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the UNIX epoch. Monotonic enough for rate math and
/// used as the timestamp on every sample.
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
