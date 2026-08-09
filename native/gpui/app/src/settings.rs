//! Les réglages de l'application, et leur persistance.
//!
//! Un fichier JSON dans `~/.carnet/settings.json` — lisible, éditable à la
//! main, et qui survit à une version qui ajoute un champ (`#[serde(default)]`
//! partout, comme §4 le demande des props inconnues).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
    System,
}

impl Appearance {
    pub fn label(self) -> &'static str {
        match self {
            Appearance::Light => "Clair",
            Appearance::Dark => "Sombre",
            Appearance::System => "Système",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub appearance: Appearance,
    /// Multiplie chaque taille de texte.
    pub font_scale: f32,
    /// Largeur de la colonne d'écriture, en pixels.
    pub page_width: f32,
    pub show_sidebar: bool,
    /// Le dossier ouvert au lancement, s'il y en a un.
    pub vault: Option<PathBuf>,
    /// Le dernier document ouvert, relatif au vault.
    pub last_document: Option<String>,
    /// L'adresse du relay de synchronisation.
    pub relay_url: String,
    /// Se connecter au relay à l'ouverture d'un document.
    pub sync_enabled: bool,
    /// Tenter une liaison directe (WebRTC) quand un pair est joignable.
    pub p2p_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            appearance: Appearance::System,
            font_scale: 1.0,
            page_width: 680.,
            show_sidebar: true,
            vault: None,
            last_document: None,
            // le défaut de `nbe serve` (packages/cli) : un relay local
            relay_url: "ws://127.0.0.1:8787".to_string(),
            sync_enabled: false,
            p2p_enabled: true,
        }
    }
}

/// Les paliers proposés par les boutons de réglage — pas un curseur libre,
/// pour que deux machines réglées « moyen » affichent la même chose.
pub const FONT_SCALES: [(f32, &str); 4] = [(0.9, "S"), (1.0, "M"), (1.15, "L"), (1.3, "XL")];
pub const PAGE_WIDTHS: [(f32, &str); 3] = [(600., "Étroit"), (680., "Normal"), (900., "Large")];

impl Settings {
    pub fn path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".carnet").join("settings.json")
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Écrit les réglages. Une écriture ratée n'a pas à faire tomber l'app —
    /// on le dit et on continue avec les réglages en mémoire.
    pub fn save(&self) {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(self) {
            Ok(json) => {
                if let Err(error) = std::fs::write(&path, json) {
                    eprintln!("carnet: réglages non écrits ({}): {error}", path.display());
                }
            }
            Err(error) => eprintln!("carnet: réglages non sérialisables : {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un fichier écrit par une version plus ancienne — ou plus récente — doit
    /// se relire sans tout perdre : les champs absents prennent leur défaut,
    /// les champs inconnus sont ignorés au lieu de faire échouer la lecture.
    #[test]
    fn partial_json_keeps_the_defaults() {
        let settings: Settings =
            serde_json::from_str(r#"{"font_scale": 1.3, "venu_du_futur": 42}"#).unwrap();
        assert_eq!(settings.font_scale, 1.3);
        assert_eq!(settings.page_width, 680.);
        assert!(matches!(settings.appearance, Appearance::System));
    }

    #[test]
    fn roundtrips() {
        let mut settings = Settings::default();
        settings.appearance = Appearance::Dark;
        settings.vault = Some(PathBuf::from("/tmp/vault"));
        let json = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.appearance, Appearance::Dark));
        assert_eq!(back.vault, Some(PathBuf::from("/tmp/vault")));
    }
}
