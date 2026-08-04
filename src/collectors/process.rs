//! Process collector. Enumerates `/proc/<pid>` entries and parses each
//! process's stat, status, and cmdline. Per-process CPU percentage is computed
//! from the delta of (utime + stime) jiffies between samples, divided by the
//! elapsed wall-clock jiffies across all cores.

use crate::state::metrics::{ProcessInfo, ProcessMetrics};
use crate::util::procfs;
use std::collections::HashMap;

/// Cached per-process CPU time from the previous sample.
#[derive(Debug, Clone, Copy, Default)]
struct PrevProc {
    total_time: u64, // utime + stime in jiffies
}

pub struct ProcessCollector {
    prev: HashMap<i64, PrevProc>,
    prev_time_ms: u64,
    clock_ticks: f64,
    page_size: u64,
    total_memory: u64,
    uid_cache: HashMap<u32, String>,
}

impl ProcessCollector {
    pub fn new() -> Self {
        let clock_ticks = Self::detect_clock_ticks();
        let page_size = Self::detect_page_size();
        let total_memory = Self::detect_total_memory();
        ProcessCollector {
            prev: HashMap::new(),
            prev_time_ms: 0,
            clock_ticks,
            page_size,
            total_memory,
            uid_cache: HashMap::new(),
        }
    }

    fn detect_clock_ticks() -> f64 {
        // sysconf(_SC_CLK_TCK) is almost universally 100 on Linux.
        100.0
    }

    fn detect_page_size() -> u64 {
        // sysconf(_SC_PAGESIZE); 4096 on typical x86_64 systems.
        4096
    }

    fn detect_total_memory() -> u64 {
        let content = procfs::read_to_string_safe("/proc/meminfo");
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                return procfs::parse_leading_u64(rest) * 1024;
            }
        }
        0
    }

    /// Resolve a UID to a username by scanning /etc/passwd, with caching.
    fn resolve_user(&mut self, uid: u32) -> String {
        if let Some(name) = self.uid_cache.get(&uid) {
            return name.clone();
        }
        let passwd = procfs::read_to_string_safe("/etc/passwd");
        for line in passwd.lines() {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() >= 3 {
                if let Ok(u) = fields[2].parse::<u32>() {
                    if u == uid {
                        let name = fields[0].to_string();
                        self.uid_cache.insert(uid, name.clone());
                        return name;
                    }
                }
            }
        }
        let fallback = uid.to_string();
        self.uid_cache.insert(uid, fallback.clone());
        fallback
    }
}

/// Parsed fields from /proc/<pid>/stat that we care about. The comm field can
/// contain spaces and parentheses, so we split around the final ')' to keep
/// the remaining fields aligned.
struct StatFields {
    comm: String,
    state: String,
    ppid: i64,
    utime: u64,
    stime: u64,
    priority: i64,
    nice: i64,
    num_threads: i64,
    start_time: u64,
    vsize: u64,
    rss_pages: u64,
}

fn parse_stat(content: &str) -> Option<StatFields> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    if close <= open {
        return None;
    }
    let comm = content[open + 1..close].to_string();
    let rest = content[close + 1..].trim();
    let f: Vec<&str> = rest.split_whitespace().collect();
    // After comm, field indices per proc(5) starting at "state" = f[0]:
    //   state=0 ppid=1 pgrp=2 session=3 tty=4 tpgid=5 flags=6
    //   minflt=7 cminflt=8 majflt=9 cmajflt=10 utime=11 stime=12
    //   cutime=13 cstime=14 priority=15 nice=16 num_threads=17
    //   itrealvalue=18 starttime=19 vsize=20 rss=21
    let g = |i: usize| -> u64 { f.get(i).and_then(|s| s.parse().ok()).unwrap_or(0) };
    let gi = |i: usize| -> i64 { f.get(i).and_then(|s| s.parse().ok()).unwrap_or(0) };
    Some(StatFields {
        comm,
        state: f.first().map(|s| s.to_string()).unwrap_or_default(),
        ppid: gi(1),
        utime: g(11),
        stime: g(12),
        priority: gi(15),
        nice: gi(16),
        num_threads: gi(17),
        start_time: g(19),
        vsize: g(20),
        rss_pages: g(21),
    })
}

fn state_label(code: &str) -> &'static str {
    match code.chars().next().unwrap_or('?') {
        'R' => "running",
        'S' => "sleeping",
        'D' => "disk-sleep",
        'Z' => "zombie",
        'T' => "stopped",
        't' => "tracing-stop",
        'X' | 'x' => "dead",
        'I' => "idle",
        'K' => "wakekill",
        'W' => "waking",
        'P' => "parked",
        _ => "unknown",
    }
}

impl ProcessCollector {
    /// Read the resolved command line, falling back to the comm name in
    /// brackets for kernel threads.
    fn read_cmdline(pid: i64, comm: &str) -> String {
        let raw = procfs::read_to_string_safe(format!("/proc/{}/cmdline", pid));
        if raw.is_empty() {
            return format!("[{}]", comm);
        }
        // cmdline is NUL-delimited; replace NULs with spaces.
        let joined: String = raw
            .split('\0')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if joined.is_empty() {
            format!("[{}]", comm)
        } else {
            joined
        }
    }

