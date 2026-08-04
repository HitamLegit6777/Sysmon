//! Authentication: a single-admin credential store with Argon2-hashed
//! passwords, opaque session tokens, and JSON persistence. Credentials and UI
//! preferences change at runtime (Profile page), so they live in their own file
//! alongside the config rather than inside the read-only app config.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use parking_lot::{Mutex, RwLock};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a session stays valid without activity (seconds).
const SESSION_TTL_SECS: u64 = 12 * 60 * 60; // 12 hours
const MAX_SESSIONS: usize = 128;
const MAX_FAILURES: u32 = 5;
const FAILURE_WINDOW_SECS: u64 = 60;
const LOCKOUT_SECS: u64 = 60;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Per-user UI preferences persisted server-side so they follow the account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub theme: String,
    pub accent: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Preferences {
            theme: "dark".into(),
            accent: "violet".into(),
        }
    }
}

/// The on-disk auth document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AuthDoc {
    username: String,
    /// Argon2 PHC string.
    password_hash: String,
    preferences: Preferences,
}

impl Default for AuthDoc {
    fn default() -> Self {
        AuthDoc {
            username: "admin".into(),
            password_hash: hash_password("admin123")
                .expect("Argon2 default parameters must produce a password hash"),
            preferences: Preferences::default(),
        }
    }
}

/// A live session.
#[derive(Clone)]
struct Session {
    username: String,
    expires_at: u64,
}

#[derive(Clone, Default)]
struct LoginAttempt {
    failures: u32,
    window_started: u64,
    locked_until: u64,
}

/// Shared authentication state.
#[derive(Clone)]
pub struct Auth {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    doc: RwLock<AuthDoc>,
    sessions: RwLock<HashMap<String, Session>>,
    login_attempts: RwLock<HashMap<String, LoginAttempt>>,
    default_credentials: AtomicBool,
    dummy_password_hash: String,
    persist_lock: Mutex<()>,
    path: PathBuf,
}

fn secure_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let mut file = options.open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = options.open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    std::fs::rename(tmp, path)
}

/// Argon2id hash of a plaintext password, returned as a PHC string.
fn hash_password(plain: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|hash| hash.to_string())
}

/// A random URL-safe 256-bit session token.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    // Simple hex encoding; no external base64 needed for cookie safety.
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

impl Auth {
    /// Load the auth document from `path`, creating it with default credentials
    /// (admin / admin123) if it does not yet exist.
    pub fn load(path: PathBuf) -> Self {
        let doc = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<AuthDoc>(&text) {
                Ok(doc)
                    if PasswordHash::new(&doc.password_hash).is_ok()
                        && !doc.username.is_empty() =>
                {
                    doc
                }
                Ok(_) | Err(_) => {
                    // Fail closed: a damaged credential file must never restore
                    // the well-known default password.
                    tracing::error!(
                        "auth file {} is invalid; login disabled until repaired",
                        path.display()
                    );
                    AuthDoc {
                        username: String::new(),
                        password_hash: String::new(),
                        preferences: Preferences::default(),
                    }
                }
            },
            Err(_) => {
                let d = AuthDoc::default();
                if let Ok(json) = serde_json::to_string_pretty(&d) {
                    if let Err(e) = secure_write(&path, json.as_bytes()) {
                        tracing::error!("failed to create auth file {}: {}", path.display(), e);
                    }
                }
                d
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let default_credentials = PasswordHash::new(&doc.password_hash)
            .ok()
            .and_then(|hash| Argon2::default().verify_password(b"admin123", &hash).ok())
            .is_some();
        let dummy_password_hash = hash_password("sysmon-dummy-password")
            .expect("Argon2 default parameters must produce a password hash");
        Auth {
            inner: Arc::new(AuthInner {
                doc: RwLock::new(doc),
                sessions: RwLock::new(HashMap::new()),
                login_attempts: RwLock::new(HashMap::new()),
                default_credentials: AtomicBool::new(default_credentials),
                dummy_password_hash,
                persist_lock: Mutex::new(()),
                path,
            }),
        }
    }

    fn persist_doc(&self, doc: &AuthDoc) -> Result<(), &'static str> {
        let _persist = self.inner.persist_lock.lock();
        let json = serde_json::to_string_pretty(doc).map_err(|_| "Failed to encode auth data")?;
        secure_write(&self.inner.path, json.as_bytes()).map_err(|e| {
            tracing::error!(
                "failed to persist auth file {}: {}",
                self.inner.path.display(),
                e
            );
            "Failed to persist auth data"
        })
    }

