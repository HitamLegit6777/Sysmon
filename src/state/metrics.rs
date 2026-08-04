//! Serializable metric data structures shared between the collectors, the
//! in-memory state store, the REST API, and the WebSocket stream. Every type
//! derives `Serialize`/`Clone` and uses camelCase field names so the frontend
//! can consume them directly as JSON.

use serde::{Deserialize, Serialize};

/// A single per-core CPU utilization reading.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreUsage {
    pub core: usize,
    pub usage: f64,
    pub user: f64,
    pub system: f64,
    pub nice: f64,
    pub idle: f64,
    pub iowait: f64,
    pub irq: f64,
    pub softirq: f64,
    pub steal: f64,
    pub freq_mhz: f64,
}

/// Aggregate CPU metrics for a single sample.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    /// Overall CPU usage percentage across all cores (0..100).
    pub usage: f64,
    pub user: f64,
    pub system: f64,
    pub nice: f64,
    pub idle: f64,
    pub iowait: f64,
    pub irq: f64,
    pub softirq: f64,
    pub steal: f64,
    pub guest: f64,
    /// Number of logical cores.
    pub core_count: usize,
    /// Per-core breakdown.
    pub cores: Vec<CoreUsage>,
    /// Context switches since boot.
    pub ctxt: u64,
    /// Context switches per second.
    pub ctxt_per_sec: f64,
    /// Processes created since boot.
    pub processes: u64,
    /// Process creations per second.
    pub forks_per_sec: f64,
    /// Number of currently running processes.
    pub procs_running: u64,
    /// Number of blocked processes.
    pub procs_blocked: u64,
    /// Total interrupts serviced since boot.
    pub interrupts: u64,
    pub interrupts_per_sec: f64,
    /// Average current frequency across cores in MHz.
    pub avg_freq_mhz: f64,
    pub min_freq_mhz: f64,
    pub max_freq_mhz: f64,
}

/// Memory and swap metrics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub total: u64,
    pub free: u64,
    pub available: u64,
    pub used: u64,
    pub buffers: u64,
    pub cached: u64,
    pub shared: u64,
    pub slab: u64,
    pub used_percent: f64,
    pub swap_total: u64,
    pub swap_free: u64,
    pub swap_used: u64,
    pub swap_used_percent: f64,
    pub active: u64,
    pub inactive: u64,
    pub dirty: u64,
    pub writeback: u64,
    pub mapped: u64,
    pub committed_as: u64,
    pub commit_limit: u64,
    pub page_tables: u64,
    pub kernel_stack: u64,
    pub huge_pages_total: u64,
    pub huge_pages_free: u64,
}

/// A single mounted filesystem's capacity metrics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemUsage {
    pub device: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub used_percent: f64,
    pub inodes_total: u64,
    pub inodes_used: u64,
    pub inodes_free: u64,
    pub inodes_used_percent: f64,
}

/// A single block device's I/O counters and computed rates.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlockDeviceIo {
    pub name: String,
    pub reads_completed: u64,
    pub writes_completed: u64,
    pub sectors_read: u64,
    pub sectors_written: u64,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub read_ops_per_sec: f64,
    pub write_ops_per_sec: f64,
    pub io_in_progress: u64,
    pub io_time_ms: u64,
    pub util_percent: f64,
}

/// Disk metrics: mounted filesystems plus per-device I/O.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub filesystems: Vec<FilesystemUsage>,
    pub devices: Vec<BlockDeviceIo>,
    pub total_capacity: u64,
    pub total_used: u64,
    pub max_used_percent: f64,
    pub total_read_bytes_per_sec: f64,
    pub total_write_bytes_per_sec: f64,
}

/// A single network interface's counters and computed rates.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub rx_errors: u64,
    pub tx_errors: u64,
    pub rx_dropped: u64,
    pub tx_dropped: u64,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
    pub rx_packets_per_sec: f64,
    pub tx_packets_per_sec: f64,
    pub is_up: bool,
    pub speed_mbps: i64,
    pub mac: String,
    pub mtu: u64,
    pub addresses: Vec<String>,
}

/// Aggregate network metrics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub interfaces: Vec<NetInterface>,
    pub total_rx_bytes_per_sec: f64,
    pub total_tx_bytes_per_sec: f64,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
    pub tcp_connections: u64,
    pub udp_connections: u64,
    pub tcp_listening: u64,
}

