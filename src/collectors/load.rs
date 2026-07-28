//! Load and uptime collector. Reads `/proc/loadavg` and `/proc/uptime` and
//! normalizes load averages by the logical core count.

use crate::state::metrics::LoadMetrics;
use crate::util::procfs;

pub struct LoadCollector {
    core_count: f64,
}

impl LoadCollector {
    pub fn new() -> Self {
        LoadCollector {
            core_count: num_cpus::get().max(1) as f64,
        }
    }

    pub fn collect(&mut self) -> LoadMetrics {
        let loadavg = procfs::read_to_string_safe("/proc/loadavg");
        let tokens = procfs::tokenize(&loadavg);

        let load1 = tokens.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let load5 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let load15 = tokens.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);

        // Field 4 is "runnable/total"; field 5 is the last pid.
        let (runnable, total_procs) = tokens
            .get(3)
            .map(|s| {
                let mut it = s.split('/');
                let r = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let t = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                (r, t)
            })
            .unwrap_or((0, 0));
        let last_pid = tokens.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);

        let uptime = procfs::read_to_string_safe("/proc/uptime");
        let up_tokens = procfs::tokenize(&uptime);
        let uptime_seconds = up_tokens.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let idle_seconds = up_tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);

        let r2 = |v: f64| crate::util::format::round_to(v, 2);

        LoadMetrics {
            load1,
            load5,
            load15,
            load1_per_core: r2(load1 / self.core_count),
            load5_per_core: r2(load5 / self.core_count),
            load15_per_core: r2(load15 / self.core_count),
            runnable,
            total_procs,
            last_pid,
            uptime_seconds,
            idle_seconds,
        }
    }
}

impl Default for LoadCollector {
    fn default() -> Self {
        Self::new()
    }
}
