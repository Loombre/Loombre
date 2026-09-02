// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LoombreIPCKitTests/FolderGrantTests.swift
//
// The loombre://grant policy, pinned as data. Every refusal here is a
// grant the app must NEVER make no matter what URL a web page opens, and
// every plan's argv is byte-checked against the documented chmod recipe.

import XCTest
@testable import LoombreIPCKit

final class FolderGrantTests: XCTestCase {
    private let home = "/Users/ozzy"

    private func plan(_ urlString: String, home: String? = nil) -> Result<FolderGrantPlan, FolderGrantRefusal> {
        FolderGrant.plan(url: URL(string: urlString)!, consoleHome: home ?? self.home)
    }

    private func success(_ result: Result<FolderGrantPlan, FolderGrantRefusal>, file: StaticString = #filePath, line: UInt = #line) -> FolderGrantPlan? {
        switch result {
        case .success(let plan): return plan
        case .failure(let refusal):
            XCTFail("expected a plan, got refusal \(refusal)", file: file, line: line)
            return nil
        }
    }

    private func refusal(_ result: Result<FolderGrantPlan, FolderGrantRefusal>, file: StaticString = #filePath, line: UInt = #line) -> FolderGrantRefusal? {
        switch result {
        case .success(let plan):
            XCTFail("expected a refusal, got plan \(plan.operations)", file: file, line: line)
            return nil
        case .failure(let refusal): return refusal
        }
    }

    // MARK: step 1 — names-only on the home

    func testNamesOnlyOnTheConsoleHomeIsASingleListSearchACE() {
        guard let plan = success(plan("loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fozzy")) else { return }
        XCTAssertEqual(plan.scope, .namesOnly)
        XCTAssertEqual(plan.operations, [FolderGrantOperation(path: "/Users/ozzy", ace: "user:_loombre allow list,search", recursive: false)])
        XCTAssertEqual(plan.operations[0].chmodArguments, ["+a", "user:_loombre allow list,search", "/Users/ozzy"])
        XCTAssertFalse(plan.operations[0].recursive)
        XCTAssertTrue(plan.consentDetail.contains("names of the folders directly inside /Users/ozzy"))
        XCTAssertTrue(plan.consentDetail.contains("nothing inside them"))
        XCTAssertTrue(plan.consentDetail.contains("chmod -a \"user:_loombre allow list,search\" /Users/ozzy"))
    }

    func testNamesOnlyAcceptsTheHomeInAnyCasingAndWithATrailingSlash() {
        XCTAssertNotNil(success(plan("loombre://grant?v=1&scope=names-only&path=%2Fusers%2FOZZY%2F")))
    }

