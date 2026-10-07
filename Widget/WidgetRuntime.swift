import Foundation
import JavaScriptCore

/// Runs the same legacy calendar, transit, weather and layout code in JSCore,
/// without loading a web view or executing downloads as code.
final class WidgetRuntime {
    private let queue = DispatchQueue(label: "UniDay.widget.javascript", qos: .utility)
    private var context: JSContext?
    private var continuation: CheckedContinuation<[String: Any], Error>?
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var nextTimer = 0
    private var tasks: [URLSessionDataTask] = []
    private var locationTask: Task<Void, Never>?
    private var seed: [String: Any] = [:]
    private var finished = false

    func refresh(_ snapshot: [String: Any]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.continuation = continuation
                self.seed = snapshot
                self.start()
            }
        }
    }

    private func start() {
        guard let context = JSContext() else { fail("JavaScriptCore недоступен."); return }
        self.context = context
        context.exceptionHandler = { [weak self] _, exception in self?.fail(exception?.toString() ?? "Ошибка JavaScript.") }
        let native: @convention(block) (String) -> Void = { [weak self] json in self?.receive(json) }
        context.setObject(native, forKeyedSubscript: "__native" as NSString)
        let timeout: @convention(block) (JSValue, Double) -> Int = { [weak self] callback, ms in
            self?.addTimer(callback, milliseconds: ms, repeats: false) ?? 0
        }
        let interval: @convention(block) (JSValue, Double) -> Int = { [weak self] callback, ms in
            self?.addTimer(callback, milliseconds: ms, repeats: true) ?? 0
        }
        let clear: @convention(block) (Int) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id)?.cancel() }
        context.setObject(timeout, forKeyedSubscript: "__setTimeout" as NSString)
        context.setObject(interval, forKeyedSubscript: "__setInterval" as NSString)
        context.setObject(clear, forKeyedSubscript: "__clearTimeout" as NSString)
        context.setObject(clear, forKeyedSubscript: "__clearInterval" as NSString)
        context.evaluateScript("var window=globalThis; var setTimeout=__setTimeout,clearTimeout=__clearTimeout,setInterval=__setInterval,clearInterval=__clearInterval; var console={log:function(){},warn:function(){},error:function(){}};")
        for name in ["runtime", "legacy", "widget-runtime"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
                  let source = try? String(contentsOf: url, encoding: .utf8) else {
                fail("Ресурс виджета \(name).js отсутствует."); return
            }
            context.evaluateScript(source, withSourceURL: url)
            if finished { return }
        }
        context.objectForKeyedSubscript("UniDayWidget")?.objectForKeyedSubscript("refresh")?.call(withArguments: [seed])
        // WidgetKit's scheduling is best effort. Time-bounded fetching falls back
        // to the last complete snapshot rather than producing a partial dashboard.
        queue.asyncAfter(deadline: .now() + 24) { [weak self] in self?.fail("Обновление заняло слишком долго. Показана сохранённая копия.") }
    }

    private func receive(_ json: String) {
        guard !finished, let bytes = json.data(using: .utf8),
              let message = try? SharedStore.object(bytes),
              let method = message["method"] as? String else { return }
        let id = message["id"] ?? NSNull()
        let payload = message["payload"] as? [String: Any] ?? [:]
        switch method {
        case "widget.result":
            var result = SharedStore.normalizedWidgetPayload(payload)
            result["appRevision"] = seed["appRevision"] ?? 0
            result["schemaVersion"] = 1
            result["generatedAt"] = result["generatedAt"] ?? SharedStore.timestamp()
            finish(.success(result))
        case "widget.error": fail(payload["message"] as? String ?? "Не удалось обновить виджет.")
        case "request": request(payload, id: id)
        case "storage.apply", "widget.publish": resolve(id, result: [:])
        case "location.current":
            locationTask = Task { @MainActor [weak self] in
                guard let self = self else { return }
                do {
                    let fix = try await WidgetLocationProvider().current()
                    self.queue.async { self.resolve(id, result: fix) }
                } catch { self.queue.async { self.resolve(id, error: error.localizedDescription) } }
            }
        case "calendar.between":
            let state = seed["state"] as? [String: Any] ?? [:]
            let events = state["calendarEvents"] as? [[String: Any]] ?? []
            let from = UniDayDate.parse(payload["from"] as? String) ?? .distantPast
            let to = UniDayDate.parse(payload["to"] as? String) ?? .distantFuture
            resolve(id, result: events.filter {
                (UniDayDate.parse($0["startDate"] as? String ?? $0["start"] as? String) ?? .distantPast) < to &&
                    (UniDayDate.parse($0["endDate"] as? String ?? $0["end"] as? String) ?? .distantFuture) > from
            })
        default: resolve(id, error: "Действие \(method) доступно в приложении UniDay.")
        }
    }

    private func request(_ payload: [String: Any], id: Any) {
        guard let text = payload["url"] as? String, let url = URL(string: text),
              url.scheme?.lowercased() == "https", url.host != nil,
              url.user == nil, url.password == nil else {
            resolve(id, error: "Неверный адрес запроса."); return
        }
        let timeout = min(20, max(1, (payload["timeoutSeconds"] as? NSNumber)?.doubleValue ?? 10))
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: timeout)
        request.httpMethod = payload["method"] as? String ?? "GET"
        for (key, value) in payload["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: key) }
        if let body = payload["body"] as? String { request.httpBody = body.data(using: .utf8) }
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            self.queue.async {
                if let error = error { self.resolve(id, error: error.localizedDescription); return }
                guard let data = data, data.count <= 8 * 1024 * 1024 else {
                    self.resolve(id, error: "Ответ сервера слишком большой или пустой."); return
                }
                let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                self.resolve(id, result: ["text": text, "status": status])
            }
        }
        tasks.append(task)
        task.resume()
    }

    private func resolve(_ id: Any, result: Any = NSNull(), error: String? = nil) {
        guard !finished else { return }
        context?.objectForKeyedSubscript("UniDayNative")?.objectForKeyedSubscript("resolve")?
            .call(withArguments: [id, result, (error as Any?) ?? NSNull()])
    }

    private func addTimer(_ callback: JSValue, milliseconds: Double, repeats: Bool) -> Int {
        nextTimer += 1
        let id = nextTimer
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let seconds = max(0.001, min(60, milliseconds.isFinite ? milliseconds / 1000 : 0.001))
        if repeats { timer.schedule(deadline: .now() + seconds, repeating: seconds) }
        else { timer.schedule(deadline: .now() + seconds) }
        timer.setEventHandler { [weak self] in
            guard let self = self, !self.finished else { return }
            if !repeats { self.timers.removeValue(forKey: id)?.cancel() }
            callback.call(withArguments: [])
        }
        timers[id] = timer
        timer.resume()
        return id
    }

    private func fail(_ message: String) { finish(.failure(StoreError.invalid(message))) }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard !finished else { return }
        finished = true
        timers.values.forEach { $0.cancel() }
        timers.removeAll()
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        locationTask?.cancel(); locationTask = nil
        let completion = continuation
        continuation = nil
        // Context cleanup after returning from a JS callback avoids destroying the
        // currently executing virtual machine while its native stack is active.
        queue.async { self.context = nil }
        completion?.resume(with: result)
    }
}
