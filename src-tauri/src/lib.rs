use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct PtyState {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    shell_pid: Mutex<Option<u32>>,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct GitStatus {
    branch: Option<String>,
    ahead: i32,
    behind: i32,
    entries: HashMap<String, String>,
}

// Builds a std Command that doesn't flash a console window on Windows.
fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn home_path() -> Option<std::ffi::OsString> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
    }
}

// On Windows there is no lsof: the PowerShell prompt writes its cwd to this file instead.
#[cfg(windows)]
fn cwd_file() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("branch-cwd-{}.txt", std::process::id()))
}

// Wraps the user's prompt so every prompt records the current directory.
// No double quotes in here: it goes through the Windows command line as a single argument.
#[cfg(windows)]
const PS_INIT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
$OutputEncoding = [Text.Encoding]::UTF8; \
$global:BranchPrompt = $function:prompt; \
function global:prompt { \
try { [IO.File]::WriteAllText($env:BRANCH_CWD_FILE, $executionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath) } catch {}; \
& $global:BranchPrompt }";

#[cfg(not(windows))]
fn shell_command() -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    CommandBuilder::new(shell)
}

#[cfg(windows)]
fn shell_command() -> CommandBuilder {
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoExit", "-Command", PS_INIT]);
    cmd.env("BRANCH_CWD_FILE", cwd_file());
    cmd
}

#[cfg(not(windows))]
fn cd_command(path: &str) -> String {
    let escaped = path.replace('\'', "'\\''");
    format!("cd '{}' && clear\n", escaped)
}

#[cfg(windows)]
fn cd_command(path: &str) -> String {
    let escaped = path.replace('\'', "''");
    format!("Set-Location -LiteralPath '{}'; Clear-Host\r", escaped)
}

#[cfg(not(windows))]
fn foreground_pgid(pid: u32) -> Result<Option<String>, String> {
    let out = command("ps")
        .args(["-o", "tpgid=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    let tpgid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tpgid.is_empty() {
        Ok(None)
    } else {
        Ok(Some(tpgid))
    }
}

// Windows has no foreground process group: follow the most recent child chain from the shell.
// Returns (name without .exe, full command line), or None when the shell itself is idle.
#[cfg(windows)]
fn foreground_info(shell_pid: u32) -> Option<(String, String)> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );

    let shell = Pid::from_u32(shell_pid);
    let mut current = shell;
    for _ in 0..32 {
        let child = sys
            .processes()
            .values()
            .filter(|p| p.parent() == Some(current))
            .filter(|p| !p.name().eq_ignore_ascii_case("conhost.exe"))
            .max_by_key(|p| p.start_time());
        match child {
            Some(p) => current = p.pid(),
            None => break,
        }
    }
    if current == shell {
        return None;
    }

    let process = sys.process(current)?;
    let cmdline = process
        .cmd()
        .iter()
        .map(|a| a.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let raw = process.name().to_string_lossy().to_lowercase();
    let mut name = raw.strip_suffix(".exe").unwrap_or(&raw).to_string();
    // Claude Code installed through npm runs as node.exe
    if cmdline.contains("claude-code") {
        name = "claude".to_string();
    }
    Some((name, cmdline))
}

