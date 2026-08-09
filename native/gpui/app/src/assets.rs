//! Les images : du fichier déposé au bloc, et du prop `src` aux octets.
//!
//! Le web stocke `src` en data-URL quand aucun magasin d'assets n'est branché
//! (`packages/dom/src/render.ts`, `fileToDataUrl`). On écrit pareil, pour
//! qu'un document composé ici s'affiche tel quel dans Chrome — et on relit
//! les trois formes qu'un document peut porter : data-URL, URL http, chemin.

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use gpui::{Image, ImageFormat, ImageSource};

/// L'extension d'un fichier déposé, si c'est une image qu'on sait encoder.
fn format_of(path: &Path) -> Option<(ImageFormat, &'static str)> {
    match path.extension()?.to_str()?.to_lowercase().as_str() {
        "png" => Some((ImageFormat::Png, "image/png")),
        "jpg" | "jpeg" => Some((ImageFormat::Jpeg, "image/jpeg")),
        "webp" => Some((ImageFormat::Webp, "image/webp")),
        "gif" => Some((ImageFormat::Gif, "image/gif")),
        "svg" => Some((ImageFormat::Svg, "image/svg+xml")),
        "bmp" => Some((ImageFormat::Bmp, "image/bmp")),
        "tif" | "tiff" => Some((ImageFormat::Tiff, "image/tiff")),
        _ => None,
    }
}

/// Un fichier image en data-URL — la forme que le web lit sans rien résoudre.
pub fn data_url_from_file(path: &Path) -> Option<String> {
    let (_, mime) = format_of(path)?;
    let bytes = std::fs::read(path).ok()?;
    // ponytail: 16 Mo de garde-fou — au-delà, le CRDT porterait plus d'image
    // que de document ; un magasin d'assets est la vraie réponse
    if bytes.len() > 16 * 1024 * 1024 {
        eprintln!("carnet-gpui: image ignorée ({} Mo) : {}", bytes.len() >> 20, path.display());
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Le `src` d'un bloc image, résolu en source affichable.
pub fn image_source(src: &str) -> Option<ImageSource> {
    if let Some(rest) = src.strip_prefix("data:") {
        let (mime, data) = rest.split_once(";base64,")?;
        let format = ImageFormat::from_mime_type(mime)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        return Some(ImageSource::Image(Arc::new(Image::from_bytes(format, bytes))));
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        return Some(ImageSource::from(src.to_string()));
    }
    let path = std::path::PathBuf::from(src);
    path.exists().then(|| ImageSource::from(path))
}

/// Vrai si ce chemin est une image qu'on sait déposer.
pub fn is_image_file(path: &Path) -> bool {
    format_of(path).is_some()
}
