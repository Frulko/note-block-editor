//! Carnet, rendu par GPUI — pas de webview, pas de DOM, pas de
//! `contenteditable` : chaque glyphe, caret et rectangle de sélection est
//! posé par nous, comme Zed le fait pour du code.
//!
//! Le *sens* des frappes vient de `carnet-model`, le miroir des tables de
//! `packages/core/src/commands.ts` ; ce fichier ne décide jamais ce qu'Entrée
//! veut dire, seulement quelles touches appellent quoi.

mod assets;
mod block;
mod editor;
mod icons;
mod rows;
mod scrollbar;
mod settings;
mod sidebar;
mod slash;
mod theme;
mod ui;
mod vault;
mod workspace;

use gpui::{
    App, Application, Bounds, Focusable, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions,
    actions, prelude::*, px, size,
};

use crate::icons::Assets;
use crate::workspace::Workspace;

actions!(
    carnet,
    [
        // le document
        Backspace,
        DeleteForward,
        Enter,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Indent,
        Outdent,
        Bold,
        Italic,
        Underline,
        Strike,
        InlineCode,
        Undo,
        Redo,
        Cancel,
        Duplicate,
        MoveBlockUp,
        MoveBlockDown,
        Copy,
        Cut,
        Paste,
        ShowCharacterPalette,
        // l'application
        Save,
        NewPage,
        OpenVault,
        ToggleSidebar,
        ToggleSettings,
        ToggleSync,
        Quit,
    ]
);

fn main() {
    Application::new().with_assets(Assets).run(move |cx: &mut App| {
        cx.bind_keys([
            // dans le document
            KeyBinding::new("backspace", Backspace, Some("Editor")),
            KeyBinding::new("delete", DeleteForward, Some("Editor")),
            KeyBinding::new("enter", Enter, Some("Editor")),
            KeyBinding::new("left", Left, Some("Editor")),
            KeyBinding::new("right", Right, Some("Editor")),
            KeyBinding::new("up", Up, Some("Editor")),
            KeyBinding::new("down", Down, Some("Editor")),
            KeyBinding::new("shift-left", SelectLeft, Some("Editor")),
            KeyBinding::new("shift-right", SelectRight, Some("Editor")),
            KeyBinding::new("shift-up", SelectLeft, Some("Editor")),
            KeyBinding::new("shift-down", SelectRight, Some("Editor")),
            KeyBinding::new("cmd-a", SelectAll, Some("Editor")),
            KeyBinding::new("home", Home, Some("Editor")),
            KeyBinding::new("cmd-left", Home, Some("Editor")),
            KeyBinding::new("end", End, Some("Editor")),
            KeyBinding::new("cmd-right", End, Some("Editor")),
            KeyBinding::new("tab", Indent, Some("Editor")),
            KeyBinding::new("shift-tab", Outdent, Some("Editor")),
            KeyBinding::new("cmd-b", Bold, Some("Editor")),
            KeyBinding::new("cmd-i", Italic, Some("Editor")),
            KeyBinding::new("cmd-u", Underline, Some("Editor")),
            KeyBinding::new("cmd-shift-x", Strike, Some("Editor")),
            KeyBinding::new("cmd-e", InlineCode, Some("Editor")),
            KeyBinding::new("cmd-z", Undo, Some("Editor")),
            KeyBinding::new("cmd-shift-z", Redo, Some("Editor")),
            KeyBinding::new("escape", Cancel, Some("Editor")),
            KeyBinding::new("cmd-d", Duplicate, Some("Editor")),
            KeyBinding::new("cmd-shift-up", MoveBlockUp, Some("Editor")),
            KeyBinding::new("cmd-shift-down", MoveBlockDown, Some("Editor")),
            KeyBinding::new("cmd-c", Copy, Some("Editor")),
            KeyBinding::new("cmd-x", Cut, Some("Editor")),
            KeyBinding::new("cmd-v", Paste, Some("Editor")),
            KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, Some("Editor")),
            // l'application, partout
            KeyBinding::new("cmd-s", Save, None),
            KeyBinding::new("cmd-n", NewPage, None),
            KeyBinding::new("cmd-o", OpenVault, None),
            KeyBinding::new("cmd-\\", ToggleSidebar, None),
            KeyBinding::new("cmd-,", ToggleSettings, None),
            KeyBinding::new("cmd-shift-s", ToggleSync, None),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());

        let bounds = Bounds::centered(None, size(px(1100.), px(760.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some("Carnet".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(Workspace::new),
            )
            .expect("ouvrir la fenêtre");

        window
            .update(cx, |workspace, window, cx| {
                // le clavier va au document dès l'ouverture
                match workspace.editor.as_ref() {
                    Some(editor) => window.focus(&editor.focus_handle(cx)),
                    None => window.focus(&workspace.focus_handle(cx)),
                }
                cx.activate(true);
            })
            .ok();
    });
}
