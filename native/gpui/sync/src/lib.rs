//! La synchronisation : un pair de plus dans le salon.
//!
//! Miroir de `packages/collab/src/sync.ts` et de
//! `native/swift/Sources/NbeSync/` — **le même octet d'en-tête, le même
//! `VersionVector`, le même Loro 1.13.9 des deux côtés**, donc un pair web et
//! ce client échangent des octets identiques par construction.
//!
//! Le fil réseau partage le `LoroDoc` (qui est `Send + Sync` : des `Arc` et
//! des mutex à l'intérieur) plutôt que de recopier le document. Ce qu'il ne
//! fait **jamais**, c'est écrire sur la socket depuis le callback d'update
//! local : celui-ci se déclenche *pendant* `commit()`, et y répondre par une
//! I/O est le bug classique de cette forme. Tout passe par une file.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use loro::{ExportMode, LoroDoc, Subscription, VersionVector};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message as WsMessage, WebSocket};

/// Les types de message du protocole. Les valeurs sont normatives : elles
/// sont écrites à l'identique dans `sync.ts` et `Wire.swift`.
pub const HAVE: u8 = 0;
pub const UPDATE: u8 = 1;
pub const PRESENCE: u8 = 2;
pub const SIGNAL: u8 = 3;

/// Un octet de type, puis le payload. Pas de préfixe de longueur : le
/// cadrage est celui du WebSocket.
pub fn envelope(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

/// Ce que l'interface affiche.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// La synchronisation est éteinte.
    Off,
    Connecting,
    /// Connecté au relais. `peers` compte les *autres* membres du salon.
    Relay { peers: usize },
    /// La connexion a échoué ou s'est fermée ; le message est celui du système.
    Error(String),
}

impl Status {
    pub fn label(&self) -> String {
        match self {
            Status::Off => "Hors ligne".into(),
            Status::Connecting => "Connexion…".into(),
            Status::Relay { peers: 0 } => "Relais · seul".into(),
            Status::Relay { peers: 1 } => "Relais · 1 pair".into(),
            Status::Relay { peers } => format!("Relais · {peers} pairs"),
            Status::Error(message) => format!("Erreur : {message}"),
        }
    }
}

/// Ce que le relais annonce en `Signal` — le seul message qu'il produit
/// lui-même, tout le reste étant du réémission brute.
#[derive(Debug, serde::Deserialize)]
struct SignalFrame {
    kind: Option<String>,
    count: Option<usize>,
}

/// Une session de synchronisation vivante. La lâcher arrête le fil.
pub struct Session {
    status: Arc<Mutex<Status>>,
    /// Incrémenté à chaque update **distante** appliquée : l'interface le
    /// compare au sien pour savoir qu'il faut relire le document.
    revision: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    outbox: Sender<Vec<u8>>,
    /// L'abonnement aux updates locales — le lâcher coupe l'émission.
    _local: Subscription,
}

