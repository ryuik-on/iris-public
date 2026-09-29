import AVFoundation
import EventKit
import Foundation
import Speech

/**
 * IRIS speech helper.
 *
 * Transcribes microphone audio on-device with SpeechAnalyzer and writes one
 * JSON object per line to stdout. Nothing leaves this process except text.
 *
 * Commands:
 *   probe            — what is available, without touching the microphone
 *   install          — download the on-device model for a locale
 *   listen           — stream transcripts until stdin closes or a signal
 *   voices           — which voices this Mac can speak with, and how good
 *   speak            — say something out loud, on-device
 *   play             — stream raw PCM from stdin to the speakers as it arrives
 *   calendar         — upcoming events, via EventKit's predicate search
 *
 * Every command reports failure as a JSON `error` event and a non-zero exit
 * rather than a crash, because the caller is a supervisor that needs to tell
 * "not installed" apart from "died".
 */

// MARK: - Output

/// One JSON object per line. Locked, because results and progress arrive on
/// different tasks and a half-written line is unparseable at the other end.
private let outputLock = NSLock()
/// Reached from several tasks, but only ever under `outputLock`.
private nonisolated(unsafe) let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

/// Set when launched detached, where stdout is not connected to anything.
private nonisolated(unsafe) var outputPath: String?

func emit(_ event: String, _ fields: [String: Any] = [:]) {
  var payload = fields
  payload["event"] = event

  outputLock.lock()
  defer { outputLock.unlock() }
  payload["at"] = isoFormatter.string(from: Date())
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
  else {
    FileHandle.standardError.write(Data("failed to encode event \(event)\n".utf8))
    return
  }
  // Launched through LaunchServices there is no stdout to read, and that is
  // exactly the launch path needed to become our own TCC responsible process
  // rather than inheriting a decision already made for the parent.
  //
  // `--out` が与えられているときは stdout に出さない。**同じものを二箇所に
  // 置かない。**
  //
  // 出していた頃、launchd は stdout を `speech-agent.out.log` へ繋いでいて、
  // そこには回す仕組みが無かった。`speech-events.jsonl` は起動のたびに書き
  // 直されるので今日の分しか残らないのに、**ログの方は 2026-08-19 から
  // 積み上がっていた** —— 聞こえた言葉 95 件が、消したつもりの場所の隣に
  // 残っていた（実測 2026-09-29、276 KB）。
  if outputPath == nil {
    print(line)
    fflush(stdout)
  }

  if let path = outputPath, let data = (line + "\n").data(using: .utf8) {
    if let handle = FileHandle(forWritingAtPath: path) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: URL(fileURLWithPath: path))
    }
  }
}

func fail(_ code: String, _ message: String, hint: String? = nil) -> Never {
  var fields: [String: Any] = ["code": code, "message": message]
  if let hint { fields["hint"] = hint }
  emit("error", fields)
  exit(1)
}

// MARK: - Arguments

struct Options {
  var command = "probe"
  var locale = "ja-JP"
  /// Volatile results are the in-progress guess. Useful for a live caption,
  /// never for anything durable.
  var emitVolatile = true
  var text = ""
  var voice: String?
  /// AVSpeechUtterance's default is oddly brisk for a assistant; 0.48 reads
  /// closer to someone speaking rather than announcing.
  var rate: Float = 0.48
  var pitch: Float = 1.0
  var volume: Float = 1.0
  var sampleRate = 24_000
  var channels = 1
  var days = 14
  /// Launched by launchd rather than by a parent process.
  ///
  /// Changes who decides when to stop. A child process is told by stdin
  /// closing; a launchd job has no parent in that sense and is told by
  /// SIGTERM. Watching stdin in that case ends the session immediately,
  /// because launchd connects it to /dev/null and EOF arrives at once.
  var detached = false
  /// Where to write output when stdout goes nowhere — e.g. launched via `open`.
  var outPath: String?
}