#[tauri::command]
fn start_shell(app: tauri::AppHandle, state: State<PtyState>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command();
    if let Some(home) = home_path() {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    *state.shell_pid.lock().unwrap() = child.process_id();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    *state.writer.lock().unwrap() = Some(writer);
    *state.master.lock().unwrap() = Some(pair.master);

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app.emit("pty-data", chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn write_to_pty(data: String, state: State<PtyState>) -> Result<(), String> {
    let mut guard = state.writer.lock().unwrap();
    if let Some(writer) = guard.as_mut() {
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("shell not started".into())
    }
}

#[tauri::command]
fn resize_pty(cols: u16, rows: u16, state: State<PtyState>) -> Result<(), String> {
    let guard = state.master.lock().unwrap();
    if let Some(master) = guard.as_ref() {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    } else {
        Err("shell not started".into())
    }
}

#[tauri::command]
fn cd_to(path: String, state: State<PtyState>) -> Result<(), String> {
    write_to_pty(cd_command(&path), state)
}

fn is_hidden(entry: &fs::DirEntry, file_name: &str) -> bool {
    if file_name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(meta) = entry.metadata() {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    #[cfg(not(windows))]
    let _ = entry;
    false
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&entry, &file_name) {
                return None;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            Some(DirEntry {
                name: file_name,
                path: path.to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
fn foreground_process(state: State<PtyState>) -> Result<String, String> {
    let pid = state
        .shell_pid
        .lock()
        .unwrap()
        .ok_or_else(|| "shell not started".to_string())?;

    #[cfg(windows)]
    {
        Ok(foreground_info(pid).map(|(name, _)| name).unwrap_or_default())
    }

    #[cfg(not(windows))]
    {
        let tpgid = match foreground_pgid(pid)? {
            Some(v) => v,
            None => return Ok(String::new()),
        };

        let comm_out = command("ps")
            .args(["-o", "comm=", "-p", &tpgid])
            .output()
            .map_err(|e| e.to_string())?;
        let comm = String::from_utf8_lossy(&comm_out.stdout).trim().to_string();
        let name = comm.rsplit('/').next().unwrap_or(&comm).to_string();
        Ok(name)
    }
}

#[tauri::command]
fn foreground_command(state: State<PtyState>) -> Result<String, String> {
    let pid = state
        .shell_pid
        .lock()
        .unwrap()
        .ok_or_else(|| "shell not started".to_string())?;

    #[cfg(windows)]
    {
        Ok(foreground_info(pid).map(|(_, cmd)| cmd).unwrap_or_default())
    }

    #[cfg(not(windows))]
    {
        let tpgid = match foreground_pgid(pid)? {
            Some(v) => v,
            None => return Ok(String::new()),
        };

        let args_out = command("ps")
            .args(["-o", "args=", "-p", &tpgid])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&args_out.stdout).trim().to_string())
    }
}

#[tauri::command]
fn shell_cwd(state: State<PtyState>) -> Result<String, String> {
    let pid = state
        .shell_pid
        .lock()
        .unwrap()
        .ok_or_else(|| "shell not started".to_string())?;

    #[cfg(windows)]
    {
        let _ = pid;
        let cwd = fs::read_to_string(cwd_file()).map_err(|_| "cwd not found".to_string())?;
        let cwd = cwd.trim();
        if cwd.is_empty() {
            Err("cwd not found".to_string())
        } else {
            Ok(cwd.to_string())
        }
    }

    #[cfg(not(windows))]
    {
        let out = command("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(path) = line.strip_prefix('n') {
                return Ok(path.to_string());
            }
        }
        Err("cwd not found".to_string())
    }
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    home_path()
        .map(|h| h.to_string_lossy().to_string())
        .ok_or_else(|| "home directory not set".to_string())
}

#[tauri::command]
fn parent_dir(path: String) -> Result<String, String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "no parent".to_string())
}

#[tauri::command]
fn dir_size(path: String) -> Result<u64, String> {
    fn walk(path: &Path, budget: &mut u32) -> u64 {
        if *budget == 0 {
            return 0;
        }
        let mut total = 0u64;
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.filter_map(|e| e.ok()) {
                if *budget == 0 {
                    break;
                }
                *budget -= 1;
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.is_dir() {
                    total += walk(&entry.path(), budget);
                } else {
                    total += meta.len();
                }
            }
        }
        total
    }

    let mut budget: u32 = 50_000;
    Ok(walk(Path::new(&path), &mut budget))
}

#[tauri::command]
fn open_in_editor(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // VS Code's launcher is a .cmd script on Windows
    let code = if cfg!(windows) { "code.cmd" } else { "code" };
    let code_result = command(code).arg(&path).status();
    if matches!(code_result, Ok(status) if status.success()) {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(&path, None::<&str>)
            .map_err(|e| e.to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        command("open")
            .arg(&path)
            .status()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

// git prints forward slashes; on Windows the tree uses backslashes, so the keys must match.
fn repo_path(toplevel: &str, relative: &str) -> String {
    let full = Path::new(toplevel).join(relative).to_string_lossy().to_string();
    if cfg!(windows) {
        full.replace('/', "\\")
    } else {
        full
    }
}

#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let out = command("git")
        .args(["-C", &path, "status", "--porcelain=v2", "--branch"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git repository".to_string());
    }

    let toplevel_out = command("git")
        .args(["-C", &path, "rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| e.to_string())?;
    let toplevel = String::from_utf8_lossy(&toplevel_out.stdout).trim().to_string();

    let text = String::from_utf8_lossy(&out.stdout);
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = HashMap::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() == 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // ordinary changed entry: "1 <xy> ... <path>"
            let mut parts = rest.splitn(2, ' ');
            let xy = parts.next().unwrap_or("");
            if let Some(file_part) = line.rsplit(' ').next() {
                entries.insert(repo_path(&toplevel, file_part), xy.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            let xy = rest.split_whitespace().next().unwrap_or("");
            if let Some(file_part) = line.rsplit(' ').next() {
                entries.insert(repo_path(&toplevel, file_part), xy.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            entries.insert(repo_path(&toplevel, rest), "??".to_string());
        }
    }

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        entries,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState {
            master: Mutex::new(None),
            writer: Mutex::new(None),
            shell_pid: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            start_shell,
            write_to_pty,
            resize_pty,
            cd_to,
            list_dir,
            home_dir,
            parent_dir,
            foreground_process,
            foreground_command,
            shell_cwd,
            dir_size,
            open_in_editor,
            delete_path,
            git_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
