import Foundation
import NbeModel

/// Runs to attributed text, and back.
///
/// Every TextKit view needs this, and it is the layer where marks quietly get
/// lost. The rule that keeps it honest: **the model is authoritative and this
/// is a projection**, so a mark that Swift has no visual for must still survive
/// the round trip. A `link`'s href, a `comment`'s thread id, a mark a plugin
/// invented — none of them render here, and all of them must come back.
///
/// That is why marks are carried as one custom attribute holding the model's
/// own array, rather than being mapped onto AppKit's `.font`, `.underlineStyle`
/// and friends. Mapping would be prettier and would lose exactly the marks that
/// matter — the ones with data attached. A view that wants bold text reads the
/// marks and decides; it does not ask this to have decided for it.
public enum AttributedText {
    /// The attribute under which the model's marks travel.
    public static let marksAttribute = NSAttributedString.Key("nbe.marks")

    /// Project runs into attributed text.
    public static func from(runs: [Run]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for run in runs {
            let piece = NSMutableAttributedString(string: run.text)
            if let marks = run.marks, !marks.isEmpty {
                piece.addAttribute(marksAttribute, value: marks, range: NSRange(location: 0, length: piece.length))
            }
            out.append(piece)
        }
        return out
    }

    /// Read attributed text back as runs.
    ///
    /// Adjacent stretches carrying the same marks are merged, because a view
    /// splits attribute runs for reasons of its own — a spell-check underline,
    /// a temporary composition highlight — and those are not model boundaries.
    /// Without the merge, typing a sentence would slowly shatter it into a run
    /// per keystroke.
    public static func toRuns(_ attributed: NSAttributedString) -> [Run] {
        var out: [Run] = []
        let whole = NSRange(location: 0, length: attributed.length)

        attributed.enumerateAttribute(marksAttribute, in: whole) { value, range, _ in
            let text = (attributed.string as NSString).substring(with: range)
            guard !text.isEmpty else { return }
            let marks = value as? [Mark]

            if let last = out.last, last.marks == marks {
                out[out.count - 1] = Run(text: last.text + text, marks: marks)
            } else {
                out.append(Run(text: text, marks: marks))
            }
        }
        return out
    }
}
