//! Thermal collector. Reads temperatures from `/sys/class/thermal/thermal_zone*`,
//! cooling device states from `/sys/class/thermal/cooling_device*`, and battery
//! and AC-power status from `/sys/class/power_supply/*`.

use crate::state::metrics::{CoolingDevice, ThermalMetrics, ThermalZone};
use crate::util::procfs;

pub struct ThermalCollector;

impl ThermalCollector {
    pub fn new() -> Self {
        ThermalCollector
    }

    fn collect_zones() -> Vec<ThermalZone> {
        let mut zones = Vec::new();
        for entry in procfs::read_dir_names("/sys/class/thermal") {
            if !entry.starts_with("thermal_zone") {
                continue;
            }
            let base = format!("/sys/class/thermal/{}", entry);
            let milli = procfs::read_i64(format!("{}/temp", base), i64::MIN);
            if milli == i64::MIN {
                continue;
            }
            let zone_type = procfs::read_first_line(format!("{}/type", base))
                .trim()
                .to_string();
            zones.push(ThermalZone {
                name: entry,
                zone_type,
                temp_celsius: crate::util::format::round_to(milli as f64 / 1000.0, 1),
            });
        }
        zones.sort_by(|a, b| a.name.cmp(&b.name));
        zones
    }

    fn collect_cooling() -> Vec<CoolingDevice> {
        let mut devices = Vec::new();
        for entry in procfs::read_dir_names("/sys/class/thermal") {
            if !entry.starts_with("cooling_device") {
                continue;
            }
            let base = format!("/sys/class/thermal/{}", entry);
            let cur_state = procfs::read_i64(format!("{}/cur_state", base), 0);
            let max_state = procfs::read_i64(format!("{}/max_state", base), 0);
            let device_type = procfs::read_first_line(format!("{}/type", base))
                .trim()
                .to_string();
            let percent = if max_state > 0 {
                crate::util::format::round_to((cur_state as f64 / max_state as f64) * 100.0, 0)
            } else {
                0.0
            };
            devices.push(CoolingDevice {
                name: entry,
                device_type,
                cur_state,
                max_state,
                percent,
            });
        }
        devices.sort_by(|a, b| a.name.cmp(&b.name));
        devices
    }

    fn collect_power() -> (bool, f64, String, bool) {
        let mut battery_present = false;
        let mut battery_percent = 0.0;
        let mut battery_status = String::new();
        let mut on_ac = false;

        for entry in procfs::read_dir_names("/sys/class/power_supply") {
            let base = format!("/sys/class/power_supply/{}", entry);
            let ps_type = procfs::read_first_line(format!("{}/type", base))
                .trim()
                .to_string();
            if ps_type == "Battery" {
                battery_present = true;
                battery_percent = procfs::read_i64(format!("{}/capacity", base), 0) as f64;
                battery_status = procfs::read_first_line(format!("{}/status", base))
                    .trim()
                    .to_string();
            } else if ps_type == "Mains" || entry.starts_with("AC") || entry.starts_with("ADP") {
                let online = procfs::read_i64(format!("{}/online", base), 0);
                if online == 1 {
                    on_ac = true;
                }
            }
        }

        (battery_present, battery_percent, battery_status, on_ac)
    }

    pub fn collect(&mut self) -> ThermalMetrics {
        let zones = Self::collect_zones();
        let cooling = Self::collect_cooling();
        let (battery_present, battery_percent, battery_status, on_ac_power) = Self::collect_power();

        let mut max_temp = 0.0f64;
        let mut sum = 0.0f64;
        let mut n = 0.0f64;
        for z in &zones {
            if z.temp_celsius > max_temp {
                max_temp = z.temp_celsius;
            }
            sum += z.temp_celsius;
            n += 1.0;
        }
        let avg_temp = if n > 0.0 {
            crate::util::format::round_to(sum / n, 1)
        } else {
            0.0
        };

        ThermalMetrics {
            zones,
            cooling,
            max_temp,
            avg_temp,
            battery_present,
            battery_percent,
            battery_status,
            on_ac_power,
        }
    }
}

impl Default for ThermalCollector {
    fn default() -> Self {
        Self::new()
    }
}
