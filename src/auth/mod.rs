//! Authentication: a single-admin credential store with Argon2-hashed
//! passwords, opaque session tokens, and JSON persistence. Credentials and UI
//! preferences change at runtime (Profile page), so they live in their own file
//! alongside the config rather than inside the read-only app config.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use parking_lot::RwLock;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a session stays valid without activity (seconds).
const SESSION_TTL_SECS: u64 = 12 * 60 * 60; // 12 hours

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
        Preferences { theme: "dark".into(), accent: "violet".into() }
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
            password_hash: hash_password("admin123"),
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

/// Shared authentication state.
#[derive(Clone)]
pub struct Auth {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    doc: RwLock<AuthDoc>,
    sessions: RwLock<HashMap<String, Session>>,
    path: PathBuf,
}

/// Argon2id hash of a plaintext password, returned as a PHC string.
fn hash_password(plain: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|h| h.to_string())
        .unwrap_or_default()
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
            Ok(text) => serde_json::from_str::<AuthDoc>(&text).unwrap_or_default(),
            Err(_) => {
                let d = AuthDoc::default();
                // Best-effort write of the initial document.
                if let Ok(json) = serde_json::to_string_pretty(&d) {
                    let _ = std::fs::write(&path, json);
                }
                d
            }
        };
        Auth {
            inner: Arc::new(AuthInner {
                doc: RwLock::new(doc),
                sessions: RwLock::new(HashMap::new()),
                path,
            }),
        }
    }

    fn persist(&self) {
        let doc = self.inner.doc.read().clone();
        if let Ok(json) = serde_json::to_string_pretty(&doc) {
            let _ = std::fs::write(&self.inner.path, json);
        }
    }

    /// Current username.
    pub fn username(&self) -> String {
        self.inner.doc.read().username.clone()
    }

    /// Current UI preferences.
    pub fn preferences(&self) -> Preferences {
        self.inner.doc.read().preferences.clone()
    }

    /// Verify credentials; on success create and return a fresh session token.
    pub fn login(&self, username: &str, password: &str) -> Option<String> {
        let doc = self.inner.doc.read();
        if username != doc.username {
            return None;
        }
        let parsed = PasswordHash::new(&doc.password_hash).ok()?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .ok()?;
        drop(doc);

        let token = new_token();
        self.inner.sessions.write().insert(
            token.clone(),
            Session { username: username.to_string(), expires_at: now_secs() + SESSION_TTL_SECS },
        );
        Some(token)
    }

    /// Return the username for a valid, unexpired session, refreshing its TTL.
    pub fn validate(&self, token: &str) -> Option<String> {
        let mut sessions = self.inner.sessions.write();
        let sess = sessions.get_mut(token)?;
        if sess.expires_at < now_secs() {
            sessions.remove(token);
            return None;
        }
        sess.expires_at = now_secs() + SESSION_TTL_SECS;
        Some(sess.username.clone())
    }

    /// Invalidate a session token.
    pub fn logout(&self, token: &str) {
        self.inner.sessions.write().remove(token);
    }

    /// Change the password after verifying the current one. Invalidates all
    /// existing sessions on success (forces re-login everywhere).
    pub fn change_password(&self, current: &str, next: &str) -> Result<(), &'static str> {
        if next.len() < 6 {
            return Err("New password must be at least 6 characters");
        }
        {
            let doc = self.inner.doc.read();
            let parsed = PasswordHash::new(&doc.password_hash).map_err(|_| "corrupt hash")?;
            Argon2::default()
                .verify_password(current.as_bytes(), &parsed)
                .map_err(|_| "Current password is incorrect")?;
        }
        self.inner.doc.write().password_hash = hash_password(next);
        self.persist();
        self.inner.sessions.write().clear();
        Ok(())
    }

    /// Change the username (requires the current password for confirmation).
    pub fn change_username(&self, current_password: &str, next: &str) -> Result<(), &'static str> {
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
        self.inner.doc.write().username = next.to_string();
        self.persist();
        Ok(())
    }

    /// Persist updated UI preferences.
    pub fn set_preferences(&self, prefs: Preferences) {
        self.inner.doc.write().preferences = prefs;
        self.persist();
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
        assert!(a.change_password("wrong", "newpass").is_err());
        assert!(a.change_password("admin123", "abc").is_err()); // too short
        assert!(a.change_password("admin123", "newpass123").is_ok());
        assert!(a.login("admin", "admin123").is_none());
        assert!(a.login("admin", "newpass123").is_some());
    }

    #[test]
    fn change_username_flow() {
        let a = temp_auth();
        assert!(a.change_username("admin123", "operator").is_ok());
        assert_eq!(a.username(), "operator");
        assert!(a.login("operator", "admin123").is_some());
    }
}
