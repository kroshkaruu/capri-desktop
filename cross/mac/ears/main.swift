// CapriEars: Capri's ears on a Mac. Listens to the microphone all the time and turns speech into text with Apple's own
// speech recognition (free, on this Mac when the language is downloaded). It prints one JSON object per line:
//   {"type":"ready","onDevice":true}           listening started
//   {"type":"partial","text":"Капри, открой"}  what it hears so far
//   {"type":"phrase","text":"Капри, открой телеграм."}  a finished phrase, after a short pause
//   {"type":"error","code":"...","text":"..."}  something went wrong
// Capri decides what to do with the text (the wake word lives on her side). Closing stdin stops it.
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

let arguments = CommandLine.arguments
let localeId = arguments.count > 1 ? arguments[1] : "ru-RU"
let silence = arguments.count > 2 ? (Double(arguments[2]) ?? 1.1) : 1.1
let hints = arguments.count > 3 ? arguments[3].split(separator: "|").map(String.init) : ["Капри"]

// Capri closed or died: stop with her.
Thread.detachNewThread {
    while let _ = readLine(strippingNewline: true) {}
    exit(0)
}

final class Listener {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let lock = NSLock()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var generation = 0
    var lastText = ""
    var lastChange = Date()
    var started = Date()
    var onDevice = false
    var ticker: Timer?
    var failures = 0

    init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

    func start() {
        onDevice = recognizer.supportsOnDeviceRecognition
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        if format.sampleRate <= 0 || format.channelCount == 0 {
            emit(["type": "error", "code": "no_mic", "text": "Микрофон не найден."])
            exit(3)
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.lock.lock()
            let current = self.request
            self.lock.unlock()
            current?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            emit(["type": "error", "code": "mic_failed", "text": "Не получилось включить микрофон: \(error.localizedDescription)"])
            exit(4)
        }
        newTask()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
        emit(["type": "ready", "onDevice": onDevice, "locale": recognizer.locale.identifier])
    }

    func newTask() {
        generation += 1
        let mine = generation
        task?.cancel()
        let fresh = SFSpeechAudioBufferRecognitionRequest()
        fresh.shouldReportPartialResults = true
        fresh.taskHint = .dictation
        fresh.contextualStrings = hints
        if onDevice { fresh.requiresOnDeviceRecognition = true }
        if #available(macOS 13.0, *) { fresh.addsPunctuation = true }
        lock.lock()
        request?.endAudio()
        request = fresh
        lock.unlock()
        lastText = ""
        started = Date()
        lastChange = Date()
        task = recognizer.recognitionTask(with: fresh) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, mine == self.generation else { return }
                if let result = result {
                    self.failures = 0
                    let text = result.bestTranscription.formattedString
                    if text != self.lastText {
                        self.lastText = text
                        self.lastChange = Date()
                        if !text.isEmpty { emit(["type": "partial", "text": text]) }
                    }
                    if result.isFinal { self.finish() }
                } else if error != nil {
                    if !self.lastText.isEmpty { self.finish(); return }
                    // Nothing heard ("no speech detected") or a hiccup: start again, a little slower after many in a row.
                    self.failures += 1
                    let wait = self.failures > 5 ? 2.0 : 0.1
                    if self.failures == 8, let error = error {
                        emit(["type": "error", "code": "recognizer", "text": error.localizedDescription])
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                        if mine == self.generation { self.newTask() }
                    }
                }
            }
        }
    }

    func tick() {
        let now = Date()
        if !lastText.isEmpty && now.timeIntervalSince(lastChange) >= silence { finish(); return }
        // Apple caps one recognition at about a minute, so a quiet room gets a fresh one now and then.
        if now.timeIntervalSince(started) > 50 {
            if lastText.isEmpty { newTask() } else if now.timeIntervalSince(started) > 58 { finish() }
        }
    }

    func finish() {
        let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
        lastText = ""
        if !text.isEmpty { emit(["type": "phrase", "text": text]) }
        newTask()
    }
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    emit(["type": "error", "code": "no_language", "text": "macOS не умеет распознавать язык \(localeId)."])
    exit(2)
}

var listener: Listener?

func begin() {
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
            if !granted {
                emit(["type": "error", "code": "mic_denied", "text": "Нет доступа к микрофону. Разреши его Capri: Системные настройки → Конфиденциальность и безопасность → Микрофон."])
                exit(5)
            }
            if !recognizer.isAvailable {
                emit(["type": "error", "code": "unavailable", "text": "Распознавание речи сейчас недоступно. Проверь интернет или включи Диктовку с русским языком в настройках клавиатуры."])
            }
            let started = Listener(recognizer: recognizer)
            listener = started
            started.start()
        }
    }
}

SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        switch status {
        case .authorized:
            begin()
        default:
            emit(["type": "error", "code": "speech_denied", "text": "Нет доступа к распознаванию речи. Разреши его Capri: Системные настройки → Конфиденциальность и безопасность → Распознавание речи."])
            exit(6)
        }
    }
}

RunLoop.main.run()
