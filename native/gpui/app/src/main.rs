//! Carnet, rendu par GPUI — pas de webview, pas de DOM, pas de
//! `contenteditable` : chaque glyphe, caret et rectangle de sélection est
//! posé par nous, comme Zed le fait pour du code.
//!
//! Le *sens* des frappes vient de `carnet-model`, le miroir des tables de
//! `packages/core/src/commands.ts` ; ce fichier ne décide jamais ce qu'Entrée
//! veut dire, seulement où peindre le résultat.

mod assets;
mod block;
mod editor;
mod rows;
mod slash;
mod theme;

use gpui::{
    App, Application, Bounds, Focusable, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions,
    actions, prelude::*, px, size,
};

use crate::editor::Editor;

actions!(
    carnet,
    [
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
        Save,
        Copy,
        Cut,
        Paste,
        ShowCharacterPalette,
        Quit,
    ]
);

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "carnet.loro".to_string());
    Application::new().run(move |cx: &mut App| {
        cx.bind_keys([
            KeyBinding::new("backspace", Backspace, Some("Editor")),
            KeyBinding::new("delete", DeleteForward, Some("Editor")),
            KeyBinding::new("enter", Enter, Some("Editor")),
            KeyBinding::new("left", Left, Some("Editor")),
            KeyBinding::new("right", Right, Some("Editor")),
            KeyBinding::new("up", Up, Some("Editor")),
            KeyBinding::new("down", Down, Some("Editor")),
            KeyBinding::new("shift-left", SelectLeft, Some("Editor")),
            KeyBinding::new("shift-right", SelectRight, Some("Editor")),
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
            KeyBinding::new("cmd-shift-s", Strike, Some("Editor")),
            KeyBinding::new("cmd-e", InlineCode, Some("Editor")),
            KeyBinding::new("cmd-z", Undo, Some("Editor")),
            KeyBinding::new("cmd-shift-z", Redo, Some("Editor")),
            KeyBinding::new("escape", Cancel, Some("Editor")),
            KeyBinding::new("cmd-s", Save, Some("Editor")),
            KeyBinding::new("cmd-c", Copy, Some("Editor")),
            KeyBinding::new("cmd-x", Cut, Some("Editor")),
            KeyBinding::new("cmd-v", Paste, Some("Editor")),
            KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, Some("Editor")),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());

        let bounds = Bounds::centered(None, size(px(860.), px(720.)), cx);
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
                {
                    let path = path.clone();
                    move |_, cx| cx.new(|cx| Editor::open(path.into(), cx))
                },
            )
            .expect("ouvrir la fenêtre");

        window
            .update(cx, |editor, window, cx| {
                window.focus(&editor.focus_handle(cx));
                cx.activate(true);
            })
            .ok();
    });
}
