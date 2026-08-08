import NbeModel
import NbeSync
import SwiftUI
import UniformTypeIdentifiers

/// The document: a stack of blocks, each its own editing surface.
///
/// The chrome mirrors the web editor's where a phone allows it and diverges
/// where it does not, deliberately in both cases:
///
/// - **The handle is always visible.** The web version reveals it on hover, and
///   a phone has no hover. Hiding it behind a long press on the text would
///   fight text selection, which is the one gesture nobody will give up.
/// - **The keyboard bar is the phone's answer to Tab.** Indent, outdent and the
///   slash menu are keystrokes on a desktop and have no equivalent on a software
///   keyboard, so they are buttons where the thumbs already are.
struct DocumentView: View {
    @ObservedObject var room: Room

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(Array(room.blocks.enumerated()), id: \.element.id) { position, block in
                    BlockRow(room: room, entry: block, entries: room.blocks, position: position)
                        .id(block.id)
                }
                // tapping under the last block appends one, the way every notes
                // app on this platform behaves
                Rectangle()
                    .fill(.clear)
                    .frame(height: 120)
                    .contentShape(Rectangle())
                    .onTapGesture { room.appendAtEnd() }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { keyboardBar }
        // `sheet(item:)` rather than `isPresented:` with a computed binding: the
        // binding's setter fires for reasons other than dismissal — a detent
        // change is one — and each of those cleared the menu out from under the
        // row that was about to be chosen.
        .sheet(item: $room.menu) { open in
            SlashMenu(query: open.query) { item in
                room.choose(item, for: open)
            }
        }
    }

    /// Indent, outdent, and the menu — only while something has the caret.
    @ViewBuilder private var keyboardBar: some View {
        if let focused = room.focus?.id {
            HStack(spacing: 18) {
                Button { room.openMenuFromButton() } label: { Image(systemName: "plus.circle") }
                    .accessibilityLabel("Insérer un bloc")
                Divider().frame(height: 20)
                Button { room.outdent(focused) } label: { Image(systemName: "arrow.left.to.line") }
                    .accessibilityLabel("Sortir")
                Button { room.indent(focused) } label: { Image(systemName: "arrow.right.to.line") }
                    .accessibilityLabel("Imbriquer")
                Divider().frame(height: 20)
                /*
                 * Reordering without dragging. The handle is the direct gesture
                 * and these are not a fallback for tests: dragging a block past a
                 * screenful of document is miserable on a phone, and a VoiceOver
                 * user cannot drag at all.
                 */
                Button { room.moveUp(focused) } label: { Image(systemName: "arrow.up") }
                    .accessibilityLabel("Monter le bloc")
                Button { room.moveDown(focused) } label: { Image(systemName: "arrow.down") }
                    .accessibilityLabel("Descendre le bloc")
                Spacer()
                Button { room.remove(focused) } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Supprimer le bloc")
                Button { dismissKeyboard() } label: { Image(systemName: "keyboard.chevron.compact.down") }
                    .accessibilityLabel("Masquer le clavier")
            }
            .font(.title3)
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    /// Clearing `focus` is not enough: the text view is the first responder and
    /// only it can give that up, so this asks whoever holds it to let go.
    private func dismissKeyboard() {
        room.clearFocus()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// One block: its handle, its marker, and its text.
private struct BlockRow: View {
    @ObservedObject var room: Room
    let entry: DocumentOrder.Entry
    let entries: [DocumentOrder.Entry]
    let position: Int
    @State private var isTarget = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            handle
            marker
            content
        }
        .padding(.leading, CGFloat(max(0, entry.depth - 1)) * 20)
        .padding(.vertical, entry.type == "heading" ? 6 : 2)
        .background(alignment: .bottom) {
            // where a dropped block would land, drawn rather than guessed at
            if isTarget { Rectangle().fill(.tint).frame(height: 2) }
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let dragged = ids.first else { return false }
            room.move(dragged, after: entry.id)
            return true
        } isTargeted: { isTarget = $0 }
    }

    /// The grab handle. `draggable` on *this* and not on the row, so a long
    /// press in the text still selects text.
    private var handle: some View {
        Image(systemName: "line.3.horizontal")
            .font(.caption)
            .foregroundStyle(.tertiary)
            .frame(width: 22, height: 26)
            .contentShape(Rectangle())
            .draggable(entry.id) {
                Text(entry.text?.isEmpty == false ? entry.text! : "Bloc")
                    .padding(6)
                    .background(.regularMaterial)
            }
            .accessibilityLabel("Déplacer le bloc")
            // named by position, like the text views: a count over an unnamed
            // query is resolved against a cached snapshot and under-reports
            .accessibilityIdentifier("poignée-\(position)")
    }

    @ViewBuilder private var marker: some View {
        switch entry.type {
        case "to_do":
            Button {
                room.setChecked(entry.id, !entry.isChecked)
            } label: {
                Image(systemName: entry.isChecked ? "checkmark.square.fill" : "square")
                    .foregroundStyle(entry.isChecked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
            .accessibilityLabel(entry.isChecked ? "Fait" : "À faire")
        case "toggle":
            Button { room.toggleCollapsed(entry.id) } label: {
                Image(systemName: room.isCollapsed(entry.id) ? "chevron.right" : "chevron.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
            .accessibilityLabel(room.isCollapsed(entry.id) ? "Déplier" : "Replier")
        default:
            if let marker = BlockCatalogue.marker(for: entry, in: entries) {
                Text(marker)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 18, alignment: .trailing)
                    .padding(.top, 1)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if entry.type == "divider" {
            Divider().padding(.vertical, 10)
        } else {
            BlockTextEditor(
                entry: entry,
                placeholder: BlockCatalogue.placeholder(for: entry, isFirst: entries.first?.id == entry.id),
                caret: room.focus?.id == entry.id ? room.focus?.caret : nil,
                focusRequest: room.focusRequest,
                modelRevision: room.modelRevision,
                position: position,
                actions: room.actions(for: entry)
            )
            // set from SwiftUI, not on the `UITextView`: SwiftUI's accessibility
            // layer replaces an identifier assigned to the underlying view, so the
            // name silently disappeared from the tree
            .accessibilityIdentifier("bloc-\(position)")
            .padding(.leading, entry.type == "quote" ? 10 : 0)
            .overlay(alignment: .leading) {
                if entry.type == "quote" {
                    Rectangle().fill(.secondary).frame(width: 3)
                }
            }
            .padding(entry.type == "code" ? 8 : 0)
            .background(entry.type == "code" ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear))
            .clipShape(RoundedRectangle(cornerRadius: entry.type == "code" ? 6 : 0))
        }
    }
}

/// The slash menu, as a sheet — the phone's popover.
///
/// **The filter field is focused on appear, and that is not a nicety.** A sheet
/// takes the keyboard away from the block, so the web editor's behaviour — keep
/// typing after the `/` and watch the list narrow — cannot work here: those
/// keystrokes would go nowhere. Handing the keyboard straight to a field inside
/// the sheet keeps the *feel* (type `/cit`, get « Citation ») with the only
/// mechanism the platform allows. The query typed before the sheet opened is
/// carried in as its starting value, so nothing typed is lost.
struct SlashMenu: View {
    let query: String
    let choose: (BlockCatalogue.Item) -> Void
    @State private var typed: String
    @FocusState private var filterFocused: Bool
    @Environment(\.dismiss) private var dismiss

    init(query: String, choose: @escaping (BlockCatalogue.Item) -> Void) {
        self.query = query
        self.choose = choose
        _typed = State(initialValue: query)
    }

    private var items: [BlockCatalogue.Item] { BlockCatalogue.matching(typed) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Filtrer", text: $typed)
                        .focused($filterFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { if let first = items.first { pick(first) } }
                        .accessibilityIdentifier("filtre")
                }
                .padding(10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)
                .padding(.bottom, 8)

                List(items) { item in
                    /*
                     * A tap gesture, not a `Button`, and the reason is a real
                     * defect rather than taste: with the filter field focused, the
                     * first tap on a `Button` inside a `List` only dismisses the
                     * keyboard — the row does nothing and you have to tap again.
                     * Since the field is focused *on purpose* (it is where typing
                     * to filter goes), every choice would have cost two taps.
                     */
                    HStack(spacing: 14) {
                        Image(systemName: item.symbol)
                            .frame(width: 26)
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.label)
                            Text(item.hint).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let shortcut = item.shortcut {
                            Text(shortcut)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { pick(item) }
                    // one element, named — otherwise the label is the whole stack
                    // read out ("Titre 1, grand titre, # ") and nothing can find it
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(item.label)
                    .accessibilityIdentifier(item.label)
                    .accessibilityAddTraits(.isButton)
                }
                .listStyle(.plain)
                .overlay {
                    if items.isEmpty { ContentUnavailableView.search(text: typed) }
                }
            }
            .navigationTitle("Transformer en")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Annuler") { dismiss() }
                }
            }
            .task { filterFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private func pick(_ item: BlockCatalogue.Item) {
        choose(item)
        dismiss()
    }
}
