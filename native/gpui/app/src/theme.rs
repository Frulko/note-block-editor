//! Les couleurs et la typographie, en un seul endroit.
//!
//! Les valeurs viennent de `packages/dom/src/style/tokens.css` et
//! `blocks.css` — corps 16 px interligne 1.5, titres 30/24/20 px en 600
//! interligne 1.3, code en chasse fixe. Le thème est un `Global` GPUI :
//! n'importe quel `render` le lit, et changer un réglage le recalcule en un
//! point plutôt que d'accorder trente constantes à la main.

use std::ops::Range;

use gpui::{
    App, Font, FontStyle, FontWeight, Global, Hsla, Pixels, StrikethroughStyle, TextRun,
    UnderlineStyle, px, rgb, rgba,
};

use carnet_model::store::{Entry, Run};

use crate::settings::{Appearance, Settings};

pub const FONT_SANS: &str = "Inter";
pub const FONT_MONO: &str = "Menlo";

/// La palette et les métriques du moment.
#[derive(Clone, Debug)]
pub struct Theme {
    pub dark: bool,
    /// Le fond de la page d'écriture.
    pub bg: Hsla,
    /// Le fond des panneaux (barre latérale, barre d'état).
    pub panel: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub accent: Hsla,
    /// La sélection de texte, et le surlignage d'un bloc sélectionné.
    pub selection: Hsla,
    pub code_bg: Hsla,
    pub rule: Hsla,
    /// Le fond d'un élément survolé (rangée de barre latérale, entrée de menu).
    pub hover: Hsla,
    pub popover: Hsla,
    /// Multiplie chaque taille de texte — le réglage « taille du texte ».
    pub font_scale: f32,
    /// La largeur de la colonne d'écriture.
    pub page_width: Pixels,
}

impl Global for Theme {}

impl Theme {
    pub fn light(settings: &Settings) -> Self {
        Self {
            dark: false,
            bg: rgb(0xffffff).into(),
            panel: rgb(0xf7f7f5).into(),
            text: rgb(0x1f2328).into(),
            muted: rgb(0x8a8f98).into(),
            accent: rgb(0x2e6ff2).into(),
            selection: rgba(0x2e6ff230).into(),
            code_bg: rgb(0xf3f4f6).into(),
            rule: rgb(0xe5e7eb).into(),
            hover: rgba(0x1f232810).into(),
            popover: rgb(0xffffff).into(),
            font_scale: settings.font_scale,
            page_width: px(settings.page_width),
        }
    }

    pub fn dark(settings: &Settings) -> Self {
        Self {
            dark: true,
            bg: rgb(0x191919).into(),
            panel: rgb(0x202020).into(),
            text: rgb(0xe6e6e3).into(),
            muted: rgb(0x8f8f8c).into(),
            accent: rgb(0x5b8cf5).into(),
            selection: rgba(0x5b8cf540).into(),
            code_bg: rgb(0x252525).into(),
            rule: rgb(0x333333).into(),
            hover: rgba(0xffffff12).into(),
            popover: rgb(0x252525).into(),
            font_scale: settings.font_scale,
            page_width: px(settings.page_width),
        }
    }

    pub fn from(settings: &Settings, system_dark: bool) -> Self {
        let dark = match settings.appearance {
            Appearance::Light => false,
            Appearance::Dark => true,
            Appearance::System => system_dark,
        };
        if dark { Self::dark(settings) } else { Self::light(settings) }
    }
}

/// Le thème courant. Posé au démarrage, remplacé à chaque réglage changé.
pub fn theme(cx: &App) -> &Theme {
    cx.global::<Theme>()
}

/// Police, taille, interligne et couleur d'un bloc — le style *est* le type.
pub fn block_style(entry: &Entry, base: &Font, theme: &Theme) -> (Font, Pixels, Pixels, Hsla) {
    let mut font = base.clone();
    font.family = FONT_SANS.into();
    let scale = theme.font_scale;
    let (size, leading) = match entry.kind.as_str() {
        "heading" => {
            font.weight = FontWeight::SEMIBOLD;
            let size = match entry.heading_level() {
                1 => px(30.),
                2 => px(24.),
                _ => px(20.),
            };
            (size, 1.3)
        }
        "code" => {
            font.family = FONT_MONO.into();
            (px(13.5), 1.5)
        }
        _ => (px(16.), 1.5),
    };
    (font, size * scale, size * scale * leading, theme.text)
}

/// L'espace au-dessus d'un bloc, comme les `margin-top` de `blocks.css`.
pub fn block_spacing(entry: &Entry) -> Pixels {
    match (entry.kind.as_str(), entry.heading_level()) {
        ("heading", 1) => px(26.),
        ("heading", 2) => px(18.),
        ("heading", _) => px(12.),
        _ => px(1.),
    }
}

/// Les runs du CRDT, traduits en runs de rendu — le gras est un poids, le
/// code une chasse fixe, un lien un souligné.
pub fn text_runs(
    runs: &[Run],
    base: &Font,
    theme: &Theme,
    marked: Option<&Range<usize>>,
) -> Vec<TextRun> {
    let color = theme.text;
    let mut out = Vec::with_capacity(runs.len().max(1));
    for run in runs {
        let mut font = base.clone();
        if run.has("bold") {
            font.weight = FontWeight::BOLD;
        }
        if run.has("italic") {
            font.style = FontStyle::Italic;
        }
        if run.has("code") {
            font.family = FONT_MONO.into();
        }
        let underline = (run.has("underline") || run.has("link")).then(|| UnderlineStyle {
            color: Some(color),
            thickness: px(1.),
            wavy: false,
        });
        let strikethrough = run.has("strike").then(|| StrikethroughStyle {
            color: Some(theme.muted),
            thickness: px(1.),
        });
        out.push(TextRun {
            len: run.text.len(),
            font,
            color: if run.has("link") { theme.accent } else { color },
            background_color: run.has("code").then_some(theme.code_bg),
            underline,
            strikethrough,
        });
    }
    // la composition IME se souligne par-dessus les marques existantes
    if let Some(marked) = marked {
        out = split_for_marked(out, marked, color);
    }
    out
}

fn split_for_marked(runs: Vec<TextRun>, marked: &Range<usize>, color: Hsla) -> Vec<TextRun> {
    let mut out = Vec::with_capacity(runs.len() + 2);
    let mut at = 0usize;
    for run in runs {
        let (start, end) = (at, at + run.len);
        at = end;
        let cuts = [start, marked.start.clamp(start, end), marked.end.clamp(start, end), end];
        for window in cuts.windows(2) {
            let (a, b) = (window[0], window[1]);
            if a >= b {
                continue;
            }
            let mut piece = run.clone();
            piece.len = b - a;
            if a >= marked.start && b <= marked.end {
                piece.underline = Some(UnderlineStyle {
                    color: Some(color),
                    thickness: px(1.),
                    wavy: false,
                });
            }
            out.push(piece);
        }
    }
    out
}
