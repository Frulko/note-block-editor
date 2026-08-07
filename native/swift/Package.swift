// swift-tools-version: 5.9
import PackageDescription

// No dependencies, on purpose: this exists to show the document format needs
// none. A port that required a JSON library we chose would be proving something
// about that library.
let package = Package(
    name: "NbeModel",
    products: [.library(name: "NbeModel", targets: ["NbeModel"])],
    targets: [
        .target(name: "NbeModel"),
        .testTarget(name: "NbeModelTests", dependencies: ["NbeModel"], resources: [.copy("document.json")]),
    ]
)