impl Session {
    /// Rejoindre un salon. Ne bloque pas : la connexion se fait sur un fil,
    /// et les trames émises avant l'ouverture attendent dans la file (perdre
    /// l'annonce initiale, c'est un pair qui ne rattrape jamais son retard).
    pub fn connect(doc: &LoroDoc, relay_url: &str, room: &str) -> Session {
        let (outbox, queue) = channel::<Vec<u8>>();
        let status = Arc::new(Mutex::new(Status::Connecting));
        let revision = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));

        // l'annonce d'ouverture : « voici ce que j'ai déjà, envoie le reste »
        let _ = outbox.send(envelope(HAVE, &doc.oplog_vv().encode()));

        // les updates locales partent dans la file, jamais sur la socket ici
        let sender = outbox.clone();
        let local = doc.subscribe_local_update(Box::new(move |bytes| {
            sender.send(envelope(UPDATE, bytes)).is_ok()
        }));

        let url = room_url(relay_url, room);
        let thread_doc = doc.clone();
        let thread_status = Arc::clone(&status);
        let thread_revision = Arc::clone(&revision);
        let thread_stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("carnet-sync".into())
            .spawn(move || {
                run(url, thread_doc, queue, thread_status, thread_revision, thread_stop);
            })
            .expect("le fil de synchronisation démarre");

        Session { status, revision, stop, outbox, _local: local }
    }

    pub fn status(&self) -> Status {
        self.status.lock().map(|status| status.clone()).unwrap_or(Status::Off)
    }

    /// Le compteur d'updates distantes appliquées.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    /// Envoyer une trame brute — la présence, ou un signal, quand ils
    /// arriveront.
    pub fn send(&self, frame: Vec<u8>) {
        let _ = self.outbox.send(frame);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// `ws://hôte:port/?room=<salon>` — le serveur ne lit que la query, le chemin
/// lui est indifférent.
pub fn room_url(relay_url: &str, room: &str) -> String {
    let base = relay_url.trim_end_matches('/');
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}/{separator}room={}", encode(room))
}

