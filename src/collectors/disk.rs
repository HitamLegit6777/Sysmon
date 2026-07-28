//! Disk collector. Reports two things:
//!   1. Mounted filesystem capacity via the `statvfs` syscall over entries in
//!      `/proc/mounts` (filtered to real, non-virtual filesystems).
//!   2. Per-block-device I/O counters and derived rates from `/proc/diskstats`.
//!
//! `statvfs` is invoked through a tiny FFI binding so we avoid pulling in an
//! external crate while still getting accurate free/used/inode figures.

use crate::state::metrics::{BlockDeviceIo, DiskMetrics, FilesystemUsage};
use crate::util::procfs;
use std::collections::HashMap;
use std::ffi::CString;

// Minimal FFI for statvfs. The struct layout matches glibc on Linux x86_64.
#[repr(C)]
#[derive(Default)]
struct StatVfs {
    f_bsize: u64,
    f_frsize: u64,
    f_blocks: u64,
    f_bfree: u64,
    f_bavail: u64,
    f_files: u64,
    f_ffree: u64,
    f_favail: u64,
    f_fsid: u64,
    f_flag: u64,
    f_namemax: u64,
    f_spare: [u32; 6],
}

extern "C" {
    fn statvfs(path: *const std::os::raw::c_char, buf: *mut StatVfs) -> std::os::raw::c_int;
}

/// Filesystem types that are virtual/pseudo and should be excluded from the
/// capacity view because they do not represent real storage.
const VIRTUAL_FS: &[&str] = &[
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "securityfs", "cgroup",
    "cgroup2", "pstore", "bpf", "autofs", "mqueue", "debugfs", "tracefs",
    "hugetlbfs", "fusectl", "configfs", "ramfs", "binfmt_misc", "rpc_pipefs",
    "nsfs", "overlay", "squashfs",
];

fn is_virtual_fs(fs_type: &str) -> bool {
    VIRTUAL_FS.contains(&fs_type)
}

#[derive(Debug, Clone, Copy, Default)]
struct DiskStat {
    reads_completed: u64,
    sectors_read: u64,
    writes_completed: u64,
    sectors_written: u64,
    io_in_progress: u64,
    io_time_ms: u64,
}

pub struct DiskCollector {
    prev_stats: HashMap<String, DiskStat>,
    prev_time_ms: u64,
}

impl DiskCollector {
    pub fn new() -> Self {
        DiskCollector {
            prev_stats: HashMap::new(),
            prev_time_ms: 0,
        }
    }

    /// Call statvfs on a mount point, returning None on failure.
    fn stat_fs(mount_point: &str) -> Option<StatVfs> {
        let c_path = CString::new(mount_point).ok()?;
        let mut buf = StatVfs::default();
        let rc = unsafe { statvfs(c_path.as_ptr(), &mut buf) };
        if rc == 0 {
            Some(buf)
        } else {
            None
        }
    }

    /// Parse /proc/mounts into (device, mount_point, fs_type) tuples,
    /// de-duplicating by mount point and skipping virtual filesystems.
    fn read_mounts() -> Vec<(String, String, String)> {
        let content = procfs::read_to_string_safe("/proc/mounts");
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for line in content.lines() {
            let tokens = procfs::tokenize(line);
            if tokens.len() < 3 {
                continue;
            }
            let device = tokens[0].to_string();
            let mount_point = tokens[1].replace("\\040", " ");
            let fs_type = tokens[2].to_string();
            if is_virtual_fs(&fs_type) {
                continue;
            }
            // Only include real devices (path-like) or network mounts.
            if !device.starts_with('/') && !device.contains(':') {
                continue;
            }
            if seen.insert(mount_point.clone()) {
                out.push((device, mount_point, fs_type));
            }
        }
        out
    }

    fn collect_filesystems() -> Vec<FilesystemUsage> {
        let mounts = Self::read_mounts();
        let mut out = Vec::new();
        for (device, mount_point, fs_type) in mounts {
            let Some(vfs) = Self::stat_fs(&mount_point) else {
                continue;
            };
            let block_size = if vfs.f_frsize > 0 {
                vfs.f_frsize
            } else {
                vfs.f_bsize
            };
            let total = vfs.f_blocks * block_size;
            let available = vfs.f_bavail * block_size;
            let free = vfs.f_bfree * block_size;
            let used = total.saturating_sub(free);
            if total == 0 {
                continue;
            }
            let used_percent =
                crate::util::format::round_to((used as f64 / total as f64) * 100.0, 1);

            let inodes_total = vfs.f_files;
            let inodes_free = vfs.f_ffree;
            let inodes_used = inodes_total.saturating_sub(inodes_free);
            let inodes_used_percent = if inodes_total > 0 {
                crate::util::format::round_to(
                    (inodes_used as f64 / inodes_total as f64) * 100.0,
                    1,
                )
            } else {
                0.0
            };

            out.push(FilesystemUsage {
                device,
                mount_point,
                fs_type,
                total,
                used,
                available,
                used_percent,
                inodes_total,
                inodes_used,
                inodes_free,
                inodes_used_percent,
            });
        }
        out.sort_by(|a, b| b.total.cmp(&a.total));
        out
    }

