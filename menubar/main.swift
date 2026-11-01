import AppKit

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
// Menu bar only: no Dock icon, no window, nothing in the app switcher.
app.setActivationPolicy(.accessory)
if CommandLine.arguments.contains("--open-iris"), let url = URL(string: "http://127.0.0.1:3002/") {
    openInIris(url)
}
app.run()
