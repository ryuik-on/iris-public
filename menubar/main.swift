import AppKit

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
// Menu bar only: no Dock icon, no window, nothing in the app switcher.
app.setActivationPolicy(.accessory)
app.run()
