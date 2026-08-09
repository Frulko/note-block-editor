//! Le format de document Carnet, lu et écrit par une troisième
//! implémentation — sans dépendance d'interface, comme `NbeModel` côté Swift.
//!
//! - [`model`] : les tables qui donnent leur *sens* aux frappes (autoformat,
//!   types continués, catégories de blocs), miroir de `packages/core`.
//! - [`store`] : le document CRDT lui-même, miroir de `packages/collab`.
//! - [`blocks`] : les commandes qui agissent sur des blocs entiers.
//! - [`json`] : le pont vers le JSON canonique d'un vault.

pub mod blocks;
pub mod json;
pub mod model;
pub mod store;
