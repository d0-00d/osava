// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn homedir() -> Result<String, String> {
    std::env::var("USERPROFILE").map_err(|e| e.to_string())
}

// Holds the spawned backend sidecar so we can kill it when the app closes.
// Only exists in release builds — in dev you run `cd backend && npm run dev`.
#[cfg(not(debug_assertions))]
struct BackendProcess(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

// Breadcrumb so a failed sidecar spawn in the installed app is debuggable
// (release builds have no console). Written to %TEMP%\osava-sidecar.log.
#[cfg(not(debug_assertions))]
fn log_sidecar(msg: &str) {
    let _ = std::fs::write(std::env::temp_dir().join("osava-sidecar.log"), msg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // In the bundled app, launch the packaged Express backend so the
            // user only runs one thing. The splash's /health poll then connects
            // to it. Skipped in dev — you run `cd backend && npm run dev`.
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                use tauri_plugin_shell::ShellExt;
                match _app.shell().sidecar("osava-backend") {
                    Ok(cmd) => match cmd.spawn() {
                        Ok((_rx, child)) => {
                            log_sidecar("backend sidecar spawned");
                            _app.manage(BackendProcess(std::sync::Mutex::new(Some(child))));
                        }
                        Err(e) => log_sidecar(&format!("spawn() failed: {e}")),
                    },
                    Err(e) => log_sidecar(&format!("sidecar() lookup failed: {e}")),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, homedir])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // Don't leave the backend running after the window is gone.
            #[cfg(not(debug_assertions))]
            if let tauri::RunEvent::ExitRequested { .. } = _event {
                use tauri::Manager;
                if let Some(state) = _app_handle.try_state::<BackendProcess>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