func parseOptions() -> Options {
  var options = Options()
  var args = Array(CommandLine.arguments.dropFirst())
  if let first = args.first, !first.hasPrefix("--") {
    options.command = first
    args.removeFirst()
  }
  var index = 0
  while index < args.count {
    switch args[index] {
    case "--locale":
      index += 1
      if index < args.count { options.locale = args[index] }
    case "--no-volatile":
      options.emitVolatile = false
    case "--text":
      index += 1
      if index < args.count { options.text = args[index] }
    case "--voice":
      index += 1
      if index < args.count { options.voice = args[index] }
    case "--rate":
      index += 1
      if index < args.count, let value = Float(args[index]) { options.rate = value }
    case "--pitch":
      index += 1
      if index < args.count, let value = Float(args[index]) { options.pitch = value }
    case "--volume":
      index += 1
      if index < args.count, let value = Float(args[index]) { options.volume = value }
    case "--rate-hz":
      index += 1
      if index < args.count, let value = Int(args[index]) { options.sampleRate = value }
    case "--channels":
      index += 1
      if index < args.count, let value = Int(args[index]) { options.channels = value }
    case "--days":
      index += 1
      if index < args.count, let value = Int(args[index]) { options.days = value }
    case "--out":
      index += 1
      if index < args.count { options.outPath = args[index] }
    case "--detached":
      options.detached = true
    default:
      break
    }
    index += 1
  }
  return options
}

// MARK: - Availability

func describe(_ status: AssetInventory.Status) -> String {
  switch status {
  case .unsupported: return "unsupported"
  case .supported: return "supported"
  case .downloading: return "downloading"
  case .installed: return "installed"
  @unknown default: return "unknown"
  }
}

func makeTranscriber(_ localeID: String) -> SpeechTranscriber {
  // progressiveTranscription reports volatile results as well as final ones,
  // which is what makes live feedback possible. Only final results are ever
  // treated as text the user said.
  SpeechTranscriber(locale: Locale(identifier: localeID), preset: .progressiveTranscription)
}

func resolveLocale(_ requested: String) async -> Locale? {
  await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested))
}

func probe(_ options: Options) async {
  let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
  let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
  let resolved = await resolveLocale(options.locale)
  let status = await AssetInventory.status(forModules: [makeTranscriber(options.locale)])

  emit("probe", [
    "transcriberAvailable": SpeechTranscriber.isAvailable,
    "requestedLocale": options.locale,
    // A locale the framework recognises may differ from the one asked for;
    // reporting the resolved one stops a silent fallback looking like a match.
    "resolvedLocale": resolved?.identifier(.bcp47) ?? NSNull(),
    "assetStatus": describe(status),
    "supportedLocales": supported,
    "installedLocales": installed,
    "microphoneAuthorization": describeMicrophoneAuthorization(),
    // Which identity TCC is deciding about. A bare CLI has none, and the
    // permission then belongs to whoever launched it — which is the failure
    // this reports rather than leaves to be inferred from a denial.
    "bundleIdentifier": Bundle.main.bundleIdentifier ?? NSNull(),
    "bundled": Bundle.main.bundleIdentifier != nil,
  ])
}

func describeMicrophoneAuthorization() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

// MARK: - Model installation

func install(_ options: Options) async {
  guard let locale = await resolveLocale(options.locale) else {
    fail("locale_unsupported",
         "このロケールは SpeechTranscriber で扱えません: \(options.locale)",
         hint: "probe の supportedLocales を確認してください。")
  }

  let transcriber = makeTranscriber(locale.identifier)
  let before = await AssetInventory.status(forModules: [transcriber])
  if before == .installed {
    emit("installed", ["locale": locale.identifier(.bcp47), "alreadyPresent": true])
    return
  }

  do {
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
      emit("installed", ["locale": locale.identifier(.bcp47), "alreadyPresent": true])
      return
    }
    emit("installing", ["locale": locale.identifier(.bcp47)])
    try await request.downloadAndInstall()
    emit("installed", [
      "locale": locale.identifier(.bcp47),
      "alreadyPresent": false,
      "status": describe(await AssetInventory.status(forModules: [transcriber])),
    ])
  } catch {
    fail("install_failed", "モデルのダウンロードに失敗しました: \(error.localizedDescription)")
  }
}

// MARK: - Listening

/// Owns everything that outlives a single function call while listening.
///
/// A lock rather than an actor: `AVAudioEngine` is not Sendable, so it cannot
/// be handed to an actor, and shutdown must be callable from a signal handler
/// that has no async context to await from.
final class Session: @unchecked Sendable {
  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var finished = false

  func hold(engine: AVAudioEngine, continuation: AsyncStream<AnalyzerInput>.Continuation) {
    lock.lock()
    defer { lock.unlock() }
    self.engine = engine
    self.continuation = continuation
  }

