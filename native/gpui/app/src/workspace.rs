//! La vue racine : la barre latérale, le document ouvert, la barre d'état.
//!
//! C'est ici que vivent les choses qui ne sont pas de l'édition — le vault,
//! les réglages, la sauvegarde différée, la synchronisation — pour que
//! `Editor` ne connaisse ni les fichiers ni le réseau.

use std::path::PathBuf;
use std::time::Duration;

use carnet_sync::{Session, Status};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, IntoElement, PathPromptOptions, Render, Task,
    Window, div, prelude::*, px,
};
use uuid::Uuid;

use crate::editor::{Editor, EditorEvent};
use crate::icons::Icon;
use crate::settings::{Appearance, FONT_SCALES, PAGE_WIDTHS, Settings};
use crate::theme::{Theme, theme};
use crate::ui::{Tooltip, icon_button};
use crate::vault::Vault;
use crate::{NewPage, OpenVault, Save, ToggleSettings, ToggleSidebar, ToggleSync, sidebar};

pub struct Workspace {
    pub settings: Settings,
    pub vault: Option<Vault>,
    pub editor: Option<Entity<Editor>>,
    pub open_id: Option<String>,
    pub show_settings: bool,
    sync: Option<Session>,
    sync_seen: u64,
    _sync_poll: Option<Task<()>>,
    save: Option<Task<()>>,
    focus_handle: FocusHandle,
}

impl Workspace {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let settings = Settings::load();
        cx.set_global(Theme::from(&settings, dark_system()));

        let mut workspace = Self {
            settings,
            vault: None,
            editor: None,
            open_id: None,
            show_settings: false,
            sync: None,
            sync_seen: 0,
            _sync_poll: None,
            save: None,
            focus_handle: cx.focus_handle(),
        };

