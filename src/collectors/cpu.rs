//! CPU collector. Parses `/proc/stat` for aggregate and per-core jiffies and
//! computes utilization from the delta between consecutive samples. Also reads
//! per-core scaling frequency from `/sys/devices/system/cpu`.

use crate::state::metrics::{CoreUsage, CpuMetrics};
use crate::util::procfs;

/// Raw cumulative jiffie counters from a single `cpu` line in /proc/stat.
#[derive(Copy, Clone, Default)]
struct CpuTimes {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
    guest: u64,
}

impl CpuTimes {
    /// Total of all counted jiffies. Guest time is already included in user
    /// and nice by the kernel, so it is not added again.
    fn total(&self) -> u64 {
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }

    fn idle_all(&self) -> u64 {
        self.idle + self.iowait
    }

    fn busy(&self) -> u64 {
        self.total().saturating_sub(self.idle_all())
    }
}

/// Parse a `cpu`/`cpuN` line's numeric fields into CpuTimes.
fn parse_cpu_line(tokens: &[&str]) -> CpuTimes {
    let g = |i: usize| -> u64 { tokens.get(i).and_then(|s| s.parse().ok()).unwrap_or(0) };
    CpuTimes {
        user: g(1),
        nice: g(2),
        system: g(3),
        idle: g(4),
        iowait: g(5),
        irq: g(6),
        softirq: g(7),
        steal: g(8),
        guest: g(9),
    }
}

/// Stateful CPU collector retaining the previous sample to compute deltas.
pub struct CpuCollector {
    prev_total: Option<CpuTimes>,
    prev_cores: Vec<CpuTimes>,
    prev_ctxt: u64,
    prev_processes: u64,
    prev_interrupts: u64,
    prev_time_ms: u64,
    core_count: usize,
}

impl CpuCollector {
    pub fn new() -> Self {
        CpuCollector {
            prev_total: None,
            prev_cores: Vec::new(),
            prev_ctxt: 0,
            prev_processes: 0,
            prev_interrupts: 0,
            prev_time_ms: 0,
            core_count: num_cpus::get(),
        }
    }

    /// Percentage busy between two samples of the same cpu line.
    fn usage_between(prev: &CpuTimes, cur: &CpuTimes) -> f64 {
        let total_delta = cur.total().saturating_sub(prev.total()) as f64;
        if total_delta <= 0.0 {
            return 0.0;
        }
        let busy_delta = cur.busy().saturating_sub(prev.busy()) as f64;
        crate::util::format::clamp_f64((busy_delta / total_delta) * 100.0, 0.0, 100.0)
    }

    /// Percentage of a specific field's delta relative to total delta.
    fn field_pct(prev_field: u64, cur_field: u64, prev_total: u64, cur_total: u64) -> f64 {
        let total_delta = cur_total.saturating_sub(prev_total) as f64;
        if total_delta <= 0.0 {
            return 0.0;
        }
        let field_delta = cur_field.saturating_sub(prev_field) as f64;
        crate::util::format::clamp_f64((field_delta / total_delta) * 100.0, 0.0, 100.0)
    }

    /// Read a single core's current scaling frequency in MHz.
    fn read_core_freq(core: usize) -> f64 {
        let path = format!(
            "/sys/devices/system/cpu/cpu{}/cpufreq/scaling_cur_freq",
            core
        );
        let khz = procfs::read_u64(&path, 0);
        khz as f64 / 1000.0
    }