  /// Idempotent: stdin closing and a signal arriving together is normal, and
  /// stopping twice must not throw or double-emit.
  func stop() {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return }
    finished = true
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    continuation?.finish()
  }
}

enum MicrophoneOutcome {
  case granted
  case denied
  /// Nobody answered the prompt. Distinct from denial: the user has not said
  /// no, they have not been asked in a way they can see.
  case unanswered
}

/**
 * Asks for the microphone, but not forever.
 *
 * Under launchd this call blocked indefinitely — the permission prompt is
 * addressed to a person, and a background job may be running when no one is
 * there to answer. An unbounded await turns that into a process that never
 * returns and never explains itself, which is the worst way for a feature to
 * be missing. Bounded, it becomes a message.
 */
func requestMicrophone(timeoutSeconds: Double = 45) async -> MicrophoneOutcome {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return .granted
  case .notDetermined:
    break
  default:
    return .denied
  }

  return await withTaskGroup(of: MicrophoneOutcome?.self) { group in
    group.addTask {
      await AVCaptureDevice.requestAccess(for: .audio) ? .granted : .denied
    }
    group.addTask {
      try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
      return nil
    }
    let first = await group.next() ?? nil
    group.cancelAll()
    return first ?? .unanswered
  }
}

func listen(_ options: Options) async {
  guard SpeechTranscriber.isAvailable else {
    fail("transcriber_unavailable", "この端末では SpeechTranscriber を利用できません。")
  }
  guard let locale = await resolveLocale(options.locale) else {
    fail("locale_unsupported",
         "このロケールは SpeechTranscriber で扱えません: \(options.locale)",
         hint: "probe の supportedLocales を確認してください。")
  }

  let transcriber = makeTranscriber(locale.identifier)

  // Checked before the microphone is opened: asking for audio we cannot
  // transcribe would light the recording indicator for nothing.
  let assetStatus = await AssetInventory.status(forModules: [transcriber])
  guard assetStatus == .installed else {
    fail("model_not_installed",
         "オンデバイスモデルが未インストールです（状態: \(describe(assetStatus))）。",
         hint: "install --locale \(locale.identifier(.bcp47)) を先に実行してください。")
  }

  switch await requestMicrophone() {
  case .granted:
    break
  case .unanswered:
    fail("microphone_prompt_unanswered",
         "マイクの許可ダイアログに応答がありませんでした。",
         hint: "バックグラウンド起動では、応答できる人がいない場合があります。" +
               "一度、前面から起動して許可してください。以降はバンドル ID に紐づいて記憶されます。")
  case .denied:
    fail("microphone_denied",
         "マイクへのアクセスが許可されていません（状態: \(describeMicrophoneAuthorization())）。",
         hint: Bundle.main.bundleIdentifier == nil
           ? "CLI にはバンドル ID がないため、TCC の許可は起動元プロセスに紐づきます。" +
             "swift/iris-speech/bundle.sh を実行して .app として署名・バンドル化してください。"
           : "システム設定 > プライバシーとセキュリティ > マイク で許可してください。")
  }

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    fail("no_audio_format", "解析に使える音声フォーマットが見つかりませんでした。")
  }

  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let session = Session()

  let engine = AVAudioEngine()
  let inputNode = engine.inputNode
  let hardwareFormat = inputNode.outputFormat(forBus: 0)

  guard let converter = AVAudioConverter(from: hardwareFormat, to: analyzerFormat) else {
    fail("converter_unavailable",
         "マイクの形式 (\(hardwareFormat)) を解析形式 (\(analyzerFormat)) に変換できません。")
  }

  inputNode.installTap(onBus: 0, bufferSize: 4096, format: hardwareFormat) { buffer, _ in
    guard let converted = convert(buffer, using: converter, to: analyzerFormat) else { return }
    continuation.yield(AnalyzerInput(buffer: converted))
  }

  session.hold(engine: engine, continuation: continuation)

  // Results are consumed on their own task: `start` does not return until the
  // input sequence ends, and nothing would drain the sequence otherwise.
  let results = Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        if result.isFinal {
          emit("final", [
            "text": text,
            "start": result.range.start.seconds,
            "end": result.range.end.seconds,
          ])
        } else if options.emitVolatile {
          emit("partial", ["text": text])
        }
      }
    } catch {
      emit("error", ["code": "results_failed", "message": error.localizedDescription])
    }
  }

  do {
    try engine.start()
  } catch {
    session.stop()
    fail("audio_engine_failed", "マイクを開始できませんでした: \(error.localizedDescription)")
  }

  emit("ready", [
    "locale": locale.identifier(.bcp47),
    "sampleRate": analyzerFormat.sampleRate,
    "hardwareSampleRate": hardwareFormat.sampleRate,
    "volatile": options.emitVolatile,
  ])

  installStopHandlers(session, detached: options.detached)

  do {
    try await analyzer.start(inputSequence: stream)
    // Whatever was mid-utterance when the stop arrived is still speech the
    // user said; discarding it would lose the end of their last sentence.
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    emit("error", ["code": "analyzer_failed", "message": error.localizedDescription])
  }

  await results.value
  session.stop()
  emit("stopped")
}