        // le dossier du dernier lancement, sinon ~/Carnet : une app sans
        // document ouvert n'a rien à montrer, et demander un dossier avant
        // d'avoir affiché quoi que ce soit est le pire premier écran
        let root = workspace
            .settings
            .vault
            .clone()
            .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Carnet"));
        workspace.open_vault(root, cx);
        workspace
    }

    pub fn open_vault(&mut self, root: PathBuf, cx: &mut Context<Self>) {
        match Vault::open(root.clone()) {
            Ok(mut vault) => {
                if vault.is_empty() {
                    let _ = vault.create_page("Bienvenue dans Carnet", None, || {
                        Uuid::now_v7().to_string()
                    });
                }
                let first = self
                    .settings
                    .last_document
                    .clone()
                    .filter(|id| vault.page(id).is_some())
                    .or_else(|| vault.roots().first().cloned());
                self.vault = Some(vault);
                self.settings.vault = Some(root);
                self.settings.save();
                if let Some(id) = first {
                    self.open_page(&id, cx);
                }
            }
            Err(error) => eprintln!("carnet: dossier illisible ({}) : {error}", root.display()),
        }
        cx.notify();
    }

    pub fn open_page(&mut self, id: &str, cx: &mut Context<Self>) {
        self.save_now(cx);
        let Some(vault) = self.vault.as_ref() else { return };
        let Some(document) = vault.load(id) else { return };

        let editor = cx.new(|cx| Editor::new(document, cx));
        // le document a changé → sauvegarde différée : 400 ms, comme le
        // desktop, pour ne pas réécrire deux fichiers à chaque frappe
        cx.subscribe(&editor, |workspace, _editor, event: &EditorEvent, cx| match event {
            EditorEvent::Changed => workspace.save_soon(cx),
        })
        .detach();

        self.editor = Some(editor);
        self.open_id = Some(id.to_string());
        self.settings.last_document = Some(id.to_string());
        self.settings.save();
        self.connect_sync(cx);
        cx.notify();
    }

    fn save_soon(&mut self, cx: &mut Context<Self>) {
        self.save = Some(cx.spawn(async move |workspace, cx| {
            cx.background_executor().timer(Duration::from_millis(400)).await;
            let _ = workspace.update(cx, |workspace, cx| workspace.save_now(cx));
        }));
    }

    pub fn save_now(&mut self, cx: &mut App) {
        let (Some(vault), Some(id), Some(editor)) =
            (self.vault.as_mut(), self.open_id.as_ref(), self.editor.as_ref())
        else {
            return;
        };
        // lire le document sans passer par le contexte : la sauvegarde ne
        // doit pas dépendre d'un rendu en cours
        let document = editor.read(cx);
        if let Err(error) = vault.save(id, &document.doc) {
            eprintln!("carnet: sauvegarde impossible : {error}");
        }
    }

    // --- synchronisation ---

    fn connect_sync(&mut self, cx: &mut Context<Self>) {
        self.sync = None;
        self._sync_poll = None;
        self.sync_seen = 0;
        if !self.settings.sync_enabled {
            return;
        }
        let (Some(id), Some(editor)) = (self.open_id.clone(), self.editor.as_ref()) else { return };
        let (url, editor) = (self.settings.relay_url.clone(), editor.clone());
        let session = Session::connect(&editor.read(cx).doc.doc, &url, &id);
        self.sync = Some(session);

        // un pair peut écrire à tout moment ; l'interface s'en aperçoit en
        // comparant un compteur, plutôt qu'en tenant un handle GPUI (qui ne
        // traverse pas les fils) depuis le réseau
        self._sync_poll = Some(cx.spawn(async move |workspace, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(250)).await;
                let alive = workspace.update(cx, |workspace, cx| {
                    let Some(session) = workspace.sync.as_ref() else { return false };
                    let revision = session.revision();
                    if revision != workspace.sync_seen {
                        workspace.sync_seen = revision;
                        if let Some(editor) = workspace.editor.as_ref() {
                            editor.update(cx, |editor, cx| editor.reload_from_peer(cx));
                        }
                    }
                    cx.notify(); // le statut vit dans la barre d'état
                    true
                });
                if !matches!(alive, Ok(true)) {
                    break;
                }
            }
        }));
    }

    fn sync_status(&self) -> Status {
        self.sync.as_ref().map(|session| session.status()).unwrap_or(Status::Off)
    }

    // --- actions ---

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _window: &mut Window, cx: &mut Context<Self>) {
        self.settings.show_sidebar = !self.settings.show_sidebar;
        self.settings.save();
        cx.notify();
    }

    fn toggle_settings(&mut self, _: &ToggleSettings, _window: &mut Window, cx: &mut Context<Self>) {
        self.show_settings = !self.show_settings;
        cx.notify();
    }

    fn toggle_sync(&mut self, _: &ToggleSync, _window: &mut Window, cx: &mut Context<Self>) {
        self.settings.sync_enabled = !self.settings.sync_enabled;
        self.settings.save();
        self.connect_sync(cx);
        cx.notify();
    }

    fn save_action(&mut self, _: &Save, _window: &mut Window, cx: &mut Context<Self>) {
        self.save_now(cx);
    }

    pub fn new_page(&mut self, _: &NewPage, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(vault) = self.vault.as_mut() else { return };
        match vault.create_page("", None, || Uuid::now_v7().to_string()) {
            Ok(id) => self.open_page(&id, cx),
            Err(error) => eprintln!("carnet: page non créée : {error}"),
        }
    }

    pub fn open_vault_action(&mut self, _: &OpenVault, _window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Ouvrir".into()),
        });
        cx.spawn(async move |workspace, cx| {
            if let Ok(Ok(Some(chosen))) = paths.await {
                if let Some(root) = chosen.into_iter().next() {
                    let _ = workspace.update(cx, |workspace, cx| {
                        workspace.settings.last_document = None;
                        workspace.open_vault(root, cx);
                    });
                }
            }
        })
        .detach();
    }

    /// Supprimer une page et sa descendance, puis ouvrir ce qui reste.
    pub fn delete_page(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(vault) = self.vault.as_mut() else { return };
        if let Err(error) = vault.delete_page(id) {
            eprintln!("carnet: page non supprimée : {error}");
            return;
        }
        if self.open_id.as_deref() == Some(id) {
            self.editor = None;
            self.open_id = None;
            let next = self.vault.as_ref().and_then(|vault| vault.roots().first().cloned());
            match next {
                Some(next) => self.open_page(&next, cx),
                None => cx.notify(),
            }
        } else {
            cx.notify();
        }
    }

    pub fn apply_settings(&mut self, cx: &mut Context<Self>) {
        self.settings.save();
        cx.set_global(Theme::from(&self.settings, dark_system()));
        cx.refresh_windows();
        cx.notify();
    }

    // --- rendu ---

    fn status_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme(cx).clone();
        let status = self.sync_status();
        let (icon, label) = match &status {
            Status::Off => (Icon::OFFLINE, status.label()),
            Status::Connecting => (Icon::REFRESH, status.label()),
            Status::Relay { .. } => (Icon::RELAY, status.label()),
            Status::Error(_) => (Icon::DISCONNECTED, status.label()),
        };
        let pages = self.vault.as_ref().map(|vault| vault.len()).unwrap_or(0);

        div()
            .h(px(28.))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .bg(palette.panel)
            .border_t_1()
            .border_color(palette.rule)
            .text_size(px(11.5))
            .text_color(palette.muted)
            .child(
                div()
                    .id("sync")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.))
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .hover(|style| style.bg(palette.hover))
                    .cursor_pointer()
                    .tooltip(Tooltip::with_key("Synchronisation", "⌘⇧S"))
                    .child(icon.sized(px(13.), palette.muted))
                    .child(label)
                    .on_click(cx.listener(|workspace, _, window, cx| {
                        workspace.toggle_sync(&ToggleSync, window, cx);
                    })),
            )
            .child(div().flex_1())
            .child(format!("{pages} page{}", if pages > 1 { "s" } else { "" }))
            .children(self.vault.as_ref().map(|vault| {
                div().child(vault.root.to_string_lossy().to_string())
            }))
    }

    fn settings_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme(cx).clone();
        let settings = &self.settings;

        let section = |title: &'static str| {
            div()
                .text_size(px(11.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(palette.muted)
                .pt(px(12.))
                .pb(px(4.))
                .child(title)
        };

        // un segment de boutons : le réglage est un choix parmi trois ou
        // quatre, pas un curseur libre — deux machines réglées « moyen »
        // doivent afficher la même chose
        let segment = |options: Vec<(String, bool, Box<dyn Fn(&mut Workspace, &mut Context<Workspace>)>)>,
                       cx: &mut Context<Self>| {
            let palette = palette.clone();
            div()
                .flex()
                .flex_row()
                .gap(px(4.))
                .children(options.into_iter().enumerate().map(|(ix, (label, active, apply))| {
                    div()
                        .id(("segment", ix as u64 + label.len() as u64 * 100))
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(5.))
                        .text_size(px(12.5))
                        .border_1()
                        .border_color(if active { palette.accent } else { palette.rule })
                        .when(active, |option| option.bg(palette.selection))
                        .hover(|style| style.bg(palette.hover))
                        .cursor_pointer()
                        .child(label)
                        .on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(move |workspace, _: &gpui::MouseDownEvent, _window, cx| {
                                apply(workspace, cx);
                                workspace.apply_settings(cx);
                            }),
                        )
                }))
        };

        div()
            .absolute()
            .top(px(44.))
            .right(px(16.))
            .w(px(320.))
            .p(px(14.))
            .bg(palette.popover)
            .border_1()
            .border_color(palette.rule)
            .rounded(px(10.))
            .shadow_lg()
            .text_color(palette.text)
            .text_size(px(13.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .child(div().flex_1().font_weight(gpui::FontWeight::SEMIBOLD).child("Réglages"))
                    .child(
                        icon_button("close-settings", Icon::CLOSE, cx).on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(|workspace, _: &gpui::MouseDownEvent, _window, cx| {
                                workspace.show_settings = false;
                                cx.notify();
                            }),
                        ),
                    ),
            )
            .child(section("Apparence"))
            .child(segment(
                [Appearance::Light, Appearance::Dark, Appearance::System]
                    .into_iter()
                    .map(|mode| {
                        let active = settings.appearance == mode;
                        (
                            mode.label().to_string(),
                            active,
                            Box::new(move |workspace: &mut Workspace, _: &mut Context<Workspace>| {
                                workspace.settings.appearance = mode;
                            }) as Box<dyn Fn(&mut Workspace, &mut Context<Workspace>)>,
                        )
                    })
                    .collect(),
                cx,
            ))
            .child(section("Taille du texte"))
            .child(segment(
                FONT_SCALES
                    .iter()
                    .map(|(scale, label)| {
                        let scale = *scale;
                        let active = (settings.font_scale - scale).abs() < 0.01;
                        (
                            label.to_string(),
                            active,
                            Box::new(move |workspace: &mut Workspace, _: &mut Context<Workspace>| {
                                workspace.settings.font_scale = scale;
                            }) as Box<dyn Fn(&mut Workspace, &mut Context<Workspace>)>,
                        )
                    })
                    .collect(),
                cx,
            ))
            .child(section("Largeur de page"))
            .child(segment(
                PAGE_WIDTHS
                    .iter()
                    .map(|(width, label)| {
                        let width = *width;
                        let active = (settings.page_width - width).abs() < 1.;
                        (
                            label.to_string(),
                            active,
                            Box::new(move |workspace: &mut Workspace, _: &mut Context<Workspace>| {
                                workspace.settings.page_width = width;
                            }) as Box<dyn Fn(&mut Workspace, &mut Context<Workspace>)>,
                        )
                    })
                    .collect(),
                cx,
            ))
            .child(section("Synchronisation"))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(palette.muted)
                    .child(self.settings.relay_url.clone()),
            )
            .child(segment(
                vec![
                    (
                        if settings.sync_enabled { "Connecté" } else { "Hors ligne" }.to_string(),
                        settings.sync_enabled,
                        Box::new(|workspace: &mut Workspace, cx: &mut Context<Workspace>| {
                            workspace.settings.sync_enabled = !workspace.settings.sync_enabled;
                            workspace.connect_sync(cx);
                        }) as Box<dyn Fn(&mut Workspace, &mut Context<Workspace>)>,
                    ),
                ],
                cx,
            ))
            .child(section("Dossier"))
            .child(
                div()
                    .id("open-vault")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(5.))
                    .rounded(px(5.))
                    .border_1()
                    .border_color(palette.rule)
                    .hover(|style| style.bg(palette.hover))
                    .cursor_pointer()
                    .child(Icon::FOLDER_OPEN.sized(px(14.), palette.muted))
                    .child("Ouvrir un dossier…")
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|workspace, _: &gpui::MouseDownEvent, window, cx| {
                            workspace.open_vault_action(&OpenVault, window, cx);
                        }),
                    ),
            )
    }
}

