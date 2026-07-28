//! The central application state store. It holds the latest metrics snapshot,
//! host info, process table, the time-series history ring buffers, and the
//! alert engine. All fields live behind fine-grained `parking_lot` locks so
//! the sampler task (writer) and the many HTTP/WebSocket readers never block
//! each other for long.

use crate::alerts::{ActiveAlert, AlertEngine, AlertEvent};
use crate::state::config::Config;
use crate::state::metrics::{
    HistoryPoint, HostInfo, MetricsSnapshot, ProcessMetrics, ThermalMetrics,
};
use crate::util::ring::RingBuffer;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A broadcast channel type alias for pushing snapshots to WebSocket clients.
pub type SnapshotSender = tokio::sync::broadcast::Sender<Arc<StreamMessage>>;

/// Messages pushed onto the broadcast channel consumed by WebSocket clients.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamMessage {
    /// A fresh fast-channel metrics snapshot.
    Snapshot { data: Box<MetricsSnapshot> },
    /// A process table update (slower cadence).
    Processes { data: Box<ProcessMetrics> },
    /// An alert transition (fired/cleared).
    Alert { data: AlertEvent },
    /// A compact history point appended to the rolling chart series.
    History { data: HistoryPoint },
}

/// The shared, cloneable handle to application state.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    config: Config,
    started_at: u64,
    snapshot: RwLock<MetricsSnapshot>,
    processes: RwLock<ProcessMetrics>,
    host: RwLock<HostInfo>,
    history_fast: RwLock<RingBuffer<HistoryPoint>>,
    alert_engine: RwLock<AlertEngine>,
    stream_tx: SnapshotSender,
    // Lightweight counters for the diagnostics endpoint.
    sample_count: AtomicU64,
    ws_client_count: AtomicU64,
    ws_messages_sent: AtomicU64,
}

impl AppState {
    /// Construct a new state store from configuration.
    pub fn new(config: Config) -> Self {
        let capacity = config.history.capacity_fast.max(60);
        let (stream_tx, _rx) = tokio::sync::broadcast::channel(256);
        let engine = AlertEngine::new(&config.alerts.rules);
        AppState {
            inner: Arc::new(Inner {
                config,
                started_at: crate::state::now_millis(),
                snapshot: RwLock::new(MetricsSnapshot::default()),
                processes: RwLock::new(ProcessMetrics::default()),
                host: RwLock::new(HostInfo::default()),
                history_fast: RwLock::new(RingBuffer::new(capacity)),
                alert_engine: RwLock::new(engine),
                stream_tx,
                sample_count: AtomicU64::new(0),
                ws_client_count: AtomicU64::new(0),
                ws_messages_sent: AtomicU64::new(0),
            }),
        }
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn started_at(&self) -> u64 {
        self.inner.started_at
    }

    /// Subscribe to the broadcast stream. Each WebSocket client gets its own
    /// receiver.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Arc<StreamMessage>> {
        self.inner.stream_tx.subscribe()
    }

    /// Broadcast a message to all subscribers, ignoring the "no receivers"
    /// error which is normal when no clients are connected.
    pub fn broadcast(&self, msg: StreamMessage) {
        let _ = self.inner.stream_tx.send(Arc::new(msg));
    }

    /// Replace the latest snapshot, append a compact history point, evaluate
    /// alerts, and broadcast the results.
    pub fn update_snapshot(&self, snapshot: MetricsSnapshot) {
        let now = snapshot.timestamp;

        // Build the compact history point before moving the snapshot.
        let point = HistoryPoint {
            t: now,
            cpu: snapshot.cpu.usage as f32,
            mem: snapshot.memory.used_percent as f32,
            swap: snapshot.memory.swap_used_percent as f32,
            load1: snapshot.load.load1 as f32,
            net_rx: snapshot.network.total_rx_bytes_per_sec as f32,
            net_tx: snapshot.network.total_tx_bytes_per_sec as f32,
            disk_r: snapshot.disk.total_read_bytes_per_sec as f32,
            disk_w: snapshot.disk.total_write_bytes_per_sec as f32,
            temp: snapshot.thermal.max_temp as f32,
            procs_running: snapshot.cpu.procs_running as u32,
        };

        // Evaluate alerts against the new snapshot.
        let events = if self.inner.config.alerts.enabled {
            self.inner.alert_engine.write().evaluate(&snapshot, now)
        } else {
            Vec::new()
        };

        {
            let mut hist = self.inner.history_fast.write();
            hist.push(point);
        }
        {
            let mut snap = self.inner.snapshot.write();
            *snap = snapshot.clone();
        }

        self.inner.sample_count.fetch_add(1, Ordering::Relaxed);

        // Broadcast snapshot, history, and any alert transitions.
        self.broadcast(StreamMessage::Snapshot {
            data: Box::new(snapshot),
        });
        self.broadcast(StreamMessage::History { data: point });
        for ev in events {
            self.broadcast(StreamMessage::Alert { data: ev });
        }
    }

    /// Replace the process table and broadcast it.
    pub fn update_processes(&self, processes: ProcessMetrics) {
        {
            let mut p = self.inner.processes.write();
            *p = processes.clone();
        }
        self.broadcast(StreamMessage::Processes {
            data: Box::new(processes),
        });
    }

    /// Merge freshly collected thermal metrics into the latest snapshot.
    pub fn update_thermal(&self, thermal: ThermalMetrics) {
        let mut snap = self.inner.snapshot.write();
        snap.thermal = thermal;
    }

    pub fn set_host(&self, host: HostInfo) {
        *self.inner.host.write() = host;
    }

    pub fn host(&self) -> HostInfo {
        self.inner.host.read().clone()
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        self.inner.snapshot.read().clone()
    }

    pub fn processes(&self) -> ProcessMetrics {
        self.inner.processes.read().clone()
    }

    /// Return a downsampled history series for the chart, at most `max_points`.
    pub fn history(&self, max_points: usize) -> Vec<HistoryPoint> {
        self.inner.history_fast.read().downsample(max_points)
    }

    /// Return the last `n` raw history points.
    pub fn history_last_n(&self, n: usize) -> Vec<HistoryPoint> {
        self.inner.history_fast.read().last_n(n)
    }

    pub fn active_alerts(&self) -> Vec<ActiveAlert> {
        self.inner.alert_engine.read().active()
    }

    pub fn alert_history(&self, limit: usize) -> Vec<AlertEvent> {
        self.inner.alert_engine.read().history(limit)
    }

    pub fn alert_counts(&self) -> std::collections::HashMap<String, usize> {
        self.inner.alert_engine.read().active_counts()
    }

    pub fn incr_ws_clients(&self) -> u64 {
        self.inner.ws_client_count.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn decr_ws_clients(&self) -> u64 {
        let prev = self.inner.ws_client_count.fetch_sub(1, Ordering::Relaxed);
        prev.saturating_sub(1)
    }

    pub fn ws_client_count(&self) -> u64 {
        self.inner.ws_client_count.load(Ordering::Relaxed)
    }

    pub fn add_ws_messages(&self, n: u64) {
        self.inner.ws_messages_sent.fetch_add(n, Ordering::Relaxed);
    }

    pub fn sample_count(&self) -> u64 {
        self.inner.sample_count.load(Ordering::Relaxed)
    }

    pub fn ws_messages_sent(&self) -> u64 {
        self.inner.ws_messages_sent.load(Ordering::Relaxed)
    }
}
