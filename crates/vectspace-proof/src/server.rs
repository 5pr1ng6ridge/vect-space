//! Persistent line-JSON Lean process. All stdout reads happen off the calling thread.
use crate::check::LeanConfig;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

impl LeanConfig {
    /// Resolve environment overrides or the pinned elan toolchain and built server.
    pub fn discover(lean_dir: &Path) -> Result<Self, String> {
        let missing = |what: &str| format!("缺少{what}；请安装 elan 并运行 npm run lean:build");
        let sysroot = if let Some(p) = std::env::var_os("VECTSPACE_LEAN_SYSROOT") {
            p.into()
        } else {
            let toolchain = std::fs::read_to_string(lean_dir.join("lean-toolchain"))
                .map_err(|_| missing(" lean/lean-toolchain"))?;
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .ok_or_else(|| missing("用户主目录"))?;
            std::path::PathBuf::from(home)
                .join(".elan/toolchains")
                .join(toolchain.trim().replace('/', "--").replace(':', "---"))
        };
        let exe = if cfg!(windows) {
            "vectproofd.exe"
        } else {
            "vectproofd"
        };
        let server = std::env::var_os("VECTSPACE_PROOF_SERVER")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| lean_dir.join(".lake/build/bin").join(exe));
        let lean_path = lean_dir.join(".lake/build/lib/lean");
        if !sysroot
            .join("bin")
            .join(if cfg!(windows) { "lean.exe" } else { "lean" })
            .is_file()
        {
            return Err(missing(&format!(" Lean 工具链 {}", sysroot.display())));
        }
        if !server.is_file() {
            return Err(missing(&format!("证明服务 {}", server.display())));
        }
        if !lean_path.join("VectProof.olean").is_file() {
            return Err(missing(&format!(" Lean 编译模块 {}", lean_path.display())));
        }
        Ok(Self {
            sysroot,
            server,
            lean_path,
            timeout: Duration::from_secs(10),
        })
    }
}
#[derive(Debug)]
pub(crate) enum ServerError {
    Timeout,
    Crash(String),
}
pub(crate) struct Server {
    child: Child,
    input: ChildStdin,
    lines: Receiver<Result<Value, String>>,
    ready: bool,
    next_id: u64,
}
impl Server {
    pub fn spawn(config: &LeanConfig) -> Result<Self, ServerError> {
        let mut command = Command::new(&config.server);
        let paths = std::iter::once(config.sysroot.join("bin"))
            .chain(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ))
            .collect::<Vec<_>>();
        let path = std::env::join_paths(paths).map_err(|e| ServerError::Crash(e.to_string()))?;
        command
            .env("PATH", path)
            .env("LEAN_SYSROOT", &config.sysroot)
            .env("LEAN_PATH", &config.lean_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| ServerError::Crash(e.to_string()))?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let value = line
                    .map_err(|e| e.to_string())
                    .and_then(|l| serde_json::from_str(&l).map_err(|e| e.to_string()));
                if tx.send(value).is_err() {
                    return;
                }
            }
        });
        Ok(Self {
            child,
            input,
            lines,
            ready: false,
            next_id: 0,
        })
    }
    fn receive(&self, deadline: Instant) -> Result<Value, ServerError> {
        let timeout = deadline.saturating_duration_since(Instant::now());
        match self.lines.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(e)) => Err(ServerError::Crash(e)),
            Err(RecvTimeoutError::Timeout) => Err(ServerError::Timeout),
            Err(RecvTimeoutError::Disconnected) => {
                Err(ServerError::Crash("Lean 服务已退出".into()))
            }
        }
    }
    pub fn request(&mut self, source: &str, timeout: Duration) -> Result<Value, ServerError> {
        if !self.ready {
            // Importing the pinned environment is startup work, separate from proof execution.
            let ready = self.receive(Instant::now() + Duration::from_secs(60))?;
            if ready["ready"] != true {
                return Err(ServerError::Crash(format!(
                    "invalid ready message: {ready}"
                )));
            }
            self.ready = true;
        }
        self.next_id += 1;
        let id = self.next_id;
        let request = serde_json::json!({"id":id,"source":source});
        let deadline = Instant::now() + timeout;
        writeln!(self.input, "{request}")
            .and_then(|_| self.input.flush())
            .map_err(|e| ServerError::Crash(e.to_string()))?;
        let response = self.receive(deadline)?;
        if response["id"] != id || response.get("error").is_some() {
            return Err(ServerError::Crash(format!(
                "invalid Lean response: {response}"
            )));
        }
        Ok(response)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