/// Un encodage de query minimal : le nom d'un salon est un UUIDv7 ou un mot,
/// mais rien n'oblige l'utilisateur à s'y tenir.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn run(
    url: String,
    doc: LoroDoc,
    queue: Receiver<Vec<u8>>,
    status: Arc<Mutex<Status>>,
    revision: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) {
    let mut socket = match tungstenite::connect(&url) {
        Ok((socket, _)) => socket,
        Err(error) => {
            set(&status, Status::Error(error.to_string()));
            return;
        }
    };
    set(&status, Status::Relay { peers: 0 });
    // une lecture bloquante ne laisserait jamais la main à la file d'envoi ;
    // 50 ms est sous le seuil de perception et garde le fil au repos
    read_timeout(&mut socket, Duration::from_millis(50));

    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = socket.close(None);
            return;
        }

        // 1. vider la file d'envoi
        loop {
            match queue.try_recv() {
                Ok(frame) => {
                    if let Err(error) = socket.send(WsMessage::Binary(frame.into())) {
                        set(&status, Status::Error(error.to_string()));
                        return;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        // 2. lire ce qui est arrivé
        match socket.read() {
            Ok(WsMessage::Binary(bytes)) => {
                if let Some(reply) = handle(&doc, &bytes, &status, &revision) {
                    if let Err(error) = socket.send(WsMessage::Binary(reply.into())) {
                        set(&status, Status::Error(error.to_string()));
                        return;
                    }
                }
            }
            // une trame texte n'est pas la nôtre : certains proxys en
            // injectent pour garder la connexion ouverte
            Ok(WsMessage::Text(_) | WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_)) => {}
            Ok(WsMessage::Close(_)) => {
                set(&status, Status::Off);
                return;
            }
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(error) => {
                set(&status, Status::Error(error.to_string()));
                return;
            }
        }
    }
}

/// Le cœur du protocole, isolé pour être testable sans socket.
///
/// Retourne la trame à renvoyer, s'il y en a une.
pub fn handle(
    doc: &LoroDoc,
    frame: &[u8],
    status: &Arc<Mutex<Status>>,
    revision: &Arc<AtomicU64>,
) -> Option<Vec<u8>> {
    let (kind, payload) = frame.split_first()?;
    match *kind {
        HAVE => {
            // un vecteur illisible se lit « vide » : envoie-moi tout
            let vv = VersionVector::decode(payload).unwrap_or_default();
            let updates = doc.export(ExportMode::updates(&vv)).ok()?;
            Some(envelope(UPDATE, &updates))
        }
        UPDATE if !payload.is_empty() => {
            // un import raté est un pair plus récent, pas une connexion morte
            if doc.import(payload).is_ok() {
                revision.fetch_add(1, Ordering::Relaxed);
            }
            None
        }
        SIGNAL => {
            if let Ok(signal) = serde_json::from_slice::<SignalFrame>(payload) {
                if signal.kind.as_deref() == Some("members") {
                    // le compte inclut celui qui reçoit
                    let peers = signal.count.unwrap_or(1).saturating_sub(1);
                    set(status, Status::Relay { peers });
                }
            }
            None
        }
        // présence, kind inconnu, trame vide : on ignore plutôt que de fermer
        // une connexion qui marche encore pour ce qu'on comprend
        _ => None,
    }
}

fn set(status: &Arc<Mutex<Status>>, next: Status) {
    if let Ok(mut slot) = status.lock() {
        *slot = next;
    }
}

fn read_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, duration: Duration) {
    match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(duration));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream.sock.set_read_timeout(Some(duration));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (Arc<Mutex<Status>>, Arc<AtomicU64>) {
        (Arc::new(Mutex::new(Status::Connecting)), Arc::new(AtomicU64::new(0)))
    }

    #[test]
    fn the_url_carries_the_room_in_the_query() {
        assert_eq!(room_url("ws://127.0.0.1:8787", "salon"), "ws://127.0.0.1:8787/?room=salon");
        assert_eq!(room_url("ws://host/", "a b"), "ws://host/?room=a%20b");
    }

    /// Le scénario complet entre deux répliques, sans socket : c'est
    /// exactement ce que le relais transporte.
    #[test]
    fn two_peers_converge_through_have_and_update() {
        let alice = LoroDoc::new();
        alice.get_text("t").insert(0, "bonjour").unwrap();
        alice.commit();

        let basile = LoroDoc::new();
        let (status, revision) = state();

        // Basile arrive et annonce son vecteur (vide)
        let have = envelope(HAVE, &basile.oplog_vv().encode());
        let reply = handle(&alice, &have, &status, &revision).expect("Alice répond");
        assert_eq!(reply[0], UPDATE);

        // il applique la réponse
        let (basile_status, basile_revision) = state();
        assert!(handle(&basile, &reply, &basile_status, &basile_revision).is_none());
        assert_eq!(basile.get_text("t").to_string(), "bonjour");
        assert_eq!(basile_revision.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn an_unreadable_version_vector_asks_for_everything() {
        let doc = LoroDoc::new();
        doc.get_text("t").insert(0, "x").unwrap();
        doc.commit();
        let (status, revision) = state();
        let reply = handle(&doc, &envelope(HAVE, &[0, 255, 255, 255]), &status, &revision)
            .expect("une réponse quand même");
        assert!(reply.len() > 1, "le payload n'est pas vide");
    }

    #[test]
    fn unknown_kinds_and_empty_frames_are_ignored() {
        let doc = LoroDoc::new();
        let (status, revision) = state();
        assert!(handle(&doc, &[], &status, &revision).is_none());
        assert!(handle(&doc, &envelope(99, b"peu importe"), &status, &revision).is_none());
        assert!(handle(&doc, &envelope(PRESENCE, b"postcard"), &status, &revision).is_none());
        assert!(handle(&doc, &envelope(UPDATE, &[]), &status, &revision).is_none());
        assert_eq!(revision.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn the_relay_member_count_becomes_the_peer_count() {
        let doc = LoroDoc::new();
        let (status, revision) = state();
        let frame = envelope(SIGNAL, br#"{"from":"relay","kind":"members","count":3}"#);
        assert!(handle(&doc, &frame, &status, &revision).is_none());
        // 3 membres, moi compris → 2 pairs
        assert_eq!(*status.lock().unwrap(), Status::Relay { peers: 2 });

        // une offre WebRTC d'un pair web ne doit rien casser
        let offer = envelope(SIGNAL, br#"{"to":"x","kind":"offer","sdp":{"type":"offer"}}"#);
        assert!(handle(&doc, &offer, &status, &revision).is_none());
        assert_eq!(*status.lock().unwrap(), Status::Relay { peers: 2 });
    }
}
