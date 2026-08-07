//! The whole backend.
//!
//! There is deliberately no application logic here. The page tree, the
//! Markdown projection, search, backlinks and the derived index all live in
//! `@nbe/workspace`, which is plain TypeScript over a four-method storage
//! interface — so a desktop build needs a filesystem, not a second
//! implementation in a second language.
//!
//! `persisted-scope` must be registered *after* `fs`: it replays the paths a
//! dialog granted, and it can only replay them into a scope that already
//! exists.

use tauri_plugin_fs::FsExt;

/// Grant access to a vault folder *and everything under it*.
///
/// The folder picker already adds the chosen path to the filesystem scope —
/// but only that path. A workspace keeps its canonical documents in `.nbe/`,
/// one level down, so every read and write there was denied and the app simply
/// did nothing. Granting recursively is the fix, and it is the backend's job:
/// deciding what a window may touch is not application logic.
///
/// `persisted-scope` then remembers this across restarts.
#[tauri::command]
fn allow_vault(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|error| format!("accès refusé à {path} : {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![allow_vault])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
