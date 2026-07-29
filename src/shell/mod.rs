//! Web shell: a PTY-backed interactive terminal streamed over a WebSocket.
//! Gated behind both authentication and the `--enable-shell` flag, because it
//! grants command execution as the server's user.

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

/// A client→server control message on the shell socket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    /// Raw keystrokes to write to the PTY.
    Input { data: String },
    /// Terminal resize.
    Resize { cols: u16, rows: u16 },
}

/// Handle a shell session. Spawns a login shell in a PTY; forwards PTY output
/// to `out_tx` (as UTF-8 chunks) and accepts input via the returned sender.
///
/// Returns `(input_tx, ())`; the caller drives the WebSocket read/write loops.
pub struct ShellSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl ShellSession {
    /// Spawn a new PTY running the user's default shell (falls back to /bin/sh).
    pub fn spawn(cols: u16, rows: u16) -> std::io::Result<(Self, mpsc::UnboundedReceiver<Vec<u8>>)> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        // Slave handle is owned by the child now; drop our copy.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

        // Reader loop on a blocking thread, forwarding chunks to an async channel.
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((ShellSession { writer, master: pair.master, _child: child }, rx))
    }

    /// Write user input to the PTY.
    pub fn write_input(&mut self, data: &[u8]) {
        let _ = self.writer.write_all(data);
        let _ = self.writer.flush();
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

/// Wrap a session for shared mutable access from the WebSocket task.
pub type SharedShell = Arc<parking_lot::Mutex<ShellSession>>;