    /// Current username.
    pub fn username(&self) -> String {
        self.inner.doc.read().username.clone()
    }

    /// Current UI preferences.
    pub fn preferences(&self) -> Preferences {
        self.inner.doc.read().preferences.clone()
    }

    pub fn uses_default_credentials(&self) -> bool {
        self.inner.default_credentials.load(Ordering::Relaxed)
    }

    /// Verify credentials; on success create and return a fresh session token.
    pub fn login(&self, username: &str, password: &str) -> Option<String> {
        if username.len() > 64 || password.len() > 1024 {
            return None;
        }
        let doc = self.inner.doc.read();
        // Always perform one Argon2 verification so an attacker cannot discover
        // the username from a much faster rejection path.
        let username_matches = username == doc.username && !doc.username.is_empty();
        let hash = if username_matches {
            &doc.password_hash
        } else {
            &self.inner.dummy_password_hash
        };
        let parsed = PasswordHash::new(hash).ok()?;
        let password_matches = Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok();
        if !username_matches || !password_matches {
            return None;
        }
        drop(doc);

        let token = new_token();
        let now = now_secs();
        let mut sessions = self.inner.sessions.write();
        sessions.retain(|_, session| session.expires_at >= now);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(token, _)| token.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            token.clone(),
            Session {
                username: username.to_string(),
                expires_at: now_secs() + SESSION_TTL_SECS,
            },
        );
        Some(token)
    }

    /// Per-peer brute-force protection. Returns retry-after seconds when locked.
    pub fn login_allowed(&self, peer: &str) -> Result<(), u64> {
        let now = now_secs();
        let mut attempts = self.inner.login_attempts.write();
        attempts.retain(|_, a| {
            a.locked_until > now || now.saturating_sub(a.window_started) <= FAILURE_WINDOW_SECS
        });
        let attempt = attempts.entry(peer.to_string()).or_default();
        if attempt.locked_until > now {
            Err(attempt.locked_until - now)
        } else {
            Ok(())
        }
    }

    pub fn record_login_result(&self, peer: &str, success: bool) {
        let now = now_secs();
        let mut attempts = self.inner.login_attempts.write();
        if success {
            attempts.remove(peer);
            return;
        }
        let attempt = attempts.entry(peer.to_string()).or_default();
        if attempt.window_started == 0
            || now.saturating_sub(attempt.window_started) > FAILURE_WINDOW_SECS
        {
            attempt.window_started = now;
            attempt.failures = 0;
        }
        attempt.failures += 1;
        if attempt.failures >= MAX_FAILURES {
            attempt.locked_until = now + LOCKOUT_SECS;
        }
    }

    /// Return the username for a valid, unexpired session, refreshing its TTL.
    pub fn validate(&self, token: &str) -> Option<String> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut sessions = self.inner.sessions.write();
        let sess = sessions.get_mut(token)?;
        let now = now_secs();
        if sess.expires_at <= now {
            sessions.remove(token);
            return None;
        }
        sess.expires_at = now + SESSION_TTL_SECS;
        Some(sess.username.clone())
    }

    /// Invalidate a session token.
    pub fn logout(&self, token: &str) {
        self.inner.sessions.write().remove(token);
    }

    /// Change the password after verifying the current one. Invalidates every
    /// session except the caller's so the successful request can finish cleanly.
    pub fn change_password(
        &self,
        current: &str,
        next: &str,
        current_token: Option<&str>,
    ) -> Result<(), &'static str> {
        if next.len() < 12 || next.len() > 1024 {
            return Err("New password must be 12-1024 characters");
        }
        {
            let doc = self.inner.doc.read();
            let parsed = PasswordHash::new(&doc.password_hash).map_err(|_| "corrupt hash")?;
            Argon2::default()
                .verify_password(current.as_bytes(), &parsed)
                .map_err(|_| "Current password is incorrect")?;
        }
        let mut doc = self.inner.doc.write();
        let mut updated = doc.clone();
        updated.password_hash = hash_password(next).map_err(|_| "Failed to hash password")?;
        self.persist_doc(&updated)?;
        *doc = updated;
        self.inner
            .default_credentials
            .store(false, Ordering::Relaxed);
        self.inner
            .sessions
            .write()
            .retain(|token, _| current_token == Some(token.as_str()));
        Ok(())
    }

    /// Change the username after confirming the password. Keeps the caller's
    /// session and updates its identity; invalidates every other session.
    pub fn change_username(
        &self,
        current_password: &str,
        next: &str,
        current_token: Option<&str>,
    ) -> Result<(), &'static str> {
        let next = next.trim();
        if next.is_empty() || next.len() > 32 {
            return Err("Username must be 1-32 characters");
        }
        {
            let doc = self.inner.doc.read();
            let parsed = PasswordHash::new(&doc.password_hash).map_err(|_| "corrupt hash")?;
            Argon2::default()
                .verify_password(current_password.as_bytes(), &parsed)
                .map_err(|_| "Current password is incorrect")?;
        }
        let mut doc = self.inner.doc.write();
        let mut updated = doc.clone();
        updated.username = next.to_string();
        self.persist_doc(&updated)?;
        *doc = updated;
        let mut sessions = self.inner.sessions.write();
        sessions.retain(|token, _| current_token == Some(token.as_str()));
        for session in sessions.values_mut() {
            session.username = next.to_string();
        }
        Ok(())
    }

    /// Persist updated UI preferences.
    pub fn set_preferences(&self, prefs: Preferences) -> Result<(), &'static str> {
        if !matches!(prefs.theme.as_str(), "dark" | "light") {
            return Err("Unsupported theme");
        }
        if !matches!(
            prefs.accent.as_str(),
            "blue" | "violet" | "emerald" | "amber" | "rose"
        ) {
            return Err("Unsupported accent");
        }
        let mut doc = self.inner.doc.write();
        let mut updated = doc.clone();
        updated.preferences = prefs;
        self.persist_doc(&updated)?;
        *doc = updated;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_auth() -> Auth {
        let mut p = std::env::temp_dir();
        p.push(format!("sysmon-auth-test-{}.json", new_token()));
        Auth::load(p)
    }

    #[test]
    fn default_credentials_work() {
        let a = temp_auth();
        assert_eq!(a.username(), "admin");
        assert!(a.login("admin", "admin123").is_some());
        assert!(a.login("admin", "wrong").is_none());
        assert!(a.login("root", "admin123").is_none());
    }

    #[test]
    fn session_validate_and_logout() {
        let a = temp_auth();
        let token = a.login("admin", "admin123").unwrap();
        assert_eq!(a.validate(&token).as_deref(), Some("admin"));
        a.logout(&token);
        assert!(a.validate(&token).is_none());
    }

    #[test]
    fn change_password_flow() {
        let a = temp_auth();
        assert!(a.change_password("wrong", "newpass", None).is_err());
        assert!(a.change_password("admin123", "abc", None).is_err()); // too short
        assert!(a.change_password("admin123", "newpass12345", None).is_ok());
        assert!(a.login("admin", "admin123").is_none());
        assert!(a.login("admin", "newpass12345").is_some());
    }

    #[test]
    fn change_username_flow() {
        let a = temp_auth();
        assert!(a.change_username("admin123", "operator", None).is_ok());
        assert_eq!(a.username(), "operator");
        assert!(a.login("operator", "admin123").is_some());
    }

    #[test]
    fn corrupt_auth_file_fails_closed() {
        let mut p = std::env::temp_dir();
        p.push(format!("sysmon-auth-corrupt-{}.json", new_token()));
        std::fs::write(&p, b"not-json").unwrap();
        let a = Auth::load(p.clone());
        assert!(a.login("admin", "admin123").is_none());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn login_attempts_are_rate_limited_and_success_resets_them() {
        let a = temp_auth();
        for _ in 0..MAX_FAILURES {
            assert!(a.login_allowed("peer-a").is_ok());
            a.record_login_result("peer-a", false);
        }
        assert!(a.login_allowed("peer-a").is_err());
        assert!(a.login_allowed("peer-b").is_ok());
        a.record_login_result("peer-b", false);
        a.record_login_result("peer-b", true);
        assert!(a.login_allowed("peer-b").is_ok());
    }

    #[test]
    fn preferences_are_allowlisted() {
        let a = temp_auth();
        assert!(a
            .set_preferences(Preferences {
                theme: "dark".into(),
                accent: "blue".into()
            })
            .is_ok());
        assert!(a
            .set_preferences(Preferences {
                theme: "<script>".into(),
                accent: "blue".into()
            })
            .is_err());
        assert!(a
            .set_preferences(Preferences {
                theme: "dark".into(),
                accent: "url(evil)".into()
            })
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn auth_file_permissions_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::env::temp_dir();
        p.push(format!("sysmon-auth-mode-{}.json", new_token()));
        let _a = Auth::load(p.clone());
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_file(p);
    }
}