/// GPUI ne publie pas l'apparence système ; macOS l'expose par défaut, et
/// faute de mieux on suppose clair — le réglage explicite reste maître.
fn dark_system() -> bool {
    false
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme(cx).clone();

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.bg)
            .text_color(palette.text)
            .font_family(crate::theme::FONT_SANS)
            .key_context("Workspace")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::toggle_settings))
            .on_action(cx.listener(Self::toggle_sync))
            .on_action(cx.listener(Self::save_action))
            .on_action(cx.listener(Self::new_page))
            .on_action(cx.listener(Self::open_vault_action))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_row()
                    .overflow_hidden()
                    .when(self.settings.show_sidebar, |row| {
                        row.child(sidebar::sidebar(self, cx))
                    })
                    .child(
                        div()
                            .flex_1()
                            .relative()
                            .flex()
                            .flex_col()
                            .child(self.toolbar(cx))
                            .children(self.editor.clone())
                            .when(self.editor.is_none(), |area| {
                                area.flex().items_center().justify_center().child(
                                    div().text_color(palette.muted).child("Aucun document ouvert"),
                                )
                            })
                            .when(self.show_settings, |area| area.child(self.settings_panel(cx))),
                    ),
            )
            .child(self.status_bar(cx))
    }
}

impl Workspace {
    /// La barre du haut : afficher/masquer la barre latérale, et les
    /// réglages. Le reste de la fenêtre est au document.
    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = theme(cx).clone();
        let title = self
            .open_id
            .as_ref()
            .and_then(|id| self.vault.as_ref().map(|vault| vault.title(id)))
            .unwrap_or_default();

        div()
            .h(px(44.))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .border_b_1()
            .border_color(palette.rule)
            .child(
                icon_button("toggle-sidebar", Icon::SIDEBAR, cx)
                    .tooltip(Tooltip::with_key("Barre latérale", "⌘\\"))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|workspace, _: &gpui::MouseDownEvent, window, cx| {
                            workspace.toggle_sidebar(&ToggleSidebar, window, cx);
                        }),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .text_size(px(13.))
                    .text_color(palette.muted)
                    .child(title),
            )
            .child(
                icon_button("settings", Icon::SETTINGS, cx)
                    .tooltip(Tooltip::with_key("Réglages", "⌘,"))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|workspace, _: &gpui::MouseDownEvent, window, cx| {
                            workspace.toggle_settings(&ToggleSettings, window, cx);
                        }),
                    ),
            )
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
