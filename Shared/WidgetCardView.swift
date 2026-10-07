import SwiftUI
import UIKit

/// One renderer for WidgetKit and the in-app visual preview. Layout decisions,
/// omissions, fonts, colors and native timer dates come from legacy widgetPlan.
struct WidgetCardView: View {
    let plan: WidgetPlan

    static func decode(_ json: [String: Any]) throws -> WidgetPlan {
        try JSONDecoder().decode(WidgetPlan.self, from: JSONSerialization.data(withJSONObject: json))
    }

    var body: some View {
        GeometryReader { geometry in
            let padding = CGFloat(plan.padding ?? 10)
            let availableWidth = max(1, geometry.size.width - 2 * padding)
            VStack(alignment: .leading, spacing: 0) {
                if plan.appearance?.widgetAlignment != "top" { Spacer(minLength: 0) }
                if plan.columns == true {
                    let gap = CGFloat(plan.appearance?.mediumColumnGap ?? 10)
                    let split = CGFloat(plan.appearance?.mediumColumnSplit ?? 55) / 100
                    HStack(alignment: .top, spacing: gap) {
                        lane(0, width: (availableWidth - gap) * split)
                        lane(1, width: (availableWidth - gap) * (1 - split))
                    }
                } else { lane(0, width: availableWidth) }
                if plan.appearance?.widgetAlignment != "bottom" { Spacer(minLength: 0) }
                if (plan.omitted ?? 0) > 0 && plan.dashboard != true {
                    Text("Ещё в UniDay ›").font(.system(size: 8)).foregroundStyle(muted).padding(.top, 2).lineLimit(1)
                }
                if plan.groups.isEmpty {
                    Text("UniDay · блоки скрыты").font(.system(size: 12)).foregroundStyle(muted)
                }
            }
            .padding(padding)
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .background(WidgetCardBackground(plan: plan))
        .environment(\.locale, Locale(identifier: "ru_RU"))
        .clipped()
    }

    private var ink: Color { Color(unidayHex: plan.appearance?.widgetText ?? "#243c32") }
    private var muted: Color { Color(unidayHex: plan.appearance?.widgetMuted ?? "#6b796e") }
    private var accent: Color { Color(unidayHex: plan.appearance?.widgetAccent ?? "#276848") }

    private func lane(_ index: Int, width: CGFloat) -> some View {
        let selected = plan.groups.filter { (plan.columns == true ? ($0.lane ?? 0) : 0) == index }
        let sections = selected.reduce(into: [String]()) { result, group in
            if !result.contains(group.section) { result.append(group.section) }
        }
        return VStack(alignment: .leading, spacing: CGFloat(plan.gap ?? 3)) {
            ForEach(sections, id: \.self) { section in
                let parts = selected.filter { $0.section == section }
                if !parts.isEmpty {
                    block(parts, width: width)
                }
            }
        }
        .frame(width: max(1, width), alignment: .topLeading)
    }

    private func block(_ groups: [WidgetPlanGroup], width: CGFloat) -> some View {
        let first = groups[0]
        let style = first.style
        let blockWidth = max(1, width * CGFloat(style?.width ?? 100) / 100)
        let rows = groups.flatMap { group in group.rows.map { (cells: $0, url: group.url) } }
        let background: Color = {
            if let hex = style?.background, !hex.isEmpty { return Color(unidayHex: hex) }
            if (plan.dashboard == true || plan.family == "small" || plan.family == "large") &&
                ["classes", "buses"].contains(first.section) {
                return accent.opacity(first.section == "classes" ? 0.08 : 0.12)
            }
            return .clear
        }()
        return VStack(alignment: .leading, spacing: CGFloat(style?.gap ?? 0)) {
            ForEach(rows.indices, id: \.self) { rowIndex in
                if let url = rows[rowIndex].url.flatMap(URL.init(string:)) {
                    Link(destination: url) { row(rows[rowIndex].cells, style: style, width: blockWidth) }.buttonStyle(.plain)
                } else { row(rows[rowIndex].cells, style: style, width: blockWidth) }
            }
            if (style?.gap ?? 0) > 0 { Spacer().frame(height: CGFloat(style?.gap ?? 0)) }
        }
        .padding(CGFloat(style?.padding ?? 0))
        .frame(width: blockWidth, height: first.sectionHeight.map { CGFloat(max(1, $0)) }, alignment: .topLeading)
        .background(background, in: RoundedRectangle(cornerRadius: CGFloat(style?.radius ?? 0)))
        .frame(width: width, alignment: .leading)
    }

    private func row(_ cells: [WidgetPlanCell], style: WidgetBlockStyle?, width: CGFloat) -> some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(cells.indices, id: \.self) { index in
                if index > 0 { Spacer(minLength: 4) }
                cell(cells[index], style: style, width: width)
            }
        }
    }

    private func cell(_ value: WidgetPlanCell, style: WidgetBlockStyle?, width: CGFloat) -> some View {
        HStack(spacing: 6) {
            if let progress = value.progress {
                ProgressView(value: max(0, min(1, progress)))
                    .tint(accent)
                    .frame(width: max(8, min(110, (width - CGFloat(style?.padding ?? 0) * 2) * 0.28)), height: 5)
            }
            text(value)
                .font(font(value))
                .foregroundStyle(color(value, style: style))
                .lineLimit(value.progress != nil ? 1 : max(1, value.lines ?? 1))
                .minimumScaleFactor(0.85)
        }
    }

    private func text(_ value: WidgetPlanCell) -> Text {
        if let date = UniDayDate.parse(value.date) {
            return Text(date, style: value.timer == true ? .timer : .offset).monospacedDigit()
        }
        return Text(value.text ?? "")
    }

    private func color(_ value: WidgetPlanCell, style: WidgetBlockStyle?) -> Color {
        if let hex = style?.color, !hex.isEmpty { return Color(unidayHex: hex) }
        switch value.color {
        case "muted": return muted
        case "accent": return accent
        case "weather": return Color(unidayHex: plan.appearance?.weatherTextColor.flatMap { $0.isEmpty ? nil : $0 } ?? plan.appearance?.widgetAccent ?? "#276848")
        default: return ink
        }
    }

    private func font(_ value: WidgetPlanCell) -> Font {
        let size = CGFloat(max(1, value.font?.size ?? value.points ?? value.size ?? 11))
        let name = value.font?.name ?? "system"
        let weight: Font.Weight = {
            switch value.font?.weight {
            case "bold": return .bold
            case "semibold": return .semibold
            case "medium": return .medium
            case "heavy": return .heavy
            default: return value.bold == true ? .bold : .regular
            }
        }()
        if !name.hasPrefix("system") { return .custom(name, fixedSize: size).weight(weight) }
        let design: Font.Design = value.font?.design == "rounded" ? .rounded :
            value.font?.design == "monospaced" ? .monospaced : .default
        return .system(size: size, weight: weight, design: design)
    }
}

struct WidgetCardBackground: View {
    let plan: WidgetPlan
    var body: some View {
        GeometryReader { geometry in
            if let dataURL = plan.background?.image?.dataURL,
               let separator = dataURL.range(of: ";base64,"),
               let data = Data(base64Encoded: String(dataURL[separator.upperBound...])),
               let image = UIImage(data: data), plan.background?.mode == "wallpaper" {
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            } else if plan.background?.mode == "clear" { Color.clear }
            else { Color(unidayHex: plan.background?.color ?? plan.appearance?.widgetBackground ?? "#f3f3ed") }
        }
    }
}

extension Color {
    init(unidayHex hex: String) {
        let clean = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let value = UInt64(clean, radix: 16) ?? 0x243c32
        self.init(.sRGB, red: Double((value >> 16) & 255) / 255,
                  green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, opacity: 1)
    }
}
