//! Les icônes : les mêmes SVG Lucide que le web (`lucide-static`), embarqués
//! dans le binaire et rendus par GPUI.
//!
//! GPUI rasterise un SVG en masque alpha coloré par `text_color` — un trait
//! Lucide passe donc tel quel, sans retouche. Les fichiers viennent de
//! `node_modules/lucide-static/icons/`, copiés dans `assets/icons/` pour que
//! le binaire n'ait besoin de rien à l'installation.

use std::borrow::Cow;

use anyhow::Result;
use gpui::{AssetSource, IntoElement, SharedString, Styled, Svg, svg};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/"]
#[include = "icons/*.svg"]
struct Embedded;

/// La source d'assets de l'application — branchée par `Application::with_assets`.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(Embedded::get(path).map(|file| file.data))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(Embedded::iter()
            .filter(|candidate| candidate.starts_with(path))
            .map(|candidate| SharedString::from(candidate.to_string()))
            .collect())
    }
}

/// Une icône, désignée par son nom Lucide.
///
/// Les constantes ci-dessous sont la seule façon d'en nommer une : une faute
/// de frappe devient une erreur de compilation, et le test en fin de fichier
/// vérifie que chaque constante correspond à un fichier réellement embarqué —
/// sans quoi l'icône disparaîtrait en silence à l'écran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Icon(&'static str);

impl Icon {
    pub const fn name(self) -> &'static str {
        self.0
    }

    fn path(self) -> String {
        format!("icons/{}.svg", self.0)
    }

    /// L'élément à peindre. La couleur suit `text_color` du parent.
    pub fn el(self) -> Svg {
        svg().path(self.path()).flex_none()
    }

    /// L'élément, dimensionné.
    pub fn sized(self, size: gpui::Pixels) -> Svg {
        self.el().size(size)
    }
}

macro_rules! icons {
    ($($konst:ident => $name:literal),* $(,)?) => {
        impl Icon {
            $(pub const $konst: Icon = Icon($name);)*
            /// Toutes les icônes déclarées — ce que le test parcourt.
            pub const ALL: &'static [Icon] = &[$(Icon($name)),*];
        }
    };
}

icons! {
    // types de blocs (les noms que `packages/dom` passe à `icon()`)
    PARAGRAPH => "pilcrow",
    HEADING_1 => "heading-1",
    HEADING_2 => "heading-2",
    HEADING_3 => "heading-3",
    BULLETED_LIST => "list",
    NUMBERED_LIST => "list-ordered",
    TODO => "square-check",
    TODO_EMPTY => "square",
    TOGGLE => "chevron-right",
    QUOTE => "text-quote",
    CODE => "code",
    IMAGE => "image",
    DIVIDER => "minus",
    CALLOUT => "lightbulb",
    PAGE => "file-text",
    TABLE => "table",
    COLUMNS => "columns-3",
    DATABASE => "database",
    LINK => "link",

    // variantes de note
    CALLOUT_INFO => "info",
    CALLOUT_TIP => "rocket",
    CALLOUT_SUCCESS => "circle-check",
    CALLOUT_WARNING => "triangle-alert",
    CALLOUT_DANGER => "octagon-x",

    // marques
    BOLD => "bold",
    ITALIC => "italic",
    UNDERLINE => "underline",
    STRIKE => "strikethrough",

    // chrome
    SIDEBAR => "panel-left",
    SETTINGS => "settings",
    PLUS => "plus",
    SEARCH => "search",
    HANDLE => "grip-vertical",
    TRASH => "trash-2",
    DUPLICATE => "copy",
    TYPE => "type",
    FOLDER => "folder",
    FOLDER_OPEN => "folder-open",
    FOLDER_PLUS => "folder-plus",
    SAVE => "save",
    REFRESH => "refresh-cw",
    CLOSE => "x",
    CHECK => "check",
    MORE => "ellipsis",
    CHEVRON_DOWN => "chevron-down",
    CHEVRON_LEFT => "chevron-left",
    CHEVRON_RIGHT => "chevron-right",
    ARROW_UP => "arrow-up",
    ARROW_DOWN => "arrow-down",
    INDENT => "indent-increase",
    OUTDENT => "indent-decrease",
    SUN => "sun",
    MOON => "moon",

    // synchronisation
    RELAY => "cloud",
    OFFLINE => "cloud-off",
    PEERS => "users",
    P2P => "radio",
    ONLINE => "wifi",
    DISCONNECTED => "wifi-off",
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une icône dont le fichier manque ne lève rien : elle ne se dessine
    /// simplement pas. C'est exactement le genre de panne qu'on ne voit qu'en
    /// production, donc elle est vérifiée ici.
    #[test]
    fn every_declared_icon_is_embedded() {
        for icon in Icon::ALL {
            assert!(
                Embedded::get(&icon.path()).is_some(),
                "icône déclarée mais absente de assets/ : {}",
                icon.name()
            );
        }
        assert!(Icon::ALL.len() > 40);
    }
}
