import SwiftUI
import WidgetKit
import AppIntents

struct UniDayWidgetConfiguration: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "UniDay"
    static var description = IntentDescription("Настройки виджета берутся из UniDay. При недоступной App Group можно вставить экспорт профиля.")

    @Parameter(title: "Экспорт настройки без App Group")
    var independentSetup: String?

    @Parameter(title: "Показать проверку подписи", default: false)
    var showDiagnostics: Bool

}

struct UniDayWidgetEntry: TimelineEntry {
    let date: Date
    let document: WidgetDocument?
    let diagnostics: [String: Any]
    let showDiagnostics: Bool
    let error: String?
}

struct UniDayTimelineProvider: AppIntentTimelineProvider {
    typealias Intent = UniDayWidgetConfiguration
    typealias Entry = UniDayWidgetEntry

    func placeholder(in context: Context) -> Entry {
        Entry(date: Date(), document: nil, diagnostics: [:], showDiagnostics: false,
              error: "Открой UniDay и настрой свой календарь и остановки.")
    }

    func snapshot(for configuration: Intent, in context: Context) async -> Entry {
        do {
            let repository = try WidgetRepository()
            let document = try repository.load(setup: configuration.independentSetup)
            return Entry(date: Date(), document: document, diagnostics: document?.diagnostics ?? repository.group.diagnostics,
                         showDiagnostics: configuration.showDiagnostics, error: nil)
        } catch {
            return Entry(date: Date(), document: nil, diagnostics: [:], showDiagnostics: configuration.showDiagnostics,
                         error: error.localizedDescription)
        }
    }

    func timeline(for configuration: Intent, in context: Context) async -> Timeline<Entry> {
        var entry = await snapshot(for: configuration, in: context)
        if let initial = entry.document, initial.object["smoke"] == nil {
            do {
                let repository = try WidgetRepository()
                let refreshed = SharedStore.compactWidgetSnapshot(try await WidgetRuntime().refresh(initial.object))
                try repository.save(refreshed, basedOn: initial.object)
                let document = try WidgetDocument(refreshed, diagnostics: initial.diagnostics)
                entry = Entry(date: Date(), document: document, diagnostics: initial.diagnostics,
                              showDiagnostics: configuration.showDiagnostics, error: nil)
            } catch {
                entry = Entry(date: Date(), document: initial, diagnostics: initial.diagnostics,
                              showDiagnostics: configuration.showDiagnostics, error: error.localizedDescription)
            }
        }
        let requested = entry.document?.refreshAfter ?? Date().addingTimeInterval(15 * 60)
        let refresh = max(Date().addingTimeInterval(60), requested)
        return Timeline(entries: [entry], policy: .after(refresh))
    }
}

struct UniDayWidgetView: View {
    let entry: UniDayWidgetEntry
    @Environment(\.widgetFamily) var family

    private var familyKey: String {
        switch family { case .systemSmall: return "small"; case .systemMedium: return "medium"; default: return "large" }
    }

    var body: some View {
        Group {
            if entry.showDiagnostics || entry.document?.object["smoke"] != nil {
                diagnosticsView
            } else if let plan = entry.document?.plans[familyKey] {
                WidgetCardView(plan: plan)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("UniDay").font(.headline)
                    Text(entry.error ?? "Открой UniDay и сохрани свой профиль. Если общая группа недоступна, вставь экспорт в настройку виджета.")
                        .font(.caption)
                    Text("Нажми, чтобы открыть").font(.caption2).foregroundStyle(.secondary)
                }.padding(12)
            }
        }
        .containerBackground(for: .widget) {
            if let plan = entry.document?.plans[familyKey], !entry.showDiagnostics {
                WidgetCardBackground(plan: plan)
            } else { Color(unidayHex: "#f3f3ed") }
        }
        .widgetURL(URL(string: entry.document?.plans[familyKey]?.url ?? "uniday://overview"))
    }

    private var diagnosticsView: some View {
        let smoke = entry.document?.object["smoke"] as? [String: Any] ?? [:]
        return VStack(alignment: .leading, spacing: 4) {
            Text("UniDay · проверка").font(.system(size: 12, weight: .bold))
            if let value = smoke["value"] as? NSNumber { Text("Значение: \(value.stringValue)").font(.system(size: 12, weight: .semibold)) }
            Text("App: \(smoke["appBundleID"] as? String ?? "—")")
            Text("Widget: \(Bundle.main.bundleIdentifier ?? "—")")
            Text("Team: \(entry.diagnostics["teamIdentifier"] as? String ?? "—")")
            Text("Group: \(entry.diagnostics["groupIdentifier"] as? String ?? "недоступна")")
            Text("Доступ: \(entry.diagnostics["groupAccessProbe"] as? String ?? "—")")
            if let error = entry.error { Text(error).foregroundStyle(.red) }
        }
        .font(.system(size: 7))
        .lineLimit(3)
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

@main
struct UniDayWidget: Widget {
    let kind = "UniDayWidget"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: UniDayWidgetConfiguration.self, provider: UniDayTimelineProvider()) { entry in
            UniDayWidgetView(entry: entry)
        }
        .configurationDisplayName("UniDay")
        .description("Расписание, погода и ближайшие автобусы с настройками UniDay.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}