    /// Whether a diskstats device name is a whole disk we care about (skip
    /// loopback and ram devices; keep sd*, nvme*, vd*, mmcblk*, dm-*).
    fn is_interesting_device(name: &str) -> bool {
        if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("fd") {
            return false;
        }
        true
    }

    fn collect_devices(&mut self, delta_ms: u64) -> Vec<BlockDeviceIo> {
        let content = procfs::read_to_string_safe("/proc/diskstats");
        let mut current: HashMap<String, DiskStat> = HashMap::new();
        let mut out = Vec::new();
        let rate = crate::util::format::compute_rate;
        const SECTOR_SIZE: u64 = 512;

        for line in content.lines() {
            let tokens = procfs::tokenize(line);
            if tokens.len() < 14 {
                continue;
            }
            let name = tokens[2].to_string();
            if !Self::is_interesting_device(&name) {
                continue;
            }
            let g = |i: usize| -> u64 { tokens.get(i).and_then(|s| s.parse().ok()).unwrap_or(0) };
            let stat = DiskStat {
                reads_completed: g(3),
                sectors_read: g(5),
                writes_completed: g(7),
                sectors_written: g(9),
                io_in_progress: g(11),
                io_time_ms: g(12),
            };
            current.insert(name.clone(), stat);

            let prev = self.prev_stats.get(&name).copied().unwrap_or_default();
            let read_bps = rate(stat.sectors_read * SECTOR_SIZE, prev.sectors_read * SECTOR_SIZE, delta_ms);
            let write_bps = rate(stat.sectors_written * SECTOR_SIZE, prev.sectors_written * SECTOR_SIZE, delta_ms);
            let read_ops = rate(stat.reads_completed, prev.reads_completed, delta_ms);
            let write_ops = rate(stat.writes_completed, prev.writes_completed, delta_ms);
            let util = if delta_ms > 0 {
                let busy = stat.io_time_ms.saturating_sub(prev.io_time_ms) as f64;
                crate::util::format::clamp_f64((busy / delta_ms as f64) * 100.0, 0.0, 100.0)
            } else {
                0.0
            };

            // Only surface devices with activity or that are whole disks.
            let is_whole = !name.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false)
                || name.starts_with("nvme")
                || name.starts_with("mmcblk");
            if !is_whole && read_bps == 0.0 && write_bps == 0.0 {
                continue;
            }

            out.push(BlockDeviceIo {
                name,
                reads_completed: stat.reads_completed,
                writes_completed: stat.writes_completed,
                sectors_read: stat.sectors_read,
                sectors_written: stat.sectors_written,
                read_bytes_per_sec: read_bps,
                write_bytes_per_sec: write_bps,
                read_ops_per_sec: read_ops,
                write_ops_per_sec: write_ops,
                io_in_progress: stat.io_in_progress,
                io_time_ms: stat.io_time_ms,
                util_percent: crate::util::format::round_to(util, 1),
            });
        }

        out.sort_by(|a, b| {
            (b.read_bytes_per_sec + b.write_bytes_per_sec)
                .partial_cmp(&(a.read_bytes_per_sec + a.write_bytes_per_sec))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.prev_stats = current;
        out
    }

    pub fn collect(&mut self) -> DiskMetrics {
        let now_ms = crate::state::now_millis();
        let delta_ms = if self.prev_time_ms == 0 {
            0
        } else {
            now_ms.saturating_sub(self.prev_time_ms)
        };

        let filesystems = Self::collect_filesystems();
        let devices = self.collect_devices(delta_ms);
        self.prev_time_ms = now_ms;

        let mut total_capacity = 0u64;
        let mut total_used = 0u64;
        let mut max_used_percent = 0.0f64;
        for fs in &filesystems {
            total_capacity += fs.total;
            total_used += fs.used;
            if fs.used_percent > max_used_percent {
                max_used_percent = fs.used_percent;
            }
        }
        let total_read: f64 = devices.iter().map(|d| d.read_bytes_per_sec).sum();
        let total_write: f64 = devices.iter().map(|d| d.write_bytes_per_sec).sum();

        DiskMetrics {
            filesystems,
            devices,
            total_capacity,
            total_used,
            max_used_percent,
            total_read_bytes_per_sec: total_read,
            total_write_bytes_per_sec: total_write,
        }
    }
}

impl Default for DiskCollector {
    fn default() -> Self {
        Self::new()
    }
}
