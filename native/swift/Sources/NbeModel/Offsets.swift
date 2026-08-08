import Foundation

/// Where a caret is, in a language that disagrees with the model about counting.
///
/// The model counts in **UTF-16 code units**, because that is what the web
/// platform hands the TypeScript editor and what §2.2 fixes as the offset unit.
/// Swift's `String` counts in `Character`s — extended grapheme clusters — and
/// refuses to index by integer at all. Neither is wrong; they are different
/// questions, and every bug in this layer is someone answering one with the
/// other.
///
/// The failure is not theoretical. A family emoji is one `Character`, eleven
/// UTF-16 units and four scalars. An accented letter may be one unit or two
/// depending on normalisation. Getting this wrong puts the caret inside a
/// character, and the symptom is text that deletes in halves.
///
/// So the model's offsets stay authoritative and this converts, in both
/// directions, with a snap for the case that matters: an offset that lands
/// inside a cluster is moved **outward** rather than truncated, matching
/// `packages/core/src/grapheme.ts`.
public enum Offsets {
    /// Which way to round an offset that lands inside a cluster.
    ///
    /// Not a preference: `.back` for the *start* of a range and `.forward` for
    /// its *end*, so snapping only ever grows a range and never silently drops
    /// a character someone selected. This mirrors `snapGrapheme` in
    /// `packages/core/src/grapheme.ts`, and the mirroring is the point — the
    /// first version of this file always snapped forward, which would have
    /// shrunk every selection at its start, and a parity test against the
    /// TypeScript implementation is what caught it.
    public enum Prefer: Sendable {
        case back
        case forward
    }

    /// The `String.Index` for a UTF-16 offset, snapped out of any cluster.
    ///
    /// Written as a walk over cluster boundaries rather than as index
    /// arithmetic. It is linear in the block's length, which is a sentence, and
    /// it is obviously right — the clever version was neither.
    public static func index(in text: String, at utf16Offset: Int, prefer: Prefer = .back) -> String.Index {
        let clamped = max(0, min(utf16Offset, text.utf16.count))
        var here = text.startIndex
        var consumed = 0
        while here < text.endIndex {
            if clamped <= consumed { return here }
            let next = text.index(after: here)
            let width = text.utf16.distance(from: here, to: next)
            // inside this cluster: to its start or to its end, as asked
            if clamped < consumed + width { return prefer == .back ? here : next }
            consumed += width
            here = next
        }
        return text.endIndex
    }

    /// The UTF-16 offset of a `String.Index` — the model's unit.
    public static func offset(in text: String, of index: String.Index) -> Int {
        text.utf16.distance(from: text.utf16.startIndex, to: index)
    }

    /// The offset one grapheme before this one, or the same one at the start.
    public static func previousGrapheme(in text: String, from utf16Offset: Int) -> Int {
        let here = index(in: text, at: utf16Offset, prefer: .back)
        guard here > text.startIndex else { return 0 }
        return offset(in: text, of: text.index(before: here))
    }

    /// The offset one grapheme after this one, or the same one at the end.
    public static func nextGrapheme(in text: String, from utf16Offset: Int) -> Int {
        let here = index(in: text, at: utf16Offset, prefer: .forward)
        guard here < text.endIndex else { return text.utf16.count }
        return offset(in: text, of: text.index(after: here))
    }

    /// How many UTF-16 units these runs hold — the block's length, model-side.
    public static func length(of runs: [Run]) -> Int {
        runs.reduce(0) { $0 + $1.text.utf16.count }
    }

    // MARK: - The CRDT's unit, which is a third one

    /// A UTF-16 offset as the **Unicode scalar** offset Loro indexes text by.
    ///
    /// Three units are now in play and it is worth naming them once: the web
    /// platform and this model count **UTF-16 code units**, Swift's `String`
    /// counts **grapheme clusters**, and `LoroText.insert(pos:s:)` counts
    /// **Unicode code points**. An emoji makes all three differ — 👍 is one
    /// cluster, one scalar, two UTF-16 units — so a caret handed straight from a
    /// text view to the CRDT lands in the wrong place the first time anyone types
    /// an emoji, and the text tears.
    ///
    /// `OffsetTests` pins Loro's unit with a document rather than trusting this
    /// comment, because it is the kind of fact that changes in a minor release.
    public static func scalarOffset(in text: String, utf16Offset: Int) -> Int {
        let here = index(in: text, at: utf16Offset, prefer: .back)
        return text.unicodeScalars.distance(from: text.unicodeScalars.startIndex, to: here.samePosition(in: text.unicodeScalars) ?? text.unicodeScalars.startIndex)
    }

    /// The other direction: a Loro scalar offset as a UTF-16 one.
    public static func utf16Offset(in text: String, scalarOffset: Int) -> Int {
        let clamped = max(0, min(scalarOffset, text.unicodeScalars.count))
        let scalars = text.unicodeScalars
        let here = scalars.index(scalars.startIndex, offsetBy: clamped)
        return text.utf16.distance(from: text.utf16.startIndex, to: here)
    }

    /// How many scalars a string is — the length the CRDT means.
    public static func scalarLength(of text: String) -> Int {
        text.unicodeScalars.count
    }
}
