import Foundation
import EventKit

func statusName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "unknown(\(status.rawValue))"
    }
}

func allowsRead(_ status: EKAuthorizationStatus) -> Bool {
    switch status {
    case .authorized, .fullAccess:
        return true
    default:
        return false
    }
}

func writeStatus(_ path: String?, _ payload: [String: Any]) {
    guard let path, !path.isEmpty else { return }
    do {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .withoutEscapingSlashes])
        try data.write(to: url)
    } catch {
        fputs("failed to write status JSON: \(error)\n", stderr)
    }
}

func requestAccess(statusPath: String?) -> Never {
    let before = EKEventStore.authorizationStatus(for: .event)
    let store = EKEventStore()
    let sema = DispatchSemaphore(value: 0)
    var granted = false
    var errorText = ""

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, err in
            granted = ok
            if let err { errorText = String(describing: err) }
            sema.signal()
        }
    } else {
        store.requestAccess(to: .event) { ok, err in
            granted = ok
            if let err { errorText = String(describing: err) }
            sema.signal()
        }
    }

    let wait = sema.wait(timeout: .now() + 300)
    let after = EKEventStore.authorizationStatus(for: .event)
    let timedOut = wait == .timedOut
    let payload: [String: Any] = [
        "mode": "request_access",
        "before": statusName(before),
        "before_raw": before.rawValue,
        "after": statusName(after),
        "after_raw": after.rawValue,
        "granted": granted,
        "timed_out": timedOut,
        "error": errorText,
        "checked_at": ISO8601DateFormatter().string(from: Date())
    ]
    writeStatus(statusPath, payload)
    if timedOut { exit(124) }
    exit(granted && allowsRead(after) ? 0 : 1)
}

func exportCalendar(daysAhead: Int, daysBack: Int, outputPath: String) -> Never {
    let authorizationStatus = EKEventStore.authorizationStatus(for: .event)
    guard allowsRead(authorizationStatus) else {
        fputs("EventKit calendar read not authorized: status=\(statusName(authorizationStatus)) raw=\(authorizationStatus.rawValue); not prompting during export\n", stderr)
        exit(77)
    }

    let outputURL = URL(fileURLWithPath: outputPath)
    let skippedCalendarNames = Set(["Scheduled Reminders", "Birthdays", "Siri Suggestions"])
    let freshnessWindowMinutes = 90
    let eventStore = EKEventStore()
    eventStore.refreshSourcesIfNecessary()
    let localCalendar = Calendar.current
    let now = Date()
    guard let windowStart = localCalendar.date(byAdding: .day, value: -daysBack, to: now),
          let windowEnd = localCalendar.date(byAdding: .day, value: daysAhead, to: now) else {
        fputs("failed to calculate EventKit query window\n", stderr)
        exit(1)
    }

    let displayFormatter = DateFormatter()
    displayFormatter.locale = Locale(identifier: "en_US_POSIX")
    displayFormatter.timeZone = TimeZone.current
    displayFormatter.dateFormat = "EEEE, d MMMM yyyy 'at' HH:mm:ss"

    let isoFormatter = DateFormatter()
    isoFormatter.locale = Locale(identifier: "en_US_POSIX")
    isoFormatter.timeZone = TimeZone.current
    isoFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"

    let calendars = eventStore.calendars(for: .event)
        .filter { calendar in !skippedCalendarNames.contains(calendar.title) }
        .sorted { lhs, rhs in lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending }

    if calendars.isEmpty {
        fputs("EventKit returned no readable calendars after skip filters; preserving last-known-good outputs\n", stderr)
        exit(1)
    }

    let predicate = eventStore.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: calendars)
    let rawEvents = eventStore.events(matching: predicate)

    func adjustedEndDate(for event: EKEvent) -> Date {
        if event.isAllDay, event.endDate > event.startDate,
           let adjusted = localCalendar.date(byAdding: .second, value: -1, to: event.endDate) {
            return adjusted
        }
        return event.endDate
    }

    var events: [[String: Any]] = []
    var seenKeys = Set<String>()
    for event in rawEvents {
        guard let startDate = event.startDate else { continue }
        if startDate < windowStart || startDate > windowEnd { continue }
        if skippedCalendarNames.contains(event.calendar.title) { continue }
        let endDate = adjustedEndDate(for: event)
        let summary = event.title ?? ""
        let startText = displayFormatter.string(from: startDate)
        let endText = displayFormatter.string(from: endDate)
        let dedupeKey = "\(summary)\u{1f}\(startText)"
        if seenKeys.contains(dedupeKey) { continue }
        seenKeys.insert(dedupeKey)
        events.append([
            "calendar": event.calendar.title,
            "summary": summary,
            "start": startText,
            "end": endText,
            "all_day": event.isAllDay,
            "location": event.location ?? "",
            "notes": "",
            "uid": event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? "",
            "recurring": !(event.recurrenceRules?.isEmpty ?? true),
            "start_iso": isoFormatter.string(from: startDate),
            "end_iso": isoFormatter.string(from: endDate),
        ])
    }

    events.sort { lhs, rhs in
        let lhsStart = (lhs["start_iso"] as? String) ?? ""
        let rhsStart = (rhs["start_iso"] as? String) ?? ""
        if lhsStart != rhsStart { return lhsStart < rhsStart }
        return ((lhs["summary"] as? String) ?? "") < ((rhs["summary"] as? String) ?? "")
    }

    let output: [String: Any] = [
        "synced_at": isoFormatter.string(from: now),
        "days_back": daysBack,
        "days_ahead": daysAhead,
        "source": "macos-calendar",
        "source_method": "eventkit-app",
        "freshness_window_minutes": freshnessWindowMinutes,
        "calendar_count": calendars.count,
        "event_count": events.count,
        "events": events,
    ]

    do {
        let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .withoutEscapingSlashes])
        guard var jsonText = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "calendar-eventkit-exporter-app", code: 1, userInfo: [NSLocalizedDescriptionKey: "failed to encode JSON as UTF-8"])
        }
        jsonText.append("\n")
        let outputDir = outputURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        let tmpURL = outputDir.appendingPathComponent(".\(outputURL.lastPathComponent).tmp.\(ProcessInfo.processInfo.processIdentifier)")
        try jsonText.write(to: tmpURL, atomically: true, encoding: .utf8)
        if FileManager.default.fileExists(atPath: outputURL.path) {
            _ = try FileManager.default.replaceItemAt(outputURL, withItemAt: tmpURL, backupItemName: nil, options: .usingNewMetadataOnly)
        } else {
            try FileManager.default.moveItem(at: tmpURL, to: outputURL)
        }
        exit(0)
    } catch {
        fputs("EventKit export write failed: \(error)\n", stderr)
        exit(1)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--request-access" {
    requestAccess(statusPath: args.count > 1 ? args[1] : nil)
}

guard (args.count == 2 || args.count == 3), let daysAhead = Int(args[0]), daysAhead >= 0 else {
    fputs("usage: CalendarEventKitExporter <days_ahead> <output_json> [days_back] OR --request-access [status_json]\n", stderr)
    exit(2)
}
let daysBack: Int
if args.count == 3 {
    guard let parsedDaysBack = Int(args[2]), parsedDaysBack >= 0 else {
        fputs("invalid days_back: \(args[2])\n", stderr)
        exit(2)
    }
    daysBack = parsedDaysBack
} else {
    daysBack = 1
}
exportCalendar(daysAhead: daysAhead, daysBack: daysBack, outputPath: args[1])
