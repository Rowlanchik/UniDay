import Foundation

struct WidgetPlan: Decodable {
    var columns: Bool?
    var dashboard: Bool?
    var groups: [WidgetPlanGroup]
    var omitted: Int?
    var gap: Double?
    var padding: Double?
    var family: String?
    var dimensions: WidgetDimensions?
    var estimatedHeight: Double?
    var budget: Double?
    var appearance: WidgetAppearance?
    var url: String?
    var background: WidgetBackground?
}

struct WidgetPlanGroup: Decodable {
    var section: String
    var priority: Double?
    var rows: [[WidgetPlanCell]]
    var style: WidgetBlockStyle?
    var lane: Int?
    var sectionHeight: Double?
    var url: String?
}

struct WidgetPlanCell: Decodable {
    var text: String?
    var size: Double?
    var bold: Bool?
    var color: String?
    var kind: String?
    var role: String?
    var lines: Int?
    var date: String?
    var timer: Bool?
    var progress: Double?
    var points: Double?
    var font: WidgetPlanFont?
    var url: String?
}

struct WidgetPlanFont: Decodable {
    var name: String?
    var size: Double?
    var weight: String?
    var design: String?
}

struct WidgetBlockStyle: Decodable {
    var scale: Double?
    var width: Double?
    var height: Double?
    var padding: Double?
    var gap: Double?
    var lines: Int?
    var radius: Double?
    var background: String?
    var color: String?
}

struct WidgetDimensions: Decodable {
    var width: Double
    var height: Double
}

struct WidgetAppearance: Decodable {
    var widgetText: String?
    var widgetMuted: String?
    var widgetAccent: String?
    var widgetBackground: String?
    var weatherTextColor: String?
    var widgetAlignment: String?
    var mediumColumnGap: Double?
    var mediumColumnSplit: Double?
}

struct WidgetBackground: Decodable {
    var mode: String?
    var color: String?
    var image: WidgetImage?
    var imagePath: String?
}

struct WidgetImage: Decodable {
    var dataURL: String?
    var width: Double?
    var height: Double?
}

enum UniDayDate {
    static func parse(_ text: String?) -> Date? {
        guard let text = text else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}
