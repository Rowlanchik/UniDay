import UIKit
import EventKit
import EventKitUI
import CoreLocation
import Photos
import PhotosUI
import UniformTypeIdentifiers
import UserNotifications

@MainActor
final class NativeAdapters: NSObject, EKEventEditViewDelegate, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, CLLocationManagerDelegate {
    weak var presenter: UIViewController?
    private let calendar = EKEventStore()
    private var eventContinuation: CheckedContinuation<Any, Error>?
    private var documentContinuation: CheckedContinuation<Any, Error>?
    private var photoContinuation: CheckedContinuation<Any, Error>?
    private var locationContinuation: CheckedContinuation<Any, Error>?
    private let location = CLLocationManager()
    private var locationTimeout: Task<Void, Never>?
    override init() { super.init(); location.delegate = self }
    private func failure(_ message: String) -> NSError { NSError(domain: "UniDay", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func present(_ controller: UIViewController) throws {
        guard let presenter, presenter.presentedViewController == nil else { throw failure("Другой экран уже открыт. Закройте его и повторите.") }
        if let popover = controller.popoverPresentationController { popover.sourceView = presenter.view; popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1) }
        presenter.present(controller, animated: true)
    }
    func alert(_ payload: [String: Any]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            let fields = payload["fields"] as? [[String: Any]] ?? []
            let sheet = payload["style"] as? String == "sheet" && fields.isEmpty
            let alert = UIAlertController(title: payload["title"] as? String, message: payload["message"] as? String, preferredStyle: sheet ? .actionSheet : .alert)
            fields.forEach { f in alert.addTextField { t in t.placeholder = f["placeholder"] as? String; t.text = f["value"] as? String; t.isSecureTextEntry = f["secure"] as? Bool ?? false } }
            let finish: (Int) -> Void = { index in continuation.resume(returning: ["index": index, "values": (alert.textFields ?? []).map { $0.text ?? "" }]) }
            for (i, action) in (payload["actions"] as? [[String: Any]] ?? []).enumerated() {
                alert.addAction(UIAlertAction(title: action["title"] as? String, style: action["destructive"] as? Bool == true ? .destructive : .default) { _ in finish(i) })
            }
            if let cancel = payload["cancel"] as? String { alert.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in finish(-1) }) }
            if alert.actions.isEmpty { alert.addAction(UIAlertAction(title: "Закрыть", style: .default) { _ in finish(0) }) }
            do { try present(alert) } catch { continuation.resume(throwing: error) }
        }
    }
    private func calendarAccess() async throws {
        let status = EKEventStore.authorizationStatus(for: .event)
        if status == .fullAccess { return }
        guard try await calendar.requestFullAccessToEvents() else { throw failure("Разрешите UniDay полный доступ к календарю в настройках iPhone.") }
    }
    private func serialize(_ event: EKEvent) -> [String: Any] {
        ["identifier": event.eventIdentifier ?? "", "title": event.title ?? "", "startDate": event.startDate.timeIntervalSince1970 * 1000,
         "endDate": event.endDate.timeIntervalSince1970 * 1000, "notes": event.notes ?? "", "location": event.location ?? "", "isAllDay": event.isAllDay,
         "calendar": ["identifier": event.calendar.calendarIdentifier, "title": event.calendar.title]]
    }
    func events(_ payload: [String: Any]) async throws -> Any {
        try await calendarAccess()
        let parse: (Any?) -> Date? = { value in
            if let ms = value as? Double { return Date(timeIntervalSince1970: ms / 1000) }
            return UniDayDate.parse(value as? String)
        }
        guard let from = parse(payload["from"]), let to = parse(payload["to"]), from < to else { throw failure("Некорректный диапазон событий") }
        return calendar.events(matching: calendar.predicateForEvents(withStart: from, end: to, calendars: nil)).map(serialize)
    }
    func createEvent() async throws -> Any {
        try await calendarAccess()
        return try await withCheckedThrowingContinuation { continuation in
            eventContinuation = continuation
            let edit = EKEventEditViewController(); edit.eventStore = calendar; edit.editViewDelegate = self
            do { try present(edit) } catch { eventContinuation = nil; continuation.resume(throwing: error) }
        }
    }
    func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        var value: Any = NSNull()
        if action == .saved, let event = controller.event { value = serialize(event) }
        controller.dismiss(animated: true) { [weak self] in self?.eventContinuation?.resume(returning: value); self?.eventContinuation = nil }
    }
    func pickDocument(_ types: [String]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            documentContinuation = continuation
            let contentTypes = types.compactMap { UTType($0) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes.isEmpty ? [.json] : contentTypes, asCopy: true)
            picker.delegate = self; picker.allowsMultipleSelection = false
            do { try present(picker) } catch { documentContinuation = nil; continuation.resume(throwing: error) }
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { documentContinuation?.resume(returning: []); documentContinuation = nil }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        do {
            let items = try urls.map { url -> [String: Any] in
                let granted = url.startAccessingSecurityScopedResource(); defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url); guard data.count <= 150 * 1024 * 1024, let text = String(data: data, encoding: .utf8) else { throw failure("Нужен JSON UTF-8 не больше 150 МБ") }
                return ["path": "/documents/Imports/\(UUID().uuidString).json", "text": text]
            }
            documentContinuation?.resume(returning: items)
        } catch { documentContinuation?.resume(throwing: error) }
        documentContinuation = nil
    }
    private func imagePayload(_ image: UIImage) throws -> [String: Any] {
        guard let png = image.pngData() else { throw failure("Не удалось прочитать изображение") }
        return ["dataURL": "data:image/png;base64," + png.base64EncodedString(), "width": image.size.width * image.scale, "height": image.size.height * image.scale]
    }
    func pickPhoto(latest: Bool) async throws -> Any {
        if latest {
            let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard status == .authorized || status == .limited else { throw failure("Для последнего снимка разрешите доступ к Фото или выберите изображение вручную.") }
            let options = PHFetchOptions(); options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]; options.fetchLimit = 1
            options.predicate = NSPredicate(format: "(mediaSubtype & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
            guard let asset = PHAsset.fetchAssets(with: .image, options: options).firstObject else { throw failure("Снимок экрана не найден. Выберите его вручную.") }
            let image: UIImage = try await withCheckedThrowingContinuation { c in
                let o = PHImageRequestOptions(); o.isNetworkAccessAllowed = true; o.deliveryMode = .highQualityFormat
                PHImageManager.default().requestImageDataAndOrientation(for: asset, options: o) { data, _, _, info in
                    if let data, let image = UIImage(data: data) { c.resume(returning: image) } else { c.resume(throwing: self.failure("Снимок недоступен")) }
                }
            }
            return try imagePayload(image)
        }
        return try await withCheckedThrowingContinuation { continuation in
            photoContinuation = continuation
            var config = PHPickerConfiguration(); config.filter = .images; config.selectionLimit = 1
            let picker = PHPickerViewController(configuration: config); picker.delegate = self
            do { try present(picker) } catch { photoContinuation = nil; continuation.resume(throwing: error) }
        }
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) {
            guard let result = results.first else { self.photoContinuation?.resume(throwing: self.failure("Выбор изображения отменён")); self.photoContinuation = nil; return }
            result.itemProvider.loadObject(ofClass: UIImage.self) { object, error in
                Task { @MainActor in
                    do { guard let image = object as? UIImage else { throw error ?? self.failure("Изображение недоступно") }; self.photoContinuation?.resume(returning: try self.imagePayload(image)) }
                    catch { self.photoContinuation?.resume(throwing: error) }
                    self.photoContinuation = nil
                }
            }
        }
    }
    func currentLocation() async throws -> Any {
        guard locationContinuation == nil else { throw failure("Геопозиция уже запрашивается") }
        return try await withCheckedThrowingContinuation { c in
            locationContinuation = c
            locationTimeout = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                if !Task.isCancelled { self.finishLocation(.failure(self.failure("Время ожидания геопозиции истекло"))) }
            }
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
            else if location.authorizationStatus == .denied || location.authorizationStatus == .restricted { finishLocation(.failure(failure("Доступ к геопозиции запрещён"))) }
            else { location.desiredAccuracy = kCLLocationAccuracyHundredMeters; location.requestLocation() }
        }
    }
    private func finishLocation(_ result: Result<Any, Error>) { locationTimeout?.cancel(); locationContinuation?.resume(with: result); locationContinuation = nil }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard locationContinuation != nil else { return }
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways { manager.requestLocation() }
        else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted { finishLocation(.failure(failure("Доступ к геопозиции запрещён"))) }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let p = locations.last else { return }; finishLocation(.success(["latitude": p.coordinate.latitude, "longitude": p.coordinate.longitude, "horizontalAccuracy": p.horizontalAccuracy, "timestamp": p.timestamp.timeIntervalSince1970 * 1000]))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finishLocation(.failure(error)) }
}