func convert(
  _ buffer: AVAudioPCMBuffer,
  using converter: AVAudioConverter,
  to format: AVAudioFormat
) -> AVAudioPCMBuffer? {
  let ratio = format.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
  guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

  // The converter calls this synchronously on this thread before returning, so
  // the buffer never actually escapes — the checker cannot see that.
  nonisolated(unsafe) let source = buffer
  var consumed = false
  var error: NSError?
  let status = converter.convert(to: output, error: &error) { _, statusOut in
    if consumed {
      statusOut.pointee = .noDataNow
      return nil
    }
    consumed = true
    statusOut.pointee = .haveData
    return source
  }

  if status == .error || output.frameLength == 0 { return nil }
  return output
}

/// Stops on stdin EOF or on a signal.
///
/// stdin is the important one: it is how a parent process says "I am gone"
/// without being able to run any code. A microphone that outlives the program
/// that opened it is the failure this prevents.
func installStopHandlers(_ session: Session, detached: Bool = false) {
  // Skipped when launchd started us. There is no parent holding the other end,
  // stdin is /dev/null, and EOF therefore arrives before the first word is
  // spoken — measured as `ready` followed by `stopped` 0.8 seconds later.
  // launchd's way of saying stop is SIGTERM, which is handled below.
  if !detached {
    let stdinWatcher = Task.detached {
      while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { break }  // EOF
        if String(decoding: data, as: UTF8.self).lowercased().contains("stop") { break }
      }
      session.stop()
    }
    _ = stdinWatcher
  }

  for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
    source.setEventHandler { session.stop() }
    source.resume()
    signalSources.append(source)
  }
}

nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

// MARK: - Speaking

/**
 * On-device speech synthesis.
 *
 * Same boundary as transcription, in the other direction: the text stays on
 * this machine and comes out of the speakers. Nothing is uploaded, so this
 * costs nothing per word and works with the network off.
 *
 * Voice quality is reported rather than assumed. The stock voices are the ones
 * that sound like a computer from 2010; the enhanced and premium ones are
 * separate downloads the user has to make in System Settings, and there is no
 * API to install them. Saying which is which is the only useful thing this
 * program can do about that.
 */
func describe(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
  switch quality {
  case .default: return "default"
  case .enhanced: return "enhanced"
  case .premium: return "premium"
  @unknown default: return "unknown"
  }
}

func listVoices(_ options: Options) {
  let wanted = options.locale.lowercased()
  let all = AVSpeechSynthesisVoice.speechVoices()
  let matching = all.filter { wanted == "all" || $0.language.lowercased().hasPrefix(String(wanted.prefix(2))) }

  let voices = matching
    .map { voice -> [String: Any] in
      [
        "identifier": voice.identifier,
        "name": voice.name,
        "language": voice.language,
        "quality": describe(voice.quality),
        "gender": describeGender(voice.gender),
      ]
    }
    // Best first: the whole point of the list is finding something that does
    // not sound synthetic.
    .sorted { rank($0["quality"] as! String) > rank($1["quality"] as! String) }

  emit("voices", [
    "locale": options.locale,
    "count": voices.count,
    "voices": voices,
    "installedTotal": all.count,
    // Stated explicitly, because a list of nine mediocre voices otherwise
    // looks like the ceiling rather than the default.
    "betterVoicesAvailable": !voices.contains { ($0["quality"] as! String) != "default" },
    "hint":
      "enhanced / premium の音声はシステム設定 > アクセシビリティ > 読み上げコンテンツ > " +
      "システムの声 > 声を管理 からダウンロードします。API からは導入できません。",
  ])
}

