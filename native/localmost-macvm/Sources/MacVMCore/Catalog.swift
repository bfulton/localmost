// What `catalog` passes on from VZ: the latest restore image this Mac
// supports, and the one place Electron may download it from.

import Foundation

/// The one host restore images are downloaded from. VZ's catalog has named
/// only this one since macOS 12; anything else is refused rather than
/// fetched, so that a catalog answer can never send Electron elsewhere.
public let restoreImageHost = "updates.cdn-apple.com"

/// Whether `url` is an https URL on the restore image host, with no port,
/// user, query or fragment, whose path ends in `.ipsw`.
public func isAllowedRestoreImageURL(_ url: URL) -> Bool {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return parts.scheme == "https" && parts.host == restoreImageHost && parts.port == nil
        && parts.user == nil && parts.password == nil && parts.query == nil && parts.fragment == nil
        && parts.path.hasSuffix(".ipsw") && !parts.path.contains("/../") && parts.path.hasPrefix("/")
}

/// `major.minor.patch`, as Electron compares versions.
public func versionString(major: Int, minor: Int, patch: Int) -> String {
    "\(major).\(minor).\(patch)"
}
