// swift-tools-version: 6.2
import PackageDescription

/**
 * The Speech framework is Swift-only, and IRIS's server is Node. So the
 * transcriber cannot be called in-process; it has to be a separate program
 * that IRIS talks to.
 *
 * That boundary is worth more than it costs. Audio never crosses it — only
 * text does — which is the property that makes always-on listening explicable
 * at all. And a crash in audio capture takes down a child process, not the
 * assistant.
 */
let package = Package(
  name: "iris-speech",
  platforms: [.macOS(.v26)],
  targets: [
    .executableTarget(name: "IrisSpeech", path: "Sources/IrisSpeech")
  ]
)