func describeGender(_ gender: AVSpeechSynthesisVoiceGender) -> String {
  switch gender {
  case .male: return "male"
  case .female: return "female"
  case .unspecified: return "unspecified"
  @unknown default: return "unknown"
  }
}

func rank(_ quality: String) -> Int {
  quality == "premium" ? 3 : quality == "enhanced" ? 2 : 1
}

/// Waits for the utterance to finish, so the caller knows when the speaker is
/// free rather than having to guess at a duration.
///
/// Note what this deliberately does *not* do: block on a semaphore. The
/// synthesiser delivers its callbacks through the run loop, so a main thread
/// parked on a semaphore never lets them arrive — the delegate is silent, no
/// audio plays, and the only symptom is a timeout. The loop has to keep
/// turning while we wait.
final class SpeechCompletion: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false
  private(set) var cancelled = false

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    lock.lock(); finished = true; lock.unlock()
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    lock.lock(); finished = true; cancelled = true; lock.unlock()
  }

  var isFinished: Bool {
    lock.lock(); defer { lock.unlock() }
    return finished
  }

  /// Pumps the run loop until the delegate reports completion, or the deadline.
  func wait(timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !isFinished && Date() < deadline {
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return isFinished
  }
}

func speak(_ options: Options) {
  guard !options.text.isEmpty else {
    fail("empty_text", "--text が空です。")
  }

  let synthesizer = AVSpeechSynthesizer()
  let completion = SpeechCompletion()
  synthesizer.delegate = completion

  let utterance = AVSpeechUtterance(string: options.text)
  var resolved: AVSpeechSynthesisVoice?

  if let requested = options.voice {
    // Accept an identifier or a plain name, because a person reading the
    // voices list will reach for the name.
    resolved = AVSpeechSynthesisVoice(identifier: requested)
      ?? AVSpeechSynthesisVoice.speechVoices().first { $0.name == requested }
    if resolved == nil {
      fail("voice_not_found", "指定された音声が見つかりません: \(requested)", hint: "voices コマンドで一覧を確認してください。")
    }
  } else {
    // Best available for the locale, rather than whatever the system default
    // happens to be.
    resolved = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.lowercased().hasPrefix(String(options.locale.lowercased().prefix(2))) }
      .max { rank(describe($0.quality)) < rank(describe($1.quality)) }
  }

  utterance.voice = resolved
  utterance.rate = options.rate
  utterance.pitchMultiplier = options.pitch
  utterance.volume = options.volume

  emit("speaking", [
    "text": options.text,
    "voice": resolved?.name ?? "system default",
    "identifier": resolved?.identifier ?? "",
    "quality": resolved.map { describe($0.quality) } ?? "unknown",
    "rate": options.rate,
    "pitch": options.pitch,
  ])

  synthesizer.speak(utterance)

  // Generous but bounded: a synthesiser that never calls back must not leave
  // a process resident forever.
  let characters = Double(options.text.count)
  let finished = completion.wait(timeout: max(30, characters * 0.6))
  if !finished {
    synthesizer.stopSpeaking(at: .immediate)
    fail("speak_timeout", "読み上げが完了しませんでした。")
  }

  emit("spoke", ["cancelled": completion.cancelled])
}

// MARK: - Streaming playback

/**
 * Plays raw PCM arriving on stdin, without waiting for the end of it.
 *
 * This exists because of a number: the cloud voices added roughly five to
 * seven seconds before a word was heard, all of it spent waiting for a
 * complete audio file that was then handed to afplay. The fix is not a faster
 * network but not waiting — every one of those services can stream, and the
 * missing half was a player on this side.
 *
 * PCM rather than MP3 on purpose. Compressed audio would need progressive
 * decoding; raw samples need none, which turns "stream audio" into "copy
 * bytes into a buffer". afplay could not have done this at all — it takes a
 * file, and a file is exactly the thing we are trying not to wait for.
 *
 * Cancellation comes free: closing the pipe stops the sound, so an assistant
 * that is interrupted mid-sentence stops mid-sentence.
 */
