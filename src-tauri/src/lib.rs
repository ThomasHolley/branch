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

fn foreground_pgid(pid: u32) -> Result<Option<String>, String> {
    let out = std::process::Command::new("ps")
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    if let Some(home) = std::env::var_os("HOME") {
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
    let escaped = path.replace('\'', "'\\''");
    let command = format!("cd '{}' && clear\n", escaped);
    write_to_pty(command, state)
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') {
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

    let tpgid = match foreground_pgid(pid)? {
        Some(v) => v,
        None => return Ok(String::new()),
    };

    let comm_out = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &tpgid])
        .output()
        .map_err(|e| e.to_string())?;
    let comm = String::from_utf8_lossy(&comm_out.stdout).trim().to_string();
    let name = comm.rsplit('/').next().unwrap_or(&comm).to_string();
    Ok(name)
}

#[tauri::command]
fn foreground_command(state: State<PtyState>) -> Result<String, String> {
    let pid = state
        .shell_pid
        .lock()
        .unwrap()
        .ok_or_else(|| "shell not started".to_string())?;

    let tpgid = match foreground_pgid(pid)? {
        Some(v) => v,
        None => return Ok(String::new()),
    };

    let args_out = std::process::Command::new("ps")
        .args(["-o", "args=", "-p", &tpgid])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&args_out.stdout).trim().to_string())
}

#[tauri::command]
fn shell_cwd(state: State<PtyState>) -> Result<String, String> {
    let pid = state
        .shell_pid
        .lock()
        .unwrap()
        .ok_or_else(|| "shell not started".to_string())?;

    let out = std::process::Command::new("lsof")
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

#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME not set".to_string())
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
fn open_in_editor(path: String) -> Result<(), String> {
    let code_result = std::process::Command::new("code").arg(&path).status();
    if matches!(code_result, Ok(status) if status.success()) {
        return Ok(());
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
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

#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let out = std::process::Command::new("git")
        .args(["-C", &path, "status", "--porcelain=v2", "--branch"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git repository".to_string());
    }

    let toplevel_out = std::process::Command::new("git")
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
                let full = Path::new(&toplevel).join(file_part);
                entries.insert(full.to_string_lossy().to_string(), xy.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            let xy = rest.split_whitespace().next().unwrap_or("");
            if let Some(file_part) = line.rsplit(' ').next() {
                let full = Path::new(&toplevel).join(file_part);
                entries.insert(full.to_string_lossy().to_string(), xy.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            let full = Path::new(&toplevel).join(rest);
            entries.insert(full.to_string_lossy().to_string(), "??".to_string());
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
