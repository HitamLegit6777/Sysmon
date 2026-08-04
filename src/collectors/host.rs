//! Host information collector. Gathers relatively static facts about the
//! machine: hostname, kernel, OS release, CPU model, core counts, memory size,
//! boot time, and a best-effort virtualization/container hint. Meant to be
//! sampled once at startup and refreshed occasionally.

use crate::state::metrics::HostInfo;
use crate::util::procfs;

pub struct HostCollector;

impl HostCollector {
    pub fn new() -> Self {
        HostCollector
    }

    fn read_hostname() -> String {
        let h = procfs::read_first_line("/proc/sys/kernel/hostname");
        if !h.is_empty() {
            return h.trim().to_string();
        }
        procfs::read_first_line("/etc/hostname").trim().to_string()
    }

    fn read_kernel() -> (String, String) {
        let ostype = procfs::read_first_line("/proc/sys/kernel/ostype");
        let release = procfs::read_first_line("/proc/sys/kernel/osrelease");
        (ostype.trim().to_string(), release.trim().to_string())
    }

    fn read_os_release() -> (String, String, String) {
        let content = procfs::read_to_string_safe("/etc/os-release");
        let mut name = String::new();
        let mut version = String::new();
        let mut pretty = String::new();
        for line in content.lines() {
            if let Some(v) = line.strip_prefix("NAME=") {
                name = Self::unquote(v);
            } else if let Some(v) = line.strip_prefix("VERSION=") {
                version = Self::unquote(v);
            } else if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                pretty = Self::unquote(v);
            }
        }
        (name, version, pretty)
    }

    fn unquote(s: &str) -> String {
        s.trim().trim_matches('"').to_string()
    }

    fn read_cpu_info() -> (String, String, f64, u64, usize) {
        let content = procfs::read_to_string_safe("/proc/cpuinfo");
        let mut model = String::new();
        let mut vendor = String::new();
        let mut mhz = 0.0;
        let mut cache_kb = 0u64;
        let mut physical_ids = std::collections::HashSet::new();
        for line in content.lines() {
            if let Some(v) = line.split_once(':') {
                let key = v.0.trim();
                let val = v.1.trim();
                match key {
                    "model name" if model.is_empty() => model = val.to_string(),
                    "vendor_id" if vendor.is_empty() => vendor = val.to_string(),
                    "cpu MHz" if mhz == 0.0 => mhz = val.parse().unwrap_or(0.0),
                    "cache size" if cache_kb == 0 => cache_kb = procfs::parse_leading_u64(val),
                    "physical id" => {
                        physical_ids.insert(val.to_string());
                    }
                    _ => {}
                }
            }
        }
        let physical = physical_ids.len().max(1);
        (model, vendor, mhz, cache_kb, physical)
    }

    fn read_boot_time() -> u64 {
        let content = procfs::read_to_string_safe("/proc/stat");
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("btime ") {
                return rest.trim().parse().unwrap_or(0);
            }
        }
        0
    }

    fn detect_virtualization() -> (String, String) {
        // Best-effort detection. Container hints come from cgroup and marker
        // files; hypervisor hints come from DMI product name.
        let mut container = String::new();
        if procfs::exists("/.dockerenv") {
            container = "docker".to_string();
        } else if std::env::var("KUBERNETES_SERVICE_HOST").is_ok() {
            container = "kubernetes".to_string();
        } else {
            let cgroup = procfs::read_to_string_safe("/proc/1/cgroup");
            if cgroup.contains("docker") {
                container = "docker".to_string();
            } else if cgroup.contains("lxc") {
                container = "lxc".to_string();
            } else if cgroup.contains("kubepods") {
                container = "kubernetes".to_string();
            }
        }

        let mut virt = String::new();
        let product = procfs::read_first_line("/sys/class/dmi/id/product_name");
        let p = product.to_lowercase();
        if p.contains("virtualbox") {
            virt = "virtualbox".to_string();
        } else if p.contains("vmware") {
            virt = "vmware".to_string();
        } else if p.contains("kvm") || p.contains("qemu") {
            virt = "kvm".to_string();
        } else if p.contains("bochs") {
            virt = "bochs".to_string();
        }
        if virt.is_empty() {
            let vendor = procfs::read_to_string_safe("/proc/cpuinfo");
            if vendor.contains("hypervisor") {
                virt = "vm".to_string();
            } else {
                virt = "bare-metal".to_string();
            }
        }
        (virt, container)
    }

    fn read_timezone() -> String {
        let link = procfs::read_link_safe("/etc/localtime");
        if let Some(idx) = link.find("zoneinfo/") {
            return link[idx + "zoneinfo/".len()..].to_string();
        }
        std::env::var("TZ").unwrap_or_else(|_| "UTC".to_string())
    }

    pub fn collect(&mut self) -> HostInfo {
        let (kernel, kernel_version) = Self::read_kernel();
        let (os_name, os_version, os_pretty) = Self::read_os_release();
        let (cpu_model, cpu_vendor, cpu_mhz_base, cpu_cache_kb, physical) = Self::read_cpu_info();
        let (virtualization, container) = Self::detect_virtualization();

        let total_memory = {
            let content = procfs::read_to_string_safe("/proc/meminfo");
            let mut mem = 0;
            for line in content.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    mem = procfs::parse_leading_u64(rest) * 1024;
                    break;
                }
            }
            mem
        };

        HostInfo {
            hostname: Self::read_hostname(),
            kernel,
            kernel_version,
            os_name,
            os_version,
            os_pretty,
            architecture: std::env::consts::ARCH.to_string(),
            cpu_model: cpu_model.trim().to_string(),
            cpu_vendor,
            cpu_cores_physical: physical,
            cpu_cores_logical: num_cpus::get(),
            cpu_mhz_base: crate::util::format::round_to(cpu_mhz_base, 0),
            cpu_cache_kb,
            total_memory,
            boot_time: Self::read_boot_time(),
            virtualization,
            container,
            sysmon_version: env!("CARGO_PKG_VERSION").to_string(),
            sysmon_pid: std::process::id(),
            timezone: Self::read_timezone(),
        }
    }
}

impl Default for HostCollector {
    fn default() -> Self {
        Self::new()
    }
}
