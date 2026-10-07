import UIKit
import WebKit
import WidgetKit
import UserNotifications
import SwiftUI

@MainActor
final class UniDayViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var web: WKWebView!
    private var store: SharedStore?
    private let adapters = NativeAdapters()
    private var startupQuery: [String: String] = [:]
    private var ready = false
    private var updateTask: Task<Void, Never>?
    private var availableRelease: SourceRelease?
    private var updateError: String?
    private var smoke = false
    private var smokeLabel: UILabel?
    private var notificationTokens: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground; adapters.presenter = self
        smoke = Bundle.main.object(forInfoDictionaryKey: "UniDaySmoke") as? String == "1"
        do { store = try SharedStore() } catch { showError(error); return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "uniday")
        web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self; web.translatesAutoresizingMaskIntoConstraints = false
        let toolbar = UIStackView(); toolbar.axis = .horizontal; toolbar.distribution = .equalSpacing; toolbar.translatesAutoresizingMaskIntoConstraints = false
        let title = UILabel(); title.text = smoke ? "UniDay · тест виджета" : "UniDay"; title.font = .boldSystemFont(ofSize: 17)
        let menu = UIButton(type: .system); menu.setTitle("Меню", for: .normal); menu.showsMenuAsPrimaryAction = true
        menu.menu = UIMenu(children: [
            UIAction(title: "Версия и обновление") { [weak self] _ in self?.showUpdate() },
            UIAction(title: "Экспорт полной резервной копии") { [weak self] _ in self?.exportBackup() },
            UIAction(title: "Восстановить резервную копию") { [weak self] _ in self?.importBackup() },
            UIAction(title: "Копировать настройку виджета без App Group") { [weak self] _ in self?.exportWidgetSetup() },
            UIAction(title: "Диагностика подписи и виджета") { [weak self] _ in self?.showDiagnostics() },
            UIAction(title: "Тест обмена с виджетом") { [weak self] _ in self?.publishSmoke() }
        ])
        toolbar.addArrangedSubview(title); toolbar.addArrangedSubview(menu); view.addSubview(toolbar); view.addSubview(web)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16), toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16), toolbar.heightAnchor.constraint(equalToConstant: 44),
            web.topAnchor.constraint(equalTo: toolbar.bottomAnchor), web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        notificationTokens.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.checkUpdate(); if self?.ready == true { self?.evaluate("UniDay.resume(); true;") } } })
        notificationTokens.append(NotificationCenter.default.addObserver(forName: .unidayOpenURL, object: nil, queue: .main) { [weak self] n in if let url = n.object as? URL { Task { @MainActor in self?.open(url) } } })
        if smoke { makeSmokeScreen() } else { loadRuntime() }
        checkUpdate()
    }
    deinit { notificationTokens.forEach(NotificationCenter.default.removeObserver) }
    private func loadRuntime() {
        ready = false
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html") else { showError(NSError(domain: "UniDay", code: 2, userInfo: [NSLocalizedDescriptionKey: "Ресурсы интерфейса не найдены"])); return }
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }
    private func json(_ value: Any) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), encoding: .utf8)! }
    private func evaluate(_ script: String) { web.evaluateJavaScript(script) { [weak self] _, error in if let error { self?.showError(error) } } }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !smoke, !ready, webView.url?.isFileURL == true else { return }
        do {
            var bootstrap = store?.readState() ?? [:]
            bootstrap["device"] = ["screenSize": ["width": UIScreen.main.bounds.width, "height": UIScreen.main.bounds.height], "screenResolution": ["width": UIScreen.main.nativeBounds.width, "height": UIScreen.main.nativeBounds.height], "scale": UIScreen.main.scale, "model": UIDevice.current.model, "systemVersion": UIDevice.current.systemVersion, "fontNames": UIFont.familyNames.flatMap { UIFont.fontNames(forFamilyName: $0) }]
            bootstrap["version"] = UpdateService.currentVersion; bootstrap["updateSourceURL"] = UpdateService.sourceURL.absoluteString
            let script = "void (async()=>{await UniDayNative.bootstrap(\(try json(bootstrap))); UniDay.start(\(try json(startupQuery))).catch(e => UniDayNative.call('runtime.error',{message:String(e)}));})().catch(e=>UniDayNative.call('runtime.error',{message:String(e)})); true;"
            ready = true; evaluate(script)
        } catch { showError(error) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { ready = false; loadRuntime() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "uniday" { open(url); decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == true && !url.isFileURL && url.absoluteString != "about:blank" { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func open(_ url: URL) {
        guard url.scheme == "uniday" else { return }
        var params = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if params["action"] == nil { params["action"] = url.host ?? "overview" }
        startupQuery = params
        if ready { do { evaluate("UniDay.navigate(\(try json(url.absoluteString))); true;") } catch { showError(error) } }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let id = body["id"], let method = body["method"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do { let value = try await handle(method, payload); try resolve(id, value, nil) }
            catch { try? resolve(id, NSNull(), error.localizedDescription) }
        }
    }
    private func resolve(_ id: Any, _ value: Any, _ error: String?) throws {
        evaluate("UniDayNative.resolve(\(try json(id)),\(try json(value)),\(try json(error as Any? ?? NSNull()))); true;")
    }
    private func handle(_ method: String, _ p: [String: Any]) async throws -> Any {
        switch method {
        case "storage.apply": try store?.apply(p["operations"] as? [[String: Any]] ?? []); return true
        case "request":
            guard let text = p["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw URLError(.badURL) }
            var request = URLRequest(url: url, timeoutInterval: max(1, min(30, p["timeoutSeconds"] as? Double ?? 6)))
            request.httpMethod = p["method"] as? String ?? "GET"; request.allHTTPHeaderFields = p["headers"] as? [String: String]
            if let body = p["body"] as? String { request.httpBody = body.data(using: .utf8) }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard data.count <= 16_000_000, let text = String(data: data, encoding: .utf8), let http = response as? HTTPURLResponse, http.url?.scheme == "https" else { throw URLError(.badServerResponse) }
            return ["text": text, "status": http.statusCode]
        case "alert": return try await adapters.alert(p)
        case "calendar.between": return try await adapters.events(p)
        case "calendar.create": return try await adapters.createEvent()
        case "location.current": return try await adapters.currentLocation()
        case "photos.pick": return try await adapters.pickPhoto(latest: p["latestScreenshot"] as? Bool ?? false)
        case "document.pick": return try await adapters.pickDocument(p["types"] as? [String] ?? ["public.json"])
        case "quickLook":
            let item: Any
            if let image = p["image"] as? [String: Any], let dataURL = image["dataURL"] as? String, let base64 = dataURL.split(separator: ",", maxSplits: 1).last, let data = Data(base64Encoded: String(base64)), let image = UIImage(data: data) { item = image }
            else { item = p["text"] as? String ?? "" }
            let child = UIViewController(); child.view.backgroundColor = .systemBackground
            let content: UIView
            if let image = item as? UIImage { let imageView = UIImageView(image: image); imageView.contentMode = .scaleAspectFit; content = imageView }
            else { let textView = UITextView(); textView.text = item as? String ?? ""; textView.isEditable = false; textView.font = .systemFont(ofSize: 15); content = textView }
            content.translatesAutoresizingMaskIntoConstraints = false; child.view.addSubview(content)
            NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: child.view.leadingAnchor, constant: 16), content.trailingAnchor.constraint(equalTo: child.view.trailingAnchor, constant: -16), content.topAnchor.constraint(equalTo: child.view.safeAreaLayoutGuide.topAnchor), content.bottomAnchor.constraint(equalTo: child.view.safeAreaLayoutGuide.bottomAnchor)])
            return try await preview(child, title: "Предпросмотр", shareItem: item)
        case "safari.open":
            guard let text = p["url"] as? String, let url = URL(string: text), ["https", "altstore-classic"].contains(url.scheme ?? "") else { throw URLError(.badURL) }
            await UIApplication.shared.open(url); return true
        case "notifications.pending": return await UNUserNotificationCenter.current().pendingNotificationRequests().map { ["identifier": $0.identifier] }
        case "notifications.delivered": return await UNUserNotificationCenter.current().deliveredNotifications().map { ["identifier": $0.request.identifier] }
        case "notifications.remove":
            let ids = (p["identifiers"] as? [String] ?? []).filter { $0.hasPrefix("uniday-personal-") }
            if p["delivered"] as? Bool == true { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
            else { UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids) }; return true
        case "notifications.removePending": UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: p["identifiers"] as? [String] ?? []); return true
        case "notifications.removeDelivered": UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: p["identifiers"] as? [String] ?? []); return true
        case "widget.publish": try store?.publishWidget(p); WidgetCenter.shared.reloadAllTimelines(); return true
        case "widget.preview":
            guard let value = p["plan"] as? [String: Any] else { throw StoreError.invalid("Не получен план предпросмотра виджета") }
            let plan = try JSONDecoder().decode(WidgetPlan.self, from: JSONSerialization.data(withJSONObject: value))
            let family = p["family"] as? String ?? "large"
            let width = CGFloat(plan.dimensions?.width ?? 338), height = CGFloat(plan.dimensions?.height ?? (family == "large" ? 354 : 158))
            let host = UIHostingController(rootView: VStack(spacing: 20) { WidgetCardView(plan: plan).frame(width: width, height: height).clipShape(RoundedRectangle(cornerRadius: 22)); Text("Предпросмотр. Окончательная компоновка зависит от размера виджета и iOS.").font(.footnote).foregroundStyle(.secondary).padding(); Spacer() }.padding(.top, 24))
            return try await preview(host, title: "Виджет \(family)")
        case "data.export":
            var content = store?.readState() ?? [:]
            if let files = p["files"] as? [String: Any] { content["files"] = files }
            if let directories = p["directories"] as? [String] { content["directories"] = directories }
            content["schemaVersion"] = SharedStore.schemaVersion
            let backup: [String: Any] = ["format": "UniDay-backup", "backupVersion": 1, "exportedAt": SharedStore.timestamp(), "containsUnsavedChanges": p["containsUnsavedChanges"] as? Bool ?? false, "state": content]
            let data = try JSONSerialization.data(withJSONObject: backup, options: [.prettyPrinted, .sortedKeys])
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("UniDay-backup-\(Int(Date().timeIntervalSince1970)).json")
            try data.write(to: url, options: .atomic); share(url); return true
        case "runtime.error": throw NSError(domain: "UniDay", code: 3, userInfo: [NSLocalizedDescriptionKey: p["message"] as? String ?? "Ошибка интерфейса"])
        default: throw NSError(domain: "UniDay", code: 4, userInfo: [NSLocalizedDescriptionKey: "Неизвестный адаптер: \(method)"])
        }
    }
    private func share(_ item: Any) {
        let controller = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = view; controller.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 44, width: 1, height: 1)
        present(controller, animated: true)
    }
    private func preview(_ child: UIViewController, title: String, shareItem: Any? = nil) async throws -> Any {
        guard presentedViewController == nil else { throw StoreError.invalid("Закройте предыдущий экран") }
        return await withCheckedContinuation { continuation in
            let container = UniDayPreviewController(root: child, title: title, shareItem: shareItem) { continuation.resume(returning: true) }
            present(container, animated: true)
        }
    }
    private func flush() async throws {
        if ready { _ = try await web.callAsyncJavaScript("await UniDayNative.flush(); return true;", arguments: [:], in: nil, contentWorld: .page) }
    }
    private func exportBackup() {
        if ready { evaluate("UniDay.exportBackup().catch(e=>UniDayNative.call('runtime.error',{message:String(e)})); true;"); return }
        Task { @MainActor in
            do { try await flush(); guard let data = try store?.exportBackup() else { return }; let url = FileManager.default.temporaryDirectory.appendingPathComponent("UniDay-backup-\(Int(Date().timeIntervalSince1970)).json"); try data.write(to: url, options: .atomic); share(url) }
            catch { showError(error) }
        }
    }
    private func importBackup() {
        Task { @MainActor in
            do {
                try await flush()
                guard let items = try await adapters.pickDocument(["public.json"]) as? [[String: Any]], let text = items.first?["text"] as? String, let data = text.data(using: .utf8) else { return }
                let choice = try await adapters.alert(["title": "Восстановить копию?", "message": "Текущие данные будут сохранены в локальную копию перед восстановлением. Выбранная копия заменит профиль, заметки, списки и кэш.", "actions": [["title": "Восстановить"]], "cancel": "Отмена"]) as? [String: Any]
                guard choice?["index"] as? Int == 0 else { return }
                try store?.importBackup(data); loadRuntime(); WidgetCenter.shared.reloadAllTimelines()
            } catch { showError(error) }
        }
    }
    private func exportWidgetSetup() {
        Task { @MainActor in
            do {
                try await flush(); guard let data = try store?.widgetSetupExport(), data.count <= 12 * 1024 * 1024, let text = String(data: data, encoding: .utf8) else { throw StoreError.invalid("Настройка ещё не создана или превышает 12 МБ. Откройте основной экран; для меньшей копии отключите фон с изображением.") }
                UIPasteboard.general.string = text
                _ = try await adapters.alert(["title": "Настройка скопирована", "message": "Удерживайте виджет → Изменить виджет → Экспорт настройки без App Group. Вставьте JSON. Последующие правки в приложении потребуют нового экспорта; профиль виджета хранится отдельно.", "actions": [["title": "Понятно"]]])
            } catch { showError(error) }
        }
    }
    private func checkUpdate() {
        guard updateTask == nil else { return }
        updateTask = Task { @MainActor in
            defer { updateTask = nil }
            do {
                availableRelease = try await UpdateService.latest(); updateError = nil
                if let release = availableRelease, UpdateService.isNew(release), UserDefaults.standard.string(forKey: "lastAnnouncedVersion") != release.version + "." + (release.buildVersion ?? "0") {
                    UserDefaults.standard.set(release.version + "." + (release.buildVersion ?? "0"), forKey: "lastAnnouncedVersion")
                    if presentedViewController == nil { showUpdate() }
                }
            } catch { updateError = "Источник сейчас недоступен. Проверка повторится при следующем открытии." }
        }
    }
    private func showUpdate() {
        let release = availableRelease
        let available = release.map { "\($0.version) (\($0.buildVersion ?? "0"))" } ?? "не определена"
        let message = "Установлена: \(UpdateService.currentVersion) (\(UpdateService.currentBuild))\nДоступна: \(available)\n\n\(release?.localizedDescription ?? updateError ?? "Первый выпуск ещё не опубликован.")\n\nВ AltStore нажмите «Обновить». Refresh продлевает подпись и не устанавливает новую версию."
        let alert = UIAlertController(title: "Версия UniDay", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Открыть в AltStore Classic", style: .default) { _ in UIApplication.shared.open(UpdateService.altStoreURL) { success in if !success { UIApplication.shared.open(UpdateService.sourceURL.deletingLastPathComponent()) } } })
        alert.addAction(UIAlertAction(title: "Проверить снова", style: .default) { [weak self] _ in self?.checkUpdate() })
        alert.addAction(UIAlertAction(title: "Закрыть", style: .cancel))
        if presentedViewController == nil { present(alert, animated: true) }
    }
    private func showDiagnostics() {
        do { let text = try json(store?.diagnostics() ?? [:]); let alert = UIAlertController(title: "Подпись и общий контейнер", message: text, preferredStyle: .alert); alert.addAction(UIAlertAction(title: "Экспорт отчёта", style: .default) { [weak self] _ in self?.share(text) }); alert.addAction(UIAlertAction(title: "Закрыть", style: .cancel)); present(alert, animated: true) } catch { showError(error) }
    }
    private func makeSmokeScreen() {
        web.isHidden = true
        let label = UILabel(); label.numberOfLines = 0; label.text = "Тест бесплатной подписи\n\n1. Нажмите «Изменить тестовое значение».\n2. Добавьте виджет UniDay.\n3. Сравните число и группу.\n4. Нажмите виджет: откроется приложение.\n\nПовторите на втором Apple Account."; label.translatesAutoresizingMaskIntoConstraints = false
        let button = UIButton(type: .system); button.setTitle("Изменить тестовое значение", for: .normal); button.translatesAutoresizingMaskIntoConstraints = false; button.addAction(UIAction { [weak self] _ in self?.publishSmoke() }, for: .touchUpInside)
        view.addSubview(label); view.addSubview(button); smokeLabel = label
        NSLayoutConstraint.activate([label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 64), label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20), label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20), button.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 24), button.centerXAnchor.constraint(equalTo: view.centerXAnchor)])
    }
    private func publishSmoke() {
        do { let value = Int(Date().timeIntervalSince1970); try store?.publishWidget(["smoke": ["value": value, "appBundleID": Bundle.main.bundleIdentifier ?? "", "diagnostics": store?.diagnostics() ?? [:]], "plans": [:], "profile": [:]]); WidgetCenter.shared.reloadAllTimelines(); smokeLabel?.text = "Значение: \(value)\n\n\(try json(store?.diagnostics() ?? [:]))\n\nВиджет должен показать то же значение. iOS может отложить обновление." } catch { showError(error) }
    }
    private func showError(_ error: Error) {
        guard isViewLoaded, presentedViewController == nil else { return }
        let alert = UIAlertController(title: "UniDay", message: error.localizedDescription, preferredStyle: .alert); alert.addAction(UIAlertAction(title: "Закрыть", style: .default)); present(alert, animated: true)
    }
}

extension Notification.Name { static let unidayOpenURL = Notification.Name("UniDayOpenURL") }
