//! Network collector. Parses `/proc/net/dev` for per-interface byte and packet
//! counters, computes per-second rates from deltas, and enriches each
//! interface with operational state, speed, MAC, and MTU from `/sys/class/net`.
//! Also counts TCP/UDP sockets from `/proc/net/tcp*` and `/proc/net/udp*`.

use crate::state::metrics::{NetInterface, NetworkMetrics};
use crate::util::procfs;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default)]
struct IfCounters {
    rx_bytes: u64,
    tx_bytes: u64,
    rx_packets: u64,
    tx_packets: u64,
    rx_errors: u64,
    tx_errors: u64,
    rx_dropped: u64,
    tx_dropped: u64,
}

pub struct NetworkCollector {
    prev: HashMap<String, IfCounters>,
    prev_time_ms: u64,
}

impl NetworkCollector {
    pub fn new() -> Self {
        NetworkCollector {
            prev: HashMap::new(),
            prev_time_ms: 0,
        }
    }

    fn parse_net_dev() -> HashMap<String, IfCounters> {
        let content = procfs::read_to_string_safe("/proc/net/dev");
        let mut map = HashMap::new();
        for line in content.lines() {
            let Some(colon) = line.find(':') else { continue };
            let name = line[..colon].trim().to_string();
            if name.is_empty() {
                continue;
            }
            let rest = &line[colon + 1..];
            let fields: Vec<u64> = rest
                .split_whitespace()
                .map(|s| s.parse().unwrap_or(0))
                .collect();
            if fields.len() < 16 {
                continue;
            }
            // Field layout per /proc/net/dev:
            // rx: bytes packets errs drop fifo frame compressed multicast
            // tx: bytes packets errs drop fifo colls carrier compressed
            let c = IfCounters {
                rx_bytes: fields[0],
                rx_packets: fields[1],
                rx_errors: fields[2],
                rx_dropped: fields[3],
                tx_bytes: fields[8],
                tx_packets: fields[9],
                tx_errors: fields[10],
                tx_dropped: fields[11],
            };
            map.insert(name, c);
        }
        map
    }

    fn read_iface_state(name: &str) -> (bool, i64, String, u64) {
        let base = format!("/sys/class/net/{}", name);
        let operstate = procfs::read_first_line(format!("{}/operstate", base));
        let is_up = operstate.trim() == "up";
        let speed = procfs::read_i64(format!("{}/speed", base), -1);
        let mac = procfs::read_first_line(format!("{}/address", base))
            .trim()
            .to_string();
        let mtu = procfs::read_u64(format!("{}/mtu", base), 0);
        (is_up, speed, mac, mtu)
    }

    fn count_sockets() -> (u64, u64, u64) {
        // Count non-header lines in tcp/tcp6 and udp/udp6. For TCP also count
        // sockets in the LISTEN state (0A in the st column).
        let mut tcp = 0u64;
        let mut udp = 0u64;
        let mut listening = 0u64;
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            let content = procfs::read_to_string_safe(path);
            for (i, line) in content.lines().enumerate() {
                if i == 0 {
                    continue; // header
                }
                let tokens = procfs::tokenize(line);
                if tokens.len() > 3 {
                    tcp += 1;
                    if tokens[3] == "0A" {
                        listening += 1;
                    }
                }
            }
        }
        for path in ["/proc/net/udp", "/proc/net/udp6"] {
            let content = procfs::read_to_string_safe(path);
            udp += content.lines().count().saturating_sub(1) as u64;
        }
        (tcp, udp, listening)
    }

    pub fn collect(&mut self) -> NetworkMetrics {
        let current = Self::parse_net_dev();
        let now_ms = crate::state::now_millis();
        let delta_ms = if self.prev_time_ms == 0 {
            0
        } else {
            now_ms.saturating_sub(self.prev_time_ms)
        };

        let mut interfaces = Vec::new();
        let mut total_rx_rate = 0.0;
        let mut total_tx_rate = 0.0;
        let mut total_rx_bytes = 0u64;
        let mut total_tx_bytes = 0u64;

        let rate = crate::util::format::compute_rate;

        for (name, cur) in &current {
            let (is_up, speed, mac, mtu) = Self::read_iface_state(name);
            let prev = self.prev.get(name);
            let (rx_rate, tx_rate, rx_pps, tx_pps) = if let Some(p) = prev {
                (
                    rate(cur.rx_bytes, p.rx_bytes, delta_ms),
                    rate(cur.tx_bytes, p.tx_bytes, delta_ms),
                    rate(cur.rx_packets, p.rx_packets, delta_ms),
                    rate(cur.tx_packets, p.tx_packets, delta_ms),
                )
            } else {
                (0.0, 0.0, 0.0, 0.0)
            };

            // Exclude the loopback interface from aggregate throughput.
            if name != "lo" {
                total_rx_rate += rx_rate;
                total_tx_rate += tx_rate;
                total_rx_bytes += cur.rx_bytes;
                total_tx_bytes += cur.tx_bytes;
            }

            interfaces.push(NetInterface {
                name: name.clone(),
                rx_bytes: cur.rx_bytes,
                tx_bytes: cur.tx_bytes,
                rx_packets: cur.rx_packets,
                tx_packets: cur.tx_packets,
                rx_errors: cur.rx_errors,
                tx_errors: cur.tx_errors,
                rx_dropped: cur.rx_dropped,
                tx_dropped: cur.tx_dropped,
                rx_bytes_per_sec: rx_rate,
                tx_bytes_per_sec: tx_rate,
                rx_packets_per_sec: rx_pps,
                tx_packets_per_sec: tx_pps,
                is_up,
                speed_mbps: speed,
                mac,
                mtu,
                addresses: Vec::new(),
            });
        }

        interfaces.sort_by(|a, b| {
            (b.rx_bytes_per_sec + b.tx_bytes_per_sec)
                .partial_cmp(&(a.rx_bytes_per_sec + a.tx_bytes_per_sec))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let (tcp, udp, listening) = Self::count_sockets();

        self.prev = current;
        self.prev_time_ms = now_ms;

        NetworkMetrics {
            interfaces,
            total_rx_bytes_per_sec: total_rx_rate,
            total_tx_bytes_per_sec: total_tx_rate,
            total_rx_bytes,
            total_tx_bytes,
            tcp_connections: tcp,
            udp_connections: udp,
            tcp_listening: listening,
        }
    }
}

impl Default for NetworkCollector {
    fn default() -> Self {
        Self::new()
    }
}
