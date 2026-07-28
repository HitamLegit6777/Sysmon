//! Safe readers for `/proc` and `/sys` pseudo-files. These files can vanish
//! or error mid-read (for example when a process exits between listing and
//! opening), so every helper degrades gracefully and never panics.

use std::fs;
use std::path::{Path, PathBuf};

/// Read a pseudo-file to a String, returning an empty string on any error.
pub fn read_to_string_safe<P: AsRef<Path>>(path: P) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Read the first line of a pseudo-file.
pub fn read_first_line<P: AsRef<Path>>(path: P) -> String {
    let content = read_to_string_safe(path);
    match content.find('\n') {
        Some(idx) => content[..idx].to_string(),
        None => content,
    }
}

/// Read a numeric pseudo-file (integer), returning `fallback` on error.
pub fn read_i64<P: AsRef<Path>>(path: P, fallback: i64) -> i64 {
    let content = read_to_string_safe(path);
    content.trim().parse::<i64>().unwrap_or(fallback)
}

/// Read a numeric pseudo-file (u64), returning `fallback` on error.
pub fn read_u64<P: AsRef<Path>>(path: P, fallback: u64) -> u64 {
    let content = read_to_string_safe(path);
    content.trim().parse::<u64>().unwrap_or(fallback)
}

/// List the entries of a directory, returning an empty vector on error.
pub fn read_dir_safe<P: AsRef<Path>>(path: P) -> Vec<PathBuf> {
    match fs::read_dir(path) {
        Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(_) => Vec::new(),
    }
}

/// List directory entry file names as strings.
pub fn read_dir_names<P: AsRef<Path>>(path: P) -> Vec<String> {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Whether a path exists.
pub fn exists<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref().exists()
}

/// Read the target of a symlink, returning empty string on error.
pub fn read_link_safe<P: AsRef<Path>>(path: P) -> String {
    fs::read_link(path)
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
        .unwrap_or_default()
}

/// Parse a whitespace-delimited line into tokens, collapsing runs of spaces.
pub fn tokenize(line: &str) -> Vec<&str> {
    line.split_whitespace().collect()
}

/// Parse a `key: value` formatted block (like /proc/meminfo) into pairs.
/// Returns a vector to preserve order and avoid hashing overhead for small
/// files; callers can look up by scanning or build a map if needed.
pub fn parse_key_value(content: &str, separator: char) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in content.lines() {
        if let Some(idx) = line.find(separator) {
            let key = line[..idx].trim().to_string();
            let value = line[idx + 1..].trim().to_string();
            if !key.is_empty() {
                out.push((key, value));
            }
        }
    }
    out
}

/// Extract the leading integer from a string like "16324516 kB".
pub fn parse_leading_u64(value: &str) -> u64 {
    let trimmed = value.trim();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().unwrap_or(0)
}

/// Whether the host exposes a usable procfs (i.e. we are on Linux).
pub fn has_procfs() -> bool {
    Path::new("/proc/stat").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize() {
        assert_eq!(tokenize("  a  b   c "), vec!["a", "b", "c"]);
    }

    #[test]
    fn test_parse_key_value() {
        let content = "MemTotal:       16324516 kB\nMemFree:  100 kB\n";
        let pairs = parse_key_value(content, ':');
        assert_eq!(pairs[0].0, "MemTotal");
        assert_eq!(pairs[0].1, "16324516 kB");
        assert_eq!(pairs[1].0, "MemFree");
    }

    #[test]
    fn test_parse_leading_u64() {
        assert_eq!(parse_leading_u64("16324516 kB"), 16324516);
        assert_eq!(parse_leading_u64("  42"), 42);
        assert_eq!(parse_leading_u64("nope"), 0);
    }
}