/// A single thermal zone reading.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThermalZone {
    pub name: String,
    pub zone_type: String,
    pub temp_celsius: f64,
}

/// A cooling device (e.g. fan or passive cooler) reading.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoolingDevice {
    pub name: String,
    pub device_type: String,
    pub cur_state: i64,
    pub max_state: i64,
    pub percent: f64,
}

/// Thermal metrics: zones, cooling devices, and battery if present.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThermalMetrics {
    pub zones: Vec<ThermalZone>,
    pub cooling: Vec<CoolingDevice>,
    pub max_temp: f64,
    pub avg_temp: f64,
    pub battery_present: bool,
    pub battery_percent: f64,
    pub battery_status: String,
    pub on_ac_power: bool,
}

/// Load average and scheduling metrics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadMetrics {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub load1_per_core: f64,
    pub load5_per_core: f64,
    pub load15_per_core: f64,
    pub runnable: u64,
    pub total_procs: u64,
    pub last_pid: u64,
    pub uptime_seconds: f64,
    pub idle_seconds: f64,
}

/// A single process entry in the process table view.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: i64,
    pub ppid: i64,
    pub name: String,
    pub cmdline: String,
    pub state: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub rss_bytes: u64,
    pub vsize_bytes: u64,
    pub threads: i64,
    pub user: String,
    pub uid: u32,
    pub priority: i64,
    pub nice: i64,
    pub start_time: u64,
    pub num_fds: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
}

/// Process table metrics and summary counters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pub processes: Vec<ProcessInfo>,
    pub total: u64,
    pub running: u64,
    pub sleeping: u64,
    pub stopped: u64,
    pub zombie: u64,
    pub total_threads: u64,
}

/// Relatively static host information gathered once at startup and refreshed
/// occasionally.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub hostname: String,
    pub kernel: String,
    pub kernel_version: String,
    pub os_name: String,
    pub os_version: String,
    pub os_pretty: String,
    pub architecture: String,
    pub cpu_model: String,
    pub cpu_vendor: String,
    pub cpu_cores_physical: usize,
    pub cpu_cores_logical: usize,
    pub cpu_mhz_base: f64,
    pub cpu_cache_kb: u64,
    pub total_memory: u64,
    pub boot_time: u64,
    pub virtualization: String,
    pub container: String,
    pub sysmon_version: String,
    pub sysmon_pid: u32,
    pub timezone: String,
}

/// A complete metrics snapshot for a single point in time. This is the object
/// broadcast on the WebSocket "fast" channel and returned by the REST
/// snapshot endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    /// Milliseconds since the UNIX epoch.
    pub timestamp: u64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub load: LoadMetrics,
    pub network: NetworkMetrics,
    pub disk: DiskMetrics,
    pub thermal: ThermalMetrics,
}

/// A compact time-series point retained in history ring buffers. Keeping this
/// small keeps memory usage low even with an hour of per-second history.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub t: u64,
    pub cpu: f32,
    pub mem: f32,
    pub swap: f32,
    pub load1: f32,
    pub net_rx: f32,
    pub net_tx: f32,
    pub disk_r: f32,
    pub disk_w: f32,
    pub temp: f32,
    pub procs_running: u32,
}

impl HistoryPoint {
    /// Build a compact history point from a full snapshot. Shared by the
    /// self-monitoring path (store.rs) and the per-agent ingest path so both
    /// produce byte-identical chart series.
    pub fn from_snapshot(snap: &MetricsSnapshot) -> Self {
        HistoryPoint {
            t: snap.timestamp,
            cpu: snap.cpu.usage as f32,
            mem: snap.memory.used_percent as f32,
            swap: snap.memory.swap_used_percent as f32,
            load1: snap.load.load1 as f32,
            net_rx: snap.network.total_rx_bytes_per_sec as f32,
            net_tx: snap.network.total_tx_bytes_per_sec as f32,
            disk_r: snap.disk.total_read_bytes_per_sec as f32,
            disk_w: snap.disk.total_write_bytes_per_sec as f32,
            temp: snap.thermal.max_temp as f32,
            procs_running: snap.cpu.procs_running as u32,
        }
    }
}
