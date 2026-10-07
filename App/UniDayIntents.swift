import AppIntents
import Foundation

struct OpenUniDayOverviewIntent: AppIntent {
    static var title: LocalizedStringResource = "Открыть UniDay"
    static var description = IntentDescription("Открывает самостоятельный UniDay и обновляет расписание.")
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult { .result() }
}

struct ExportUniDayHTMLIntent: AppIntent {
    static var title: LocalizedStringResource = "HTML последнего экрана UniDay"
    static var description = IntentDescription("Возвращает сохранённый полный экран UniDay как HTML. Сначала откройте UniDay для свежих данных; затем задайте имя UniDay.html и покажите веб-страницу в Командах.")
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let store = try SharedStore()
        guard let html = try store.latestHTML(), !html.isEmpty else { throw StoreError.invalid("Сначала откройте UniDay и дождитесь загрузки расписания.") }
        return .result(value: html)
    }
}

struct UniDayShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenUniDayOverviewIntent(), phrases: ["Открой \(.applicationName)"], shortTitle: "Открыть UniDay", systemImageName: "calendar")
    }
}