    func testNamesOnlyAnywhereButTheHomeIsRefused() {
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fbob")), .namesOnlyOutsideHome(home: home))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fozzy%2FMovies")), .namesOnlyOutsideHome(home: home))
    }

    // MARK: step 2 — read on a folder

    func testReadInsideTheHomeWithTraversalIsTwoOperationsTraversalFirst() {
        guard let plan = success(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMovies&traverse=%2FUsers%2Fozzy")) else { return }
        XCTAssertEqual(plan.operations, [
            FolderGrantOperation(path: "/Users/ozzy", ace: "user:_loombre allow search", recursive: false),
            FolderGrantOperation(path: "/Users/ozzy/Movies", ace: "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit", recursive: true),
        ])
        // The traverse grant on the home is a single directory (never -R);
        // the read grant is -R so existing files inside are reached too.
        XCTAssertEqual(plan.operations[0].chmodArguments, ["+a", "user:_loombre allow search", "/Users/ozzy"])
        XCTAssertEqual(plan.operations[1].chmodArguments, ["-R", "+a", "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit", "/Users/ozzy/Movies"])
        XCTAssertEqual(plan.consentTitle, "Let Loombre\u{2019}s service read \u{201C}Movies\u{201D}?")
        XCTAssertTrue(plan.consentDetail.contains("pass through /Users/ozzy"))
        XCTAssertTrue(plan.consentDetail.contains("everything already in it"))
        XCTAssertTrue(plan.consentDetail.contains("Nothing else in your home folder becomes visible."))
    }

    func testReadInsideTheHomeWithoutTraversalIsTheReadGrantAlone() {
        guard let plan = success(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMovies")) else { return }
        XCTAssertEqual(plan.operations.count, 1)
        XCTAssertEqual(plan.operations[0].path, "/Users/ozzy/Movies")
        XCTAssertTrue(plan.operations[0].recursive)
        XCTAssertFalse(plan.consentDetail.contains("pass through"))
    }

    func testReadOutsideTheHomeMentionsNothingAboutTheHome() {
        guard let plan = success(plan("loombre://grant?v=1&scope=read&path=%2FVolumes%2FMedia")) else { return }
        XCTAssertEqual(plan.operations.map(\.path), ["/Volumes/Media"])
        XCTAssertFalse(plan.consentDetail.contains("home folder"))
    }

    func testPathsRoundTripPercentEncodingSpacesAndAmpersands() {
        guard let plan = success(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMy%20Media%20%26%20More")) else { return }
        XCTAssertEqual(plan.operations[0].path, "/Users/ozzy/My Media & More")
        XCTAssertEqual(plan.operations[0].chmodArguments.last, "/Users/ozzy/My Media & More")
        XCTAssertEqual(plan.operations[0].chmodArguments.first, "-R")
        XCTAssertEqual(
            plan.operations[0].shellCommand,
            "chmod -R +a \"user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit\" '/Users/ozzy/My Media & More'"
        )
    }

    // MARK: refusals — the grants the app must never make

    func testWholeHomeReadIsRefusedInEveryCasingAndSlashForm() {
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy")), .wholeHomeRead(home: home))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2Fusers%2Fozzy%2F")), .wholeHomeRead(home: home))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMovies%2F..")), .wholeHomeRead(home: home))
    }

    func testTCCProtectedHomeSubfoldersAreRefusedCaseInsensitivelyAtAnyDepth() {
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FDocuments")), .tccProtected(folder: "Documents"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2Fdownloads%2Fmovies")), .tccProtected(folder: "downloads"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FDesktop%2Fx&traverse=%2FUsers%2Fozzy")), .tccProtected(folder: "Desktop"))
        // A folder merely NAMED Documents elsewhere is not TCC-protected.
        XCTAssertNotNil(success(plan("loombre://grant?v=1&scope=read&path=%2FVolumes%2FMedia%2FDocuments")))
    }

    func testTraversalMustNameTheConsoleHomeAndThePathMustBeInsideIt() {
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FUsers%2Fozzy%2FMovies&traverse=%2FUsers%2Fbob")), .traversalNotHome(home: home))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2FVolumes%2FMedia&traverse=%2FUsers%2Fozzy")), .traversalNotHome(home: home))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fozzy&traverse=%2FUsers%2Fozzy")), .malformed(reason: "traverse is not valid with scope=names-only"))
    }

    func testMalformedRequestsAreRefusedNotGuessedAt() {
        XCTAssertEqual(refusal(plan("loombre://grant?scope=read&path=%2FVolumes%2FMedia")), .malformed(reason: "unsupported request version (none)"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=2&scope=read&path=%2FVolumes%2FMedia")), .malformed(reason: "unsupported request version 2"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read")), .malformed(reason: "missing path"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=write&path=%2FVolumes%2FMedia")), .malformed(reason: "missing or unknown scope"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=Movies")), .notAbsolute(path: "Movies"))
        XCTAssertEqual(refusal(plan("loombre://grant?v=1&scope=read&path=%2F")), .malformed(reason: "the filesystem root is not a media folder"))
        XCTAssertEqual(refusal(plan("loombre://open?v=1&scope=read&path=%2FVolumes%2FMedia")), .malformed(reason: "not a loombre://grant URL"))
        XCTAssertFalse(FolderGrant.isGrantURL(URL(string: "https://grant?v=1")!))
    }

    func testRepeatedQueryKeysUseTheFirstValueOnly() {
        // A second `path=` cannot smuggle a different target past the
        // consent dialog, which renders the first.
        guard let plan = success(plan("loombre://grant?v=1&scope=read&path=%2FVolumes%2FMedia&path=%2FUsers%2Fozzy")) else { return }
        XCTAssertEqual(plan.operations.map(\.path), ["/Volumes/Media"])
    }

    // MARK: helpers

    func testNormalizeCollapsesDotsAndSlashesWithoutTouchingTheFilesystem() {
        XCTAssertEqual(FolderGrant.normalize("/Users/ozzy/Movies/"), "/Users/ozzy/Movies")
        XCTAssertEqual(FolderGrant.normalize("/Users//ozzy/./Movies/../Music"), "/Users/ozzy/Music")
        XCTAssertEqual(FolderGrant.normalize("/../.."), "/")
    }

    func testShellQuoteMatchesTheServerRule() {
        XCTAssertEqual(FolderGrant.shellQuote("/Users/ozzy/Media"), "/Users/ozzy/Media")
        XCTAssertEqual(FolderGrant.shellQuote("/Users/ozzy/My Media"), "'/Users/ozzy/My Media'")
        XCTAssertEqual(FolderGrant.shellQuote("/Users/ozzy/O'Brien"), "'/Users/ozzy/O'\\''Brien'")
    }

    func testRefusalExplanationsAlwaysSayNothingWasChanged() {
        let refusals: [FolderGrantRefusal] = [
            .malformed(reason: "x"), .notAbsolute(path: "x"), .wholeHomeRead(home: home),
            .namesOnlyOutsideHome(home: home), .tccProtected(folder: "Documents"), .traversalNotHome(home: home),
        ]
        for refusal in refusals {
            XCTAssertTrue(FolderGrant.explain(refusal).detail.contains("Nothing was changed."), "\(refusal)")
        }
        XCTAssertTrue(FolderGrant.explain(.tccProtected(folder: "Documents")).detail.contains("Full Disk Access"))
        XCTAssertTrue(FolderGrant.explain(.wholeHomeRead(home: home)).detail.contains(".ssh"))
    }
}
