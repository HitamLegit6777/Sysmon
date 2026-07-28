//! The sampler orchestrates all collectors on independent cadences using Tokio
//! intervals. Fast metrics (CPU, memory, load, network, disk aggregate) run on
//! the fast interval; the process table and thermal run on their own slower
//! cadences to keep overhead low. Each collector call is cheap because it only
//! reads pseudo-files.

use crate::collectors::{
    CpuCollector, DiskCollector, HostCollector, LoadCollector, MemoryCollector,
    NetworkCollector, ProcessCollector, ThermalCollector,
};
use crate::state::metrics::MetricsSnapshot;
use crate::state::store::AppState;
use std::time::Duration;
use tokio::time::{interval, MissedTickBehavior};

/// Spawn all sampling tasks. Returns immediately; tasks run until the process
/// exits. The fast task owns the collectors that participate in the primary
/// snapshot; separate tasks own the process and thermal collectors.
pub fn spawn(state: AppState) {
    spawn_fast(state.clone());
    spawn_process(state.clone());
    spawn_thermal(state.clone());
    spawn_host_refresh(state);
}

fn make_interval(period_ms: u64) -> tokio::time::Interval {
    let mut iv = interval(Duration::from_millis(period_ms.max(100)));
    // If the runtime is briefly starved, skip missed ticks rather than
    // bursting to catch up, which would distort rate calculations.
    iv.set_missed_tick_behavior(MissedTickBehavior::Skip);
    iv
}

fn spawn_fast(state: AppState) {
    let period = state.config().sampling.fast_interval_ms;
    tokio::spawn(async move {
        let mut cpu = CpuCollector::new();
        let mut memory = MemoryCollector::new();
        let mut load = LoadCollector::new();
        let mut network = NetworkCollector::new();
        let mut disk = DiskCollector::new();

        // Prime the delta-based collectors so the first published sample has
        // meaningful rates instead of zeros.
        cpu.collect();
        network.collect();
        disk.collect();
        tokio::time::sleep(Duration::from_millis(period.min(1000))).await;

        let mut iv = make_interval(period);
        let disk_every =
            (state.config().sampling.disk_interval_ms / period.max(1)).max(1);
        let mut tick: u64 = 0;
        let mut last_disk = disk.collect();

        loop {
            iv.tick().await;
            tick += 1;

            let mut snapshot = MetricsSnapshot::default();
            snapshot.timestamp = crate::state::now_millis();
            snapshot.cpu = cpu.collect();
            snapshot.memory = memory.collect();
            snapshot.load = load.collect();
            snapshot.network = network.collect();

            // Disk capacity scanning is comparatively expensive, so refresh it
            // on a slower cadence and reuse the last value in between.
            if tick % disk_every == 0 {
                last_disk = disk.collect();
            }
            snapshot.disk = last_disk.clone();

            // Preserve the most recent thermal reading collected by the
            // thermal task by merging it from the current stored snapshot.
            let prev = state.snapshot();
            snapshot.thermal = prev.thermal;

            state.update_snapshot(snapshot);
        }
    });
}

fn spawn_process(state: AppState) {
    let period = state.config().sampling.process_interval_ms;
    let limit = state.config().sampling.process_limit;
    let want_io = state.config().sampling.process_io;
    tokio::spawn(async move {
        let mut collector = ProcessCollector::new();
        // Prime once so the first published table has CPU percentages.
        collector.collect(limit, want_io);
        tokio::time::sleep(Duration::from_millis(period.min(1500))).await;

        let mut iv = make_interval(period);
        loop {
            iv.tick().await;
            let processes = collector.collect(limit, want_io);
            state.update_processes(processes);
        }
    });
}

fn spawn_thermal(state: AppState) {
    let period = state.config().sampling.thermal_interval_ms;
    tokio::spawn(async move {
        let mut collector = ThermalCollector::new();
        let mut iv = make_interval(period);
        loop {
            iv.tick().await;
            let thermal = collector.collect();
            state.update_thermal(thermal);
        }
    });
}

fn spawn_host_refresh(state: AppState) {
    tokio::spawn(async move {
        let mut collector = HostCollector::new();
        // Collect once immediately at startup.
        state.set_host(collector.collect());
        // Refresh occasionally to catch kernel/uptime changes.
        let mut iv = make_interval(60_000);
        loop {
            iv.tick().await;
            state.set_host(collector.collect());
        }
    });
}
