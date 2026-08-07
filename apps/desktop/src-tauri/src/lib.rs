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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
