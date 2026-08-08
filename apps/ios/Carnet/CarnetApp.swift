import SwiftUI

@main
struct CarnetApp: App {
    var body: some Scene {
        WindowGroup {
            RoomView()
        }
    }
}

/// One room, one page, and the line that says how the bytes are travelling.
///
/// The editor itself is `DocumentView`; this is the shell around it — joining a
/// relay, and reporting whether the document is going through it.
struct RoomView: View {
    @StateObject private var room = Room()
    @State private var relay = "ws://localhost:8787"
    @State private var name = "salon"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if room.connected {
                    DocumentView(room: room)
                } else {
                    connect
                }
                Divider()
                status
            }
            .navigationTitle("Carnet")
            .toolbar {
                if room.connected {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Quitter") { room.leave() }
                    }
                }
            }
            /*
             * A simulator run is the only way this app gets checked, and tapping
             * a button is the one thing a script cannot do to it. So the room can
             * come from the environment:
             *
             *   SIMCTL_CHILD_CARNET_ROOM=salon xcrun simctl launch booted fr.myrole.carnet
             *
             * Nothing else in the app reads these, and without them it behaves
             * exactly as it looks.
             */
            .task {
                let environment = ProcessInfo.processInfo.environment
                guard let room = environment["CARNET_ROOM"] else { return }
                name = room
                if let url = environment["CARNET_RELAY"] { relay = url }
                self.room.join(relay: relay, room: room)
            }
        }
    }

    private var status: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(room.status.hasPrefix("Pair-à-pair") ? .green : room.connected ? .orange : .secondary)
                .frame(width: 8, height: 8)
            Text(room.status).font(.footnote).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
    }

    private var connect: some View {
        Form {
            Section("Relais") {
                TextField("ws://…", text: $relay)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("salon", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section {
                Button("Rejoindre") { room.join(relay: relay, room: name) }
                    .disabled(relay.isEmpty || name.isEmpty)
            } footer: {
                Text(
                    """
                    Le relais sert à se trouver, pas à porter le document : \
                    dès qu’un canal WebRTC est ouvert avec chaque pair, il n’en \
                    voit plus rien. Lancez `nbe relay` sur votre machine — depuis \
                    le simulateur, `localhost` est bien cette machine.
                    """
                )
            }
        }
    }
}
