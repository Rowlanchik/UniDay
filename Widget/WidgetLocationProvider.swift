import Foundation
import CoreLocation

/// A one-shot, ephemeral fix. The JavaScript legacy code persists the resulting
/// zone only. Authorization is granted through the containing app and extended
/// to its widget by the user's iOS choice; the extension never requests a prompt.
@MainActor
final class WidgetLocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<[String: Any], Error>?
    private var timeout: Task<Void, Never>?

    override init() { super.init(); manager.delegate = self }

    func current() async throws -> [String: Any] {
        guard manager.isAuthorizedForWidgetUpdates else {
            throw StoreError.invalid("Доступ виджета к геопозиции не разрешён. Показана сохранённая зона.")
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
                timeout = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    guard !Task.isCancelled else { return }
                    self?.finish(.failure(StoreError.invalid("Геопозиция виджета пока недоступна. Показана сохранённая зона.")))
                }
                manager.requestLocation()
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let point = locations.last, point.horizontalAccuracy >= 0 else {
            finish(.failure(StoreError.invalid("Виджет не получил пригодную геопозицию.")))
            return
        }
        finish(.success(["latitude": point.coordinate.latitude, "longitude": point.coordinate.longitude,
                         "horizontalAccuracy": point.horizontalAccuracy,
                         "timestamp": point.timestamp.timeIntervalSince1970 * 1000]))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(.failure(error)) }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard let continuation = continuation else { return }
        self.continuation = nil
        timeout?.cancel(); timeout = nil
        manager.stopUpdatingLocation()
        continuation.resume(with: result)
    }
}
