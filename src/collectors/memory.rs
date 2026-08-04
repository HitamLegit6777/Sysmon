//! Memory collector. Parses `/proc/meminfo` into structured memory and swap
//! metrics. All values are normalized to bytes (meminfo reports kB).

use crate::state::metrics::MemoryMetrics;
use crate::util::procfs;
use std::collections::HashMap;

pub struct MemoryCollector;

impl MemoryCollector {
    pub fn new() -> Self {
        MemoryCollector
    }

    pub fn collect(&mut self) -> MemoryMetrics {
        let content = procfs::read_to_string_safe("/proc/meminfo");
        let mut map: HashMap<String, u64> = HashMap::new();
        for line in content.lines() {
            if let Some(idx) = line.find(':') {
                let key = line[..idx].trim().to_string();
                let value = procfs::parse_leading_u64(&line[idx + 1..]);
                let bytes = if line[idx + 1..].split_whitespace().nth(1) == Some("kB") {
                    value.saturating_mul(1024)
                } else {
                    value
                };
                map.insert(key, bytes);
            }
        }

        let get = |k: &str| -> u64 { *map.get(k).unwrap_or(&0) };

        let total = get("MemTotal");
        let free = get("MemFree");
        let available = if map.contains_key("MemAvailable") {
            get("MemAvailable")
        } else {
            // Fallback approximation when MemAvailable is absent.
            free + get("Buffers") + get("Cached")
        };
        let buffers = get("Buffers");
        let cached = get("Cached");
        let used = total.saturating_sub(available);
        let used_percent = if total > 0 {
            crate::util::format::round_to((used as f64 / total as f64) * 100.0, 1)
        } else {
            0.0
        };

        let swap_total = get("SwapTotal");
        let swap_free = get("SwapFree");
        let swap_used = swap_total.saturating_sub(swap_free);
        let swap_used_percent = if swap_total > 0 {
            crate::util::format::round_to((swap_used as f64 / swap_total as f64) * 100.0, 1)
        } else {
            0.0
        };

        MemoryMetrics {
            total,
            free,
            available,
            used,
            buffers,
            cached,
            shared: get("Shmem"),
            slab: get("Slab"),
            used_percent,
            swap_total,
            swap_free,
            swap_used,
            swap_used_percent,
            active: get("Active"),
            inactive: get("Inactive"),
            dirty: get("Dirty"),
            writeback: get("Writeback"),
            mapped: get("Mapped"),
            committed_as: get("Committed_AS"),
            commit_limit: get("CommitLimit"),
            page_tables: get("PageTables"),
            kernel_stack: get("KernelStack"),
            huge_pages_total: get("HugePages_Total"),
            huge_pages_free: get("HugePages_Free"),
        }
    }
}

impl Default for MemoryCollector {
    fn default() -> Self {
        Self::new()
    }
}
