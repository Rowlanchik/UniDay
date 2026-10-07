import SwiftUI

@main
struct UniDayApp: App {
    var body: some Scene {
        WindowGroup { UniDayHost().ignoresSafeArea(.container, edges: .bottom).onOpenURL { url in NotificationCenter.default.post(name: .unidayOpenURL, object: url) } }
    }
}

struct UniDayHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UniDayViewController { UniDayViewController() }
    func updateUIViewController(_ controller: UniDayViewController, context: Context) {}
}