    /// Collect a fresh CPU metrics sample.
    pub fn collect(&mut self) -> CpuMetrics {
        let stat = procfs::read_to_string_safe("/proc/stat");
        let now_ms = crate::state::now_millis();
        let delta_ms = if self.prev_time_ms == 0 {
            0
        } else {
            now_ms.saturating_sub(self.prev_time_ms)
        };

        let mut agg = CpuTimes::default();
        let mut cores: Vec<(usize, CpuTimes)> = Vec::new();
        let mut ctxt = 0u64;
        let mut processes = 0u64;
        let mut procs_running = 0u64;
        let mut procs_blocked = 0u64;
        let mut interrupts = 0u64;

        for line in stat.lines() {
            let tokens = procfs::tokenize(line);
            if tokens.is_empty() {
                continue;
            }
            match tokens[0] {
                "cpu" => agg = parse_cpu_line(&tokens),
                "ctxt" => ctxt = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
                "processes" => processes = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
                "procs_running" => {
                    procs_running = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0)
                }
                "procs_blocked" => {
                    procs_blocked = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0)
                }
                "intr" => interrupts = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
                other => {
                    if let Some(rest) = other.strip_prefix("cpu") {
                        if let Ok(idx) = rest.parse::<usize>() {
                            cores.push((idx, parse_cpu_line(&tokens)));
                        }
                    }
                }
            }
        }

        cores.sort_by_key(|(idx, _)| *idx);
        let core_count = cores.len().max(self.core_count);

        let mut metrics = CpuMetrics {
            core_count,
            ctxt,
            processes,
            procs_running,
            procs_blocked,
            interrupts,
            ..Default::default()
        };

        // Aggregate usage relative to the previous aggregate sample.
        if let Some(prev) = self.prev_total {
            metrics.usage = Self::usage_between(&prev, &agg);
            let pt = prev.total();
            let ct = agg.total();
            metrics.user = Self::field_pct(prev.user, agg.user, pt, ct);
            metrics.nice = Self::field_pct(prev.nice, agg.nice, pt, ct);
            metrics.system = Self::field_pct(prev.system, agg.system, pt, ct);
            metrics.idle = Self::field_pct(prev.idle, agg.idle, pt, ct);
            metrics.iowait = Self::field_pct(prev.iowait, agg.iowait, pt, ct);
            metrics.irq = Self::field_pct(prev.irq, agg.irq, pt, ct);
            metrics.softirq = Self::field_pct(prev.softirq, agg.softirq, pt, ct);
            metrics.steal = Self::field_pct(prev.steal, agg.steal, pt, ct);
            metrics.guest = Self::field_pct(prev.guest, agg.guest, pt, ct);
        }

        // Per-core usage relative to the previous per-core sample.
        let mut freq_sum: f64 = 0.0;
        let mut freq_min: f64 = f64::MAX;
        let mut freq_max: f64 = 0.0;
        let mut freq_n: f64 = 0.0;
        for (idx, cur) in &cores {
            let mut cu = CoreUsage {
                core: *idx,
                ..Default::default()
            };
            if let Some(prev) = self.prev_cores.get(*idx) {
                cu.usage = Self::usage_between(prev, cur);
                let pt = prev.total();
                let ct = cur.total();
                cu.user = Self::field_pct(prev.user, cur.user, pt, ct);
                cu.system = Self::field_pct(prev.system, cur.system, pt, ct);
                cu.nice = Self::field_pct(prev.nice, cur.nice, pt, ct);
                cu.idle = Self::field_pct(prev.idle, cur.idle, pt, ct);
                cu.iowait = Self::field_pct(prev.iowait, cur.iowait, pt, ct);
                cu.irq = Self::field_pct(prev.irq, cur.irq, pt, ct);
                cu.softirq = Self::field_pct(prev.softirq, cur.softirq, pt, ct);
                cu.steal = Self::field_pct(prev.steal, cur.steal, pt, ct);
            }
            let freq = Self::read_core_freq(*idx);
            cu.freq_mhz = freq;
            if freq > 0.0 {
                freq_sum += freq;
                freq_min = freq_min.min(freq);
                freq_max = freq_max.max(freq);
                freq_n += 1.0;
            }
            metrics.cores.push(cu);
        }

        if freq_n > 0.0 {
            metrics.avg_freq_mhz = crate::util::format::round_to(freq_sum / freq_n, 0);
            metrics.min_freq_mhz = crate::util::format::round_to(freq_min, 0);
            metrics.max_freq_mhz = crate::util::format::round_to(freq_max, 0);
        }

        // Rates for counters.
        metrics.ctxt_per_sec = crate::util::format::compute_rate(ctxt, self.prev_ctxt, delta_ms);
        metrics.forks_per_sec =
            crate::util::format::compute_rate(processes, self.prev_processes, delta_ms);
        metrics.interrupts_per_sec =
            crate::util::format::compute_rate(interrupts, self.prev_interrupts, delta_ms);

        // Round the aggregate percentages for a cleaner UI.
        metrics.usage = crate::util::format::round_to(metrics.usage, 1);
        metrics.user = crate::util::format::round_to(metrics.user, 1);
        metrics.system = crate::util::format::round_to(metrics.system, 1);
        metrics.iowait = crate::util::format::round_to(metrics.iowait, 1);

        // Save state for the next delta computation.
        self.prev_total = Some(agg);
        self.prev_cores = cores.into_iter().map(|(_, t)| t).collect();
        self.prev_ctxt = ctxt;
        self.prev_processes = processes;
        self.prev_interrupts = interrupts;
        self.prev_time_ms = now_ms;

        metrics
    }
}

impl Default for CpuCollector {
    fn default() -> Self {
        Self::new()
    }
}