func playStream(_ options: Options) {
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()

  // Signed 16-bit little-endian is what every one of these APIs emits.
  guard let inputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: Double(options.sampleRate),
    channels: AVAudioChannelCount(options.channels),
    interleaved: true
  ), let playFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(options.sampleRate),
    channels: AVAudioChannelCount(options.channels),
    interleaved: false
  ) else {
    fail("bad_audio_format", "PCM フォーマットを構成できません（\(options.sampleRate)Hz \(options.channels)ch）。")
  }

  engine.attach(player)
  engine.connect(player, to: engine.mainMixerNode, format: playFormat)

  do {
    try engine.start()
  } catch {
    fail("audio_engine_failed", "再生を開始できませんでした: \(error.localizedDescription)")
  }
  player.play()

  emit("playing", ["sampleRate": options.sampleRate, "channels": options.channels])

  let bytesPerFrame = 2 * options.channels
  var carry = Data()
  var scheduled = 0
  var firstAudioAt: Date?

  let input = FileHandle.standardInput
  while true {
    let chunk = input.availableData
    if chunk.isEmpty { break }  // EOF: the sender is done
    carry.append(chunk)

    // Whole frames only; a split sample would be heard as a click.
    let usable = (carry.count / bytesPerFrame) * bytesPerFrame
    guard usable > 0 else { continue }

    let frames = usable / bytesPerFrame
    let payload = carry.prefix(usable)
    carry.removeFirst(usable)

    guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)) else { continue }
    buffer.frameLength = AVAudioFrameCount(frames)

    payload.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      guard let channels = buffer.floatChannelData else { return }
      for frame in 0..<frames {
        for channel in 0..<options.channels {
          // Int16 to normalised float; 32768 rather than 32767 so the most
          // negative sample does not clip.
          channels[channel][frame] = Float(samples[frame * options.channels + channel]) / 32768.0
        }
      }
    }

    if firstAudioAt == nil {
      firstAudioAt = Date()
      // The number the whole exercise is about: when sound actually started,
      // as measured here rather than estimated by the caller.
      emit("first_audio", ["frames": frames])
    }
    player.scheduleBuffer(buffer, completionHandler: nil)
    scheduled += frames
  }

  // Everything queued still has to be heard. Without this the process exits
  // and takes the tail of the sentence with it.
  let remaining = Double(scheduled) / Double(options.sampleRate)
  let deadline = Date().addingTimeInterval(remaining + 2.0)
  while player.isPlaying, Date() < deadline {
    if let last = player.lastRenderTime,
       let played = player.playerTime(forNodeTime: last),
       played.sampleTime >= AVAudioFramePosition(scheduled) {
      break
    }
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }

  player.stop()
  engine.stop()
  emit("played", ["frames": scheduled, "seconds": remaining])
}

// MARK: - Calendar

/**
 * Upcoming events, read through EventKit.
 *
 * Replaces an AppleScript path that took 60–75 seconds for a fortnight,
 * because Calendar.app's scripting interface has no way to ask for a date
 * range — every query walks every event and filters afterwards. EventKit has
 * `predicateForEvents(withStart:end:calendars:)`, which is the same question
 * asked in a form the store can answer directly.
 *
 * Read-only by design. Full access is requested because reading events
 * requires it on macOS 14+, but nothing here writes, and the usage string
 * says so — a permission dialog that overstates what it is for teaches people
 * to stop reading them.
 */
func describeCalendarAuthorization() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

/**
 * Asks for calendar access, bounded.
 *
 * Same lesson as the microphone: under launchd the prompt is addressed to a
 * person who may not be there, and an unbounded await turns that into a
 * process that never returns and never explains itself.
 */
/**
 * Asks for calendar access, pumping the run loop while it waits.
 *
 * The async form returned false immediately with no prompt and no error. Same
 * shape as the AVSpeechSynthesizer bug earlier in this file: the permission
 * dialog is presented through the run loop, so a thread parked on an await
 * never lets it appear — and EventKit reports "not granted" rather than
 * "nobody was asked", which is indistinguishable from a refusal.
 *
 * Bounded, because under launchd there may be no one to answer.
 */
final class CalendarAccessResult: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Bool?
  private var failure: String?

  func settle(granted: Bool, error: Error?) {
    lock.lock(); defer { lock.unlock() }
    if value == nil {
      value = granted
      if let error { failure = error.localizedDescription }
    }
  }

  var settled: Bool {
    lock.lock(); defer { lock.unlock() }
    return value != nil
  }

  var outcome: (granted: Bool, failure: String?) {
    lock.lock(); defer { lock.unlock() }
    return (value ?? false, failure)
  }
}