    /// Read the process UID from /proc/<pid>/status (Uid: line).
    fn read_uid(pid: i64) -> u32 {
        let status = procfs::read_to_string_safe(format!("/proc/{}/status", pid));
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                if let Some(first) = rest.split_whitespace().next() {
                    return first.parse().unwrap_or(0);
                }
            }
        }
        0
    }

    /// Count open file descriptors for a process.
    fn count_fds(pid: i64) -> u64 {
        procfs::read_dir_names(format!("/proc/{}/fd", pid)).len() as u64
    }

    /// Read cumulative read/write bytes from /proc/<pid>/io if permitted.
    fn read_io(pid: i64) -> (u64, u64) {
        let io = procfs::read_to_string_safe(format!("/proc/{}/io", pid));
        let mut rd = 0;
        let mut wr = 0;
        for line in io.lines() {
            if let Some(rest) = line.strip_prefix("read_bytes:") {
                rd = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("write_bytes:") {
                wr = rest.trim().parse().unwrap_or(0);
            }
        }
        (rd, wr)
    }

    pub fn collect(&mut self, limit: usize, want_io: bool) -> ProcessMetrics {
        let now_ms = crate::state::now_millis();
        let delta_ms = if self.prev_time_ms == 0 {
            0
        } else {
            now_ms.saturating_sub(self.prev_time_ms)
        };
        let core_count = num_cpus::get().max(1) as f64;
        // Total available CPU jiffies across all cores in this interval.
        let interval_jiffies = (delta_ms as f64 / 1000.0) * self.clock_ticks * core_count;

        let mut processes = Vec::new();
        let mut new_prev: HashMap<i64, PrevProc> = HashMap::new();
        let mut running = 0u64;
        let mut sleeping = 0u64;
        let mut stopped = 0u64;
        let mut zombie = 0u64;
        let mut total_threads = 0u64;

        for name in procfs::read_dir_names("/proc") {
            let Ok(pid) = name.parse::<i64>() else {
                continue;
            };
            let stat_raw = procfs::read_to_string_safe(format!("/proc/{}/stat", pid));
            let Some(sf) = parse_stat(&stat_raw) else {
                continue;
            };

            let total_time = sf.utime.saturating_add(sf.stime);
            new_prev.insert(pid, PrevProc { total_time });

            let cpu_percent = if interval_jiffies > 0.0 {
                if let Some(prev) = self.prev.get(&pid) {
                    let delta = total_time.saturating_sub(prev.total_time) as f64;
                    crate::util::format::clamp_f64(
                        (delta / interval_jiffies) * 100.0 * core_count,
                        0.0,
                        100.0 * core_count,
                    )
                } else {
                    0.0
                }
            } else {
                0.0
            };

            let rss_bytes = sf.rss_pages.saturating_mul(self.page_size);
            let mem_percent = if self.total_memory > 0 {
                crate::util::format::round_to(
                    (rss_bytes as f64 / self.total_memory as f64) * 100.0,
                    2,
                )
            } else {
                0.0
            };

            let state = state_label(&sf.state).to_string();
            match sf.state.chars().next().unwrap_or('?') {
                'R' => running += 1,
                'S' | 'D' | 'I' => sleeping += 1,
                'T' | 't' => stopped += 1,
                'Z' => zombie += 1,
                _ => {}
            }
            total_threads += sf.num_threads.max(0) as u64;

            let uid = Self::read_uid(pid);
            let (read_bytes, write_bytes) = if want_io { Self::read_io(pid) } else { (0, 0) };

            processes.push(ProcessInfo {
                pid,
                ppid: sf.ppid,
                name: sf.comm.clone(),
                cmdline: Self::read_cmdline(pid, &sf.comm),
                state,
                cpu_percent: crate::util::format::round_to(cpu_percent, 1),
                mem_percent,
                rss_bytes,
                vsize_bytes: sf.vsize,
                threads: sf.num_threads,
                user: self.resolve_user(uid),
                uid,
                priority: sf.priority,
                nice: sf.nice,
                start_time: sf.start_time,
                num_fds: if want_io { Self::count_fds(pid) } else { 0 },
                read_bytes,
                write_bytes,
            });
        }

        let total = processes.len() as u64;

        // Sort by CPU desc, then memory desc, and truncate to the limit for
        // the table view while keeping the summary counts accurate.
        processes.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.rss_bytes.cmp(&a.rss_bytes))
        });
        if limit > 0 && processes.len() > limit {
            processes.truncate(limit);
        }

        self.prev = new_prev;
        self.prev_time_ms = now_ms;

        ProcessMetrics {
            processes,
            total,
            running,
            sleeping,
            stopped,
            zombie,
            total_threads,
        }
    }
}

impl Default for ProcessCollector {
    fn default() -> Self {
        Self::new()
    }
}
