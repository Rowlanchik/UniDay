import UIKit

@MainActor
final class UniDayPreviewController: UINavigationController, UIAdaptivePresentationControllerDelegate {
    private var completion: (() -> Void)?
    private let shareItem: Any?
    init(root: UIViewController, title: String, shareItem: Any?, completion: @escaping () -> Void) {
        self.completion = completion; self.shareItem = shareItem
        super.init(rootViewController: root); root.title = title
        root.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Готово", style: .done, target: self, action: #selector(closePreview))
        if shareItem != nil { root.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(sharePreview)) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); presentationController?.delegate = self }
    @objc private func closePreview() { dismiss(animated: true) { [weak self] in self?.finish() } }
    @objc private func sharePreview() {
        guard let shareItem else { return }
        let activity = UIActivityViewController(activityItems: [shareItem], applicationActivities: nil)
        activity.popoverPresentationController?.barButtonItem = topViewController?.navigationItem.leftBarButtonItem
        present(activity, animated: true)
    }
    private func finish() { let done = completion; completion = nil; done?() }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }
}