func requestCalendarAccess(timeoutSeconds: Double = 45) -> MicrophoneOutcome {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess:
    return .granted
  case .notDetermined:
    break
  case .writeOnly:
    // macOS 14+ splits calendar permission in two, and write-only is not a
    // refusal — it is a narrower grant that can be widened. Reading events
    // needs the wider one, and asking for it is the upgrade the system
    // provides. Treating this as denied would leave the feature permanently
    // unavailable with no way to fix it from here.
    break
  default:
    return .denied
  }

  let store = EKEventStore()
  let result = CalendarAccessResult()
  store.requestFullAccessToEvents { granted, error in
    result.settle(granted: granted, error: error)
  }

  let deadline = Date().addingTimeInterval(timeoutSeconds)
  while !result.settled, Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }

  if !result.settled { return .unanswered }
  let (granted, failure) = result.outcome
  if let failure {
    // Reported rather than swallowed. The first version used `try?`, which
    // turned "the request failed and here is why" into an indistinguishable
    // "denied" — and the reason was the only thing worth having.
    emit("error", ["code": "calendar_request_failed", "message": failure])
  }
  return granted ? .granted : .denied
}

func readCalendar(_ options: Options) async {
  let store = EKEventStore()

  switch requestCalendarAccess() {
  case .granted:
    break
  case .unanswered:
    fail("calendar_prompt_unanswered",
         "カレンダーの許可ダイアログに応答がありませんでした。",
         hint: "バックグラウンド起動では応答できる人がいない場合があります。一度、前面から実行して許可してください。")
  case .denied:
    fail("calendar_denied",
         "カレンダーへのアクセスが許可されていません（状態: \(describeCalendarAuthorization())）。",
         hint: describeCalendarAuthorization() == "writeOnly"
           ? "書き込みのみ許可された状態です。読み取りには「フルアクセス」が必要で、" +
             "システム設定 > プライバシーとセキュリティ > カレンダー で IRIS Speech を許可してください。"
           : Bundle.main.bundleIdentifier == nil
             ? "CLI にはバンドル ID がないため、許可は起動元プロセスに紐づきます。bundle.sh で .app 化してください。"
             : "システム設定 > プライバシーとセキュリティ > カレンダー で許可してください。")
  }

  let started = Date()
  let now = Date()
  let end = Calendar.current.date(byAdding: .day, value: max(1, options.days), to: now) ?? now

  // The whole point: the store answers a date range directly instead of us
  // walking every event and discarding most of them.
  let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
  let events = store.events(matching: predicate)

  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]

  let payload: [[String: Any]] = events
    .sorted { ($0.startDate ?? .distantFuture) < ($1.startDate ?? .distantFuture) }
    .map { event in
      var entry: [String: Any] = [
        "title": event.title ?? "(無題)",
        "allDay": event.isAllDay,
        "calendar": event.calendar?.title ?? "",
      ]
      if let start = event.startDate { entry["start"] = formatter.string(from: start) }
      if let end = event.endDate { entry["end"] = formatter.string(from: end) }
      if let location = event.location, !location.isEmpty { entry["location"] = location }
      return entry
    }

  // Listed separately from the events. "No events in the window" and "no
  // calendars visible to this process" produce the same empty list and mean
  // completely different things — the second is a permission or account
  // problem wearing the costume of a quiet fortnight.
  let allCalendars = store.calendars(for: .event)

  emit("calendar", [
    "days": options.days,
    "count": payload.count,
    "calendarsVisible": allCalendars.count,
    "calendarNames": allCalendars.map { $0.title }.sorted(),
    // Reported so the replacement can be compared against the 60–75s it
    // replaced, rather than assumed to be faster.
    "elapsedMs": Int(Date().timeIntervalSince(started) * 1000),
    "calendars": Set(events.compactMap { $0.calendar?.title }).sorted(),
    "events": payload,
  ])
}

// MARK: - Entry point

let options = parseOptions()
outputPath = options.outPath
switch options.command {
case "probe":
  await probe(options)
case "install":
  await install(options)
case "listen":
  await listen(options)
case "voices":
  listVoices(options)
case "speak":
  speak(options)
case "play":
  playStream(options)
case "calendar":
  await readCalendar(options)
default:
  fail("unknown_command", "不明なコマンド: \(options.command)", hint: "probe | install | listen | voices | speak | play | calendar")
}
