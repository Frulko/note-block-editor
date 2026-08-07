// swift-tools-version: 5.9
import PackageDescription

/// Two targets, and the split is the point.
///
/// `NbeModel` has **no dependencies**, on purpose: it exists to show the
/// document format needs none, and a port requiring a JSON library we chose
/// would be proving something about that library.
///
/// `NbeSync` is separate because it does need one — `loro-swift`, to read the
/// same CRDT snapshot the web and desktop clients write. Keeping it apart means
/// a Swift client that only wants to *read documents* still pays nothing.
let package = Package(
    name: "NbeModel",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "NbeModel", targets: ["NbeModel"]),
        .library(name: "NbeSync", targets: ["NbeSync"]),
        .library(name: "NbeEditorKit", targets: ["NbeEditorKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/loro-dev/loro-swift.git", from: "1.8.1"),
    ],
    targets: [
        .target(name: "NbeModel"),
        .target(name: "NbeSync", dependencies: [.product(name: "Loro", package: "loro-swift"), "NbeModel"]),
        .target(name: "NbeEditorKit", dependencies: ["NbeModel", "NbeSync"]),
        .testTarget(
            name: "NbeModelTests",
            dependencies: ["NbeModel", "NbeSync", "NbeEditorKit"],
            resources: [.copy("document.json"), .copy("document.loro")]
        ),
    ]
)
