//! Formatting helpers for human-readable byte counts, rates, durations,
//! and percentages. Pure functions, fully unit-tested at the bottom.

/// IEC (1024-based) byte unit suffixes.
const IEC_UNITS: [&str; 7] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/// SI (1000-based) byte unit suffixes.
const SI_UNITS: [&str; 7] = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];

/// Format a byte count into a human readable string using IEC units.
pub fn format_bytes(bytes: u64) -> String {
    format_bytes_opts(bytes as f64, 1, true)
}

/// Format a byte count with configurable decimals and unit base.
pub fn format_bytes_opts(bytes: f64, decimals: usize, iec: bool) -> String {
    if bytes == 0.0 {
        return format!("0 {}", if iec { IEC_UNITS[0] } else { SI_UNITS[0] });
    }
    let base = if iec { 1024.0 } else { 1000.0 };
    let units = if iec { &IEC_UNITS } else { &SI_UNITS };
    let negative = bytes < 0.0;
    let mut value = bytes.abs();
    let mut unit_index = 0usize;
    while value >= base && unit_index < units.len() - 1 {
        value /= base;
        unit_index += 1;
    }
    format!(
        "{}{:.*} {}",
        if negative { "-" } else { "" },
        decimals,
        value,
        units[unit_index]
    )
}

/// Format a per-second byte rate.
pub fn format_rate(bytes_per_second: f64) -> String {
    format!("{}/s", format_bytes_opts(bytes_per_second, 1, true))
}

/// Format a duration in seconds into a compact `d h m s` string.
pub fn format_uptime(seconds: u64) -> String {
    let s = seconds % 60;
    let m = (seconds / 60) % 60;
    let h = (seconds / 3600) % 24;
    let d = seconds / 86400;
    let mut parts: Vec<String> = Vec::new();
    if d > 0 {
        parts.push(format!("{}d", d));
    }
    if h > 0 || d > 0 {
        parts.push(format!("{}h", h));
    }
    if m > 0 || h > 0 || d > 0 {
        parts.push(format!("{}m", m));
    }
    parts.push(format!("{}s", s));
    parts.join(" ")
}

/// Clamp a floating point value into an inclusive range.
pub fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Round to a fixed number of decimals.
pub fn round_to(value: f64, decimals: u32) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    (value * factor).round() / factor
}

/// Format a percentage (0..100) with fixed decimals.
pub fn format_percent(value: f64, decimals: usize) -> String {
    format!("{:.*}%", decimals, value)
}

/// Compute a per-second rate from two cumulative counter samples and a
/// delta in milliseconds. Handles counter resets by returning 0.
pub fn compute_rate(current: u64, previous: u64, delta_ms: u64) -> f64 {
    if delta_ms == 0 || current < previous {
        return 0.0;
    }
    let delta = (current - previous) as f64;
    (delta / delta_ms as f64) * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_bytes_zero() {
        assert_eq!(format_bytes(0), "0 B");
    }

    #[test]
    fn test_format_bytes_kib() {
        assert_eq!(format_bytes(1536), "1.5 KiB");
    }

    #[test]
    fn test_format_bytes_gib() {
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GiB");
    }

    #[test]
    fn test_format_uptime() {
        assert_eq!(format_uptime(90061), "1d 1h 1m 1s");
        assert_eq!(format_uptime(59), "59s");
        assert_eq!(format_uptime(61), "1m 1s");
    }

    #[test]
    fn test_compute_rate() {
        assert_eq!(compute_rate(2000, 1000, 1000), 1000.0);
        assert_eq!(compute_rate(1000, 2000, 1000), 0.0); // counter reset
        assert_eq!(compute_rate(1000, 1000, 0), 0.0);
    }

    #[test]
    fn test_round_to() {
        assert_eq!(round_to(3.14159, 2), 3.14);
        assert_eq!(round_to(2.5, 0), 3.0);
    }

    #[test]
    fn test_clamp() {
        assert_eq!(clamp_f64(5.0, 0.0, 10.0), 5.0);
        assert_eq!(clamp_f64(-1.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp_f64(11.0, 0.0, 10.0), 10.0);
    }
}
