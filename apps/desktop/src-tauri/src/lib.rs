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

/// Grant access to a vault folder and the directories the app writes in it.
///
/// The folder picker adds the chosen path to the filesystem scope — but only
/// that path, so `.nbe/` one level down was denied and the app did nothing.
/// Granting recursively should cover it, and did not: reported as
/// `forbidden path: …/.nbe … for allow-exists`. So each directory the app
/// actually uses is granted by name as well, rather than trusting one glob to
/// mean what it looks like it means.
///
/// Deciding what a window may touch is the backend's job, not application
/// logic. `persisted-scope` remembers this across restarts.
///
/// Fails with the paths that are still refused, so a failure that survives
/// this carries the evidence rather than prompting another guess.
#[tauri::command]
fn allow_vault(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let scope = app.fs_scope();
    let root = std::path::Path::new(&path);
    let wanted = [root.to_path_buf(), root.join(".nbe"), root.join("pages")];

    for directory in &wanted {
        // it has to exist before the scope can be asked about it
        let _ = std::fs::create_dir_all(directory);
        scope
            .allow_directory(directory, true)
            .map_err(|error| format!("accès refusé à {} : {error}", directory.display()))?;
    }

    // verify rather than assume: `allow_directory` returning Ok has not meant
    // the path is reachable, which is how `.nbe` stayed forbidden
    let refused: Vec<String> = wanted
        .iter()
        .filter(|directory| !scope.is_allowed(directory))
        .map(|directory| directory.display().to_string())
        .collect();

    if refused.is_empty() {
        Ok(())
    } else {
        Err(format!("toujours hors portée après autorisation : {}", refused.join(", ")))
    }
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
