import Foundation
import CoreLocation
import MapKit

/**
 * How long it takes to get there, computed here rather than asked for.
 *
 * The first version went through Shortcuts, because `移動時間を取得` is listed
 * in the actions and looked like the supported route. It returns nothing on
 * this machine — measured 2026-08-22 across a geocoded address, 現在地 to
 * 現在地, driving and walking, from the command line and from the editor's own
 * run button: an empty result every time, with no error and no permission
 * prompt, while a weather shortcut built the same way worked on every run.
 *
 * MapKit is the same data without the intermediary. `MKDirections.calculateETA`
 * is a first-party call to Apple's servers, so the destination and the
 * position go to the same place they would have gone through Shortcuts and
 * nowhere else. It also returns seconds as a number, which removes the other
 * half of the old design: nothing here has to read a sentence to find a
 * figure in it.
 *
 * It lives in the menu bar app because a location permission belongs to an
 * application bundle, and this is the only part of IRIS that is one. The
 * server still decides *where* — that needs the calendar and the place map —
 * and stops there.
 */
final class Travel: NSObject, CLLocationManagerDelegate {
    static let shared = Travel()

    struct Answer {
        let minutes: Int
        let to: String
        let at: Date
    }

    /// What to say when there is no figure. Never an empty corner.
    private(set) var reason: String?

    private let manager = CLLocationManager()
    private var here: CLLocation?
    private var answers: [String: Answer] = [:]
    /// Requests in flight, so a forty-five second poll does not stack them up.
    private var asking: Set<String> = []

    /**
     * Five minutes.
     *
     * Shorter than anything else IRIS caches, because the answer is about
     * traffic and traffic is the only reason to ask. A figure held for a
     * quarter of an hour would have stopped being about the road.
     */
    private let ttl: TimeInterval = 5 * 60

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    /**
     * The answer if there is a fresh one, and a request if there is not.
     *
     * Deliberately synchronous and deliberately allowed to return nothing. The
     * strip redraws on a poll, so a first pass with no figure is a line
     * without a travel time and the pass after it has one — which is a
     * quarter of a minute later at worst, against a number that only matters
     * within three hours of leaving.
     */
    func minutes(to address: String) -> Int? {
        if let hit = answers[address], Date().timeIntervalSince(hit.at) < ttl {
            return hit.minutes
        }
        ask(address)
        return nil
    }

    private func ask(_ address: String) {
        guard !asking.contains(address) else { return }

        switch manager.authorizationStatus {
        case .notDetermined:
            reason = "位置情報の許可を待っています。"
            manager.requestWhenInUseAuthorization()
            return
        case .denied, .restricted:
            reason = "位置情報が許可されていないため、移動時間は出せません。"
            return
        default:
            break
        }

        guard let from = here else {
            // Not a failure. The first fix takes a moment and the next poll
            // will have it; saying "unavailable" here would be wrong by then.
            reason = "現在地を測っています。"
            manager.startUpdatingLocation()
            return
        }

        asking.insert(address)
        CLGeocoder().geocodeAddressString(address) { [weak self] marks, error in
            guard let self else { return }
            guard let mark = marks?.first, let to = mark.location else {
                DispatchQueue.main.async {
                    self.asking.remove(address)
                    // Names the place rather than the failure: a typo in
                    // places.json and a road that cannot be routed look the
                    // same from here, and only one is worth going to look at.
                    self.reason = "「\(address)」の場所が見つかりません。"
                    _ = error
                }
                return
            }

            let request = MKDirections.Request()
            request.source = MKMapItem(placemark: MKPlacemark(coordinate: from.coordinate))
            request.destination = MKMapItem(placemark: MKPlacemark(coordinate: to.coordinate))
            request.transportType = .automobile

            MKDirections(request: request).calculateETA { response, error in
                DispatchQueue.main.async {
                    self.asking.remove(address)
                    guard let response else {
                        self.reason = "経路を計算できませんでした。"
                        _ = error
                        return
                    }
                    self.reason = nil
                    self.answers[address] = Answer(
                        // Rounded up: arriving is the point, and a minute
                        // early is a different kind of wrong from a minute
                        // late.
                        minutes: max(1, Int(ceil(response.expectedTravelTime / 60))),
                        to: address,
                        at: Date()
                    )
                }
            }
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        here = latest
        report(latest)
        // One fix is enough for a figure measured in minutes, and a receiver
        // left running is a receiver left running.
        manager.stopUpdatingLocation()
    }

    /**
     * Tells IRIS where the machine is.
     *
     * IRIS is a server process and has no Core Location of its own — that
     * belongs to an application with a window and a permission prompt. This
     * client already exists for travel times, so anything else needing a
     * position is better served by it saying what it knows than by a second
     * subsystem asking the same question.
     *
     * Posted when the fix changes rather than on a timer: the band is the only
     * thing that knows when that happens, and polling would either miss the
     * change or wake the receiver far more often than anything needs.
     *
     * Failures are ignored. A position that did not arrive is not worth an
     * error on screen; the endpoint says so on its own by having nothing.
     */
    private func report(_ location: CLLocation) {
        guard let url = URL(string: "http://127.0.0.1:3002/api/location") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 5
        let body: [String: Any] = [
            "lat": location.coordinate.latitude,
            "lon": location.coordinate.longitude,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession(configuration: .ephemeral).dataTask(with: request).resume()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        reason = "現在地を取得できません。"
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorized {
            reason = nil
            manager.startUpdatingLocation()
        }
    }
}
